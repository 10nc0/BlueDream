'use strict';
// Real signed HTTP intake + real PostgreSQL, isolated schema, no delivery worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const twilio = require('twilio');
const { createPool } = require('../lib/db-resolver');
const { OrderedInpipe } = require('../lib/ordered-inpipe');
const schema = `burst_fixture_${process.pid}_${Date.now()}`;
const db = createPool({ max: 6, connectionTimeoutMillis: 5000 });
const rewrite = sql => sql.replaceAll('core.', `${schema}.`);
let queryCount = 0;
const pool = {
    async query(sql, params) { queryCount++; return db.query(rewrite(sql), params); },
    async connect() {
        const client = await db.connect();
        return {
            query(sql, params) { queryCount++; return client.query(rewrite(sql), params); },
            release: () => client.release()
        };
    }
};
function load(file, overrides, globals = {}) {
    const filename = require.resolve(file), nativeRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => overrides[name] || nativeRequire(name),
        process, console, Date, Buffer, setInterval, clearInterval, ...globals
    }, { filename });
    return module.exports;
}
const fixtureToken = 'fixture-signing-token-not-a-credential';
const webhookUrl = 'https://fixture.invalid/api/twilio/webhook';
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const { TwilioChannel } = load('../lib/channels/twilio', {}, {
    process: { env: { TWILIO_AUTH_TOKEN: fixtureToken, TWILIO_WEBHOOK_URL: webhookUrl } }
});
class FixtureTwilio extends TwilioChannel { async initialize() {} }
class DisabledChannel {
    async initialize() {}
    isConfigured() { return false; }
}
let injectFailure = false;
const queue = new OrderedInpipe(pool);
const packetQueue = {
    ...require('../lib/packet-queue'), setPool() {},
    totalQueueDepth: async () => 0,
    enqueueItem: item => {
        if (injectFailure) throw Object.assign(new Error('private details must not be logged'), { code: '55P03' });
        return queue.enqueue(item);
    }
};
function intakeRoutes(coordinator) { return load('../routes/pipe', {
    '../lib/channels/twilio': { TwilioChannel: FixtureTwilio },
    '../lib/channels/line': { LineChannel: DisabledChannel },
    '../lib/channels/email': { EmailChannel: DisabledChannel },
    '../lib/channels/telegram': { TelegramChannel: DisabledChannel },
    '../lib/delivery-environment': { isDeliveryAuthority: () => false },
    '../lib/packet-queue': {
        ...packetQueue,
        enqueueItem: item => {
            if (injectFailure) throw Object.assign(new Error('private details must not be logged'), { code: '55P03' });
            return coordinator.enqueue(item);
        }
    },
    './inpipe/generic': { register() {} }
}); }
const servers = [], endpoints = [];
async function send(sid, sender = '0', signature = true, replica = 0) {
    const body = {
        MessageSid: sid, From: `whatsapp:+1999000${sender.padStart(4, '0')}`,
        Body: 'identical text is not a duplicate', NumMedia: '1',
        MediaUrl0: 'https://fixture.invalid/photo.jpg', MediaContentType0: 'image/jpeg'
    };
    const start = performance.now();
    const response = await fetch(endpoints[replica], {
        method: 'POST', body: new URLSearchParams(body),
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'X-Twilio-Signature': signature ? twilio.getExpectedTwilioSignature(fixtureToken, webhookUrl, body) : 'invalid'
        }
    });
    await response.text();
    return { status: response.status, ms: performance.now() - start, retryAfter: response.headers.get('retry-after') };
}
async function burst(senders, size) {
    queryCount = 0;
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: senders * size }, (_, i) =>
        send(`fixture-${senders}-${i}`, String(Math.floor(i / size)), true, i % endpoints.length)));
    const times = results.map(r => r.ms).sort((a, b) => a - b);
    const accepted = results.filter(r => r.status === 200).length;
    console.log(JSON.stringify({
        senders, messages: results.length, accepted, rejected: results.length - accepted,
        p95Ms: Math.round(times[Math.ceil(times.length * .95) - 1]), maxMs: Math.round(times.at(-1)),
        totalMs: Math.round(performance.now() - start), dbQueries: queryCount
    }));
    return { results, accepted };
}
async function run() {
    try {
        await db.query(`CREATE SCHEMA ${schema};
            CREATE TABLE ${schema}.message_queue(
                id SERIAL PRIMARY KEY,priority TEXT NOT NULL,payload JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',retry_count INT NOT NULL DEFAULT 0,
                last_error TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
            CREATE TABLE ${schema}.processed_sids(sid TEXT PRIMARY KEY,processed_at TIMESTAMPTZ);`);
        await db.query(rewrite(fs.readFileSync('migrations/core/015_ordered_inpipe.sql', 'utf8')));
        await db.query(rewrite(fs.readFileSync('migrations/core/016_burst_admission_indexes.sql', 'utf8')));
        // Independent pool identities create independent intake batchers, just
        // like replicas, contending through actual PostgreSQL transactions.
        const replicaPool = { ...pool };
        const competitor = new OrderedInpipe(replicaPool);
        for (const coordinator of [queue, competitor]) {
            const app = express();
            app.use(express.urlencoded({ extended: false }));
            intakeRoutes(coordinator).registerPipeRoutes(app, { pool: coordinator.pool, logger, bots: {}, constants: {}, helpers: {} });
            const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
            servers.push(server);
            endpoints.push(`http://127.0.0.1:${server.address().port}/api/twilio/webhook`);
        }
        assert.equal((await send('invalid', '0', false)).status, 401);
        const first = await burst(1, 14);
        if (process.argv.includes('--baseline')) return;
        assert.equal(first.accepted, 14);
        await db.query(`TRUNCATE ${schema}.message_queue,${schema}.processed_sids`);
        const many = await burst(20, 30);
        assert.equal(many.accepted, 600);
        assert.ok(many.results.every(r => r.ms < 15000), 'all ACKs must beat Twilio response deadline');
        assert.ok(queryCount < 200, 'database roundtrips must scale with batches, not messages');
        const count = await db.query(`SELECT COUNT(*)::int AS n FROM ${schema}.message_queue`);
        assert.equal(count.rows[0].n, 600);
        // A duplicate storm and competing admission instance must not create rows.
        const row = (await db.query(`SELECT payload FROM ${schema}.message_queue ORDER BY id LIMIT 1`)).rows[0].payload;
        const duplicates = await Promise.all(Array.from({ length: 30 }, () => competitor.enqueue(row)));
        assert.ok(duplicates.every(r => r.duplicate));
        assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${schema}.message_queue`)).rows[0].n, 600);
        // Full queue still ACKs known duplicates, never burns a rejected SID.
        assert.equal((await queue.enqueue(row, 0)).duplicate, true);
        const rejected = { ...row, messageSid: 'fixture-full', msg: { ...row.msg, messageId: 'fixture-full' } };
        await assert.rejects(queue.enqueue(rejected, 0), error => error.status === 503);
        assert.equal((await queue.enqueue(rejected)).duplicate, false);
        injectFailure = true;
        const failure = await send('fixture-failure');
        assert.equal(failure.status, 503);
        assert.ok(failure.retryAfter);
        injectFailure = false;
        assert.equal((await send('fixture-failure')).status, 200);
        // Capacity is an exact shared cap, even when two replicas race.
        await db.query(`TRUNCATE ${schema}.message_queue,${schema}.processed_sids`);
        const items = Array.from({ length: 10 }, (_, i) => ({
            ...row, messageSid: `capacity-${i}`, msg: { ...row.msg, messageId: `capacity-${i}` }
        }));
        const capacity = await Promise.allSettled(items.map((item, i) =>
            (i % 2 ? competitor : queue).enqueue(item, 3)));
        assert.equal(capacity.filter(r => r.status === 'fulfilled').length, 3);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${schema}.processed_sids`)).rows[0].n, 3);
        const rejectedIndex = capacity.findIndex(r => r.status === 'rejected');
        assert.equal((await queue.enqueue(items[rejectedIndex])).duplicate, false);
        // Legacy receipts and packets remain idempotent, including normalized
        // messageId-only packets. Payloads without provider IDs stay distinct.
        await db.query(`INSERT INTO ${schema}.processed_sids VALUES('legacy-seen',NOW())`);
        assert.equal((await queue.enqueue({ ...row, messageSid: 'legacy-seen' })).duplicate, true);
        await db.query(`INSERT INTO ${schema}.message_queue(priority,payload,status)
            VALUES('text',$1,'done')`, [{ ...row, messageSid: 'legacy-packet' }]);
        assert.equal((await queue.enqueue({ ...row, messageSid: 'legacy-packet' })).duplicate, true);
        const normalized = { channel: 'twilio', msg: { phone: 'fixture', messageId: 'normalized-only' } };
        await queue.enqueue(normalized);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${schema}.processed_sids WHERE sid='normalized-only'`)).rows[0].n, 1);
        const anonymous = await Promise.all([queue.enqueue({ msg: {} }), queue.enqueue({ msg: {} })]);
        assert.ok(anonymous.every(r => !r.duplicate));
        assert.notEqual(anonymous[0].id, anonymous[1].id);
        console.log('Passed: signed multi-sender burst intake, deadline, dedupe, capacity and retryable failures.');
    } finally {
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await db.end();
    }
}
run().catch(error => { console.error({ code: error.code, message: error.message }); process.exitCode = 1; });
