// Tenant Manager - Multi-tenant schema management
class TenantManager {
    constructor(pool) {
        this.pool = pool;
    }

    async initializeCoreSchema() {
        const client = await this.pool.connect();
        try {
            // Core schema initialization - safe to run multiple times
            await client.query(`
                CREATE TABLE IF NOT EXISTS core.invite_tokens (
                    id SERIAL PRIMARY KEY,
                    token TEXT UNIQUE NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    expires_at TIMESTAMP NOT NULL,
                    consumed BOOLEAN DEFAULT FALSE,
                    consumed_at TIMESTAMP,
                    consumed_by TEXT
                )
            `).catch(err => {
                // Ignore duplicate table errors on restart
                if (err.code !== '23505') throw err;
            });
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS core.tenant_creation_log (
                    id SERIAL PRIMARY KEY,
                    email TEXT NOT NULL,
                    ip TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(err => {
                // Ignore duplicate table errors on restart
                if (err.code !== '23505') throw err;
            });
        } finally {
            client.release();
        }
    }

    async createTenant(userId) {
        const client = await this.pool.connect();
        try {
            // FIRST PRINCIPLES: Get next tenant ID, then register in catalog with correct schema name
            // This ensures CHECK constraint on tenant_schema pattern is satisfied from the start
            const idResult = await client.query(`SELECT nextval('core.tenant_catalog_id_seq') as id`);
            const tenantId = parseInt(idResult.rows[0].id);
            const schemaName = `tenant_${tenantId}`;
            
            // Register tenant in catalog with correct schema name (satisfies foreign key constraints)
            await client.query(`
                INSERT INTO core.tenant_catalog (id, tenant_schema, genesis_user_id, status)
                VALUES ($1, $2, $3, 'active')
            `, [tenantId, schemaName, userId]);
            
            // Create the actual tenant schema
            await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
            
            // Create tenant tables
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.users (
                    id SERIAL PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'admin',
                    tenant_id INTEGER NOT NULL,
                    is_genesis_admin BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.books (
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
                    archived BOOLEAN DEFAULT FALSE,
                    fractal_id TEXT,
                    created_by_admin_id TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.drops (
                    id SERIAL PRIMARY KEY,
                    book_id INTEGER NOT NULL REFERENCES ${schemaName}.books(id) ON DELETE CASCADE,
                    discord_message_id TEXT NOT NULL,
                    metadata_text TEXT NOT NULL,
                    extracted_tags TEXT[] DEFAULT '{}'::text[],
                    extracted_dates TEXT[] DEFAULT '{}'::text[],
                    search_vector tsvector,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS drops_book_message_idx 
                ON ${schemaName}.drops (book_id, discord_message_id)
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS drops_search_idx 
                ON ${schemaName}.drops USING gin(search_vector)
            `);
            
            // Create sessions table for session management (express-session uses 'expires' not 'expire')
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.sessions (
                    sid TEXT PRIMARY KEY,
                    sess JSONB NOT NULL,
                    expires TIMESTAMP NOT NULL
                )
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS sessions_expire_idx 
                ON ${schemaName}.sessions (expires)
            `);
            
            // Create refresh_tokens table for JWT refresh tokens (auth-service.js)
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.refresh_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES ${schemaName}.users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    device_info TEXT,
                    ip_address TEXT,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    revoked_at TIMESTAMP,
                    is_revoked BOOLEAN DEFAULT FALSE
                )
            `);
            
            // Create audit_logs table for security tracking (logAudit function)
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.audit_logs (
                    id SERIAL PRIMARY KEY,
                    actor_user_id INTEGER,
                    action_type TEXT NOT NULL,
                    target_type TEXT,
                    target_id TEXT,
                    details JSONB,
                    ip_address TEXT,
                    user_agent TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS audit_logs_actor_idx 
                ON ${schemaName}.audit_logs (actor_user_id, created_at DESC)
            `);
            
            // Create media_buffer table for atomic media storage before Discord delivery
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.media_buffer (
                    id SERIAL PRIMARY KEY,
                    book_id INTEGER NOT NULL REFERENCES ${schemaName}.books(id) ON DELETE CASCADE,
                    media_data BYTEA NOT NULL,
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
                CREATE INDEX IF NOT EXISTS media_buffer_book_idx 
                ON ${schemaName}.media_buffer (book_id, delivered_to_ledger, created_at)
            `);
            
            // Create active_sessions table for session tracking (createSessionRecord function)
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.active_sessions (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES ${schemaName}.users(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL UNIQUE,
                    ip_address TEXT,
                    user_agent TEXT,
                    device_type TEXT,
                    browser TEXT,
                    os TEXT,
                    location TEXT,
                    login_time TIMESTAMP DEFAULT NOW(),
                    last_activity TIMESTAMP DEFAULT NOW(),
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS active_sessions_user_idx 
                ON ${schemaName}.active_sessions (user_id, is_active, last_activity DESC)
            `);
            
            // Create message_analytics table for message statistics
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.message_analytics (
                    id SERIAL PRIMARY KEY,
                    book_id INTEGER NOT NULL REFERENCES ${schemaName}.books(id) ON DELETE CASCADE,
                    date DATE NOT NULL,
                    message_count INTEGER DEFAULT 0,
                    media_count INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(book_id, date)
                )
            `);
            
            return { tenantId, schemaName };
        } finally {
            client.release();
        }
    }

    async validateInviteToken(token) {
        const client = await this.pool.connect();
        try {
            const result = await client.query(`
                SELECT * FROM core.invite_tokens 
                WHERE token = $1 AND consumed = FALSE AND expires_at > NOW()
            `, [token]);
            
            return {
                valid: result.rows.length > 0,
                token: result.rows[0] || null
            };
        } finally {
            client.release();
        }
    }

    async consumeInviteToken(token) {
        const client = await this.pool.connect();
        try {
            await client.query(`
                UPDATE core.invite_tokens 
                SET consumed = TRUE, consumed_at = NOW()
                WHERE token = $1
            `, [token]);
        } finally {
            client.release();
        }
    }

    async checkSybilRisk(email, ip) {
        // Simplified sybil check - allow all signups
        return { allowed: true };
    }

    async checkRateLimit(type, key, value) {
        // Simplified rate limit check - allow all requests
        return { allowed: true };
    }

    async recordTenantCreation(email, ip) {
        const client = await this.pool.connect();
        try {
            await client.query(`
                INSERT INTO core.tenant_creation_log (email, ip)
                VALUES ($1, $2)
            `, [email, ip]);
        } finally {
            client.release();
        }
    }

    async generateInviteToken(tenantId, createdBy, expiresInDays = 7) {
        const client = await this.pool.connect();
        try {
            const token = require('crypto').randomBytes(32).toString('hex');
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiresInDays);
            
            await client.query(`
                INSERT INTO core.invite_tokens (token, expires_at)
                VALUES ($1, $2)
            `, [token, expiresAt]);
            
            return token;
        } finally {
            client.release();
        }
    }
}

module.exports = TenantManager;
