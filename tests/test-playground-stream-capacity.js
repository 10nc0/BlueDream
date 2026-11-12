'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Readable } = require('node:stream');
const capacity = require('../utils/ai-capacity');
const capacityPool = require('./fixtures/ai-capacity-pool');
const { groqWithRetry } = require('../utils/groq-client');
const { LLM_MODEL } = require('../config/llm');

test('guarded streams reserve once, settle after complete output, and never replay interrupted paid work', async t => {
    const original = axios.defaults.adapter;
    const key = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'offline-fixture';
    const db = capacityPool();
    capacity.install(null, db);
    const policy = { maxConcurrency: 4, global: { usd: 1 },
        models: { [LLM_MODEL]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
    const context = () => ({ id: 'stream-fixture', calls: 0, tokens: 0, outputs: 0, policy });
    let calls = 0;
    const frame = object => `data: ${JSON.stringify(object)}\n\n`;
    const input = onDelta => ({
        data: { model: LLM_MODEL, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 64,
            stream: true, stream_options: { include_usage: true } },
        config: { responseType: 'stream', aiStream: { onDelta }, timeout: 1000 }
    });
    try {
        await t.test('successful stream keeps reservation unsettled until final usage arrives', async () => {
            axios.defaults.adapter = async config => {
                calls++;
                return { config, status: 200, data: Readable.from((async function* () {
                    yield Buffer.from(frame({ choices: [{ delta: { content: 'Visible draft' } }] }));
                    assert.equal([...db.reservations.values()].at(-1).settled, false);
                    yield Buffer.from(frame({ choices: [{ finish_reason: 'stop', delta: {} }] }));
                    yield Buffer.from(frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
                    yield Buffer.from('data: [DONE]\n\n');
                })()) };
            };
            let text = '';
            const result = await capacity.withContext(context(), () => groqWithRetry(input(delta => { text += delta; }), 3));
            assert.equal(text, 'Visible draft');
            assert.equal(result.data.usage.prompt_tokens, 12);
            assert.equal([...db.reservations.values()].at(-1).settled, true);
            assert.equal(calls, 1);
        });
        await t.test('missing terminal event retains the full reservation and has no paid retry', async () => {
            axios.defaults.adapter = async config => {
                calls++;
                return { config, status: 200, data: Readable.from([Buffer.from(frame({ choices: [{ delta: { content: 'Partial draft' } }] }))]) };
            };
            await assert.rejects(capacity.withContext(context(), () => groqWithRetry(input(() => {}), 3)),
                error => error.code === 'AI_STREAM_INCOMPLETE');
            assert.equal(calls, 2);
            assert.equal([...db.reservations.values()].at(-1).settled, false);
        });
        await t.test('unbounded stream entry points are rejected before transport', async () => {
            const request = input(() => {});
            delete request.config.aiStream;
            await assert.rejects(capacity.withContext(context(), () => groqWithRetry(request)),
                error => error.code === 'AI_CAPACITY');
            assert.equal(calls, 2);
        });
    } finally {
        axios.defaults.adapter = original;
        if (key === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = key;
    }
});
