'use strict';
// Opt-in synthetic evaluation. No tenant records, images or credentials are output.
const fs = require('node:fs');
const axios = require('axios');
const { Pool } = require('pg');
const { createCanvas } = require('@napi-rs/canvas');
const { resolveDatabase } = require('../lib/db-resolver');
const { getLLMBackend } = require('../config/constants');
const budget = require('../utils/ai-capacity');
const { MODEL } = require('../utils/multimodal-book-audit');
const { hash } = budget;
async function run() {
    const cfg = budget.configuration();
    if (cfg.bookVision?.evaluationApproved !== true || !cfg.global?.usd || !cfg.tenant?.usd ||
        !cfg.global?.tokens || !cfg.tenant?.tokens || !cfg.models?.[MODEL])
        throw new Error('Synthetic evaluation needs explicit evaluationApproved, current prices and central approved token/USD budgets.');
    const resolved = resolveDatabase({ skipHandshake: true });
    const db = new Pool(resolved.source === 'DATABASE_URL'
        ? { connectionString: resolved.connectionString, ssl: resolved.ssl }
        : { ...resolved.pgConfig, ssl: resolved.ssl });
    budget.install(null, db);
    const baseline = getLLMBackend();
    const rows = [];
    try {
        for (const [index, fixture] of [
            { label: 'agreement', original: '125000', extracted: '125000', expected: 'supported' },
            { label: 'wrong_ocr', original: '125000', extracted: '1250000', expected: 'contradicted' },
            { label: 'image_only', original: '85000', extracted: null, expected: 'supported' },
            { label: 'unreadable', original: null, extracted: '400000', expected: 'unreadable' }
        ].entries()) {
            await budget.withContext({ req: { aiApplication: 'synthetic-book-evaluation', body: {} },
                id: hash(fixture.label), audit: true, calls: 0, tokens: 0, outputs: 0, deadline: Date.now() + 60000 }, async () => {
                await budget.reserveAuditEnvelope(cfg.models[MODEL]);
                const canvas = createCanvas(1000, 300);
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 300);
                ctx.fillStyle = 'black'; ctx.font = fixture.original ? '64px sans-serif' : '3px sans-serif';
                ctx.fillText(`SYNTHETIC RECEIPT — IDR ${fixture.original || '??????'}`, 20, 150);
                const pixel = `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
                const prompt = `Synthetic evidence id E${index}. Extracted text: ${fixture.extracted || '(none)'}.
Return JSON {amount:string|null,status:supported|contradicted|unreadable|unsupported}.
Only trust visible source amounts; distinguish OCR disagreement and unreadability.`;
                try {
                    for (const [name, url, model, token, images] of [
                        ['text_baseline', baseline.url, baseline.model, process.env.NYANBOOK_AI_KEY, false],
                        ['vision', 'https://openrouter.ai/api/v1/chat/completions', MODEL, process.env.OPENROUTER_API_KEY, true]
                    ]) {
                        const start = Date.now();
                        try {
                            const response = await axios.post(url, {
                                model, max_tokens: 350, temperature: 0,
                                messages: [{ role: 'user', content: images
                                    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: pixel, detail: 'high' } }]
                                    : prompt }],
                                response_format: { type: 'json_object' },
                                ...(images ? { provider: { data_collection: 'deny', zdr: true, allow_fallbacks: false } } : {})
                            }, { timeout: 25000, headers: { Authorization: `Bearer ${token}` } });
                            let parsed;
                            try { parsed = JSON.parse(response.data?.choices?.[0]?.message?.content); } catch {}
                            rows.push({ fixture: fixture.label, candidate: name, model,
                                structured: !!parsed, correctAmount: fixture.original ? parsed?.amount === fixture.original : parsed?.amount == null,
                                detectedDisagreement: fixture.expected === 'contradicted' ? parsed?.status === 'contradicted' : null,
                                falseApproval: fixture.expected !== 'supported' && parsed?.status === 'supported',
                                humanReview: ['unreadable', 'unsupported', 'contradicted'].includes(parsed?.status),
                                latencyMs: Date.now() - start, usage: response.data?.usage || null });
                        } catch (err) {
                            rows.push({ fixture: fixture.label, candidate: name, model, unavailable: true,
                                status: err.response?.status || err.status || null, latencyMs: Date.now() - start });
                        }
                    }
                } finally { await budget.finishAuditEnvelope(); }
            });
        }
        const output = { kind: 'synthetic-only', at: new Date().toISOString(), fixtures: rows,
            limits: 'Three original pages; 10 MiB/source, 20 MiB fetched, 8 MiB encoded; 24k tokens/4k output/3calls/60s.',
            recommendation: 'Review measured accuracy, false approvals, prices and source-check contract before enabling private audits.' };
        fs.mkdirSync('generated-artifacts', { recursive: true });
        fs.writeFileSync('generated-artifacts/book-vision-evaluation.json', JSON.stringify(output, null, 2));
        console.log('Synthetic evaluation written to generated-artifacts/book-vision-evaluation.json. Private vision remains unchanged.');
    } finally { await db.end(); }
}
run().catch(err => { console.error({ error: err.code || 'EVALUATION_BLOCKED', message: err.code ? 'Evaluation could not finish.' : err.message }); process.exit(1); });
