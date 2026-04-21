const crypto = require('crypto');
const { isProd } = require('../config');
const { VALID_SCHEMA_PATTERN } = require('./validators');

const loginAttempts = new Map();
const LOGIN_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

function checkLoginRateLimit(namespace, key) {
    const compositeKey = `${namespace}:${key}`;
    const now = Date.now();
    const entry = loginAttempts.get(compositeKey);
    if (!entry || now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        return { allowed: true };
    }
    if (entry.count >= LOGIN_RATE_LIMIT.maxAttempts) {
        return { allowed: false };
    }
    return { allowed: true };
}

function recordFailedLogin(namespace, key) {
    const compositeKey = `${namespace}:${key}`;
    const now = Date.now();
    const entry = loginAttempts.get(compositeKey);
    if (!entry || now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        loginAttempts.set(compositeKey, { count: 1, firstAttempt: now });
    } else {
        entry.count++;
    }
}

function clearLoginAttempts(namespace, key) {
    loginAttempts.delete(`${namespace}:${key}`);
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts.entries()) {
        if (now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) loginAttempts.delete(key);
    }
}, 60000);

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function createAuthMiddleware(pool, authService, logger) {
    async function requireAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = authService.verifyToken(token);
            
            if (decoded && decoded.type === 'access') {
                req.userId = decoded.userId;
                req.userEmail = decoded.email;
                req.userRole = decoded.role;
                req.tenantId = decoded.tenantId;
                const candidateSchema = `tenant_${decoded.tenantId}`;
                if (!VALID_SCHEMA_PATTERN.test(candidateSchema)) {
                    logger.warn({ tenantId: decoded.tenantId }, 'JWT tenantId failed schema validation');
                    return res.status(401).json({ error: 'Invalid token claims' });
                }
                req.tenantSchema = candidateSchema;
                req.authMethod = 'jwt';
                return next();
            } else {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }
        }
        
        if (req.session && req.session.userId) {
            try {
                const mappingResult = await pool.query(
                    'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [req.session.userEmail]
                );
                
                if (mappingResult.rows.length === 0) {
                    return res.status(401).json({ error: 'User not found' });
                }
                
                const { tenant_id, tenant_schema } = mappingResult.rows[0];
                
                req.userId = req.session.userId;
                req.userEmail = req.session.userEmail;
                req.userRole = req.session.userRole;
                req.tenantId = tenant_id;
                req.tenantSchema = tenant_schema;
                req.authMethod = 'cookie';
                return next();
            } catch (error) {
                logger.error({ err: error }, 'Session auth error');
                return res.status(500).json({ error: 'Authentication failed' });
            }
        }
        
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login.html');
    }

    function requireRole(...allowedRoles) {
        return async (req, res, next) => {
            if (!req.userId || !req.tenantSchema) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const result = await pool.query(
                `SELECT role FROM ${req.tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            
            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            const userRole = result.rows[0].role;
            
            if (userRole === 'dev') {
                if (isProd) {
                    logger.warn({ userId: req.userId }, 'Dev role bypass blocked in production');
                    return res.status(403).json({ error: 'Dev role bypass not allowed in production' });
                }
                req.userRole = userRole;
                return next();
            }
            
            if (userRole === 'admin' && (allowedRoles.includes('admin') || allowedRoles.includes('user'))) {
                req.userRole = userRole;
                return next();
            }
            
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            
            req.userRole = userRole;
            next();
        };
    }

    return { requireAuth, requireRole };
}

module.exports = {
    checkLoginRateLimit,
    recordFailedLogin,
    clearLoginAttempts,
    hashToken,
    createAuthMiddleware
};
