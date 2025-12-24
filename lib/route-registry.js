'use strict';

const routeModules = [
    { name: 'auth', register: require('../routes/auth').registerAuthRoutes, priority: 1 },
    { name: 'books', register: require('../routes/books').registerBooksRoutes, priority: 2 },
    { name: 'inpipe', register: require('../routes/inpipe').registerInpipeRoutes, priority: 3 },
    { name: 'export', register: require('../routes/export').registerExportRoutes, priority: 4 },
    { name: 'prometheus', register: require('../routes/prometheus').registerPrometheusRoutes, priority: 5 },
    { name: 'nyan-ai', register: require('../routes/nyan-ai').registerNyanAIRoutes, priority: 6 }
];

function registerAllRoutes(app, deps, options = {}) {
    const logger = options.logger || console;
    const setDepsMiddleware = options.setDepsMiddleware;
    
    const sorted = [...routeModules].sort((a, b) => a.priority - b.priority);
    const registered = [];
    
    for (const route of sorted) {
        try {
            const result = route.register(app, deps);
            
            if (route.name === 'auth' && result && setDepsMiddleware) {
                setDepsMiddleware(result.requireAuth, result.requireRole);
            }
            
            registered.push(route.name);
        } catch (error) {
            logger.error(`Failed to register ${route.name} routes:`, error.message);
            throw error;
        }
    }
    
    logger.info(`📦 Modular routes registered: ${registered.join(', ')}`);
    return registered;
}

function getRouteStats() {
    return {
        totalModules: routeModules.length,
        modules: routeModules.map(r => r.name)
    };
}

module.exports = {
    registerAllRoutes,
    getRouteStats,
    routeModules
};
