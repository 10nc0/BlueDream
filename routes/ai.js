const axios = require('axios');

function registerAiRoutes(app, deps) {
    const { pool, bots, helpers, logger } = deps;
    
    if (!bots) {
        logger.warn('AI routes: bots not yet available, skipping registration');
        return {};
    }
    
    const { idris: idrisBot, horus: horusBot } = bots;

    logger.info('AI routes module loaded (not yet integrated)');
    
    return {};
}

module.exports = { registerAiRoutes };
