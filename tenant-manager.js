// Tenant Manager - Multi-tenant schema management
const crypto = require('crypto');

// Sybil Rate Limiter - In-memory tracking for signup abuse prevention
const RATE_LIMITS = {
    IP_PER_HOUR: 3,
    IP_PER_DAY: 5,
    DOMAIN_PER_DAY: 10
};

const DISPOSABLE_EMAIL_DOMAINS = new Set([
    'tempmail.com', 'throwaway.email', '10minutemail.com', 'guerrillamail.com',
    'mailinator.com', 'yopmail.com', 'temp-mail.org', 'fakeinbox.com',
    'getnada.com', 'burnermail.io', 'discard.email', 'sharklasers.com'
]);

class SybilRateLimiter {
    constructor() {
        this.ipHourly = new Map();
        this.ipDaily = new Map();
        this.domainDaily = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }
    
    cleanup() {
        const now = Date.now();
        const hourAgo = now - 3600000;
        const dayAgo = now - 86400000;
        
        for (const [key, data] of this.ipHourly) {
            if (data.timestamp < hourAgo) this.ipHourly.delete(key);
        }
        for (const [key, data] of this.ipDaily) {
            if (data.timestamp < dayAgo) this.ipDaily.delete(key);
        }
        for (const [key, data] of this.domainDaily) {
            if (data.timestamp < dayAgo) this.domainDaily.delete(key);
        }
    }
    
    hashKey(value) {
        return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
    }
    
    extractDomain(email) {
        const parts = email.toLowerCase().split('@');
        return parts.length === 2 ? parts[1] : null;
    }
    
    checkRateLimit(ip, email) {
        const now = Date.now();
        const hourAgo = now - 3600000;
        const dayAgo = now - 86400000;
        const ipHash = this.hashKey(ip);
        const domain = this.extractDomain(email);
        
        if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
            return { allowed: false, reason: 'Disposable email domains are not allowed' };
        }
        
        const ipHourData = this.ipHourly.get(ipHash);
        if (ipHourData && ipHourData.timestamp > hourAgo && ipHourData.count >= RATE_LIMITS.IP_PER_HOUR) {
            return { allowed: false, reason: 'Rate limit exceeded: too many signups from this IP (hourly)' };
        }
        
        const ipDayData = this.ipDaily.get(ipHash);
        if (ipDayData && ipDayData.timestamp > dayAgo && ipDayData.count >= RATE_LIMITS.IP_PER_DAY) {
            return { allowed: false, reason: 'Rate limit exceeded: too many signups from this IP (daily)' };
        }
        
        if (domain) {
            const domainHash = this.hashKey(domain);
            const domainData = this.domainDaily.get(domainHash);
            if (domainData && domainData.timestamp > dayAgo && domainData.count >= RATE_LIMITS.DOMAIN_PER_DAY) {
                return { allowed: false, reason: 'Rate limit exceeded: too many signups from this email domain' };
            }
        }
        
        return { allowed: true };
    }
    
    recordSignup(ip, email) {
        const now = Date.now();
        const ipHash = this.hashKey(ip);
        const domain = this.extractDomain(email);
        
        const ipHour = this.ipHourly.get(ipHash) || { count: 0, timestamp: now };
        ipHour.count++;
        ipHour.timestamp = now;
        this.ipHourly.set(ipHash, ipHour);
        
        const ipDay = this.ipDaily.get(ipHash) || { count: 0, timestamp: now };
        ipDay.count++;
        ipDay.timestamp = now;
        this.ipDaily.set(ipHash, ipDay);
        
        if (domain) {
            const domainHash = this.hashKey(domain);
            const domainDay = this.domainDaily.get(domainHash) || { count: 0, timestamp: now };
            domainDay.count++;
            domainDay.timestamp = now;
            this.domainDaily.set(domainHash, domainDay);
        }
    }
}

const sybilLimiter = new SybilRateLimiter();

class TenantManager {
    constructor(pool) {
        this.pool = pool;
        this.rateLimiter = sybilLimiter;
    }
    
    checkSignupRateLimit(ip, email) {
        return this.rateLimiter.checkRateLimit(ip, email);
    }
    
    recordSuccessfulSignup(ip, email) {
        this.rateLimiter.recordSignup(ip, email);
    }

    async initializeCoreSchema() {
        const client = await this.pool.connect();
        try {
            // Core schema initialization - safe to run multiple times
            await client.query(`
                CREATE TABLE IF NOT EXISTS core.tenant_catalog (
                    id SERIAL PRIMARY KEY,
                    tenant_schema TEXT NOT NULL UNIQUE,
                    genesis_user_id INTEGER NOT NULL,
                    status TEXT DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(err => {
                // Ignore duplicate table errors on restart
                if (err.code !== '23505') throw err;
            });
            
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
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS core.user_email_to_tenant (
                    email TEXT UNIQUE NOT NULL,
                    tenant_id INTEGER NOT NULL,
                    tenant_schema TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `).catch(err => {
                // Ignore duplicate table errors on restart
                if (err.code !== '23505') throw err;
            });
            
            // Book sharing table - cross-tenant read access via email
            await client.query(`
                CREATE TABLE IF NOT EXISTS core.book_shares (
                    id SERIAL PRIMARY KEY,
                    book_fractal_id TEXT NOT NULL,
                    owner_email TEXT NOT NULL,
                    shared_with_email TEXT NOT NULL,
                    permission_level TEXT NOT NULL DEFAULT 'viewer',
                    invited_at TIMESTAMPTZ DEFAULT NOW(),
                    revoked_at TIMESTAMPTZ,
                    UNIQUE(book_fractal_id, shared_with_email)
                )
            `).catch(err => {
                if (err.code !== '23505') throw err;
            });
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_book_shares_shared_email 
                ON core.book_shares (shared_with_email) WHERE revoked_at IS NULL
            `).catch(() => {});
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_book_shares_book_id 
                ON core.book_shares (book_fractal_id) WHERE revoked_at IS NULL
            `).catch(() => {});
            
            console.log('✅ Book shares table initialized');
        } finally {
            client.release();
        }
    }

    async createTenant(userId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            // FIRST PRINCIPLES: Get next tenant ID, then register in catalog with correct schema name
            // This ensures CHECK constraint on tenant_schema pattern is satisfied from the start
            // NOTE: nextval() is not rolled back on ROLLBACK — sequence gaps are expected and acceptable.
            const idResult = await client.query(`SELECT nextval('core.tenant_catalog_id_seq') as id`);
            const tenantId = parseInt(idResult.rows[0].id);
            const schemaName = `tenant_${tenantId}`;
            
            // Register tenant in catalog with correct schema name (satisfies foreign key constraints)
            await client.query(`
                INSERT INTO core.tenant_catalog (id, tenant_schema, genesis_user_id, status)
                VALUES ($1, $2, $3, 'active')
            `, [tenantId, schemaName, userId]);
            
            // SECURITY: Validate schema name before interpolation
            if (!/^[a-z_][a-z0-9_]*$/i.test(schemaName)) {
                throw new Error(`Invalid schema name generated: ${schemaName}`);
            }
            
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
                    updated_at TIMESTAMP DEFAULT NOW(),
                    sort_order INTEGER DEFAULT 0
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
            
            // Create phone_to_book table for WhatsApp phone number mapping and join codes
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.phone_to_book (
                    id SERIAL PRIMARY KEY,
                    phone_number TEXT,
                    book_id INTEGER NOT NULL REFERENCES ${schemaName}.books(id) ON DELETE CASCADE,
                    join_code TEXT UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS phone_to_book_phone_book_idx 
                ON ${schemaName}.phone_to_book (phone_number, book_id)
                WHERE phone_number IS NOT NULL
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS phone_to_book_join_code_idx 
                ON ${schemaName}.phone_to_book (join_code)
            `);
            
            // Create audit_queries table for Nyan AI audit history
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schemaName}.audit_queries (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES ${schemaName}.users(id) ON DELETE CASCADE,
                    book_id INTEGER REFERENCES ${schemaName}.books(id) ON DELETE SET NULL,
                    rule_type TEXT NOT NULL,
                    language TEXT DEFAULT 'en',
                    input_messages JSONB NOT NULL,
                    result_status TEXT NOT NULL,
                    result_confidence NUMERIC(4,3),
                    result_reason TEXT,
                    result_data JSONB,
                    raw_response TEXT,
                    processing_time_ms INTEGER,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS audit_queries_user_idx 
                ON ${schemaName}.audit_queries (user_id, created_at DESC)
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS audit_queries_book_idx 
                ON ${schemaName}.audit_queries (book_id, created_at DESC)
            `);
            
            await client.query('COMMIT');
            return { tenantId, schemaName };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
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
                invite: result.rows[0] || null
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
        const client = await this.pool.connect();
        try {
            const emailDomain = email.split('@')[1]?.toLowerCase() || '';
            
            const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const last1h = new Date(Date.now() - 60 * 60 * 1000);
            
            const ipResult = await client.query(`
                SELECT COUNT(*) as count FROM core.tenant_creation_log 
                WHERE ip = $1 AND created_at > $2
            `, [ip, last24h]);
            const ipCount24h = parseInt(ipResult.rows[0]?.count || 0);
            
            const ipHourResult = await client.query(`
                SELECT COUNT(*) as count FROM core.tenant_creation_log 
                WHERE ip = $1 AND created_at > $2
            `, [ip, last1h]);
            const ipCountHour = parseInt(ipHourResult.rows[0]?.count || 0);
            
            const domainResult = await client.query(`
                SELECT COUNT(*) as count FROM core.tenant_creation_log 
                WHERE email LIKE $1 AND created_at > $2
            `, [`%@${emailDomain}`, last24h]);
            const domainCount = parseInt(domainResult.rows[0]?.count || 0);
            
            const disposableDomains = new Set([
                'tempmail.com', 'throwaway.com', 'guerrillamail.com', '10minutemail.com',
                'mailinator.com', 'yopmail.com', 'tempail.com', 'fakeinbox.com',
                'trashmail.com', 'discard.email', 'temp-mail.org'
            ]);
            
            const reasons = [];
            
            if (ipCountHour >= 3) {
                reasons.push(`Too many signups from this IP in the last hour (${ipCountHour}/3)`);
            }
            if (ipCount24h >= 5) {
                reasons.push(`Too many signups from this IP today (${ipCount24h}/5)`);
            }
            if (domainCount >= 10) {
                reasons.push(`Too many signups from @${emailDomain} today (${domainCount}/10)`);
            }
            if (disposableDomains.has(emailDomain)) {
                reasons.push(`Disposable email domain not allowed: @${emailDomain}`);
            }
            
            const allowed = reasons.length === 0;
            
            if (!allowed) {
                console.warn(`🚫 Sybil check failed for ${email} from ${ip}:`, reasons);
            }
            
            return { 
                allowed, 
                reasons,
                metrics: { ipCountHour, ipCount24h, domainCount }
            };
        } finally {
            client.release();
        }
    }

    async checkRateLimit(type, key, maxRequests = 10, windowMs = 60000) {
        const windowStart = new Date(Date.now() - windowMs);
        const client = await this.pool.connect();
        try {
            if (type === 'tenant_creation') {
                const result = await client.query(`
                    SELECT COUNT(*) as count FROM core.tenant_creation_log 
                    WHERE (email = $1 OR ip = $2) AND created_at > $3
                `, [key, key, windowStart]);
                const count = parseInt(result.rows[0]?.count || 0);
                
                const allowed = count < maxRequests;
                if (!allowed) {
                    console.warn(`⏱️ Rate limit exceeded for ${type}:${key} (${count}/${maxRequests})`);
                }
                return { allowed, count, limit: maxRequests };
            }
            
            return { allowed: true, count: 0, limit: maxRequests };
        } finally {
            client.release();
        }
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
