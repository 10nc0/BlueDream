'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const logger = require('../lib/logger');
const { fetchWithRetry, withRetry, retryAfterMs, awaitWithSignal } = require('../lib/fetch-retry');

function transient(status = 503, headers = {}, cancel = async () => {}) {
    return { status, headers: new Headers(headers), body: { cancel } };
}
function quiet(t) { t.mock.method(logger, 'warn', () => {}); }

test('pre-cancelled fetch and SDK work makes zero attempts', async t => {
    quiet(t);
    const controller = new AbortController(), reason = new Error('caller left');
    controller.abort(reason);
    let calls = 0;
    t.mock.method(global, 'fetch', async () => { calls++; });
    await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), e => e === reason);
    await assert.rejects(withRetry(() => { calls++; }, { signal: controller.signal }), e => e === reason);
    assert.equal(calls, 0);
});

test('in-flight native fetch cancellation stops immediately without retries', async t => {
    quiet(t);
    const controller = new AbortController(), reason = new Error('cancel fetch');
    let calls = 0;
    t.mock.method(global, 'fetch', (_url, { signal }) => new Promise((_, reject) => {
        calls++;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort(reason));
    }));
    await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), e => e === reason);
    assert.equal(calls, 1);
});

test('both retry paths abort backoff before another attempt', async t => {
    for (const kind of ['fetch', 'sdk']) {
        const controller = new AbortController(), reason = new Error('cancel backoff');
        let calls = 0;
        t.mock.method(logger, 'warn', () => setImmediate(() => controller.abort(reason)));
        t.mock.method(global, 'fetch', async () => { calls++; return transient(); });
        const task = kind === 'fetch'
            ? fetchWithRetry('https://fixture.invalid', { signal: controller.signal }, { backoffMs: 10000 })
            : withRetry(async () => { calls++; throw new Error('network'); },
                { signal: controller.signal, backoffMs: 10000 });
        await assert.rejects(task, e => e === reason);
        assert.equal(calls, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
});

test('SDK cancellation stops waiting, handles late rejection, and never retries', async t => {
    quiet(t);
    const controller = new AbortController(), reason = new Error('cancel SDK');
    let rejectSdk, calls = 0, received;
    const result = withRetry(context => {
        calls++; received = context;
        return new Promise((_, reject) => { rejectSdk = reject; });
    }, { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(result, e => e === reason);
    assert.equal(received.signal, controller.signal);
    assert.equal(received.attempt, 1);
    rejectSdk(new Error('late SDK failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('shared Retry-After parsing is strict, nonnegative and capped', () => {
    const now = Date.parse('2026-10-23T08:00:00Z');
    assert.equal(retryAfterMs('1.5', now), 1500);
    assert.equal(retryAfterMs('99999', now), 10000);
    assert.equal(retryAfterMs('Fri, 23 Oct 2026 08:00:03 GMT', now), 3000);
    assert.equal(retryAfterMs('Fri, 23 Oct 2026 07:59:59 GMT', now), 0);
    for (const value of [null, '', '-1', '1junk', 'NaN', 'Infinity'])
        assert.equal(retryAfterMs(value, now), null);
});

test('transient fetch responses are closed exactly once, final body stays readable', async t => {
    quiet(t);
    let calls = 0, closed = 0;
    const final = new Response('{"ok":true}', { status: 200 });
    t.mock.method(global, 'fetch', async () => ++calls < 3
        ? transient(503, {}, async () => { closed++; }) : final);
    const response = await fetchWithRetry('https://fixture.invalid', {}, { backoffMs: 0 });
    assert.equal(response, final);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(closed, 2); assert.equal(calls, 3);
});

test('exhausted retries return final response without cancelling its body', async t => {
    quiet(t);
    let calls = 0, closed = 0;
    t.mock.method(global, 'fetch', async () => { calls++; return transient(503, {}, async () => { closed++; }); });
    assert.equal((await fetchWithRetry('https://fixture.invalid', {}, { backoffMs: 0 })).status, 503);
    assert.equal(calls, 3); assert.equal(closed, 2);
});

test('permanent statuses and cancellation errors never retry in either path', async t => {
    quiet(t);
    for (const status of [400, 401, 403, 404, 410, 422]) {
        let fetchCalls = 0, sdkCalls = 0;
        t.mock.method(global, 'fetch', async () => { fetchCalls++; return transient(status); });
        assert.equal((await fetchWithRetry('https://fixture.invalid')).status, status);
        const error = Object.assign(new Error('permanent'), { statusCode: status });
        await assert.rejects(withRetry(() => { sdkCalls++; throw error; }), e => e === error);
        assert.equal(fetchCalls, 1); assert.equal(sdkCalls, 1);
    }
    for (const error of [new DOMException('abort', 'AbortError'),
        Object.assign(new Error('cancel'), { code: 'ERR_CANCELED' })]) {
        let calls = 0;
        t.mock.method(global, 'fetch', async () => { calls++; throw error; });
        await assert.rejects(fetchWithRetry('https://fixture.invalid'), e => e === error);
        await assert.rejects(withRetry(() => { calls++; throw error; }), e => e === error);
        assert.equal(calls, 2);
    }
});

test('SDK transient network, 429 and 5xx retries stay bounded', async t => {
    quiet(t);
    for (const status of [undefined, 429, 500, 502, 503, 504]) {
        let calls = 0;
        const error = Object.assign(new Error('transient'), {
            response: status ? { status, headers: { 'retry-after': '0' } } : undefined
        });
        await assert.rejects(withRetry(() => { calls++; throw error; }, { backoffMs: 0 }), e => e === error);
        assert.equal(calls, 3);
    }
});

test('total fetch deadline is preserved across retries and combined caller signals', async t => {
    quiet(t);
    const deadline = new AbortController(), caller = new AbortController(), reason = new DOMException('deadline', 'TimeoutError');
    const signals = [];
    t.mock.method(global, 'fetch', async (_url, options) => {
        signals.push(options.signal);
        if (signals.length === 1) return transient();
        deadline.abort(reason);
        throw reason;
    });
    await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: deadline.signal },
        { signal: caller.signal, backoffMs: 0 }), e => e === reason);
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1], 'retry must not refresh the total deadline');
    assert(signals[0].aborted);
});

test('response cleanup failure does not cause duplicate retries', async t => {
    quiet(t);
    let calls = 0;
    t.mock.method(global, 'fetch', async () => ++calls === 1
        ? transient(503, {}, async () => { throw new Error('already closed'); }) : new Response('ok'));
    assert.equal(await (await fetchWithRetry('https://fixture.invalid', {}, { backoffMs: 0 })).text(), 'ok');
    assert.equal(calls, 2);
});

test('successful SDK calls remove abort listeners', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) assert.equal(await awaitWithSignal(Promise.resolve(i), controller.signal), i);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('invalid retry configuration fails before outbound work', async t => {
    let calls = 0;
    t.mock.method(global, 'fetch', async () => { calls++; });
    await assert.rejects(fetchWithRetry('https://fixture.invalid', {}, { maxAttempts: 0 }), RangeError);
    await assert.rejects(withRetry(() => { calls++; }, { backoffMs: -1 }), RangeError);
    assert.equal(calls, 0);
});

test('cancellation racing response delivery cannot wait for slow body cleanup', async t => {
    quiet(t);
    const controller = new AbortController(), reason = new Error('cancel delivery');
    let closed = 0;
    t.mock.method(global, 'fetch', async () => {
        controller.abort(reason);
        return transient(200, {}, () => { closed++; return new Promise(() => {}); });
    });
    await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), e => e === reason);
    assert.equal(closed, 1);
});
