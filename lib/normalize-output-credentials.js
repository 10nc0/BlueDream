'use strict';

const logger = require('./logger');

/**
 * One-shot boot-time normalization: rewrite legacy-flat output_credentials
 *   { thread_id, thread_name, ... }
 * into the canonical nested shape:
 *   { output_01: { type: 'thread', thread_id, thread_name, webhook_url }, ... }
 *
 * Self-retiring: once a boot completes with zero rewrites, a flag row is
 * written to core.boot_flags. Subsequent boots skip the full tenant scan
 * entirely (O(1) check). DELETE the flag row to force a re-run.
 *
 * Idempotent: only touches books that have flat `thread_id` AND no `output_01`.
 */
const FLAG_KEY = 'normalize_output_credentials';

async function normalizeOutputCredentials(pool) {
    // --- self-retire fast-path ---
    try {
        const flagCheck = await pool.query(
            `SELECT 1 FROM core.boot_flags WHERE key = $1`,
            [FLAG_KEY]
        );
        if (flagCheck.rowCount > 0) {
            logger.debug('normalizeOutputCredentials: retired (flag set) — skipping');
            return { rewritten: 0 };
        }
    } catch (err) {
        // boot_flags table not yet created — fall through and run the normalizer
        if (err.code !== '42P01') {
            logger.warn({ err: err.message }, 'normalizeOutputCredentials: flag check failed — running anyway');
        }
    }

    let tenants;
    try {
        tenants = await pool.query(`SELECT tenant_schema FROM core.tenant_catalog WHERE status != 'deleted'`);
    } catch (err) {
        logger.debug('normalizeOutputCredentials: core.tenant_catalog not present yet — skipping');
        return { rewritten: 0 };
    }
    let totalRewritten = 0;

    for (const { tenant_schema } of tenants.rows) {
        try {
            const candidates = await pool.query(`
                SELECT id, output_credentials, output_01_url
                FROM ${tenant_schema}.books
                WHERE output_credentials ? 'thread_id'
                  AND NOT (output_credentials ? 'output_01')
            `);

            for (const row of candidates.rows) {
                const creds = row.output_credentials || {};
                const { thread_id, thread_name, ...rest } = creds;
                const nested = {
                    output_01: {
                        type: 'thread',
                        webhook_url: row.output_01_url || null,
                        thread_id,
                        thread_name: thread_name || null,
                        channel_id: null
                    },
                    ...rest
                };

                await pool.query(
                    `UPDATE ${tenant_schema}.books SET output_credentials = $1::jsonb WHERE id = $2`,
                    [JSON.stringify(nested), row.id]
                );
                totalRewritten++;
            }
        } catch (err) {
            logger.warn({ err: err.message, schema: tenant_schema }, '⚠️ normalizeOutputCredentials: tenant scan failed');
        }
    }

    if (totalRewritten > 0) {
        logger.info({ count: totalRewritten }, '🔧 Normalized legacy output_credentials → nested output_01 shape');
    } else {
        logger.debug('normalizeOutputCredentials: no legacy flat-shape books found');
        // Write retirement flag — next boot will skip this scan entirely.
        try {
            await pool.query(
                `INSERT INTO core.boot_flags (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
                [FLAG_KEY]
            );
            logger.debug('normalizeOutputCredentials: retirement flag written');
        } catch (err) {
            logger.debug({ err: err.message }, 'normalizeOutputCredentials: could not write retirement flag (non-fatal)');
        }
    }

    return { rewritten: totalRewritten };
}

module.exports = { normalizeOutputCredentials };
