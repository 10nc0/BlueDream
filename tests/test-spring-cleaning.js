'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { OrderedInpipe, orderedDelivery } = require('../lib/ordered-inpipe');
const { bookSnapshot, requireMedia } = require('../lib/inpipe-preparation');
const { fetchMediaBytes, validateMediaUrl, MAX_MEDIA_BYTES } = require('../lib/outpipes/fetch-bytes');
const { OutboxWorker } = require('../lib/outpipes/worker');
const { routeUserOutput } = require('../lib/outpipes/router');
const { createSendToLedger } = require('../lib/discord-webhooks');
const { processQueuedMessage } = require('../lib/packet-queue');

const logger = { info() {}, warn() {}, error() {}, debug() {} };
function fixture() {
    const queue = new OrderedInpipe({});
    queue.checkpoint = async (row, state) => { row.delivery_state = structuredClone(state); };
    return { queue, row: { id: 7, delivery_state: {} } };
}

test('development outbox start, tick, delivery and pruning never access shared storage', async () => {
    const { isDeliveryAuthority } = require('../lib/delivery-environment');
    assert.equal(isDeliveryAuthority(), false, 'Run this test outside production only');
    const worker = new OutboxWorker();
    worker.setPool({ query() { throw new Error('shared database accessed'); } });
    worker.start(); assert.equal(worker._timer, null);
    await worker._tick(); await worker._processJobs(); await worker._prune();
    await worker._deliverJob({});
    worker.stop();
    await assert.rejects(routeUserOutput({}, {}, {}), /disabled/);
    const q = require('../lib/packet-queue');
    await q.recoverStaleProcessing(logger);
    await q.cleanupDoneMessages({ query() { throw Error('shared access'); } }, logger);
});

test('snapshot is read before mutable book lookup on retry', async () => {
    const { queue, row } = fixture();
    let lookups = 0;
    const load = () => bookSnapshot('book', async () => { lookups++; return { id: 1 }; });
    await queue.run(row, load);
    await queue.run(structuredClone(row), () => bookSnapshot('book', () => { throw Error('deleted'); }));
    assert.equal(lookups, 1);
    await assert.rejects(bookSnapshot('missing', async () => null), /unavailable/);
});

test('missing media is failure, never text-only success', async () => {
    await assert.rejects(requireMedia({ downloadMedia: async () => null }, { hasMedia: true }, {}), /unavailable/);
});

test('limbo media failure stops before any send and pending media is retained', async () => {
    const { queue, row } = fixture();
    const msg = { hasMedia: true, channel: 'twilio', phone: 'fixture' };
    const deps = { logger, pool: { query: async () => ({ rows: [] }) } };
    row.delivery_state.routing = { bookRecord: null };
    await assert.rejects(queue.run(row, () => processQueuedMessage(msg, {}, { downloadMedia: async () => null }, deps, 'twilio')), /unavailable/);
    row.delivery_state.routing = { bookRecord: { status: 'pending' } };
    await assert.rejects(queue.run(row, () => processQueuedMessage(msg, {}, {}, deps, 'twilio')), /Activate/);
});

test('missing active book and invalid generic schema hold rather than complete', async () => {
    const { queue, row } = fixture();
    row.delivery_state.routing = { bookRecord: { status: 'active', tenant_schema: 'tenant_123', fractal_id: 'fixture' } };
    const deps = { logger, pool: { query: async () => ({ rows: [] }) } };
    await assert.rejects(queue.run(row, () => processQueuedMessage({}, {}, {}, deps, 'twilio')), /unavailable/);
    await assert.rejects(queue.run(row, () => processQueuedMessage({ tenantSchema: 'bad!' }, {}, {}, deps, 'webhook')), /Invalid/);
});

test('ledger chunk retry reuses first receipt and rejects missing receipts', async () => {
    const { queue, row } = fixture();
    const original = axios.post;
    let sends = 0;
    const send = createSendToLedger({}, 'https://discord.com/api/webhooks/fixture');
    axios.post = async () => {
        sends++;
        if (sends === 2) throw { response: { status: 429, data: { retry_after: 90 } } };
        return { data: { id: String(sends) } };
    };
    try {
        await assert.rejects(queue.run(row, () => send({ content: 'x'.repeat(2500) })));
        assert.equal(row.delivery_state.deliveries['ledger:chunk:0'].state, 'done');
        await queue.run(row, () => send({ content: 'x'.repeat(2500) }));
        assert.equal(sends, 3);
        const other = fixture();
        axios.post = async () => ({ data: {} });
        await assert.rejects(other.queue.run(other.row, () => send({ content: 'no receipt' })), /receipt missing/);
        assert.equal(other.row.delivery_state.deliveries['ledger:chunk:0'].state, 'started');
    } finally { axios.post = original; }
});

test('nested activation checkpoints retain inner publication receipts', async () => {
    const { queue, row } = fixture();
    await queue.run(row, () => orderedDelivery('outer', async () => {
        await orderedDelivery('inner', async () => ({ data: { id: 'child' } }));
        return { data: { id: 'parent' } };
    }));
    assert.equal(row.delivery_state.deliveries.inner.receipt.data.id, 'child');
});

test('Discord video subscribers use pointers with zero media downloads', async () => {
    const { queue, row } = fixture();
    const post = axios.post, get = axios.get;
    const bodies = [];
    axios.get = async () => { throw Error('Redundant media download'); };
    axios.post = async (_url, body) => { bodies.push(body); return { data: { id: String(bodies.length) } }; };
    try {
        const book = { outpipes_user: [
            { type: 'discord', url: 'https://discord.com/api/webhooks/one' },
            { type: 'webhook', url: 'https://discord.com/api/webhooks/two' }
        ] };
        await queue.run(row, () => routeUserOutput({ text: '#video', media_url: 'https://cdn.discordapp.com/attachments/1/video.mp4?ex=123&hm=abc' }, {}, book));
        assert.equal(bodies.length, 2);
        assert.match(bodies[0].embeds[0].description, /video.mp4/);
    } finally { axios.post = post; axios.get = get; }
});

test('media URL permits signed CDN URLs but rejects private and credential destinations', () => {
    assert.ok(validateMediaUrl('https://cdn.discordapp.com/attachments/1/a.mp4?ex=1'));
    for (const url of ['http://127.0.0.1/a', 'http://[::1]/a', 'http://169.254.169.254/a',
        'http://user:pass@example.com/a', 'file:///etc/passwd', 'https://nyanbook.io/a']) {
        assert.throws(() => validateMediaUrl(url));
    }
});

test('media fetch rejects DNS rebinding and redirect to private destination', async () => {
    let calls = 0;
    await assert.rejects(fetchMediaBytes('https://example.com/a', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        get: async () => { calls++; }
    }), /not public/);
    assert.equal(calls, 0);
    await assert.rejects(fetchMediaBytes('https://example.com/a', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        get: async () => ({ status: 302, headers: { location: 'http://10.0.0.1/a' } })
    }), /not public/);
});

test('media fetch pins DNS, caps bytes and rejects HTML/oversized responses', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const media = await fetchMediaBytes('https://example.com/a', { lookup,
        get: async (_url, options) => {
            assert.equal(options.maxRedirects, 0); assert.equal(options.proxy, false);
            assert.equal(options.maxContentLength, MAX_MEDIA_BYTES);
            options.lookup('example.com', {}, (err, address) => { assert.equal(err, null); assert.equal(address, '93.184.216.34'); });
            return { status: 200, headers: { 'content-type': 'video/mp4' }, data: Buffer.from('video') };
        }
    });
    assert.equal(media.byteLength, 5);
    for (const data of [
        { headers: { 'content-type': 'text/html' }, data: Buffer.from('bad') },
        { headers: {}, data: Buffer.alloc(MAX_MEDIA_BYTES + 1) }
    ]) {
        await assert.rejects(fetchMediaBytes('https://example.com/a', { lookup, get: async () => ({ status: 200, ...data }) }));
    }
});

test('Seed Metric output extraction preserves sources, metadata and regime boundaries', () => {
    const output = require('../utils/seed-metric-output');
    const table = '| City | Price | Income | TFR | Other | Years | Regime |\n' +
        '| Tokyo | 1 | 2 | 3 | 4 | 10 | wrong |\n' +
        '| Tokyo | 1 | 2 | 3 | 4 | 26 | wrong |';
    assert.deepEqual(output.extractCities(table), ['tokyo']);
    const regimes = output.normalizeRegimes(table);
    assert.match(regimes, /EXTRACTION/); assert.match(regimes, /FATALISM/);
    const sources = [{ title: 'Source', url: 'https://example.com' }, { title: 'Again', url: 'https://example.com' }];
    const body = output.reattachSources('Answer', sources);
    assert.equal((body.match(/https:/g) || []).length, 1);
    assert.equal(output.reattachSources(body, sources), body);
    assert.ok(output.insertCoda(body, 'Reading').indexOf('Reading') < output.insertCoda(body, 'Reading').indexOf('**Sources:**'));
    assert.deepEqual(output.extractMeta('Answer <!--SEED_META:{"country":"JP"}-->'), { meta: { country: 'JP' }, text: 'Answer' });
});
