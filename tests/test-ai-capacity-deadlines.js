'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { capacityTransaction, CAPACITY_TIMEOUT_MS } = require('../lib/ai-capacity-transaction');
const logger = require('../lib/logger');
const capacity = require('../utils/ai-capacity');
const { publicAIError } = require('../lib/ai-errors');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(query = async () => ({ rows: [] })) {
    const sql = [], releases = [];
    const client = {
        query: (text, params) => { sql.push(text); return query(text, params); },
        release: destroy => releases.push(destroy)
    };
    return { sql, releases, client, pool: { connect: async () => client } };
}
const run = (f, extra = {}) => capacityTransaction({
    pool: f.pool, operation: 'reservation', fn: client => client.query('fixture-work'), ...extra
});

test('capacity transaction deadlines and safe diagnostics', async t => {
    const original = logger.error;
    const logs = [];
    logger.error = message => logs.push(message);
    try {
        await t.test('success keeps the lock/transaction contract and returns a reusable client', async () => {
            const f = fixture(async () => ({ rows: [{ ok: true }] }));
            assert.deepEqual(await run(f), { rows: [{ ok: true }] });
            assert.equal(CAPACITY_TIMEOUT_MS, 5000);
            assert.equal(f.sql[0], 'BEGIN');
            assert.ok(f.sql.includes('SELECT pg_advisory_xact_lock(708282)'));
            assert.equal(f.sql.at(-1), 'COMMIT');
            assert.deepEqual(f.releases, [false]);
        });
        await t.test('pool acquisition obeys caller deadline and returns a late unused client', async () => {
            const f = fixture(), pending = deferred();
            f.pool.connect = () => pending.promise;
            const started = Date.now();
            await assert.rejects(run(f, { deadline: Date.now() + 20 }), error =>
                error.code === 'AI_CAPACITY' && error.capacityPhase === 'pool' && error.capacityReason === 'deadline');
            assert.ok(Date.now() - started < 1000);
            pending.resolve(f.client);
            await sleep(0);
            assert.deepEqual(f.releases, [false]);
            assert.deepEqual(f.sql, []);
        });
        await t.test('a late pool rejection is handled after cancellation', async () => {
            const pending = deferred(), controller = new AbortController();
            const f = fixture();
            f.pool.connect = () => { queueMicrotask(() => controller.abort()); return pending.promise; };
            await assert.rejects(run(f, { signal: controller.signal }), e => e.capacityReason === 'cancelled');
            pending.reject(new Error('late rejection'));
            await sleep(0);
            assert.equal(f.releases.length, 0);
        });
        await t.test('a hung lock destroys the client once and cannot later COMMIT', async () => {
            const pending = deferred();
            const f = fixture(sql => sql.startsWith('SELECT pg_advisory') ? pending.promise : Promise.resolve({ rows: [] }));
            await assert.rejects(run(f, { ctx: { deadline: Date.now() + 20 } }),
                e => e.capacityPhase === 'lock' && e.capacityReason === 'deadline');
            pending.resolve({ rows: [] });
            await sleep(0);
            assert.deepEqual(f.releases, [true]);
            assert.ok(!f.sql.includes('COMMIT'));
            assert.ok(!f.sql.includes('ROLLBACK'), 'must not queue rollback on an in-flight timed-out query');
        });
        await t.test('an interrupted COMMIT stays unknown with no compensating refund', async () => {
            const pending = deferred(), f = fixture(sql => sql === 'COMMIT' ? pending.promise : Promise.resolve({ rows: [] }));
            await assert.rejects(run(f, { deadline: Date.now() + 20 }), e => e.capacityPhase === 'commit');
            pending.resolve({ rows: [] });
            await sleep(0);
            assert.deepEqual(f.releases, [true]);
            assert.ok(!f.sql.includes('ROLLBACK'));
        });
        await t.test('database classification survives without leaking SQL, content or credentials', async () => {
            logs.length = 0;
            const f = fixture(async sql => {
                if (sql === 'fixture-work') throw Object.assign(new Error('password=secret-fixture private-prompt SQL'), { code: '42P01' });
                return { rows: [] };
            });
            await assert.rejects(run(f, { ctx: { id: 'safe-request-123', req: { body: 'private-prompt' } } }),
                e => e.code === 'AI_CAPACITY' && e.dbCode === '42P01' && e.capacityOperation === 'reservation');
            assert.equal(f.sql.at(-1), 'ROLLBACK');
            assert.deepEqual(f.releases, [false]);
            assert.match(logs.join(''), /42P01/);
            assert.match(logs.join(''), /safe-request-123/);
            assert.doesNotMatch(logs.join(''), /secret-fixture|private-prompt|fixture-work|password/);
        });
        await t.test('rollback failure destroys the connection and preserves the original error classification', async () => {
            const f = fixture(async sql => {
                if (sql === 'fixture-work') throw Object.assign(new Error('missing table'), { code: '42P01' });
                if (sql === 'ROLLBACK') throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
                return { rows: [] };
            });
            await assert.rejects(run(f), e => e.dbCode === '42P01');
            assert.deepEqual(f.releases, [true]);
        });
        await t.test('pre-cancellation and expired deadlines never acquire a client', async () => {
            let calls = 0;
            const pool = { connect: () => { calls++; throw new Error('must not connect'); } };
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(run({ pool }, { signal: controller.signal }), e => e.capacityReason === 'cancelled');
            await assert.rejects(run({ pool }, { deadline: Date.now() - 1 }), e => e.capacityReason === 'deadline');
            assert.equal(calls, 0);
        });
        await t.test('real denials stay 429, not provider-busy or accounting errors', async () => {
            const failure = capacity.problem('Shared daily AI budget exhausted.');
            await assert.rejects(run(fixture(), { fn: async () => { throw failure; } }), e => e === failure);
            assert.equal(publicAIError(failure).status, 429);
            assert.equal(publicAIError(failure).message, failure.message);
            assert.match(publicAIError(Object.assign(capacity.problem('internal', 503),
                { capacityReason: 'deadline' })).message, /capacity checks timed out/);
            assert.equal(publicAIError({ response: { status: 429 } }).code, 'AI_PROVIDER_BUSY');
            assert.equal(publicAIError({ response: { status: 401 } }).code, 'AI_PROVIDER_UNAVAILABLE');
        });
        await t.test('missing pool preserves the fail-closed unavailable contract', async () => {
            await assert.rejects(run({ pool: null }), e =>
                e.code === 'AI_CAPACITY' && e.status === 503 && /unavailable/.test(e.message));
        });
    } finally { logger.error = original; }
});
