'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const axios = require('axios');
const { DeliveryCoordinator, OrderedInpipe, deliveryContext } = require('../lib/ordered-inpipe');
const { processQueuedMessage } = require('../lib/packet-queue');

function admissionRouter() {
    const file = require.resolve('../lib/outpipes/router');
    const nativeRequire = createRequire(file), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports,
        require: name => name === '../delivery-environment' ? { isDeliveryAuthority: () => true } : nativeRequire(name),
        Date, Buffer, console
    }, { filename: file });
    return module.exports;
}

test('ingestion and outbox share the exact coordinator implementation', () => {
    assert.equal(DeliveryCoordinator, OrderedInpipe);
});

test('identical content accepted at the same instant stays distinct without changing hashes or the proof format', () => {
    const { buildCapsule } = require('../utils/message-capsule');
    const input = { bookFractalId: 't1-b1', tenantId: 1, phone: 'sender',
        body: 'identical', timestamp: '2026-11-12T00:00:00.000Z', breatheCount: 42 };
    const first = buildCapsule({ ...input, acceptanceId: 'accepted-one' });
    const second = buildCapsule({ ...input, acceptanceId: 'accepted-two' });
    assert.notEqual(first.message_fractal_id, second.message_fractal_id);
    assert.equal(first.content_hash, second.content_hash);
    assert.equal(first.sender_hash, second.sender_hash);
    assert.equal(first.v, 2);
    assert.match(first.message_fractal_id, /^msg_t1_b42_[a-f0-9]{12}$/);
    assert.deepEqual(buildCapsule(input), buildCapsule(input), 'legacy derivation remains deterministic');
});

test('non-ordered publication only admits durable work; a database error never falls back to sending', async () => {
    const { routeUserOutput } = admissionRouter();
    const original = axios.post;
    axios.post = async () => { throw Error('Ownership bypass'); };
    const pool = { async connect() { throw Error('fixture DB unavailable'); } };
    try {
        await assert.rejects(routeUserOutput({ text: 'same' }, {}, {
            fractal_id: 't1-b1', outpipes_user: [{ type: 'discord', url: 'https://discord.com/api/webhooks/fixture' }]
        }, { pool, tenantSchema: 'tenant_1' }), /DB unavailable/);
    } finally { axios.post = original; }
});

test('generic HTTP receipts and frozen destinations survive a restart without replay', async () => {
    const queue = new DeliveryCoordinator({});
    queue.checkpoint = async (row, state) => { row.delivery_state = structuredClone(state); };
    const row = { id: 1, payload: { acceptance: { id: 'accepted-event' } }, delivery_state: {} };
    const { routeUserOutput } = require('../lib/outpipes/router');
    const original = axios.post;
    let posts = 0;
    axios.post = async () => { posts++; return { status: 202, data: {} }; };
    try {
        const book = { outpipes_user: [{ type: 'webhook', url: 'https://example.com/first' }] };
        await queue.run(row, () => routeUserOutput({ text: 'hello' }, {}, book));
        assert.equal(row.delivery_state.deliveries['outpipe:0'].receipt.status, 202);
        assert.equal(row.delivery_state.outpipePlan.capsule.id, 'accepted-event');
        await queue.run(structuredClone(row), () => routeUserOutput({ text: 'changed' }, {},
            { outpipes_user: [{ type: 'webhook', url: 'https://example.com/reconfigured' }] }));
        assert.equal(posts, 1);
    } finally { axios.post = original; }
});

test('outbox dispatch requires owned work and a matching book snapshot', async () => {
    const queue = new DeliveryCoordinator({});
    queue.checkpoint = async (row, state) => { row.delivery_state = state; };
    await assert.rejects(processQueuedMessage({}, {}, null, {}, 'outbox'), /ownership/);
    await assert.rejects(queue.run({ id: 1, delivery_state: {} }, () =>
        processQueuedMessage({ tenantSchema: 'tenant_1', fractalId: 'one' },
            { book: { fractal_id: 'two' } }, null, {}, 'outbox')), /mismatch/);
});

test('known chunk receipts retain attachment references while uncertain sends hold', async () => {
    const queue = new DeliveryCoordinator({});
    queue.checkpoint = async (row, state) => { row.delivery_state = structuredClone(state); };
    const row = { id: 3, delivery_state: {} };
    let sends = 0;
    const work = async () => {
        const context = deliveryContext.getStore();
        await context.deliver('a', async () => {
            sends++; return { data: { id: 'receipt', attachments: [{ url: 'https://cdn.discordapp.com/video.mp4' }] } };
        }, { requireReceipt: true });
        await context.deliver('b', async () => { throw Error('unknown transport outcome'); });
    };
    await assert.rejects(queue.run(row, work), /unknown transport/);
    await assert.rejects(queue.run(structuredClone(row), work), /Publication outcome unknown/);
    assert.equal(sends, 1);
    assert.match(row.delivery_state.deliveries.a.receipt.data.attachments[0].url, /video/);
});
