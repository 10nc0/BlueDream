'use strict';
// Explicit integration test: real SQL in two newly created, isolated schemas.
// Fake Discord and media only; never start the shared ingestion worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const axios = require('axios');
const { createPool } = require('../lib/db-resolver');
const { OrderedInpipe, deliveryContext } = require('../lib/ordered-inpipe');
const { processQueuedMessage } = require('../lib/packet-queue');
const schema = `inpipe_fixture_${process.pid}_${Date.now()}`;
const tenant = `tenant_99${process.pid}${Date.now() % 100000}`;
const db = createPool({ max: 6, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const rewrite = text => text.replaceAll('core.', `${schema}.`);
let failArchive = false, failReceipt = false;
const query = async (client, sql, params) => {
    if (failArchive && sql.includes('INSERT INTO') && sql.includes('.anatta_messages')) {
        failArchive = false;
        throw Object.assign(new Error('fixture archive unavailable'), { code: 'FIXTURE_DB' });
    }
    if (failReceipt && sql.startsWith('UPDATE core.message_queue SET delivery_state=') &&
        Object.values(params[2]?.deliveries || {}).some(value => value.state === 'done')) {
        failReceipt = false;
        throw new Error('fixture receipt unavailable');
    }
    return client.query(rewrite(sql), params);
};
const pool = {
    query: (sql, params) => query(db, sql, params),
    async connect() {
        const client = await db.connect();
        return { query: (sql, params) => query(client, sql, params), release: () => client.release() };
    }
};
const queue = new OrderedInpipe(pool), competitor = new OrderedInpipe(pool);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const deps = { pool, logger, constants: { HERMES_TOKEN: 'isolated-fixture-token' } };
const published = [];
const originalPost = axios.post, originalPatch = axios.patch;
let releaseVideo, videoEntered;
let inject429 = false;
let subscriberEntered, releaseSubscriber;
const channel = {
    async downloadMedia(url) {
        if (url === 'fixture:video') {
            videoEntered?.();
            await new Promise(resolve => { releaseVideo = resolve; });
        }
        return { buffer: Buffer.from('isolated-fixture'), filename: 'test.mp4', contentType: 'video/mp4' };
    },
    async sendReply() { throw new Error('Receive-only channel attempted a reply'); }
};
let nextId = 0;
function packet(sender, body, media = null, sentAt = null) {
    const messageId = `fixture-${++nextId}`;
    return {
        channel: 'twilio', messageSid: messageId, queuedAt: Date.now(),
        msg: { channel: 'twilio', phone: sender, senderName: sender,
            body, bodyLower: body.toLowerCase(), joinCode: 'fixture-book',
            messageId, hasMedia: !!media, sentAt },
        rawPayload: { mediaUrl: media, mediaContentType: media ? 'video/mp4' : null }
    };
}
async function processRow(row) {
    const item = row.payload;
    await queue.run(row, () => processQueuedMessage(item.msg, item.rawPayload, channel, deps, item.channel));
    await queue.finish(row);
}
const wake = row => pool.query("UPDATE core.message_queue SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1", [row.id]);
async function clear() {
    await db.query(`TRUNCATE ${schema}.message_queue,${schema}.processed_sids,${schema}.message_ledger,${tenant}.anatta_messages`);
    published.length = 0;
}
async function run() {
    try {
        await db.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${tenant};
            CREATE TABLE ${schema}.message_queue(
                id SERIAL PRIMARY KEY,priority TEXT NOT NULL DEFAULT 'text',payload JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
                retry_count INT NOT NULL DEFAULT 0,last_error TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
            CREATE TABLE ${schema}.processed_sids(sid TEXT PRIMARY KEY,processed_at TIMESTAMPTZ);
            CREATE TABLE ${schema}.outbox_jobs(id SERIAL PRIMARY KEY,status TEXT,last_error TEXT,updated_at TIMESTAMPTZ);
            CREATE TABLE ${schema}.book_registry(id INT,tenant_schema TEXT,tenant_email TEXT,fractal_id TEXT,
                book_name TEXT,join_code TEXT,outpipe_ledger JSONB,outpipes_user JSONB,status TEXT,phone_number TEXT,creator_phone TEXT);
            CREATE TABLE ${schema}.book_engaged_phones(book_registry_id INT,phone TEXT,is_creator BOOL,
                first_engaged_at TIMESTAMPTZ,last_engaged_at TIMESTAMPTZ,UNIQUE(book_registry_id,phone));
            CREATE TABLE ${schema}.message_ledger(message_fractal_id TEXT PRIMARY KEY,book_fractal_id TEXT,
                sender_hash TEXT,content_hash TEXT,has_attachment BOOL,env TEXT,detected_lang TEXT,
                ipfs_cid TEXT,attachment_cid TEXT);
            CREATE TABLE ${tenant}.books(id INT,name TEXT,fractal_id TEXT,output_credentials JSONB,outpipes_user JSONB,
                output_01_url TEXT,output_0n_url TEXT);
            CREATE TABLE ${tenant}.anatta_messages(id SERIAL,book_fractal_id TEXT,message_fractal_id TEXT UNIQUE,
                sender_name TEXT,body TEXT,has_attachment BOOL,media_url TEXT,media_type TEXT,
                phi_breathe_stamp BIGINT,recorded_at TIMESTAMPTZ,sent_at TIMESTAMPTZ,attachment_cid TEXT);`);
        await db.query(rewrite(fs.readFileSync('migrations/core/015_ordered_inpipe.sql', 'utf8')));
        await db.query(`INSERT INTO ${schema}.book_registry VALUES
            (1,$1,'fixture','t999-b1','fixture','fixture-book','{}','[]','active','sender','sender')`, [tenant]);
        await db.query(`INSERT INTO ${tenant}.books(id,name,fractal_id,output_credentials,outpipes_user) VALUES(1,'fixture','t999-b1',$1,'[]')`,
            [{ output_01: { type: 'thread', thread_id: '123456789012345678' } }]);
        axios.post = async (url, payload) => {
            const destination = new URL(url);
            assert.ok(destination.origin === 'https://discord.com' &&
                ['/api/v10/channels/123456789012345678/messages', '/api/webhooks/fixture'].includes(destination.pathname),
                'No transport other than the fake Discord ledger is permitted');
            if (subscriberEntered && url.includes('/webhooks/')) {
                subscriberEntered();
                await new Promise(resolve => { releaseSubscriber = resolve; });
            }
            if (inject429) { inject429 = false; throw { response: { status: 429, data: { retry_after: 0.001 } } }; }
            const row = deliveryContext.getStore().row;
            published.push(row.payload.msg.body);
            return { data: { id: `discord-${row.id}`, attachments: row.payload.msg.hasMedia
                ? [{ url: 'https://fixture.invalid/clip.mp4', content_type: 'video/mp4' }] : [] } };
        };
        axios.patch = async () => { throw new Error('Unexpected Discord mutation'); };
        if (!process.argv.includes('--agent-only')) {
        // Real handlers, actual SQL, separate Discord and archive assertions.
        const burst = ['#A', 'photo A1', 'photo A2', 'video A', '#B', 'photo B'];
        const packets = burst.map((body, i) => packet('sender-A', body,
            i === 3 ? 'fixture:video' : [1, 2, 5].includes(i) ? 'fixture:photo' : null));
        for (const item of packets) await queue.enqueue(item);
        assert.equal((await queue.enqueue(packets[1])).duplicate, true);
        await competitor.enqueue(packet('sender-X', 'independent X'));
        const heads = await Promise.all([queue.claim(), competitor.claim()]);
        assert.deepEqual(new Set(heads.map(row => row.payload.msg.body)), new Set(['#A', 'independent X']));
        for (const row of heads) await processRow(row);
        await processRow(await queue.claim());
        await processRow(await queue.claim());
        const video = await queue.claim();
        assert.equal(video.payload.msg.body, 'video A');
        const entered = new Promise(resolve => { videoEntered = resolve; });
        const videoWork = processRow(video);
        await Promise.race([entered, videoWork.then(() => { throw Error('Video preparation was never reached'); })]);
        await competitor.enqueue(packet('sender-Y', 'independent Y'));
        const independent = await competitor.claim();
        assert.equal(independent.payload.msg.body, 'independent Y');
        await processRow(independent);
        assert.equal(await competitor.claim(), null, 'later #B cannot pass a slow video');
        releaseVideo(); await videoWork; videoEntered = null;
        inject429 = true;
        await processRow(await queue.claim());
        await processRow(await queue.claim());
        assert.deepEqual(published.filter(text => burst.includes(text)), burst);
        const archived = await db.query(`SELECT body FROM ${tenant}.anatta_messages
            WHERE sender_name='sender-A' ORDER BY recorded_at,id`);
        assert.deepEqual(archived.rows.map(row => row.body), burst);
        console.log('Passed: real handler burst order, slow video, independent fairness, duplicate and Discord 429.');
        await clear();
        // A persisted receipt survives an archive failure/restart without repost.
        await queue.enqueue(packet('restart', '#restart'));
        let row = await queue.claim();
        failArchive = true;
        await assert.rejects(processRow(row), /fixture archive/);
        await queue.retry(row, new Error('archive failed')); await wake(row);
        row = await competitor.claim();
        await processRow(row);
        assert.deepEqual(published, ['#restart']);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${tenant}.anatta_messages`)).rows[0].n, 1);
        await clear();
        // Lost send receipt: hold, never blindly resend, retain successor.
        await queue.enqueue(packet('uncertain', 'may have sent'));
        await queue.enqueue(packet('uncertain', 'must wait'));
        row = await queue.claim(); failReceipt = true;
        await assert.rejects(processRow(row), /fixture receipt/);
        assert.equal(await queue.retry(row, new Error('receipt failed')), 'failed');
        assert.equal(await competitor.claim(), null);
        assert.deepEqual(published, ['may have sent']);
        const held = await pool.query("SELECT status,last_error FROM core.message_queue WHERE id=$1", [row.id]);
        assert.match(held.rows[0].last_error, /HELD/);
        console.log('Passed: archive retries reuse receipts; uncertain publication holds without duplicates.');
        await clear();
        // Recovery/fencing before publication is safe; expired sends are held.
        await queue.enqueue(packet('recovery', 'prepare'));
        row = await queue.claim();
        await pool.query("UPDATE core.message_queue SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [row.id]);
        const recovered = await competitor.claim();
        assert.equal(recovered.id, row.id);
        assert.notEqual(recovered.lease_token, row.lease_token);
        await assert.rejects(queue.context(row).deliver('ledger', async () => {
            throw new Error('stale worker reached transport');
        }), /lease lost/);
        await queue.checkpoint(recovered, { deliveries: { ledger: { state: 'started' } } });
        await pool.query("UPDATE core.message_queue SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [row.id]);
        assert.equal(await competitor.claim(), null);
        assert.equal((await pool.query('SELECT status FROM core.message_queue WHERE id=$1', [row.id])).rows[0].status, 'failed');
        console.log('Passed: expired ownership is fenced and uncertain recovered sends are held.');
        await clear();
        // Terminal preparation errors are retained and block their own sender.
        await queue.enqueue(packet('terminal', 'bad media'));
        await queue.enqueue(packet('terminal', 'next group'));
        for (let attempt = 0; attempt < 3; attempt++) {
            row = await queue.claim();
            await queue.retry(row, { code: 'INPIPE_MEDIA_FAILED' });
            await wake(row);
        }
        assert.equal(await competitor.claim(), null);
        assert.equal((await pool.query('SELECT status FROM core.message_queue WHERE id=$1', [row.id])).rows[0].status, 'failed');
        console.log('Passed: terminal preparation errors retain their successors.');
        await clear();
        // Shared cap, not one cap per application instance.
        for (let i = 0; i < 5; i++) await queue.enqueue(packet(`parallel-${i}`, `parallel ${i}`));
        const leases = [];
        for (let i = 0; i < 4; i++) leases.push(await (i % 2 ? competitor : queue).claim());
        assert.ok(leases.every(Boolean));
        assert.equal(await competitor.claim(), null);
        for (const lease of leases) await queue.finish(lease);
        assert.ok(await queue.claim());
        console.log('Passed: the global concurrency limit spans competing instances.');
        await clear();
        // Queue rejection never burns a provider ID. Old timestamps don't reorder ingress.
        const rejected = packet('rejected', 'retry me');
        await assert.rejects(queue.enqueue(rejected, 0), /full/);
        assert.equal((await queue.enqueue(rejected)).duplicate, false);
        await queue.enqueue(packet('rejected', 'late upstream', null, '2000-01-01T00:00:00Z'));
        row = await queue.claim();
        assert.equal(row.payload.msg.body, 'retry me'); await queue.finish(row);
        assert.equal((await queue.claim()).payload.msg.body, 'late upstream');
        console.log('Passed: fencing, restart recovery, terminal policy, cross-instance cap and durable ingress order.');
        await clear();
        // LINE shares the same preparation placeholder and sender head-of-line.
        const lineVideo = packet('line-sender', 'line video', 'fixture:video');
        lineVideo.channel = lineVideo.msg.channel = 'line';
        const lineNext = packet('line-sender', 'line next');
        lineNext.channel = lineNext.msg.channel = 'line';
        await queue.enqueue(lineVideo); await queue.enqueue(lineNext);
        row = await queue.claim();
        const lineEntered = new Promise(resolve => { videoEntered = resolve; });
        const lineWork = processRow(row);
        await Promise.race([lineEntered, lineWork.then(() => { throw Error('LINE video preparation was never reached'); })]);
        const placeholder = (await pool.query('SELECT delivery_state FROM core.message_queue WHERE id=$1', [row.id])).rows[0].delivery_state;
        assert.ok(placeholder.messageRef);
        assert.equal(await competitor.claim(), null);
        releaseVideo(); await lineWork; videoEntered = null;
        await processRow(await competitor.claim());
        assert.deepEqual(published, ['line video', 'line next']);
        await clear();

        // Successful router admission uses real SQL, never an immediate sender.
        const file = require.resolve('../lib/outpipes/router');
        const nativeRequire = createRequire(file), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
            require: name => name === '../delivery-environment' ? { isDeliveryAuthority: () => true } : nativeRequire(name),
            Date, Buffer, console }, { filename: file });
        const book = { fractal_id: 't999-b1', outpipes_user: [
            { type: 'discord', url: 'https://discord.com/api/webhooks/fixture' }] };
        const admit = (id, text, media = null) => module.exports.routeUserOutput({
            id, sender: 'outbox-sender', text, media_url: media
        }, {}, book, { pool, tenantSchema: tenant });
        await admit('video-event', 'outbox video', 'https://cdn.discordapp.com/video.mp4');
        assert.equal((await admit('video-event', 'outbox video')).duplicate, true);
        await admit('next-event', 'same text');
        await admit('another-event', 'same text');
        assert.deepEqual(published, [], 'admission cannot publish before a lease');
        const raced = await Promise.all([queue.claim(), competitor.claim()]);
        assert.equal(raced.filter(Boolean).length, 1, 'immediate/background contenders share one ownership claim');
        row = raced.find(Boolean);
        const acceptedIdentity = row.payload.acceptance.id;
        const subEntered = new Promise(resolve => { subscriberEntered = resolve; });
        const subWork = processRow(row);
        await Promise.race([subEntered, subWork.then(() => { throw Error('Subscriber publication was never reached'); })]);
        assert.equal(await competitor.claim(), null, 'next outbox event cannot pass video publication');
        releaseSubscriber(); await subWork; subscriberEntered = null;
        assert.equal(row.payload.acceptance.id, acceptedIdentity);
        const receipt = row.delivery_state.deliveries['outpipe:0:chunk:0'];
        assert.equal(receipt.state, 'done');
        await processRow(await queue.claim()); await processRow(await queue.claim());
        assert.deepEqual(published, ['outbox video', 'same text', 'same text']);
        console.log('Passed: LINE/outbox delayed video, competing claims, immutable acceptance and distinct identical text.');
        await clear();
        }

        // Agent/webhook delivery uses the same checkpointed publisher and archive.
        deps.helpers = { sendToLedger: require('../lib/discord-webhooks').createSendToLedger(pool,
            'https://discord.com/api/webhooks/fixture') };
        await queue.enqueue({ channel: 'webhook', messageSid: 'agent-event',
            msg: { tenantSchema: tenant, fractalId: 't999-b1', body: 'agent text', phone: 'caller' }, rawPayload: {} });
        await processRow(await queue.claim());
        assert.deepEqual(published, ['agent text']);
        await clear();
        await db.query(`INSERT INTO ${schema}.outbox_jobs(status) VALUES('pending'),('success')`);
        assert.equal((await queue.quarantineLegacyOutbox()).rowCount, 1);
        const legacy = await db.query(`SELECT status,last_error FROM ${schema}.outbox_jobs ORDER BY id`);
        assert.equal(legacy.rows[0].status, 'failed');
        assert.match(legacy.rows[0].last_error, /HELD/);
        assert.equal(legacy.rows[1].status, 'success');
        console.log('Passed: agent delivery uses shared receipts; uncertain legacy outbox jobs are held without changing successful history.');
    } catch (error) {
        console.error('Isolated fixture failure:', error.message || error.code);
        throw error;
    } finally {
        releaseVideo?.(); releaseSubscriber?.();
        axios.post = originalPost; axios.patch = originalPatch;
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${tenant} CASCADE`);
        await db.end();
    }
}
run().then(() => process.exit(0)).catch(error => {
    console.error({ code: error.code || 'FIXTURE_FAILED', message: error.message }); process.exit(1);
});
