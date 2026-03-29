const { registerAuditRoutes } = require('./nyan-ai/audit');
const { registerPlaygroundRoutes } = require('./nyan-ai/playground');
const { registerV1Routes } = require('./nyan-ai/v1');

const capacityManager = require('../utils/playground-capacity');
const usageTracker = require('../utils/playground-usage');

function registerNyanAIRoutes(app, deps) {
    registerAuditRoutes(app, deps);
    registerPlaygroundRoutes(app, deps);
    registerV1Routes(app, deps);

    return { endpoints: 15 };
}

module.exports = { registerNyanAIRoutes, capacityManager, usageTracker };
