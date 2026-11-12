'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');
const capacity = require('../utils/ai-capacity');
const visual = require('../utils/multimodal-book-audit');
const media = require('../utils/book-evidence');
const context = require('../utils/audit-context');
const groq = require('../utils/groq-client');
const pipeline = require('../utils/dashboard-audit-pipeline');
const { createCanvas } = require('@napi-rs/canvas');

async function run() {
    // Synthetic credential only when none exists; transport is always mocked.
    if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = 'synthetic-fixture-not-a-credential';
    let visualFetches = 0, textCalls = 0, retries = false, invalidChecker = false;
    let textFinishReason = 'stop', textContent = 'Text evidence says IDR 1000.';
    const calls = [], cache = new Map();
    const book = { id: 1, fractal_id: 'book_t183_b4', name: 'Sensus TBM — synthetic example (t183-b4)', created_at: new Date('2025-01-01') };
    const pool = { query: async () => ({ rows: [book] }) };
    capacity.admission = async () => {};
    capacity.auditKey = async (key, result) => result ? cache.set(key, result) : cache.get(key);
    capacity.auditFailed = async () => {};
    capacity.recordAudit = async () => {};
    capacity.reserveAuditEnvelope = async () => {};
    capacity.finishAuditEnvelope = async () => {};
    const canvas = createCanvas(400, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 100);
    ctx.fillStyle = 'black'; ctx.font = '30px sans-serif'; ctx.fillText('Receipt: IDR 100', 10, 55);
    const png = canvas.toBuffer('image/png');
    const meta = { id: 'source-p1', bookId: book.fractal_id, bookName: book.name,
        messageId: '42', attachmentId: '9', source: 'db', page: 1, status: 'selected' };
    const prepared = { images: [{ data: png, mime: 'image/png', page: 1, id: meta.id,
        text: 'OCR: IDR 1000', meta }], evidence: [meta], available: 1, limitations: [], capped: false };
    const realSettings = visual.settings;
    const realConfiguration = capacity.configuration;
    capacity.configuration = () => ({});
    const realPrepare = visual.prepare;
    visual.prepare = async () => { visualFetches++; return prepared; };
    context.buildAuditContext = async () => ({
        books: [{ name: book.name, fractalId: book.fractal_id, totalMessages: 1 }],
        totalMessages: 1, sampledCount: 1,
        recentMessages: [{ id: '42', content: 'OCR: IDR 1000', timestamp: new Date().toISOString() }],
        allMessages: [], entityAggregates: {}
    });
    groq.groqWithRetry = async request => {
        textCalls++;
        assert(!JSON.stringify(request.data).includes('image_url'));
        return { data: { choices: [{ finish_reason: textFinishReason, message: { content: textContent } }] } };
    };
    pipeline.runDashboardAuditPipeline = async options => {
        if (retries) await options.llmCallFn('Correct this amount.', {});
        return { response: options.initialResponse, verified: true, needsHumanReview: false };
    };
    axios.post = async (url, body) => {
        calls.push(body);
        return { data: { model: visual.MODEL, choices: [{ message: { content: body.response_format
            ? invalidChecker ? 'not JSON' : JSON.stringify({ findings: [{ evidenceId: meta.id, claim: 'Amount is IDR 1000',
                status: 'contradicted', observed: 'Original amount is IDR 100' }] })
            : 'Amount is IDR 1000 [source-p1].' } }] } };
    };
    delete require.cache[require.resolve('../routes/nyan-ai/audit')];
    const app = express();
    app.use(express.json(), capacity.middleware);
    require('../routes/nyan-ai/audit').registerAuditRoutes(app, {
        pool, bots: {}, middleware: { requireAuth: (req, res, next) => {
            req.userId = 'fixture'; req.tenantSchema = 'tenant_183'; req.userRole = 'user'; next();
        } }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/nyan-ai/audit`;
    const post = async (body, query = 'fixture') => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, bookIds: [book.fractal_id], ...body }) });
        return { status: res.status, data: await res.json(), headers: res.headers };
    };
    try {
        assert.throws(realSettings, /not enabled/);
        retries = true;
        let result = await post({});
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.data.imageAudit.mode, 'text_only');
        assert.equal(result.data.includeImages, false);
        assert.equal(visualFetches, 0);
        assert.equal(calls.length, 0);
        assert.equal(textCalls, 2, 'Text corrective path must remain text-only');
        await post({});
        assert.equal(textCalls, 2, 'Idempotent retry must not bill twice');
        result = await post({ includeImages: false }, 'another text fixture');
        assert.equal(result.status, 200);
        assert.equal(visualFetches, 0);
        result = await post({ includeImages: 'true' }, 'invalid flag');
        assert.equal(result.status, 400);
        result = await post({ includeImages: true }, 'disabled vision');
        assert.equal(result.status, 503);
        assert.equal(visualFetches, 0);
        result = await post({ bookIds: ['book_t2_abc'] }, 'outside tenant');
        assert.equal(result.status, 403);
        capacity.configuration = () => ({
            global: { tokens: 1000000, usd: 100 }, tenant: { tokens: 1000000, usd: 100 },
            models: { [visual.MODEL]: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, imageTokens: 2490 } },
            bookVision: { enabled: true, model: visual.MODEL, contractApproved: true, dataHandlingApproved: true }
        });
        retries = false;
        result = await post({ includeImages: true }, 'Check the receipt amount');
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(calls.length, 2);
        for (const body of calls) {
            assert.equal(body.model, 'meta/muse-ember');
            assert.deepEqual(body.reasoning, { effort: body.response_format ? 'minimal' : 'low' });
            assert.equal(body.max_tokens, body.response_format ? 700 : 1600);
            const images = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');
            assert.equal(images.length, 1, 'Draft and separate checker must each see original pixels');
            assert(images[0].image_url.url.startsWith('data:image/png;base64,'));
            assert.equal(body.provider.zdr, true);
            assert.equal(body.provider.allow_fallbacks, false);
        }
        assert.equal(result.data.pipelineStatus.verified, false);
        assert.equal(result.data.needsHumanReview, true);
        assert.equal(result.data.imageAudit.findings[0].status, 'contradicted');
        assert(result.data.answer.includes('SOURCE DISCREPANCY'));
        // The route intentionally clears buffers; create a fresh isolated fixture.
        const copy = { ...prepared, images: [{ data: png, mime: 'image/png', page: 1, id: meta.id, text: '', meta }] };
        invalidChecker = true;
        let checked = await visual.verify(copy, 'amount?', '1000');
        assert.equal(checked.needsHumanReview, true);
        assert.equal(checked.inspected, 0);
        const savedPost = axios.post;
        axios.post = async () => ({ data: { choices: [{ finish_reason: 'length', message: {
            content: JSON.stringify({ findings: [{ evidenceId: meta.id, claim: '100', status: 'supported', observed: '100' }] })
        } }] } });
        checked = await visual.verify(copy, 'amount?', '100');
        assert.equal(checked.needsHumanReview, true, 'Truncated JSON must never verify a book');
        assert.equal(checked.coverage, 'visual_check_unavailable');
        await assert.rejects(visual.draft(copy, 'amount?', 'fixture'), /AI_RESPONSE_TRUNCATED/);
        axios.post = async () => ({ data: { choices: [{ message: { content: '', reasoning: 'private reasoning' } }] } });
        await assert.rejects(visual.draft(copy, 'amount?', 'fixture'), /AI_RESPONSE_EMPTY/);
        axios.post = savedPost;
        textFinishReason = 'length';
        result = await post({ includeImages: false }, 'truncated text fixture');
        assert.equal(result.status, 500, 'Truncated text must not become a successful audit');
        textFinishReason = 'stop';
        textContent = '';
        result = await post({ includeImages: false }, 'empty text fixture');
        assert.equal(result.status, 500, 'Empty text must not become a successful audit');
        assert.throws(() => visual.parseFindings('{"findings":[{"evidenceId":"poisoned","status":"supported","claim":"x","observed":"x"}]}', copy), /Invalid/);
        assert.throws(() => visual.parseFindings('{"findings":[]}', copy), /Invalid/);
        for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'https://cdn.discordapp.com.evil.test/attachments/a',
            'https://cdn.discordapp.com:8443/attachments/a', 'https://user@cdn.discordapp.com/attachments/a']) {
            assert.throws(() => media.allowedUrl(url));
        }
        await assert.rejects(media.download('https://cdn.discordapp.com/attachments/a', {
            lookup: async () => [{ address: '127.0.0.1', family: 4 }]
        }), /Unsafe/);
        assert.equal(media.inScope({ timestamp: '2026-10-21T10:00:00Z', text: '', sender: '' },
            'receipts yesterday', new Date('2026-10-23T10:00:00Z'), 'Asia/Jakarta'), false);
        assert.equal(media.inScope({ timestamp: '2026-10-22T10:00:00Z', text: '', sender: '' },
            'receipts yesterday', new Date('2026-10-23T10:00:00Z'), 'Asia/Jakarta'), true);
        assert.deepEqual(media.imageDimensions(png), { width: 400, height: 100 });
        const decoded = await media.decodeImage(png);
        assert.equal(decoded.width, 400);
        assert.throws(() => media.imageDimensions(Buffer.from('<svg/>')), /Unsupported/);
        const huge = Buffer.from(png); huge.writeUInt32BE(200000, 16);
        await assert.rejects(media.decodeImage(huge), /outside processing limits/);
        assert.throws(() => capacity.estimate({ messages: [{ content: [{ type: 'image_url' }] }] }), /approved image/);
        const estimate = capacity.estimate({ messages: [{ content: [{ type: 'image_url' }] }], max_tokens: 100 }, { imageTokens: 2490 });
        assert.equal(estimate.tokens, 2622);
        const imageOnlyPool = { query: async sql => ({ rows: sql.includes('FROM tenant_183.books') ? [book]
            : Array.from({ length: 51 }, (_, i) => ({ id: i, sender_name: 'fixture', body: '',
                recorded_at: new Date(), media_url: `https://cdn.discordapp.com/attachments/1/${i}/image.png` })) }) };
        const found = await media.discover({ pool: imageOnlyPool, tenant: 'tenant_183',
            bookIds: [book.fractal_id], query: 'receipts', now: new Date() });
        assert.equal(found.candidates.length, 50);
        assert.equal(found.capped, true);
        // Three vector pages, generated in memory; exercise real bounded PDF rendering.
        const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
        for (let n = 0; n < 3; n++) {
            const stream = `BT /F1 24 Tf 72 720 Td (Synthetic receipt page ${n + 1}) Tj ET`;
            objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + n * 2} 0 R >>`,
                `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
        }
        objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
        let pdf = '%PDF-1.4\n', offsets = [0];
        objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
        const xref = Buffer.byteLength(pdf);
        pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
        pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
        pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
        const rendered = await media.render(Buffer.from(pdf), 3);
        assert.equal(rendered.total, 3);
        assert.equal(rendered.images.length, 1);
        assert.equal(rendered.images[0].page, 3);
        assert(rendered.images[0].height <= 1201);
        console.log('Book vision: off/omitted/invalid/retry, mode-separated idempotency, tenant, originals in both passes, OCR disagreement, malformed checker, SSRF, scope and media limits passed.');
    } finally {
        visual.settings = realSettings;
        capacity.configuration = realConfiguration;
        visual.prepare = realPrepare;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
