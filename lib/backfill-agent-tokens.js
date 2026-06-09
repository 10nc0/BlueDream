'use strict';

/**
 * One-shot boot-time backfill: sync existing tenant_N.books.agent_token_hash
 * values into core.book_registry.agent_token_hash so the token-based write
 * route (POST /api/agent/message) works for books whose tokens were generated
 * BEFORE migration 009 added the core column.
 *
 * Self-retiring: once a boot completes with zero tokens left to sync, a flag
 * row is written to core.boot_flags. Subsequent boots skip the full tenant
 * scan entirely (O(1) check). DELETE the flag row to force a re-run.
 *
 * Idempotent: only updates rows where core mirror is NULL but tenant has a
 * hash. Conflict handling: if two tenants somehow share a token hash
 * (statistically impossible with 256-bit keys, but the unique index would
 * reject it), the UPDATE silently skips the duplicate.
 */
const FLAG_KEY = 'backfill_agent_tokens';

async function backfillAgentTokens(pool, logger) {
    // --- self-retire fast-path ---
    try {
        const flagCheck = await pool.query(
            `SELECT 1 FROM core.boot_flags WHERE key = $1`,
            [FLAG_KEY]
        );
        if (flagCheck.rowCount > 0) {
            logger.debug('Agent token backfill: retired (flag set) — skipping');
            return;
        }
    } catch (err) {
        // boot_flags table not yet created — fall through and run the backfill
        if (err.code !== '42P01') {
            logger.warn({ err: err.message }, 'Agent token backfill: flag check failed — running anyway');
        }
    }

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
            // Write retirement flag — next boot will skip this scan entirely.
            try {
                await pool.query(
                    `INSERT INTO core.boot_flags (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
                    [FLAG_KEY]
                );
                logger.debug('Agent token backfill: retirement flag written');
            } catch (err) {
                logger.debug({ err: err.message }, 'Agent token backfill: could not write retirement flag (non-fatal)');
            }
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
