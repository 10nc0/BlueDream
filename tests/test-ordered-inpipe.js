'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { OrderedInpipe } = require('../lib/ordered-inpipe');
const { routeUserOutput } = require('../lib/outpipes/router');
const { TwilioChannel } = require('../lib/channels/twilio');

test('ordered subscribers await publication and reuse checkpoints instead of outbox replay', async () => {
    const original = axios.post;
    const queue = new OrderedInpipe({ query() { throw new Error('Independent outbox must not be used'); } });
    queue.checkpoint = async (row, value) => { row.delivery_state = structuredClone(value); };
    const row = { id: 1, delivery_state: {} };
    const sent = [];
    axios.post = async (url, body) => { sent.push(body.content); return { data: { id: 'fixture' } }; };
    const book = { fractal_id: 'fixture', outpipes_user: [{ type: 'discord', url: 'https://discord.invalid/fixture' }] };
    const send = () => routeUserOutput({ text: '#A' }, {}, book, { pool: queue.pool, tenantSchema: 'fixture' });
    try {
        await queue.run(row, send);
        await queue.run(structuredClone(row), send);
        assert.deepEqual(sent, ['#A']);
        assert.equal(row.delivery_state.deliveries['outpipe:0:chunk:0'].state, 'done');
    } finally { axios.post = original; }
});

test('partial multi-chunk subscriber publication holds when the last chunk has an unknown outcome', async () => {
    const original = axios.post;
    const queue = new OrderedInpipe({});
    queue.checkpoint = async (row, value) => { row.delivery_state = structuredClone(value); };
    const row = { id: 2, delivery_state: {} };
    let calls = 0;
    axios.post = async () => {
        calls++;
        if (calls === 2) throw new Error('fixture network loss');
        return { data: { id: 'first-chunk' } };
    };
    const send = () => routeUserOutput({ text: 'a'.repeat(2500) }, {},
        { outpipes_user: [{ type: 'discord', url: 'https://discord.invalid/fixture' }] });
    try {
        await assert.rejects(queue.run(row, send), /fixture network loss/);
        assert.equal(row.delivery_state.deliveries['outpipe:0:chunk:0'].state, 'done');
        assert.equal(row.delivery_state.deliveries['outpipe:0:chunk:1'].state, 'started');
        await assert.rejects(queue.run(row, send), /unknown/);
        assert.equal(calls, 2, 'the already delivered first chunk must not be replayed');
    } finally { axios.post = original; }
});

test('a publication error swallowed by a handler still fails the queue lifecycle', async () => {
    const queue = new OrderedInpipe({});
    queue.checkpoint = async (row, value) => { row.delivery_state = value; };
    await assert.rejects(queue.run({ id: 3, delivery_state: {} }, async () => {
        const { orderedDelivery } = require('../lib/ordered-inpipe');
        try { await orderedDelivery('ledger', async () => { throw new Error('fixture network loss'); }); }
        catch { /* legacy handlers must not turn this into success */ }
    }), /fixture network loss/);
});

test('WhatsApp replies are disabled without constructing a sending client', async () => {
    const channel = new TwilioChannel({ logger: {} });
    channel.twilioHelper = { getTwilioClient() { throw new Error('Sending is not permitted'); } };
    assert.equal(await channel.sendReply('fixture', 'ignored'), false);
});

test('configured Discord subscriber retries a rate-limited mixed burst without holding later groups', async () => {
    const original = axios.post;
    const { deliveryContext } = require('../lib/ordered-inpipe');
    const queue = new OrderedInpipe({});
    queue.checkpoint = async (row, value) => { row.delivery_state = structuredClone(value); };
    const sequence = ['#A', 'photo A1', 'photo A2', 'video A', '#B', 'photo B'];
    const delivered = [];
    const book = { outpipes_user: [{ type: 'discord', url: 'https://discord.invalid/fixture' }] };
    let attempts = 0, rejectedAt, retryAt;
    axios.post = async () => {
        attempts++;
        if (attempts === 3) {
            rejectedAt = performance.now();
            throw { response: { status: 429, data: { retry_after: 0.01 } } };
        }
        if (attempts === 4) retryAt = performance.now();
        delivered.push(deliveryContext.getStore().row.fixtureText);
        return { data: { id: `accepted-${attempts}` } };
    };
    try {
        for (let i = 0; i < sequence.length; i++) {
            const row = { id: 10 + i, delivery_state: {}, fixtureText: sequence[i] };
            const options = sequence[i].startsWith('#') ? {} :
                { mediaBuffer: Buffer.from('fixture'), mediaContentType: i === 3 ? 'video/mp4' : 'image/png' };
            await queue.run(row, () => routeUserOutput({ text: sequence[i] }, options, book));
            assert.ok(Object.values(row.delivery_state.deliveries).every(value => value.state === 'done'));
        }
        assert.deepEqual(delivered, sequence);
        assert.equal(attempts, 7);
        assert.ok(retryAt - rejectedAt >= 8, 'honor the server delay before retrying the rejected chunk');
    } finally { axios.post = original; }
});

test('a later chunk rate limit retries that chunk only, not accepted earlier chunks', async () => {
    const original = axios.post;
    const queue = new OrderedInpipe({});
    queue.checkpoint = async (row, value) => { row.delivery_state = structuredClone(value); };
    let attempts = 0;
    const accepted = [];
    axios.post = async (url, payload) => {
        attempts++;
        if (attempts === 2) throw { response: { status: 429, data: { retry_after: 0 } } };
        accepted.push(payload.content);
        return { data: { id: `accepted-${attempts}` } };
    };
    const row = { id: 30, delivery_state: {} };
    try {
        await queue.run(row, () => routeUserOutput({ text: 'a'.repeat(2500) }, {},
            { outpipes_user: [{ type: 'discord', url: 'https://discord.invalid/fixture' }] }));
        assert.equal(attempts, 3);
        assert.deepEqual(accepted.map(text => text.length), [2000, 500]);
    } finally { axios.post = original; }
});

test('long rate-limit waits release the lease for a safe durable retry at the server deadline', async () => {
    const original = axios.post;
    let retryParams;
    const queue = new OrderedInpipe({ async query(sql, params) { retryParams = params; return { rows: [{ status: 'pending' }] }; } });
    queue.checkpoint = async (row, value) => { row.delivery_state = structuredClone(value); };
    axios.post = async () => { throw Object.assign(new Error('fixture rate limit'), { response: { status: 429, data: { retry_after: 90 } } }); };
    const row = { id: 40, retry_count: 0, delivery_state: {} };
    let error;
    try {
        try {
            await queue.run(row, () => routeUserOutput({ text: 'defer safely' }, {},
                { outpipes_user: [{ type: 'discord', url: 'https://discord.invalid/fixture' }] }));
        } catch (caught) { error = caught; }
        assert.equal(error.retryAfterMs, 90000);
        assert.equal(Object.values(row.delivery_state.deliveries).some(stage => stage.state === 'started'), false);
        assert.equal(await queue.retry(row, error), 'pending');
        assert.equal(retryParams[2], false, 'definite rejection must not become an uncertain-send hold');
        assert.equal(retryParams[5], 90000);
    } finally { axios.post = original; }
});
