const logger = require('./logger');
const { MigrationRunner } = require('./migration-runner');

function createDbInit(pool, tenantManager) {
    const runner = new MigrationRunner(pool);

    async function initializeDatabase() {
        try {
            await runner.run();
            logger.info('🗄️ Database initialized via migration runner');
        } catch (error) {
            logger.error({ err: error }, 'Database initialization error');
            throw error;
        }
    }

    async function initUsageTable() {
        // playground_usage is now in core baseline migration (001_baseline.sql)
        // kept as no-op for backward compat with callers
    }

    return { initializeDatabase, initUsageTable, migrationRunner: runner };
}

module.exports = { createDbInit };
