// Tenant Manager - Multi-tenant schema management
const crypto = require('crypto');
const logger = require('./logger');

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
        this._migrationRunner = null;
    }

    setMigrationRunner(runner) {
        this._migrationRunner = runner;
    }
    
    checkSignupRateLimit(ip, email) {
        return this.rateLimiter.checkRateLimit(ip, email);
    }
    
    recordSuccessfulSignup(ip, email) {
        this.rateLimiter.recordSignup(ip, email);
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

            // Apply all tenant migrations to the new schema
            if (this._migrationRunner) {
                await this._migrationRunner.applyTenantMigrations(schemaName, client);
            } else {
                logger.warn({ schema: schemaName }, 'Migration runner not set — using inline fallback');
                const { MigrationRunner } = require('./migration-runner');
                const fallback = new MigrationRunner(this.pool);
                await fallback.applyTenantMigrations(schemaName, client);
            }
            
            await client.query('COMMIT');
            return { tenantId, schemaName };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
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
                logger.warn({ email, ip, reasons }, '🚫 Sybil check failed');
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
                    logger.warn({ type, key, count, limit: maxRequests }, '⏱️ Rate limit exceeded');
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

}

module.exports = TenantManager;
