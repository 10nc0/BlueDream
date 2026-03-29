'use strict';

const crypto = require('crypto');
const { DiscordOutpipe } = require('./discord');
const { EmailOutpipe } = require('./email');
const { WebhookOutpipe } = require('./webhook');
const logger = require('../logger');

const OUTPIPE_TYPES = {
    discord: DiscordOutpipe,
    email: EmailOutpipe,
    webhook: WebhookOutpipe
};

function createOutpipe(config) {
    const Cls = OUTPIPE_TYPES[config.type];
    if (!Cls) throw new Error(`Unknown outpipe type: ${config.type}`);
    return new Cls(config);
}

function validateOutpipeConfig(config) {
    const Cls = OUTPIPE_TYPES[config?.type];
    if (!Cls) {
        return { valid: false, error: `Unknown type: "${config?.type}". Allowed: ${Object.keys(OUTPIPE_TYPES).join(', ')}` };
    }
    return Cls.validateConfig(config);
}

function _getEndpoint(config) {
    return config.url || config.to || null;
}

// Hybrid outbox delivery for a single outpipe config.
// 1. Writes a durable outbox job (source of truth).
// 2. Immediately attempts fast-path delivery via setImmediate.
//    If it succeeds, the job is marked success before the worker polls.
//    If it fails, the job sits pending until the worker retries with backoff.
// next_attempt_at = +30s so the worker only picks it up if the fast path didn't finish.
async function _writeOutboxJob(pool, capsuleWithId, tenantSchema, book, config) {
    let jobId;
    try {
        const { rows } = await pool.query(
            `INSERT INTO core.outbox_jobs
                 (book_fractal_id, tenant_schema, capsule_id,
                  outpipe_type, outpipe_name, endpoint, payload, outpipe_config,
                  next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + interval '30 seconds')
             RETURNING id`,
            [
                book.fractal_id,
                tenantSchema,
                capsuleWithId.id,
                config.type,
                config.name || config.type,
                _getEndpoint(config),
                JSON.stringify(capsuleWithId),
                JSON.stringify(config)
            ]
        );
        jobId = rows[0].id;
    } catch (err) {
        logger.error({ err }, '❌ Failed to write outbox job — delivering directly as fallback');
        // Write failed: attempt delivery directly so the message isn't silently lost
        try {
            const pipe = createOutpipe(config);
            await pipe.deliver(capsuleWithId, {});
        } catch (deliverErr) {
            logger.error({ err: deliverErr }, '❌ Fallback direct delivery also failed');
        }
        return;
    }

    // Fast-path: try delivery immediately in the background
    setImmediate(async () => {
        try {
            const pipe = createOutpipe(config);
            await pipe.deliver(capsuleWithId, {});
            await pool.query(
                `UPDATE core.outbox_jobs SET status = 'success', updated_at = NOW() WHERE id = $1`,
                [jobId]
            );
            logger.debug({ jobId, type: config.type }, '✅ Fast-path outbox delivery succeeded');
        } catch (err) {
            // Worker will retry with backoff — just log and move on
            logger.debug({ jobId, err: err.message }, '📬 Fast-path failed — worker will retry');
        }
    });
}

async function routeUserOutput(capsule, options, book, { pool, tenantSchema } = {}) {
    let outpipes = [];

    if (book.outpipes_user && book.outpipes_user.length > 0) {
        outpipes = book.outpipes_user;
    } else {
        const webhooks = book.output_credentials?.webhooks || [];
        const url = book.output_0n_url;

        if (webhooks.length > 0) {
            outpipes = webhooks
                .filter(w => w.url?.trim())
                .map(w => ({ type: 'discord', url: w.url, name: w.name || 'Webhook' }));
        } else if (url?.trim()) {
            outpipes = [{ type: 'discord', url, name: 'Primary Webhook' }];
        }
    }

    if (outpipes.length === 0) {
        logger.debug('📤 Output #0n: no outpipes configured — skipping');
        return;
    }

    logger.debug({ count: outpipes.length }, '📤 Output #0n: routing to outpipes');

    // Attach a stable ID to this capsule for idempotency headers and outbox tracking
    const capsuleWithId = { ...capsule, id: capsule.id || crypto.randomUUID() };

    // Durable path: pool available → write outbox job + fast-path attempt
    if (pool && tenantSchema && book.fractal_id) {
        for (const config of outpipes) {
            await _writeOutboxJob(pool, capsuleWithId, tenantSchema, book, config);
        }
        return;
    }

    // Fallback: no pool (shouldn't happen in production) — direct delivery
    logger.warn('📤 Output #0n: pool unavailable — falling back to direct delivery (no durability)');
    const results = await Promise.allSettled(
        outpipes.map(async config => {
            try {
                const pipe = createOutpipe(config);
                await pipe.deliver(capsuleWithId, options);
                return { success: true, name: config.name || config.type };
            } catch (err) {
                logger.error({ outpipeType: config.type, outpipeName: config.name, err }, '❌ Outpipe delivery failed');
                return { success: false, name: config.name || config.type, error: err.message };
            }
        })
    );

    const succeeded = results.filter(r => r.value?.success).length;
    logger.info({ succeeded, total: outpipes.length }, '📤 Output #0n complete (direct)');
}

module.exports = { routeUserOutput, validateOutpipeConfig, createOutpipe };
