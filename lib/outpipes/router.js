'use strict';

const { DiscordOutpipe } = require('./discord');
const { EmailOutpipe } = require('./email');
const { WebhookOutpipe } = require('./webhook');

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

async function routeUserOutput(capsule, options, book) {
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
        console.log('  ℹ️  No outpipes configured — skipping Output #0n');
        return;
    }

    console.log(`  📤 Routing to ${outpipes.length} outpipe(s)...`);

    const results = await Promise.allSettled(
        outpipes.map(async config => {
            try {
                const pipe = createOutpipe(config);
                await pipe.deliver(capsule, options);
                return { success: true, name: config.name || config.type };
            } catch (err) {
                console.error(`  ❌ Outpipe [${config.type}] "${config.name}" failed: ${err.message}`);
                return { success: false, name: config.name || config.type, error: err.message };
            }
        })
    );

    const succeeded = results.filter(r => r.value?.success).length;
    console.log(`  ✅ Output #0n: ${succeeded}/${outpipes.length} outpipe(s) delivered`);
}

module.exports = { routeUserOutput, validateOutpipeConfig, createOutpipe, OUTPIPE_TYPES };
