'use strict';

const crypto = require('crypto');
const { DiscordOutpipe } = require('./discord');
const { EmailOutpipe } = require('./email');
const { WebhookOutpipe } = require('./webhook');
const { fetchMediaBytes } = require('./fetch-bytes');
const { DeliveryCoordinator, deliveryContext } = require('../ordered-inpipe');
const { isDeliveryAuthority } = require('../delivery-environment');
const { assertValidSchemaName } = require('../validators');

const OUTPIPE_TYPES = { discord: DiscordOutpipe, email: EmailOutpipe, webhook: WebhookOutpipe };

function createOutpipe(config) {
    const Cls = OUTPIPE_TYPES[config.type];
    if (!Cls) throw new Error(`Unknown outpipe type: ${config.type}`);
    return new Cls(config);
}
function validateOutpipeConfig(config) {
    const Cls = OUTPIPE_TYPES[config?.type];
    return Cls ? Cls.validateConfig(config)
        : { valid: false, error: `Unknown type: "${config?.type}". Allowed: ${Object.keys(OUTPIPE_TYPES).join(', ')}` };
}
function resolveOutpipes(book) {
    if (book.outpipes_user?.length) return book.outpipes_user;
    const hooks = book.output_credentials?.webhooks || [];
    if (hooks.length) return hooks.filter(w => w.url?.trim()).map(w => ({
        type: 'discord', url: w.url, name: w.name || 'Webhook'
    }));
    return book.output_0n_url?.trim()
        ? [{ type: 'discord', url: book.output_0n_url, name: 'Primary Webhook' }] : [];
}
const needsBytes = (pipe, config) => config.type === 'email' ||
    (config.type === 'webhook' && pipe.resolveGrammar() !== 'discord');

async function routeUserOutput(capsule, options = {}, book, { pool, tenantSchema } = {}) {
    const context = deliveryContext.getStore();
    if (!context) {
        if (!isDeliveryAuthority()) throw new Error('Development outbox delivery is disabled');
        if (!pool || !tenantSchema || !book.fractal_id) throw new Error('Durable delivery requires a pool and tenant/book identity');
        assertValidSchemaName(tenantSchema);
        if (!resolveOutpipes(book).length) return;
        if ((options.mediaBuffer || options.isMedia) && !capsule.media_url) {
            throw new Error('Durable media delivery requires a resolvable attachment reference');
        }
        // Admission, never publication. The normal queue processor is the only
        // executor; immediate and background callers cannot bypass its lease.
        const id = capsule.id || crypto.randomUUID();
        return new DeliveryCoordinator(pool).enqueue({
            channel: 'outbox',
            messageSid: JSON.stringify([tenantSchema, book.fractal_id, id]),
            msg: { phone: capsule.sender || 'book', tenantSchema, fractalId: book.fractal_id,
                body: capsule.text || '', hasMedia: !!capsule.media_url },
            rawPayload: { capsule: { ...capsule, id }, options: { isMedia: !!options.isMedia }, book },
            queuedAt: Date.now()
        });
    }

    // Freeze the accepted fan-out as well as its identity. Retries do not adopt
    // whichever destinations happen to be configured when media finishes.
    const plan = await context.memo('outpipePlan', () => ({
        capsule: { ...capsule, id: capsule.id || context.row.payload?.acceptance?.id || crypto.randomUUID() },
        configs: resolveOutpipes(book)
    }));
    const pending = plan.configs.map((config, i) => ({ config, i, pipe: createOutpipe(config) }))
        .filter(({ i }) => context.row.delivery_state.deliveries?.[`outpipe:${i}`]?.state !== 'done');
    const requiresBytes = pending.some(({ pipe, config }) => needsBytes(pipe, config));
    const media = requiresBytes && plan.capsule.media_url ? await fetchMediaBytes(plan.capsule.media_url) : null;
    for (const { config, i, pipe } of pending) {
        const deliveryOptions = { ...options, orderedStage: `outpipe:${i}`,
            ...(media && needsBytes(pipe, config) ? { mediaBuffer: media.buffer, mediaContentType: media.contentType } : {}) };
        if (pipe.resolveGrammar?.() === 'discord') {
            await pipe.deliver(plan.capsule, deliveryOptions);
        } else {
            await context.deliver(`outpipe:${i}`, () => pipe.deliver(plan.capsule, deliveryOptions),
                { singleMessage: true });
        }
    }
}

module.exports = { routeUserOutput, validateOutpipeConfig, createOutpipe };
