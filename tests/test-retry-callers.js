'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const { fetchWithRetry, withRetry } = require('../lib/fetch-retry');

test('Seed Metric providers preserve successful response contracts and total-deadline signals', async t => {
    const { urlCache } = require('../lib/fetch-cache');
    const logger = require('../lib/logger');
    t.mock.method(logger, 'warn', () => {});
    t.mock.method(logger, 'debug', () => {});
    urlCache.clear();
    const fixtures = [
        { file: '../lib/tools/uk-lr', run: m => m.fetchUkLrPricePerSqm('london', 2024), budget: 14000,
            body: { results: { bindings: [{ month: { value: '2024-06' }, avgPrice: { value: '150000' } }] } }, expected: 2000 },
        { file: '../lib/tools/sgp-hdb', run: m => m.fetchSgpHdbPricePerSqm(2024), budget: 14000,
            body: { success: true, result: { records: [{ resale_price: '600000', floor_area_sqm: '100' }] } }, expected: 6000 },
        { file: '../lib/tools/wb-tfr', run: m => m.fetchWbTFR('SG', 2024), budget: 10000,
            body: [{}, [{ date: '2024', value: 1.4 }]], expected: 1.4 }
    ];
    for (const f of fixtures) {
        const signals = [], budgets = [];
        t.mock.method(AbortSignal, 'timeout', budget => {
            budgets.push(budget);
            return new AbortController().signal;
        });
        t.mock.method(global, 'fetch', async (_url, options) => {
            signals.push(options.signal);
            return signals.length === 1 ? new Response('retry', { status: 503 }) : Response.json(f.body);
        });
        const result = await f.run(require(f.file));
        assert.equal(result.value, f.expected);
        assert.deepEqual(budgets, [f.budget]);
        assert.equal(signals.length, 2);
        assert.equal(signals[0], signals[1], 'provider must preserve its original total deadline');
    }
    urlCache.clear();
});

test('Exa caller forwards cancellation to both SDK transport and shared retry helper', async () => {
    const controller = new AbortController(), reason = new Error('cancel Exa');
    let attempts = 0, received;
    class Exa {
        searchAndContents(_query, _options, transport) {
            attempts++; received = transport.signal;
            queueMicrotask(() => controller.abort(reason));
            return new Promise((_, reject) => transport.signal.addEventListener('abort',
                () => reject(transport.signal.reason), { once: true }));
        }
    }
    const box = {
        module: { exports: {} }, process: { env: { EXA_API_KEY: 'fixture-key' } },
        require(name) {
            if (name === '../logger') return { debug() {}, error() {} };
            if (name === '../fetch-cache') return { exaCache: { get() {}, set() {} } };
            if (name === '../fetch-retry') return { fetchWithRetry, withRetry };
            if (name === 'exa-js') return { default: Exa };
            throw new Error(`Unexpected dependency ${name}`);
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/tools/exa'), 'utf8'), box);
    await assert.rejects(box.module.exports.execute('fixture query', { signal: controller.signal }), e => e === reason);
    assert.equal(attempts, 1);
    assert.equal(received, controller.signal);
});
