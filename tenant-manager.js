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
            const result = await client.query(`
                SELECT COALESCE(MAX(CAST(REPLACE(schema_name, 'tenant_', '') AS INTEGER)), 0) + 1 as next_id
                FROM information_schema.schemata
                WHERE schema_name LIKE 'tenant_%'
            `);
            
            const tenantId = result.rows[0].next_id;
            const schemaName = `tenant_${tenantId}`;
            
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
                    archived BOOLEAN DEFAULT FALSE,
                    fractal_id TEXT,
                    created_by_admin_id TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
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
