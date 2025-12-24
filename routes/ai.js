const axios = require('axios');

function registerAiRoutes(app, deps) {
    const { pool, bots, helpers, logger } = deps;
    
    const idrisBot = bots?.idris;
    const horusBot = bots?.horus;

    logger.info('AI routes module loaded (factory pattern ready)');
    
    return {};
}

module.exports = { registerAiRoutes };
