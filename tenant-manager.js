const crypto = require('crypto');

class TenantManager {
    constructor(pool) {
        this.pool = pool;
    }

    async initializeCoreSchema() {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(`CREATE SCHEMA IF NOT EXISTS core`);

            await client.query(`
                CREATE TABLE IF NOT EXISTS core.tenant_catalog (
                    id SERIAL PRIMARY KEY,
                    tenant_schema TEXT UNIQUE NOT NULL CHECK (tenant_schema ~ '^tenant_[0-9]+$'),
                    genesis_user_id INTEGER NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
                    metadata JSONB DEFAULT '{}'::jsonb
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_tenant_genesis_user 
                ON core.tenant_catalog(genesis_user_id)
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS core.invites (
                    id SERIAL PRIMARY KEY,
                    token TEXT UNIQUE NOT NULL,
                    tenant_id INTEGER NOT NULL REFERENCES core.tenant_catalog(id) ON DELETE CASCADE,
                    created_by_user_id INTEGER NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    max_uses INTEGER DEFAULT 1,
                    current_uses INTEGER DEFAULT 0,
                    target_role TEXT DEFAULT 'read-only' CHECK (target_role IN ('admin', 'read-only', 'write-only')),
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    metadata JSONB DEFAULT '{}'::jsonb,
                    CONSTRAINT valid_uses CHECK (current_uses <= max_uses)
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_invites_token ON core.invites(token)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_invites_tenant ON core.invites(tenant_id)
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS core.sybil_protection (
                    id SERIAL PRIMARY KEY,
                    identifier_type TEXT NOT NULL CHECK (identifier_type IN ('email', 'ip', 'fingerprint')),
                    identifier_value TEXT NOT NULL,
                    tenant_count INTEGER DEFAULT 0,
                    last_tenant_created_at TIMESTAMPTZ,
                    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
                    blocked BOOLEAN DEFAULT false,
                    block_reason TEXT,
                    metadata JSONB DEFAULT '{}'::jsonb,
                    UNIQUE(identifier_type, identifier_value)
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_sybil_identifier 
                ON core.sybil_protection(identifier_type, identifier_value)
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS core.rate_limits (
                    id SERIAL PRIMARY KEY,
                    action_type TEXT NOT NULL CHECK (action_type IN ('tenant_creation', 'invite_creation', 'signup')),
                    identifier_type TEXT NOT NULL CHECK (identifier_type IN ('email', 'ip', 'user_id')),
                    identifier_value TEXT NOT NULL,
                    attempt_count INTEGER DEFAULT 1,
                    window_start TIMESTAMPTZ DEFAULT NOW(),
                    window_end TIMESTAMPTZ,
                    blocked_until TIMESTAMPTZ,
                    metadata JSONB DEFAULT '{}'::jsonb,
                    UNIQUE(action_type, identifier_type, identifier_value, window_start)
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup 
                ON core.rate_limits(action_type, identifier_type, identifier_value)
            `);

            await client.query(`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES core.tenant_catalog(id) ON DELETE SET NULL
            `);
            
            await client.query(`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS is_genesis_admin BOOLEAN DEFAULT false
            `);

            await client.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint 
                        WHERE conname = 'users_role_check_with_dev'
                    ) THEN
                        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
                        ALTER TABLE users ADD CONSTRAINT users_role_check_with_dev 
                        CHECK (role IN ('dev', 'admin', 'read-only', 'write-only'));
                    END IF;
                END $$;
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)
            `);

            await client.query('COMMIT');
            console.log('✅ Core schema initialized with security tables');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Core schema initialization failed:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    sanitizeSchemaName(tenantId) {
        const numericId = parseInt(tenantId, 10);
        if (isNaN(numericId) || numericId < 1) {
            throw new Error('Invalid tenant ID for schema name');
        }
        return `tenant_${numericId}`;
    }

    async createTenantSchema(tenantId) {
        const schemaName = this.sanitizeSchemaName(tenantId);
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');

            await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.bridges (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    input_platform TEXT NOT NULL,
                    output_platform TEXT NOT NULL,
                    input_credentials JSONB,
                    output_credentials JSONB,
                    output_01_url TEXT,
                    output_0n_url TEXT,
                    status TEXT DEFAULT 'inactive',
                    contact_info TEXT,
                    tags TEXT[],
                    archived BOOLEAN DEFAULT false NOT NULL,
                    fractal_id TEXT UNIQUE,
                    created_by_admin_id TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            // DISCORD-FIRST ARCHITECTURE: Messages table dropped - Discord threads are sole storage
            // All message history, search, and UI handled by Discord at $0 cost
            
            // MEDIA BUFFER: Temporary storage for retry-safe webhook delivery
            // Purpose: Ensure zero media loss between WhatsApp download and Discord webhook delivery
            // Lifecycle: Purged after 3 days (Nyanbook Ledger has permanent copy)
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.media_buffer (
                    id SERIAL PRIMARY KEY,
                    bridge_id INTEGER REFERENCES ${schemaName}.bridges(id) ON DELETE CASCADE,
                    media_data TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    sender_name TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    delivered_to_ledger BOOLEAN DEFAULT false,
                    delivered_to_user BOOLEAN DEFAULT false,
                    delivery_attempts INTEGER DEFAULT 0,
                    last_delivery_attempt TIMESTAMPTZ
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_created_at 
                ON ${schemaName}.media_buffer(created_at DESC)
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_bridge 
                ON ${schemaName}.media_buffer(bridge_id)
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_pending
                ON ${schemaName}.media_buffer(delivered_to_ledger, delivered_to_user)
                WHERE delivered_to_ledger = false OR delivered_to_user = false
            `);


            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_bridges_fractal_id 
                ON ${schemaName}.bridges(fractal_id)
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.sessions (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    session_id TEXT UNIQUE NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    last_activity TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ,
                    active BOOLEAN DEFAULT true
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.audit_logs (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ DEFAULT NOW(),
                    action_type TEXT NOT NULL,
                    actor_user_id INTEGER,
                    target_type TEXT,
                    target_id TEXT,
                    details JSONB,
                    ip_address TEXT,
                    user_agent TEXT,
                    session_id TEXT,
                    status TEXT DEFAULT 'success'
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_audit_timestamp 
                ON ${schemaName}.audit_logs(timestamp DESC)
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.message_analytics (
                    id SERIAL PRIMARY KEY,
                    date DATE NOT NULL,
                    bridge_id INTEGER REFERENCES ${schemaName}.bridges(id) ON DELETE CASCADE,
                    total_messages INTEGER DEFAULT 0,
                    failed_messages INTEGER DEFAULT 0,
                    rate_limit_events INTEGER DEFAULT 0,
                    avg_response_time_ms NUMERIC(10,2),
                    UNIQUE(date, bridge_id)
                )
            `);

            await client.query('COMMIT');
            console.log(`✅ Created tenant schema: ${schemaName}`);
            return schemaName;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`❌ Failed to create tenant schema ${schemaName}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    async checkSybilRisk(email, ipAddress) {
        const TENANT_LIMIT_PER_EMAIL = 3;
        const TENANT_LIMIT_PER_IP = 10;
        const COOLDOWN_HOURS = 24;

        const emailCheck = await this.pool.query(`
            SELECT tenant_count, blocked, block_reason, last_tenant_created_at
            FROM core.sybil_protection
            WHERE identifier_type = 'email' AND identifier_value = $1
        `, [email]);

        if (emailCheck.rows.length > 0) {
            const record = emailCheck.rows[0];
            if (record.blocked) {
                return { allowed: false, reason: record.block_reason || 'Email blocked for suspicious activity' };
            }
            if (record.tenant_count >= TENANT_LIMIT_PER_EMAIL) {
                return { allowed: false, reason: `Maximum ${TENANT_LIMIT_PER_EMAIL} tenant databases per email` };
            }
            
            if (record.last_tenant_created_at) {
                const hoursSinceLastCreate = (Date.now() - new Date(record.last_tenant_created_at)) / (1000 * 60 * 60);
                if (hoursSinceLastCreate < COOLDOWN_HOURS && record.tenant_count > 0) {
                    return { allowed: false, reason: `Please wait ${Math.ceil(COOLDOWN_HOURS - hoursSinceLastCreate)} hours before creating another tenant` };
                }
            }
        }

        if (ipAddress) {
            const ipCheck = await this.pool.query(`
                SELECT tenant_count, blocked, block_reason
                FROM core.sybil_protection
                WHERE identifier_type = 'ip' AND identifier_value = $1
            `, [ipAddress]);

            if (ipCheck.rows.length > 0) {
                const record = ipCheck.rows[0];
                if (record.blocked) {
                    return { allowed: false, reason: 'IP address blocked for suspicious activity' };
                }
                if (record.tenant_count >= TENANT_LIMIT_PER_IP) {
                    return { allowed: false, reason: 'Too many tenant databases from this IP address' };
                }
            }
        }

        return { allowed: true };
    }

    async recordTenantCreation(email, ipAddress) {
        await this.pool.query(`
            INSERT INTO core.sybil_protection (identifier_type, identifier_value, tenant_count, last_tenant_created_at)
            VALUES ('email', $1, 1, NOW())
            ON CONFLICT (identifier_type, identifier_value)
            DO UPDATE SET 
                tenant_count = core.sybil_protection.tenant_count + 1,
                last_tenant_created_at = NOW()
        `, [email]);

        if (ipAddress) {
            await this.pool.query(`
                INSERT INTO core.sybil_protection (identifier_type, identifier_value, tenant_count, last_tenant_created_at)
                VALUES ('ip', $1, 1, NOW())
                ON CONFLICT (identifier_type, identifier_value)
                DO UPDATE SET 
                    tenant_count = core.sybil_protection.tenant_count + 1,
                    last_tenant_created_at = NOW()
            `, [ipAddress]);
        }
    }

    async checkRateLimit(actionType, identifierType, identifierValue) {
        const LIMITS = {
            tenant_creation: { max: 3, windowMinutes: 60 },
            invite_creation: { max: 20, windowMinutes: 60 },
            signup: { max: 5, windowMinutes: 15 }
        };

        const limit = LIMITS[actionType];
        if (!limit) return { allowed: true };

        const windowStart = new Date(Date.now() - limit.windowMinutes * 60 * 1000);

        const result = await this.pool.query(`
            SELECT SUM(attempt_count) as total_attempts, MAX(blocked_until) as blocked_until
            FROM core.rate_limits
            WHERE action_type = $1 
            AND identifier_type = $2 
            AND identifier_value = $3
            AND window_start > $4
        `, [actionType, identifierType, identifierValue, windowStart]);

        const record = result.rows[0];
        
        if (record.blocked_until && new Date(record.blocked_until) > new Date()) {
            const minutesLeft = Math.ceil((new Date(record.blocked_until) - new Date()) / (1000 * 60));
            return { 
                allowed: false, 
                reason: `Rate limit exceeded. Try again in ${minutesLeft} minutes.` 
            };
        }

        const totalAttempts = parseInt(record.total_attempts || 0);
        if (totalAttempts >= limit.max) {
            const blockedUntil = new Date(Date.now() + 60 * 60 * 1000);
            await this.pool.query(`
                INSERT INTO core.rate_limits 
                (action_type, identifier_type, identifier_value, attempt_count, window_start, blocked_until)
                VALUES ($1, $2, $3, 1, NOW(), $4)
            `, [actionType, identifierType, identifierValue, blockedUntil]);
            
            return { 
                allowed: false, 
                reason: `Rate limit exceeded. Maximum ${limit.max} ${actionType} per ${limit.windowMinutes} minutes.` 
            };
        }

        await this.pool.query(`
            INSERT INTO core.rate_limits 
            (action_type, identifier_type, identifier_value, attempt_count, window_start)
            VALUES ($1, $2, $3, 1, NOW())
        `, [actionType, identifierType, identifierValue]);

        return { allowed: true };
    }

    async createTenant(genesisUserId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Use 'tenant_0' as placeholder (matches CHECK constraint pattern)
            const tenantResult = await client.query(`
                INSERT INTO core.tenant_catalog (genesis_user_id, tenant_schema)
                VALUES ($1, 'tenant_0')
                RETURNING id
            `, [genesisUserId]);

            const tenantId = tenantResult.rows[0].id;
            const schemaName = this.sanitizeSchemaName(tenantId);

            // Update with correct schema name
            await client.query(`
                UPDATE core.tenant_catalog 
                SET tenant_schema = $1, updated_at = NOW()
                WHERE id = $2
            `, [schemaName, tenantId]);

            // Link user to tenant
            await client.query(`
                UPDATE users 
                SET tenant_id = $1, is_genesis_admin = true, updated_at = NOW()
                WHERE id = $2
            `, [tenantId, genesisUserId]);

            await client.query('COMMIT');

            // Create the actual tenant schema
            await this.createTenantSchema(tenantId);

            console.log(`✅ Created tenant ${tenantId} with genesis user ${genesisUserId}`);
            return { tenantId, schemaName };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Tenant creation failed:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async generateInviteToken(tenantId, createdByUserId, targetRole = 'read-only', expiresInDays = 7, maxUses = 1) {
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        await this.pool.query(`
            INSERT INTO core.invites (token, tenant_id, created_by_user_id, expires_at, max_uses, target_role)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [token, tenantId, createdByUserId, expiresAt, maxUses, targetRole]);

        console.log(`✅ Generated invite token for tenant ${tenantId}`);
        return token;
    }

    async validateInviteToken(token) {
        const result = await this.pool.query(`
            SELECT i.*, t.tenant_schema
            FROM core.invites i
            JOIN core.tenant_catalog t ON i.tenant_id = t.id
            WHERE i.token = $1 
            AND i.status = 'active'
            AND i.expires_at > NOW()
            AND i.current_uses < i.max_uses
            AND t.status = 'active'
        `, [token]);

        if (result.rows.length === 0) {
            return { valid: false, reason: 'Invalid, expired, or fully used invite token' };
        }

        return { valid: true, invite: result.rows[0] };
    }

    async consumeInviteToken(token) {
        const result = await this.pool.query(`
            UPDATE core.invites
            SET current_uses = current_uses + 1,
                status = CASE 
                    WHEN current_uses + 1 >= max_uses THEN 'expired'
                    ELSE 'active'
                END
            WHERE token = $1
            RETURNING tenant_id, target_role, tenant_schema
            FROM (
                SELECT tenant_id, target_role, 
                       (SELECT tenant_schema FROM core.tenant_catalog WHERE id = tenant_id) as tenant_schema
                FROM core.invites
                WHERE token = $1
            ) sub
        `, [token]);

        return result.rows[0];
    }

    async getTenantContext(userId) {
        const result = await this.pool.query(`
            SELECT u.tenant_id, t.tenant_schema, u.role, u.is_genesis_admin
            FROM users u
            LEFT JOIN core.tenant_catalog t ON u.tenant_id = t.id
            WHERE u.id = $1
        `, [userId]);

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }
}

module.exports = TenantManager;
