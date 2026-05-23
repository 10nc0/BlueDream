'use strict';

const logger = require('./logger');

/**
 * One-shot boot-time normalization: rewrite legacy-flat output_credentials
 *   { thread_id, thread_name, ... }
 * into the canonical nested shape:
 *   { output_01: { type: 'thread', thread_id, thread_name, webhook_url }, ... }
 *
 * Idempotent: only touches books that have flat `thread_id` AND no `output_01`.
 * Pattern mirrors lib/backfill-agent-tokens.js.
 */
async function normalizeOutputCredentials(pool) {
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
        logger.info('✓ normalizeOutputCredentials: no legacy flat-shape books found');
    }
    return { rewritten: totalRewritten };
}

module.exports = { normalizeOutputCredentials };
