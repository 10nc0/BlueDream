'use strict';

const crypto = require('crypto');
const { DiscordOutpipe } = require('./discord');
const { EmailOutpipe } = require('./email');
const { WebhookOutpipe } = require('./webhook');
const { fetchMediaBytes } = require('./fetch-bytes');
const logger = require('../logger');

// User-facing type → class. Types map to a TRANSPORT (or an application of one):
//   webhook → HTTP POST transport (generic HMAC grammar by default)
//   discord → application of the webhook transport (DiscordOutpipe extends WebhookOutpipe)
//   email   → distinct transport (Resend/MIME)
// See lib/outpipes/base.js for the full transport-vs-grammar taxonomy.
const OUTPIPE_TYPES = {
    discord: DiscordOutpipe,
    email: EmailOutpipe,
    webhook: WebhookOutpipe
};

// Outpipe types that forward raw bytes to the subscriber.
// DiscordOutpipe renders CDN URLs natively — byte push would be redundant.
const BYTE_FORWARD_TYPES = new Set(['webhook', 'email']);

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
//
// mediaFetch: { buffer, contentType, byteLength } | null
//   Passed from routeUserOutput where bytes were fetched once for all outpipes.
//   Used only on the fast-path (in-memory). The outbox retry path re-fetches
//   independently so bytes are never serialised into the DB payload.
async function _writeOutboxJob(pool, capsuleWithId, tenantSchema, book, config, mediaFetch) {
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
        try {
            const pipe = createOutpipe(config);
            const deliveryOpts = _mediaOpts(mediaFetch, config);
            await pipe.deliver(capsuleWithId, deliveryOpts);
        } catch (deliverErr) {
            logger.error({ err: deliverErr }, '❌ Fallback direct delivery also failed');
        }
        return;
    }

    // Fast-path: try delivery immediately in the background.
    // mediaFetch buffer is passed in-memory — not stored in the outbox row.
    // The outbox retry path re-fetches from capsule.media_url independently.
    setImmediate(async () => {
        try {
            const pipe = createOutpipe(config);
            const deliveryOpts = _mediaOpts(mediaFetch, config);
            await pipe.deliver(capsuleWithId, deliveryOpts);
            await pool.query(
                `UPDATE core.outbox_jobs SET status = 'success', updated_at = NOW() WHERE id = $1`,
                [jobId]
            );
            logger.debug({ jobId, type: config.type }, '✅ Fast-path outbox delivery succeeded');
        } catch (err) {
            logger.debug({ jobId, err: err.message }, '📬 Fast-path failed — worker will retry');
        }
    });
}

// Build delivery options from an in-memory mediaFetch result.
// Only passed for BYTE_FORWARD_TYPES; discord uses CDN URLs natively.
function _mediaOpts(mediaFetch, config) {
    if (!mediaFetch || !BYTE_FORWARD_TYPES.has(config.type)) return {};
    return {
        mediaBuffer:      mediaFetch.buffer,
        mediaContentType: mediaFetch.contentType
    };
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

    // Fetch bytes once for all byte-capable outpipes — N subscribers, 1 GET.
    // Only triggered when there is a media_url AND at least one outpipe that
    // forwards bytes (webhook / email). Discord renders CDN URLs natively so
    // it doesn't need the buffer.
    const hasByteOutpipe = outpipes.some(c => BYTE_FORWARD_TYPES.has(c.type));
    let mediaFetch = null;
    if (capsule.media_url && hasByteOutpipe) {
        mediaFetch = await fetchMediaBytes(capsule.media_url);
        if (mediaFetch) {
            logger.info({
                byteLength: mediaFetch.byteLength,
                outpipeCount: outpipes.filter(c => BYTE_FORWARD_TYPES.has(c.type)).length
            }, '📦 Output #0n: bytes fetched once for byte-forward outpipes');
        }
    }

    // Attach a stable ID to this capsule for idempotency headers and outbox tracking
    const capsuleWithId = { ...capsule, id: capsule.id || crypto.randomUUID() };

    // Durable path: pool available → write outbox job + fast-path attempt
    if (pool && tenantSchema && book.fractal_id) {
        for (const config of outpipes) {
            await _writeOutboxJob(pool, capsuleWithId, tenantSchema, book, config, mediaFetch);
        }
        return;
    }

    // Fallback: no pool (shouldn't happen in production) — direct delivery
    logger.warn('📤 Output #0n: pool unavailable — falling back to direct delivery (no durability)');
    const results = await Promise.allSettled(
        outpipes.map(async config => {
            try {
                const pipe = createOutpipe(config);
                const deliveryOpts = { ...options, ..._mediaOpts(mediaFetch, config) };
                await pipe.deliver(capsuleWithId, deliveryOpts);
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
