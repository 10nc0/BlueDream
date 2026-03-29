const { register: registerCrud } = require('./books/crud');
const { register: registerMessages } = require('./books/messages');
const { register: registerDrops } = require('./books/drops');
const { register: registerExport } = require('./books/export');
const { register: registerShares } = require('./books/shares');
const { register: registerAgent } = require('./books/agent');

function registerBooksRoutes(app, deps) {
    if (!deps.middleware?.requireAuth) {
        deps.logger.warn('Books routes: middleware not available, skipping registration');
        return {};
    }

    registerCrud(app, deps);
    registerMessages(app, deps);
    registerDrops(app, deps);
    registerExport(app, deps);
    registerShares(app, deps);
    registerAgent(app, deps);

    return { endpoints: 33 };
}

module.exports = { registerBooksRoutes };
