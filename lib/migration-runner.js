const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class MigrationRunner {
    constructor(pool) {
        this.pool = pool;
        this.migrationsDir = path.join(__dirname, '..', 'migrations');
    }

    async run() {
        await this._bootstrap();
        await this._runCoreMigrations();
        await this._runAllTenantMigrations();
    }

    async _bootstrap() {
        await this.pool.query('CREATE SCHEMA IF NOT EXISTS core');
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS core.migrations (
                name TEXT PRIMARY KEY,
                completed_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS core.tenant_migrations (
                tenant_schema TEXT NOT NULL,
                name TEXT NOT NULL,
                completed_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (tenant_schema, name)
            )
        `);
    }

    _readSqlFiles(dir) {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.sql'))
            .sort()
            .map(f => ({
                name: f,
                sql: fs.readFileSync(path.join(dir, f), 'utf8')
            }));
    }

    async _getAppliedCore() {
        const result = await this.pool.query('SELECT name FROM core.migrations');
        return new Set(result.rows.map(r => r.name));
    }

    async _getAppliedTenant(schemaName) {
        const result = await this.pool.query(
            'SELECT name FROM core.tenant_migrations WHERE tenant_schema = $1',
            [schemaName]
        );
        return new Set(result.rows.map(r => r.name));
    }

    async _runCoreMigrations() {
        const files = this._readSqlFiles(path.join(this.migrationsDir, 'core'));
        if (files.length === 0) return;

        const applied = await this._getAppliedCore();
        let count = 0;

        const isPreExisting = applied.size === 0 && await this._coreHasTables();

        for (const file of files) {
            if (applied.has(file.name)) continue;

            if (isPreExisting && file.name === '001_baseline.sql') {
                logger.info('⏭ Seeding core baseline record for pre-existing database');
                await this.pool.query(
                    'INSERT INTO core.migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
                    [file.name]
                );
                count++;
                continue;
            }

            logger.info({ migration: file.name }, '▶ Running core migration');
            await this.pool.query(file.sql);
            await this.pool.query(
                'INSERT INTO core.migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
                [file.name]
            );
            count++;
        }

        if (count > 0) {
            logger.info({ count }, '✅ Core migrations applied');
        } else {
            logger.info('Core schema up to date');
        }
    }

    async _runAllTenantMigrations() {
        const files = this._readSqlFiles(path.join(this.migrationsDir, 'tenant'));
        if (files.length === 0) return;

        let tableExists;
        try {
            const check = await this.pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'core' AND table_name = 'tenant_catalog'
                )
            `);
            tableExists = check.rows[0].exists;
        } catch (err) {
            logger.error({ err }, 'Failed to check tenant_catalog existence');
            throw err;
        }
        if (!tableExists) return;

        const tenants = await this.pool.query('SELECT tenant_schema FROM core.tenant_catalog');
        if (tenants.rows.length === 0) return;

        let totalApplied = 0;
        for (const tenant of tenants.rows) {
            const count = await this._applyTenantMigrations(tenant.tenant_schema, null, files);
            totalApplied += count;
        }

        if (totalApplied > 0) {
            logger.info({ totalApplied, tenants: tenants.rows.length }, '✅ Tenant migrations applied');
        } else {
            logger.info({ tenants: tenants.rows.length }, 'Tenant schemas up to date');
        }
    }

    async applyTenantMigrations(schemaName, client = null) {
        const files = this._readSqlFiles(path.join(this.migrationsDir, 'tenant'));
        return this._applyTenantMigrations(schemaName, client, files);
    }

    async _applyTenantMigrations(schemaName, client = null, files = null) {
        if (!files) {
            files = this._readSqlFiles(path.join(this.migrationsDir, 'tenant'));
        }
        if (files.length === 0) return 0;

        if (!/^tenant_\d+$/.test(schemaName)) {
            throw new Error(`Invalid tenant schema name: ${schemaName}`);
        }

        const db = client || this.pool;
        const applied = await this._getAppliedTenant(schemaName);
        let count = 0;

        const isPreExisting = applied.size === 0 && await this._schemaHasTables(schemaName, db);

        for (const file of files) {
            if (applied.has(file.name)) continue;

            if (isPreExisting && file.name === '001_baseline.sql') {
                logger.info({ schema: schemaName }, '⏭ Seeding baseline record for pre-existing tenant');
                await db.query(
                    'INSERT INTO core.tenant_migrations (tenant_schema, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [schemaName, file.name]
                );
                count++;
                continue;
            }

            const sql = file.sql.replace(/\$\{SCHEMA\}/g, schemaName);
            logger.info({ migration: file.name, schema: schemaName }, '▶ Running tenant migration');
            await db.query(sql);
            await db.query(
                'INSERT INTO core.tenant_migrations (tenant_schema, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [schemaName, file.name]
            );
            count++;
        }

        return count;
    }

    async _coreHasTables() {
        const result = await this.pool.query(
            `SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'core' AND table_name = 'tenant_catalog'
            )`
        );
        return result.rows[0].exists;
    }

    async _schemaHasTables(schemaName, db) {
        const result = await db.query(
            `SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = $1 AND table_name = 'users'
            )`,
            [schemaName]
        );
        return result.rows[0].exists;
    }
}

module.exports = { MigrationRunner };
