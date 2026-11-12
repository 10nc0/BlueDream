'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const capacity = require('../utils/ai-capacity');
const capacityPool = require('./fixtures/ai-capacity-pool');
const { groqWithRetry } = require('../utils/groq-client');
const { fetchWithRetry } = require('../lib/fetch-retry');
const { publicAIError } = require('../lib/ai-errors');
const { LLM_MODEL, LLM_API_URL } = require('../config/llm');

const body = { model: LLM_MODEL, messages: [{ role: 'user', content: 'synthetic natural answer fixture' }], max_tokens: 16 };
const policy = { global: { usd: 1 }, maxConcurrency: 4,
    models: { [LLM_MODEL]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
const freshContext = () => ({ id: 'offline-request', calls: 0, tokens: 0, outputs: 0, policy });
const request = () => ({ data: body, config: { timeout: 1000 } });
const dbFailure = () => Object.assign(new Error('synthetic private driver message'), { code: '42P01' });
const globalCharge = db => [...db.ledger].find(([key]) => key.endsWith(':global'))?.[1].cost;

test('capacity transport failures do not duplicate paid inference', async t => {
    process.env.OPENROUTER_API_KEY = 'offline-fixture-not-a-real-key';
    const adapter = axios.defaults.adapter, nativeFetch = global.fetch;
    let calls = 0, fetchCalls = 0, fetchFailure = false;
    global.fetch = async () => {
        fetchCalls++;
        if (fetchFailure) throw new Error('unknown network outcome');
        return new Response('synthetic answer');
    };
    capacity.install(null, capacityPool());
    axios.defaults.adapter = async config => {
        calls++;
        return { config, status: 200, headers: {}, data: {
            choices: [{ message: { content: 'Natural provider fixture, unchanged.' } }],
            usage: { total_tokens: 8, prompt_tokens: 6, completion_tokens: 2 }
        } };
    };
    try {
        await t.test('admission failure makes zero provider calls and is not retried', async () => {
            calls = 0;
            const db = capacityPool();
            db.poolError = dbFailure();
            capacity.setDbPool(db);
            await capacity.withContext(freshContext(), async () => {
                await assert.rejects(groqWithRetry(request(), 3), error =>
                    error.code === 'AI_CAPACITY' && error.attempts === 1 && error.capacityOperation === 'admission');
            });
            assert.equal(calls, 0);
            assert.equal(db.connects, 1);
        });
        await t.test('successful inference followed by failed settlement keeps its charge and never retries', async () => {
            calls = 0;
            const db = capacityPool(), ctx = freshContext();
            db.beforeQuery = sql => { if (sql.startsWith('SELECT * FROM core.ai_reservations')) throw dbFailure(); };
            capacity.setDbPool(db);
            await capacity.withContext(ctx, async () => {
                await assert.rejects(groqWithRetry(request(), 3), error =>
                    error.capacityOperation === 'settlement' && error.providerCompleted &&
                    error.attempts === 1 && /usage could not be recorded/.test(publicAIError(error).message));
                await assert.rejects(groqWithRetry(request(), 3), e => e.providerCompleted);
            });
            assert.equal(calls, 1, 'caught settlement failures must also block subsequent calls in this request');
            const reservation = [...db.reservations.values()][0];
            assert.equal(reservation.settled, false);
            assert.equal(globalCharge(db), reservation.cost);
            assert.equal(ctx.accountingUncertain, true);
        });
        await t.test('a successful response remains unchanged and settles real usage once', async () => {
            const db = capacityPool(), ctx = freshContext();
            capacity.setDbPool(db);
            const response = await capacity.withContext(ctx, () => groqWithRetry(request(), 0));
            assert.equal(response.data.choices[0].message.content, 'Natural provider fixture, unchanged.');
            assert.equal([...db.reservations.values()][0].settled, true);
            assert.ok(Math.abs(globalCharge(db) - 8 / 1e6) < 1e-12);
            assert.equal(ctx.tokens, 8);
        });
        await t.test('native fetch settlement failure is not retried by the shared retry wrapper', async () => {
            fetchCalls = 0;
            const db = capacityPool();
            db.beforeQuery = sql => { if (sql.startsWith('SELECT * FROM core.ai_reservations')) throw dbFailure(); };
            capacity.setDbPool(db);
            await capacity.withContext(freshContext(), () => assert.rejects(fetchWithRetry(LLM_API_URL,
                { method: 'POST', body: JSON.stringify(body) }, { backoffMs: 0 }),
            e => e.code === 'AI_CAPACITY' && e.providerCompleted));
            assert.equal(fetchCalls, 1);
            assert.equal(db.connects, 3, 'admission, reservation, one settlement; no cleanup settlement retry');
            assert.equal([...db.reservations.values()][0].settled, false);
        });
        await t.test('unknown fetch network outcomes retain both spend and concurrency lease', async () => {
            fetchCalls = 0; fetchFailure = true;
            const db = capacityPool();
            capacity.setDbPool(db);
            await capacity.withContext(freshContext(), () => assert.rejects(fetch(LLM_API_URL,
                { method: 'POST', body: JSON.stringify(body) }), /unknown network outcome/));
            assert.equal(db.connects, 2, 'no settlement of an unknown network outcome');
            assert.equal([...db.reservations.values()][0].settled, false);
            fetchFailure = false;
        });
        await t.test('real budget denials roll back reservations and make no inference calls', async () => {
            calls = 0;
            const db = capacityPool(), ctx = freshContext();
            ctx.policy = { ...policy, global: { usd: 0.0000001 } };
            capacity.setDbPool(db);
            await capacity.withContext(ctx, () => assert.rejects(groqWithRetry(request(), 3),
                error => error.status === 429 && /budget exhausted/.test(publicAIError(error).message)));
            assert.equal(calls, 0);
            assert.equal(db.reservations.size, 0);
        });
        await t.test('uncertain child accounting cannot refund an audit envelope', async () => {
            const db = capacityPool(), ctx = freshContext();
            capacity.setDbPool(db);
            await capacity.withContext(ctx, async () => {
                await capacity.reserveAuditEnvelope({ inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
                const child = await capacity.reserve(body);
                db.beforeQuery = sql => { if (sql.startsWith('SELECT * FROM core.ai_reservations')) throw dbFailure(); };
                await assert.rejects(capacity.settle(child, { total_tokens: 8 }, { providerCompleted: true }));
                db.beforeQuery = undefined;
                await capacity.finishAuditEnvelope();
                assert.equal(db.reservations.get(ctx.envelope.id).settled, true);
                assert.equal(db.reservations.get(child.id).settled, false);
                assert.equal(globalCharge(db), ctx.envelope.cost, 'keep the full envelope charge, not partial known usage');
            });
        });
        await t.test('cancelled capacity acquisition cannot reach native fetch', async () => {
            const db = capacityPool(), ctx = freshContext(), controller = new AbortController();
            controller.abort();
            ctx.signal = controller.signal;
            fetchCalls = 0;
            capacity.setDbPool(db);
            await capacity.withContext(ctx, () => assert.rejects(fetch(LLM_API_URL,
                { method: 'POST', body: JSON.stringify(body) }), e => e.capacityReason === 'cancelled'));
            assert.equal(fetchCalls, 0);
            assert.equal(db.connects, 0);
        });
    } finally {
        axios.defaults.adapter = adapter;
        global.fetch = nativeFetch;
    }
});
