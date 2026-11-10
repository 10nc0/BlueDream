const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Detect whether a SQL file opts into non-transactional statement-by-statement
 * execution (required for CREATE INDEX CONCURRENTLY, which cannot run inside a
 * transaction block — including the implicit transaction that PostgreSQL wraps
 * around multi-statement simple-query strings).
 *
 * Mark a migration file with the comment:
 *   -- @nontransactional
 * anywhere in its header to activate this mode.
 */
function isNontransactional(sql) {
    return /--\s*@nontransactional\b/i.test(sql);
}

/**
 * Split a SQL string into individual statements, respecting dollar-quoting
 * (e.g. DO $$ ... $$ blocks).  Returns only non-empty, non-comment-only
 * statements.
 */
function splitStatements(sql) {
    const statements = [];
    let current = '';
    let dollarTag = null;

    let i = 0;
    while (i < sql.length) {
        if (dollarTag === null) {
            // Check for start of a dollar-quoted block: $identifier$ or $$
            const dollarMatch = sql.slice(i).match(/^(\$[A-Za-z0-9_]*\$)/);
            if (dollarMatch) {
                dollarTag = dollarMatch[1];
                current += dollarTag;
                i += dollarTag.length;
                continue;
            }

            if (sql[i] === ';') {
                const stmt = current.trim();
                // Push if there is any non-comment, non-whitespace content
                if (stmt.replace(/--[^\n]*/g, '').trim().length > 0) {
                    statements.push(stmt);
                }
                current = '';
                i++;
                continue;
            }
        } else {
            // Inside a dollar-quoted block — look for the closing tag
            if (sql.slice(i).startsWith(dollarTag)) {
                current += dollarTag;
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
        }

        current += sql[i];
        i++;
    }

    // Trailing statement without a final semicolon
    const last = current.trim();
    if (last && last.replace(/--[^\n]*/g, '').trim()) {
        statements.push(last);
    }

    return statements.filter(s => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

class MigrationRunner {
    constructor(pool) {
        this.pool = pool;
        this.migrationsDir = path.join(__dirname, '..', 'migrations');
    }

    async run() {
        if (await this._isCurrent()) {
            logger.info('Core and tenant schemas up to date (complete-history fast-path)');
            return;
        }
        await this._bootstrap();
        await this._runCoreMigrations();
        await this._runAllTenantMigrations();
    }

    async _bootstrap() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS core;
            CREATE TABLE IF NOT EXISTS core.migrations (
                name TEXT PRIMARY KEY,
                completed_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS core.tenant_migrations (
                tenant_schema TEXT NOT NULL,
                name TEXT NOT NULL,
                completed_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (tenant_schema, name)
            )
        `);
    }

    async _isCurrent() {
        const present = await this.pool.query(`SELECT to_regclass('core.migrations') AS core,
            to_regclass('core.tenant_migrations') AS tenant,to_regclass('core.tenant_catalog') AS catalog`);
        if (!present.rows[0]?.core || !present.rows[0]?.tenant || !present.rows[0]?.catalog) return false;
        const core = this._readSqlFiles(path.join(this.migrationsDir, 'core')).map(f => f.name);
        const tenants = this._readSqlFiles(path.join(this.migrationsDir, 'tenant')).map(f => f.name);
        const result = await this.pool.query(`SELECT
            ARRAY(SELECT name FROM core.migrations) AS applied,
            NOT EXISTS (
                SELECT 1 FROM core.tenant_catalog tc CROSS JOIN unnest($1::text[]) AS expected(name)
                LEFT JOIN core.tenant_migrations tm ON tm.tenant_schema=tc.tenant_schema AND tm.name=expected.name
                WHERE tm.name IS NULL OR to_regnamespace(tc.tenant_schema) IS NULL
            ) AS tenants_current`, [tenants]);
        return result.rows[0]?.tenants_current === true && core.every(name => result.rows[0].applied.includes(name));
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

    async _getAppliedTenant(schemaName, db = this.pool) {
        const result = await db.query(
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

            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query("SELECT pg_advisory_xact_lock(hashtext('nyanbook:core-migrations'))");
                const existing = await client.query('SELECT name FROM core.migrations WHERE name=$1', [file.name]);
                if (!existing.rowCount) {
                    logger.info({ migration: file.name }, '▶ Running core migration');
                    await client.query(file.sql);
                    await client.query('INSERT INTO core.migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file.name]);
                    count++;
                }
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally { client.release(); }
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
        if (!tableExists)
            throw Object.assign(new Error('Recorded migrations are inconsistent with the missing tenant catalog; restore or repair the database before serving.'), { code: 'MIGRATION_SCHEMA_MISSING' });

        const tenants = await this.pool.query(`SELECT tc.tenant_schema, to_regnamespace(tc.tenant_schema) IS NOT NULL AS schema_exists,
            EXISTS (SELECT 1 FROM core.tenant_migrations tm WHERE tm.tenant_schema=tc.tenant_schema) AS previously_migrated
            FROM core.tenant_catalog tc`);
        if (tenants.rows.length === 0) return;
        if (tenants.rows.some(row => row.schema_exists === false && row.previously_migrated === true))
            throw Object.assign(new Error('A catalogued tenant schema is missing; restore its data before serving.'), { code: 'MIGRATION_SCHEMA_MISSING' });

        const behindCount = await this.pool.query(`
            SELECT COUNT(DISTINCT tc.tenant_schema) AS behind
            FROM core.tenant_catalog tc
            CROSS JOIN unnest($1::text[]) AS expected(name)
            WHERE NOT EXISTS (
                SELECT 1 FROM core.tenant_migrations tm
                WHERE tm.tenant_schema = tc.tenant_schema AND tm.name = expected.name
            )
        `, [files.map(file => file.name)]);
        if (parseInt(behindCount.rows[0].behind) === 0) {
            logger.info({ tenants: tenants.rows.length }, 'Tenant schemas up to date (complete-history fast-path)');
            return;
        }

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

        // Ordinary boot migrations are serialized per tenant and committed
        // together with their tracking rows. Signup already supplies its own
        // transaction. Preserve the explicit nontransactional/index path.
        if (!client && !files.some(file => isNontransactional(file.sql))) {
            const connection = await this.pool.connect();
            try {
                await connection.query('BEGIN');
                const count = await this._applyTenantMigrations(schemaName, connection, files);
                await connection.query('COMMIT');
                return count;
            } catch (error) {
                await connection.query('ROLLBACK').catch(() => {});
                throw error;
            } finally { connection.release(); }
        }
        const db = client || this.pool;
        if (client) await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nyanbook:migrations:${schemaName}`]);
        const applied = await this._getAppliedTenant(schemaName, db);
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
            if (isNontransactional(sql)) {
                const stmts = splitStatements(sql);
                if (client) {
                    // In-transaction path (e.g. createTenant): the schema exists but
                    // isn't committed yet, so this.pool (a different connection) cannot
                    // see it.  Run statements on the transaction client instead, but
                    // strip CONCURRENTLY — it cannot run inside a transaction block.
                    // For new tenants the drops table is empty, so a standard
                    // CREATE INDEX is instant regardless.
                    logger.info({ migration: file.name, schema: schemaName, stmts: stmts.length }, '▶ Non-transactional migration (in-txn: CONCURRENTLY stripped)');
                    for (const stmt of stmts) {
                        await db.query(stmt.replace(/\bCONCURRENTLY\b/gi, ''));
                    }
                } else {
                    // Boot-time path: schema is already committed and visible.
                    // Run each statement individually on pool so CONCURRENTLY
                    // executes outside of any implicit transaction block.
                    logger.info({ migration: file.name, schema: schemaName, stmts: stmts.length }, '▶ Non-transactional migration — running statements individually on pool');
                    for (const stmt of stmts) {
                        await this.pool.query(stmt);
                    }
                }
            } else {
                await db.query(sql);
            }
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
