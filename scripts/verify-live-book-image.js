'use strict';
// Explicit, single-image operator check. Normal HTTP vision remains disabled.
// No private pixels, text, URLs, keys, emails or tokens are logged or saved.
const fs = require('node:fs');
const { Pool } = require('pg');
const { resolveDatabase } = require('../lib/db-resolver');
const media = require('../utils/book-evidence');
const vision = require('../utils/multimodal-book-audit');
const capacity = require('../utils/ai-capacity');

async function run() {
    const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
    const tenantId = Number(args.tenant), bookNumber = Number(args.book);
    const approved = Number(args['approved-spend']);
    if (!Number.isInteger(tenantId) || tenantId < 1 || !Number.isInteger(bookNumber) || bookNumber < 1 ||
        !(approved > 0 && approved <= 0.05)) throw new Error('Explicit tenant/book and approved-spend<=0.05 required.');
    const resolved = resolveDatabase({ skipHandshake: true });
    const db = new Pool(resolved.source === 'DATABASE_URL'
        ? { connectionString: resolved.connectionString, ssl: resolved.ssl, connectionTimeoutMillis: 5000, statement_timeout: 10000 }
        : { ...resolved.pgConfig, ssl: resolved.ssl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    const tenant = `tenant_${tenantId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let prepared;
    const summary = { scope: 'one-source-image-only', approvedMaxUsd: approved, model: vision.MODEL,
        generalFeatureEnabled: false, paidCalls: 0, inspected: 0 };
    try {
        const book = await media.authorizedBook(db, tenant, String(bookNumber));
        const user = (await db.query(`SELECT id FROM ${tenant}.users WHERE tenant_id=$1 AND role='admin' ORDER BY id LIMIT 1`, [tenantId])).rows[0];
        if (!user) throw new Error('No existing authorized tenant administrator.');
        const credentials = typeof book.output_credentials === 'string' ? JSON.parse(book.output_credentials) : book.output_credentials;
        const thread = credentials?.output_01?.thread_id;
        if (!thread) throw new Error('Book has no configured original-source thread.');
        const discordHeaders = { Authorization: `Bot ${process.env.THOTH_TOKEN}` };
        const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(thread)}/messages?limit=3`,
            { headers: discordHeaders, signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error('Authorized source metadata is unavailable.'), { status: response.status });
        const recent = await response.json();
        summary.metadataMessages = recent.length;
        const source = recent.find(msg => new Date(msg.timestamp) >= new Date(book.created_at) &&
            msg.attachments?.some(a => /^image\/(png|jpeg|webp)$/.test(a.content_type || '')));
        if (!source) throw new Error('No supported image in the latest three messages; no further scanning performed.');
        const attachment = source.attachments.find(a => /^image\/(png|jpeg|webp)$/.test(a.content_type || ''));
        if (attachment.size > 10 * 1024 * 1024) throw new Error('Selected source exceeds the byte ceiling.');
        const currentPolicy = capacity.configuration();
        const pricing = { inputUsdPerMillion: 0.5, outputUsdPerMillion: 2, imageTokens: 2490 };
        // Twenty-five percent above the verified catalogue price, constrained by
        // provider max_price and the user's explicit five-cent ceiling.
        const day = new Date().toISOString().slice(0, 10);
        const scopes = await db.query(`SELECT key,state FROM core.ai_capacity WHERE key=ANY($1::text[])`,
            [[`spend:${day}:global`, `spend:${day}:tenant:${tenant}`]]);
        const current = key => scopes.rows.find(row => row.key === key)?.state || { cost: 0, tokens: 0 };
        const ceiling = (usage, existing) => ({
            tokens: Math.min(existing?.tokens || Infinity, usage.tokens + 24000),
            usd: Math.min(existing?.usd || Infinity, usage.cost + approved)
        });
        const policy = { ...currentPolicy,
            global: ceiling(current(`spend:${day}:global`), currentPolicy.global),
            tenant: ceiling(current(`spend:${day}:tenant:${tenant}`), currentPolicy.tenant),
            models: { ...currentPolicy.models, [vision.MODEL]: pricing },
            bookVision: { enabled: true, model: vision.MODEL, contractApproved: true, dataHandlingApproved: true }
        };
        capacity.install(null, db);
        await capacity.withContext({ req: { userId: user.id, tenantSchema: tenant, body: {} },
            id: capacity.hash(`${tenant}:${book.id}:${source.id}:${attachment.id}:approved-live-image-test`),
            policy, audit: true, calls: 0, tokens: 0, outputs: 0, deadline: Date.now() + 60000,
            signal: controller.signal, requestMaxUsd: approved }, async () => {
            const ctx = capacity.context.getStore();
            const key = `test:${ctx.id}`;
            const previous = await capacity.auditKey(key);
            if (previous) { Object.assign(summary, previous, { reused: true }); return; }
            try {
                await capacity.admission('vision');
                await capacity.reserveAuditEnvelope(pricing);
                // This adapter can return only the metadata just read from the
                // authorized thread. It cannot follow model/client source URLs.
                const msg = { id: source.id, channelId: source.channel_id, createdAt: new Date(source.timestamp),
                    content: source.content, attachments: new Map(source.attachments.map(a => [a.id, {
                        id: a.id, name: a.filename, url: a.url, size: a.size, contentType: a.content_type
                    }])) };
                const thothBot = { ready: true, client: { channels: { fetch: async id => {
                    if (String(id) !== String(thread)) throw new Error('Source thread mismatch.');
                    return { messages: { fetch: async id => {
                        if (String(id) !== String(source.id)) throw new Error('Source message mismatch.');
                        return msg;
                    } } };
                } } } };
                const fresh = await media.resolveSource({ pool: db, tenant,
                    ref: { bookId: book.fractal_id, messageId: source.id, attachmentId: attachment.id, source: 'discord' }, thothBot });
                const raw = await media.download(fresh.url, { signal: controller.signal });
                const image = await media.decodeImage(raw, controller.signal);
                const meta = { id: `E-${capacity.hash(`${source.id}:${attachment.id}`).slice(0, 16)}-p1`,
                    bookId: book.fractal_id, bookName: book.name, messageId: source.id, attachmentId: attachment.id,
                    source: 'discord', page: 1, status: 'selected', hash: capacity.hash(raw) };
                prepared = { images: [{ ...image, id: meta.id, text: fresh.text || '', meta }],
                    evidence: [meta], available: 1, capped: true,
                    limitations: ['One selected image only; no complete-book coverage is claimed.'] };
                const prompt = 'Validate this one original image only. Briefly identify the document/evidence type and whether a non-personal heading or numeric field is legible. Do not reproduce personal names, identifiers, contact details, addresses or signatures. Cite the evidence ID. Do not infer full-book totals.';
                const started = Date.now();
                const answer = await vision.draft(prepared, prompt, 'You are a source-grounded document auditor. Keep this validation answer brief.', { signal: controller.signal });
                summary.draftLatencyMs = Date.now() - started;
                const checkerStarted = Date.now();
                const checked = await vision.verify(prepared, prompt, answer, { signal: controller.signal });
                Object.assign(summary, { checkLatencyMs: Date.now() - checkerStarted, inspected: checked.inspected,
                    coverage: checked.coverage, verdict: checked.verdict, needsHumanReview: checked.needsHumanReview,
                    structuredFindings: checked.findings.length, findingStatuses: checked.findings.map(f => f.status) });
                await capacity.auditKey(key, summary);
            } finally {
                summary.paidCalls = ctx.calls;
                summary.chargedTokens = ctx.envelopeTokens || 0;
                summary.chargedUsd = ctx.envelopeCost || 0;
                await capacity.finishAuditEnvelope();
                await capacity.auditFailed(key);
            }
        });
    } catch (error) {
        summary.error = error.code || 'LIVE_IMAGE_CHECK_UNAVAILABLE';
        summary.httpStatus = error.response?.status || error.status || null;
        summary.privateDataLogged = false;
    } finally {
        clearTimeout(timeout);
        if (prepared) prepared.images.length = 0;
        await db.end();
        fs.mkdirSync('generated-artifacts', { recursive: true });
        fs.writeFileSync('generated-artifacts/live-image-check.json', JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary, null, 2));
    }
}
run().catch(() => { console.error('Live image test failed before admission; no private details logged.'); process.exitCode = 1; });
