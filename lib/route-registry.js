'use strict';

const SATELLITE_META = {
    'auth': { emoji: '🔐', desc: 'lifecycle, sessions, JWT, audit trail', endpoints: 19 },
    'books': { emoji: '📚', desc: 'CRUD, drops, messages, search, tags', endpoints: 20 },
    'inpipe': { emoji: '📥', desc: 'Twilio webhook, media relay', endpoints: 1 },
    'export': { emoji: '📤', desc: 'book export, attachments', endpoints: 2 },
    'prometheus': { emoji: '🔮', desc: 'φ-auditor, history, multi-book context', endpoints: 4 },
    'nyan-ai': { emoji: '🌈', desc: 'playground, vision, audit bridge', endpoints: 5 }
};

const routeModules = [
    { name: 'auth', register: require('../routes/auth').registerAuthRoutes, priority: 1 },
    { name: 'books', register: require('../routes/books').registerBooksRoutes, priority: 2 },
    { name: 'inpipe', register: require('../routes/inpipe').registerInpipeRoutes, priority: 3 },
    { name: 'export', register: require('../routes/export').registerExportRoutes, priority: 4 },
    { name: 'prometheus', register: require('../routes/prometheus').registerPrometheusRoutes, priority: 5 },
    { name: 'nyan-ai', register: require('../routes/nyan-ai').registerNyanAIRoutes, priority: 6 }
];

function formatPulseLog(registered, phiStatus = 'online') {
    const timestamp = new Date().toISOString();
    const lines = [];
    
    lines.push(`🫀 PULSE │ ${timestamp} │ Vegapunk v2.0`);
    
    const lastIdx = registered.length - 1;
    registered.forEach((name, idx) => {
        const meta = SATELLITE_META[name] || { emoji: '📦', desc: 'unknown', endpoints: '?' };
        const prefix = idx === lastIdx ? '└─' : '├─';
        const paddedName = name.padEnd(10);
        const paddedCount = String(meta.endpoints).padStart(2);
        lines.push(`${prefix} ${meta.emoji} ${paddedName} (${paddedCount}) → ${meta.desc}`);
    });
    
    const satelliteEndpoints = registered.reduce((sum, name) => {
        return sum + (SATELLITE_META[name]?.endpoints || 0);
    }, 0);
    const kernelPages = 11;
    const totalEndpoints = satelliteEndpoints + kernelPages;
    
    lines.push(`📊 VITALS: ${totalEndpoints} endpoints │ ${registered.length} satellites + kernel(${kernelPages}) │ O(1) │ φ-rhythm: ${phiStatus}`);
    
    return lines.join('\n');
}

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
    
    console.log('\n' + formatPulseLog(registered, 'online') + '\n');
    
    return registered;
}

function getRouteStats() {
    const totalEndpoints = Object.values(SATELLITE_META).reduce((sum, m) => sum + m.endpoints, 0);
    return {
        totalModules: routeModules.length,
        totalEndpoints,
        modules: routeModules.map(r => r.name),
        meta: SATELLITE_META
    };
}

module.exports = {
    registerAllRoutes,
    getRouteStats,
    routeModules,
    SATELLITE_META,
    formatPulseLog
};
