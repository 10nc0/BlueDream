const archiver = require('archiver');
const axios = require('axios');

function registerBooksRoutes(app, deps) {
    const { pool, bots, helpers, middleware, tenantMiddleware, logger } = deps;
    
    if (!middleware || !middleware.requireAuth) {
        logger.warn('Books routes: middleware not available, skipping registration');
        return {};
    }
    
    const { requireAuth, requireRole } = middleware;
    const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = tenantMiddleware || {};
    const { logAudit, noCacheHeaders, getTimestamp } = helpers || {};
    const hermesBot = bots?.hermes;
    const thothBot = bots?.thoth;

    logger.info('Books routes module loaded (factory pattern ready)');
    
    return {};
}

module.exports = { registerBooksRoutes };
