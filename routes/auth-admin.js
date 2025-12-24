const bcrypt = require('bcrypt');
const crypto = require('crypto');

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
                req.tenantSchema = `tenant_${decoded.tenantId}`;
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

function registerAuthAdminRoutes(app, deps) {
    const { pool, authService, tenantManager, helpers, logger } = deps;
    const { logAudit, noCacheHeaders, getTimestamp, createSessionRecord, getAllTenantSchemas, getGlobalWebhook, saveGlobalWebhook } = helpers;
    
    const { requireAuth, requireRole } = createAuthMiddleware(pool, authService, logger);

    // ============ AUTHENTICATION ROUTES ============
    
    app.get('/api/auth/status', async (req, res) => {
        noCacheHeaders(res);
        
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                const decoded = authService.verifyToken(token);
                
                if (decoded && decoded.type === 'access') {
                    const mappingResult = await pool.query(
                        'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                        [decoded.email]
                    );
                    
                    if (mappingResult.rows.length > 0) {
                        const { tenant_schema } = mappingResult.rows[0];
                        const result = await pool.query(
                            `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                            [decoded.userId]
                        );
                        
                        if (result.rows.length > 0) {
                            return res.json({ authenticated: true, user: result.rows[0], authMethod: 'jwt' });
                        }
                    }
                }
            }
            
            if (req.session && req.session.userId && req.session.userEmail) {
                const mappingResult = await pool.query(
                    'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [req.session.userEmail]
                );
                
                if (mappingResult.rows.length > 0) {
                    const { tenant_schema } = mappingResult.rows[0];
                    const result = await pool.query(
                        `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                        [req.session.userId]
                    );
                    
                    if (result.rows.length > 0) {
                        return res.json({ authenticated: true, user: result.rows[0], authMethod: 'cookie' });
                    }
                }
            }
            
            res.json({ authenticated: false });
        } catch (error) {
            logger.error({ err: error }, 'Auth status error');
            res.json({ authenticated: false });
        }
    });

    logger.info('Auth-Admin routes registered (factory pattern)');
    
    return { requireAuth, requireRole };
}

module.exports = { registerAuthAdminRoutes, createAuthMiddleware };
