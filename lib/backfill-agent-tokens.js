'use strict';

/**
 * One-shot boot-time backfill: sync existing tenant_N.books.agent_token_hash
 * values into core.book_registry.agent_token_hash so the token-based write
 * route (POST /api/agent/message — Task #206) works for books whose tokens
 * were generated BEFORE migration 009 added the core column.
 *
 * Idempotent: only updates rows where core mirror is NULL but tenant has a
 * hash. Safe to run on every boot. Logs a single summary line.
 *
 * Conflict handling: if two tenants somehow share a token hash (statistically
 * impossible with 256-bit keys, but the unique index would reject it), the
 * UPDATE silently skips the duplicate and the summary count reflects only
 * successful syncs.
 */
async function backfillAgentTokens(pool, logger) {
    let totalSynced = 0;
    let tenantsScanned = 0;

    try {
        const { rows: tenants } = await pool.query(
            `SELECT tenant_schema FROM core.tenant_catalog WHERE status != 'deleted'`
        );

        for (const { tenant_schema: tenantSchema } of tenants) {
            if (!/^tenant_\d+$/.test(tenantSchema)) continue;
            tenantsScanned++;

            try {
                const { rows } = await pool.query(
                    `SELECT fractal_id, agent_token_hash
                     FROM ${tenantSchema}.books
                     WHERE agent_token_hash IS NOT NULL`
                );

                for (const { fractal_id, agent_token_hash } of rows) {
                    try {
                        const result = await pool.query(
                            `UPDATE core.book_registry
                             SET agent_token_hash = $1
                             WHERE fractal_id = $2 AND agent_token_hash IS NULL`,
                            [agent_token_hash, fractal_id]
                        );
                        if (result.rowCount > 0) totalSynced++;
                    } catch (err) {
                        if (err.code !== '23505') {
                            logger.warn({ err, fractal_id, tenantSchema }, 'Agent token backfill: per-row sync failed');
                        }
                    }
                }
            } catch (err) {
                if (err.code === '42P01' || err.code === '42703') continue;
                logger.warn({ err, tenantSchema }, 'Agent token backfill: tenant scan failed');
            }
        }

        if (totalSynced > 0) {
            logger.info({ totalSynced, tenantsScanned }, '🔑 Agent token backfill: synced existing tokens to core.book_registry');
        } else {
            logger.debug({ tenantsScanned }, 'Agent token backfill: nothing to sync (all tokens already in core)');
        }
    } catch (err) {
        if (err.code === '42P01') {
            logger.debug('Agent token backfill: core.tenant_catalog not present yet — skipping');
            return;
        }
        logger.warn({ err }, 'Agent token backfill: top-level failure (non-fatal)');
    }
}

module.exports = { backfillAgentTokens };
