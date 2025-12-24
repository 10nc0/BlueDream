const axios = require('axios');

function registerAiRoutes(app, deps) {
    const { pool, bots, helpers, logger } = deps;
    
    const idrisBot = bots?.idris;
    const horusBot = bots?.horus;
    const { noCacheHeaders } = helpers || {};

    app.get('/api/ai/status', async (req, res) => {
        if (noCacheHeaders) noCacheHeaders(res);
        
        res.json({
            status: 'operational',
            bots: {
                idris: idrisBot?.isReady() || false,
                horus: horusBot?.isReady() || false
            }
        });
    });

    logger.info('AI routes registered (factory pattern)');
    
    return {};
}

module.exports = { registerAiRoutes };
