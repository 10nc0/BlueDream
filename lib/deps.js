const logger = require('./logger');

const deps = {
    pool: null,
    tenantManager: null,
    authService: null,
    fractalId: null,
    
    constants: {
        NYANBOOK_LEDGER_WEBHOOK: null,
        LIMBO_THREAD_ID: null,
        HERMES_TOKEN: null
    },
    
    bots: {
        hermes: null,
        thoth: null,
        idris: null,
        horus: null
    },
    
    middleware: {
        requireAuth: null,
        requireRole: null
    },
    
    tenantMiddleware: {
        setTenantContext: null,
        getAllTenantSchemas: null,
        sanitizeForRole: null
    },
    
    helpers: {
        logAudit: null,
        noCacheHeaders: null,
        createSessionRecord: null
    },
    
    logger
};

function initialize(config) {
    if (config.pool) deps.pool = config.pool;
    if (config.tenantManager) deps.tenantManager = config.tenantManager;
    if (config.authService) deps.authService = config.authService;
    if (config.fractalId) deps.fractalId = config.fractalId;
    
    if (config.constants) {
        Object.assign(deps.constants, config.constants);
    }
    
    if (config.bots) {
        Object.assign(deps.bots, config.bots);
    }
    
    if (config.middleware) {
        Object.assign(deps.middleware, config.middleware);
    }
    
    if (config.tenantMiddleware) {
        Object.assign(deps.tenantMiddleware, config.tenantMiddleware);
    }
    
    if (config.helpers) {
        Object.assign(deps.helpers, config.helpers);
    }
    
    logger.info('⚙️ Dependencies initialized');
}

function setMiddleware(requireAuth, requireRole) {
    deps.middleware.requireAuth = requireAuth;
    deps.middleware.requireRole = requireRole;
    logger.debug('🔐 Auth middleware registered');
}

function get(key) {
    if (key) {
        return deps[key];
    }
    return deps;
}

module.exports = { deps, initialize, setMiddleware, get };
