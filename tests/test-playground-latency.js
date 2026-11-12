'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { consumeCompletionStream } = require('../lib/llm-stream');
const { canStreamDraft } = require('../lib/playground-latency');
const { bridgeQueryDeterministic } = require('../utils/grammar-bridge');
const { runPublicResearch } = require('../utils/playground-research');
const { SearchKernel } = require('../lib/tools/search-kernel');
// The existing memory manager owns a service cleanup interval. Do not let it
// keep this isolated offline test process alive.
const originalInterval = global.setInterval;
global.setInterval = (...args) => originalInterval(...args).unref();
const { isSessionFirstQuery, markSessionNyanBooted, clearSessionMemory } = require('../utils/context-extractor');
global.setInterval = originalInterval;

const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const delta = text => ({ choices: [{ delta: { content: text } }] });
const end = { choices: [{ finish_reason: 'stop', delta: {} }] };

test('visible SSE content streams once, handles split UTF8/CRLF and never forwards reasoning', async () => {
    const bytes = Buffer.from(event({ choices: [{ delta: { reasoning: 'secret' } }] }) +
        event(delta('A 猫 answer')) + event(end) + event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }) + 'data: [DONE]\r\n\r\n');
    const chunks = [...bytes].map(value => Buffer.from([value]));
    let content = '';
    const result = await consumeCompletionStream(Readable.from(chunks), { onDelta: text => { content += text; } });
    assert.equal(content, 'A 猫 answer');
    assert.equal(result.usage.completion_tokens, 8);
    assert.equal(result.choices[0].message.content, content);
});

test('malformed, truncated and interrupted streams cannot complete a draft', async () => {
    for (const text of [event(delta('partial')), 'data: invalid\n\n',
        event(delta('partial')) + event({ choices: [{ finish_reason: 'length' }] }) + 'data: [DONE]\n\n']) {
        await assert.rejects(consumeCompletionStream(Readable.from([Buffer.from(text)])),
            error => ['AI_STREAM_INVALID', 'AI_STREAM_INCOMPLETE', 'AI_RESPONSE_TRUNCATED'].includes(error.code));
    }
    await assert.rejects(consumeCompletionStream(Readable.from([Buffer.alloc(32)]), { maxBytes: 16 }),
        error => error.code === 'AI_STREAM_INVALID');
});

test('abort destroys transport and produces no further visible deltas', async () => {
    const controller = new AbortController();
    const stream = new Readable({ read() {} });
    const work = consumeCompletionStream(stream, { signal: controller.signal, onDelta: () => assert.fail('late content') });
    controller.abort(new Error('caller stopped'));
    await assert.rejects(work, /caller stopped/);
    assert.equal(stream.destroyed, true);
});

test('strict surfaces, attachments, retries and high-risk follow-ups stay audit gated', () => {
    const state = { mode: 'general', retryCount: 0, preflight: {} };
    const input = { surface: 'playground', streaming: true, onDraftDelta() {}, query: 'Who represents Texas?' };
    assert.equal(canStreamDraft(state, input), true);
    for (const change of [{ surface: 'dashboard' }, { photos: [{}] }, { documents: [{}] },
        { extractedContent: ['private'] }, { query: 'What dose is safe?' },
        { history: [{ content: 'medical advice' }] }, { contextAttachments: { files: [{}] } }]) {
        assert.equal(canStreamDraft(state, { ...input, ...change }), false);
    }
    assert.equal(canStreamDraft({ ...state, mode: 'seed-metric' }, input), false);
    assert.equal(canStreamDraft({ ...state, retryCount: 1 }, input), false);
});

test('deterministic grammar preserves intent, explicit geo/time, language and lens', () => {
    const result = bridgeQueryDeterministic('buat laporan housing Singapore terkini', { finance: 1 });
    assert.equal(result.intent, 'C');
    assert.equal(result.context.geo, 'Singapore');
    assert.equal(result.context.time, 'current');
    assert.equal(result.sessionLens.finance, 1);
    assert.equal(result.sessionLens['real-estate'], 1);
    assert.equal(bridgeQueryDeterministic('東京の歴史').context.language, 'ja');
    assert.match(bridgeQueryDeterministic('what about him?').subject, /him/);
});

test('existing discovery reads bounded sources without a paid selector or another search', async () => {
    let reads = 0;
    const timing = { values: {} };
    const result = await runPublicResearch({
        query: 'fixture', discovery: '   Source: https://example.org/news/a\n   Source: https://example.org/news/b',
        reader: { admitSources() {}, async read({ url }) { reads++; return { ok: true, finalUrl: url }; } },
        select: () => assert.fail('redundant selection'), search: () => assert.fail('redundant search'), timing
    });
    assert.equal(reads, 1);
    assert.equal(result.sourceUrls.length, 1);
    assert.equal(timing.values.selectorCalls, 0);
});

test('unhealthy provider is skipped until recovery and admits just one recovery probe', async () => {
    process.env.TINYFISH_API_KEY = 'fixture';
    const kernel = new SearchKernel();
    let calls = 0;
    kernel._load = () => {};
    kernel._resolveChain = () => ['tinyfish', 'ddg'];
    kernel._providers = { tinyfish: { execute: async () => { calls++; return null; } },
        ddg: { execute: async () => 'fixture evidence' } };
    await kernel.search({ query: 'fixture', tier: 'generic' });
    await kernel.search({ query: 'fixture', tier: 'generic' });
    assert.equal(calls, 1);
    kernel._health.tinyfish.until = 0;
    kernel._providers.tinyfish.execute = async () => { calls++; return 'recovered'; };
    assert.equal((await kernel.search({ query: 'fixture', tier: 'generic' })).provider, 'tinyfish');
    assert.equal(calls, 2);
    delete process.env.TINYFISH_API_KEY;
});

test('NYAN boot flag flips after success and does not resend full prompt on later turns', () => {
    const session = 'offline-latency-test';
    clearSessionMemory(session);
    assert.equal(isSessionFirstQuery(session), true);
    markSessionNyanBooted(session);
    assert.equal(isSessionFirstQuery(session), false);
    clearSessionMemory(session);
});
