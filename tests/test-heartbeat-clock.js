'use strict';
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { HeartbeatClock } = require('../lib/heartbeat-clock');

function fixture({ latency = 0, follower = false } = {}) {
    let time = 0, value = 0, calls = 0, release = 0;
    const timers = new Map(), messages = [];
    const lease = {
        async tick() {
            calls++;
            time += latency;
            return { value: follower ? 90 : ++value, owned: !follower, fresh: true, age_ms: 0 };
        },
        async release() { release++; }
    };
    const clock = new HeartbeatClock({ lease, publish: data => messages.push(data),
        now: () => time, wallNow: () => 1000000 + time,
        schedule: (fn, ms) => { const id = {}; timers.set(id, { fn, at: time + ms }); return id; },
        cancel: id => timers.delete(id) });
    return { clock, lease, timers, messages, calls: () => calls, releases: () => release,
        advance: ms => { time += ms; },
        async next() {
            assert.equal(timers.size, 1, 'exactly one scheduled tick');
            const [id, timer] = [...timers.entries()][0];
            timers.delete(id); time = Math.max(time, timer.at);
            await timer.fn();
        }
    };
}

async function deterministic() {
    const f = fixture({ latency: 500 });
    await f.clock.start();
    assert.equal([...f.timers.values()][0].at, 6472, 'DB latency must not shift the deadline');
    for (let i = 0; i < 20; i++) await f.next();
    const observations = f.messages.filter(m => m.kind === 'observation');
    assert.equal(observations.length, 21);
    for (let i = 1; i < observations.length; i++) {
        assert.equal(observations[i].spacingMs, i % 2 ? 6472 : 4000);
        assert.equal(observations[i].latenessMs, 0);
        assert.equal(observations[i].dbMs, 500);
    }
    await f.clock.stop(); assert.equal(f.timers.size, 0); assert.equal(f.releases(), 1);

    const follower = fixture({ follower: true, latency: 100 });
    await follower.clock.start();
    for (let i = 0; i < 20; i++) await follower.next();
    assert(follower.messages.every(m => !m.owned && m.durationMs === 10000));
    follower.lease.tick = async () => ({ value: 91, owned: true, fresh: true, age_ms: 0 });
    await follower.next();
    assert(follower.messages.at(-1).owned);
    assert.equal(follower.messages.at(-1).count, 91);
    follower.lease.tick = async () => ({ value: 92, owned: false, fresh: true, age_ms: 0 });
    await follower.next();
    assert(!follower.messages.at(-1).owned);
    await follower.clock.stop();

    const slow = fixture({ latency: 22000 });
    await slow.clock.start();
    assert.equal(slow.calls(), 1);
    assert.equal(slow.messages[0].fresh, false);
    assert(slow.messages.some(m => m.kind === 'overdue'));
    assert([...slow.timers.values()][0].at > 22000, 'skip missed deadlines rather than catch up');
    slow.lease.tick = async () => { throw Object.assign(new Error('offline'), { code: 'DB_DOWN' }); };
    await slow.next();
    assert.equal(slow.messages.at(-1).code, 'DB_DOWN');
    assert.equal(slow.messages.at(-1).fresh, false);
    await slow.clock.stop();

    const stale = fixture({ latency: 500 });
    stale.lease.tick = async () => {
        stale.advance(500);
        return { value: 80, owned: false, fresh: true, age_ms: 19900 };
    };
    await stale.clock.start();
    assert.equal(stale.messages[0].fresh, false, 'DB age plus roundtrip must not be freshened');
    await stale.clock.stop();

    const invalid = fixture();
    invalid.lease.tick = async () => ({ value: 'NaN', owned: true, fresh: true });
    await invalid.clock.start();
    assert.equal(invalid.messages[0].code, 'HEARTBEAT_INVALID_COUNT');
    await invalid.clock.stop();

}

async function blockedParent() {
    const worker = new Worker(require.resolve('../lib/heartbeat-worker'), {
        workerData: { production: false }, env: {}, execArgv: []
    });
    const observations = [];
    let timeout;
    try {
        await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Independent heartbeat timed out')), 12000);
            worker.on('error', reject);
            worker.on('message', message => {
                if (message.kind !== 'observation') return;
                observations.push(message);
                if (observations.length === 1) {
                    // Intentionally occupy the entire parent event loop through
                    // breath two, not just a simulated asynchronous job.
                    const until = Date.now() + 7000;
                    while (Date.now() < until) {}
                } else resolve();
            });
        });
        const gap = observations[1].spacingMs;
        assert(Math.abs(gap - 6472) < 150, `Worker spacing was ${gap}ms, expected 6472ms ±150ms`);
        assert.equal(observations[1].count, 2);
        console.log(`Heartbeat blocked-parent fixture: expected 6472ms, actual ${gap.toFixed(1)}ms; parent blocked 7000ms.`);
    } finally {
        clearTimeout(timeout);
        worker.postMessage({ kind: 'stop' });
        await new Promise(resolve => worker.once('exit', resolve));
    }
}

async function main() {
    // Keep an explicit pending-query case separate so stop can race the query.
    const f = fixture();
    let finish;
    f.lease.tick = () => new Promise(resolve => { finish = resolve; });
    const starting = f.clock.start();
    assert.equal(f.clock.start(), starting);
    const stopping = f.clock.stop();
    finish({ value: 1, owned: true, fresh: true, age_ms: 0 });
    await Promise.all([starting, stopping]);
    assert.equal(f.messages.length, 0); assert.equal(f.timers.size, 0);
    await deterministic();
    await blockedParent();
    console.log('Heartbeat clock: anchored cadence, bounded query lane, overdue skip, follower/takeover, DB error, stop and worker isolation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
