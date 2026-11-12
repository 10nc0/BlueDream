'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admit } = require('../lib/queue-admission');
const { identity } = require('../lib/ordered-inpipe');
const packet = i => ({ channel: 'twilio', messageSid: `fixture-${i}`, msg: { phone: 'fixture' } });
const fakeClient = {
    async query(sql, params) {
        if (!params) return { rows: [] };
        return { rows: JSON.parse(params[0]).map(i => ({ n: i.n, id: i.n + 1, accepted: true, duplicate: false })) };
    }
};

test('admission only acknowledges after the transaction commits, with same-batch dedupe', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let entered, commit;
    const reached = new Promise(resolve => { entered = resolve; });
    const committed = new Promise(resolve => { commit = resolve; });
    const coordinator = {
        pool: {},
        async transaction(work) {
            const result = await work(fakeClient);
            entered();
            await committed;
            return result;
        }
    };
    const item = packet(1);
    let acknowledged = false;
    const first = admit(coordinator, item, identity(item)).then(value => { acknowledged = true; return value; });
    const duplicate = admit(coordinator, item, identity(item));
    t.mock.timers.tick(5);
    await reached;
    assert.equal(acknowledged, false);
    commit();
    const results = await Promise.all([first, duplicate]);
    assert.equal(results[0].duplicate, false);
    assert.equal(results[1].duplicate, true);
    assert.equal(results[0].id, results[1].id);
});

test('temporary waiting capacity and deadline are bounded without accepting expired packets', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const coordinator = {
        pool: {},
        async transaction(work) { entered(); await held; return work(fakeClient); }
    };
    const results = Array.from({ length: 2049 }, (_, i) => {
        const item = packet(i);
        return admit(coordinator, item, identity(item))
            .then(value => ({ accepted: true, value }), error => ({ accepted: false, code: error.code }));
    });
    t.mock.timers.tick(5);
    await reached;
    t.mock.timers.tick(5000);
    release();
    const settled = await Promise.all(results);
    assert.equal(settled.filter(r => r.accepted).length, 128);
    assert.equal(settled.filter(r => r.code === 'INPIPE_ADMISSION_BUSY').length, 1921);
});

test('a failed transaction rejects the entire batch instead of acknowledging uncommitted messages', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const coordinator = {
        pool: {},
        async transaction(work) { await work(fakeClient); throw Object.assign(new Error('commit failed'), { code: '08006' }); }
    };
    const item = packet(1);
    const result = admit(coordinator, item, identity(item)).then(() => null, error => error.code);
    t.mock.timers.tick(5);
    assert.equal(await result, '08006');
});
