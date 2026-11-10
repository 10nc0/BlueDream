'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const { getEventListeners } = require('node:events');
const { awaitWithSignal } = require('../lib/fetch-retry');

function fixture({ scrape = async () => ({ markdown: 'm'.repeat(150) }), Client, enabled = true } = {}) {
    const clients = [], calls = [];
    class FakeClient {
        constructor(options) { clients.push(options); }
        scrape(url, options) { calls.push({ url, options }); return scrape(url, options); }
    }
    const box = {
        module: { exports: {} }, process: { env: enabled ? { FIRECRAWL_API_KEY: 'fixture-key' } : {} },
        Map, Set, Promise,
        require(name) {
            if (name === '../lib/logger') return { debug() {}, info() {} };
            if (name === '../lib/fetch-retry') return { awaitWithSignal };
            if (name === '@mendable/firecrawl-js') return { FirecrawlClient: Client || FakeClient };
            throw new Error(`Unexpected dependency: ${name}`);
        }
        // No timers in this sandbox: leaked Promise.race timers would fail.
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../utils/firecrawl-enricher'), 'utf8'), box);
    return { ...box.module.exports, clients, calls };
}

test('enrichment uses native bounded SDK transport without retries or auto-resume', async () => {
    const f = fixture();
    const enriched = await f.enrichUrls(['https://example.com/a', 'https://example.com/a'], { timeoutMs: 6000, maxCharsPerUrl: 120 });
    assert.equal(enriched.size, 1);
    assert.equal(enriched.get('https://example.com/a').length, 120);
    assert.equal(f.clients[0].timeoutMs, 6000);
    assert.equal(f.clients[0].maxRetries, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.autoResume, false);
    assert.equal(f.calls[0].options.timeout, undefined, 'SDK server timeout would extend the transport deadline');
    await f.enrichUrls(['https://example.com/b'], { timeoutMs: 6000 });
    assert.equal(f.clients.length, 1);
    await f.enrichUrls(['https://example.com/c'], { timeoutMs: 8000 });
    assert.equal(f.clients[1].timeoutMs, 8000);
});

test('pre-aborted enrichment never instantiates or calls SDK', async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error('left');
    controller.abort(reason);
    await assert.rejects(f.enrichUrls(['https://example.com'], { signal: controller.signal }), e => e === reason);
    assert.equal(f.clients.length, 0); assert.equal(f.calls.length, 0);
});

test('SDK waiting aborts cleanly without retries or late-result mutation', async () => {
    let rejectSdk;
    const f = fixture({ scrape: () => new Promise((_, reject) => { rejectSdk = reject; }) });
    const controller = new AbortController(), reason = new Error('cancel enrichment');
    const result = f.enrichUrls(['https://example.com'], { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(result, e => e === reason);
    rejectSdk(new Error('native SDK timeout later'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('native SDK errors preserve graceful per-URL fallback and successful snippets', async () => {
    const f = fixture({ scrape: async url => {
        if (url.endsWith('/bad')) throw new Error('timeout');
        return { markdown: 'm'.repeat(150) };
    } });
    const result = await f.enrichUrls(['https://example.com/bad', 'https://example.com/good']);
    assert.equal(result.size, 1);
    const original = '1. Title\n   Raw snippet\n   Source: https://example.com/good';
    assert(f.substituteEnrichedSnippets(original, result).includes('m'.repeat(150)));
    assert.equal(f.substituteEnrichedSnippets(original, new Map()), original);
    assert.equal((await fixture({ enabled: false }).enrichUrls(['https://example.com'])).size, 0);
});

test('installed SDK honors constructor timeout and sends only one HTTP attempt', async t => {
    const axios = require('axios');
    const { FirecrawlClient } = require('@mendable/firecrawl-js');
    let requests = 0, transportTimeout;
    t.mock.method(axios, 'create', options => ({
        defaults: { timeout: options.timeout },
        async request(config) {
            requests++;
            transportTimeout = config.timeout ?? options.timeout;
            return { status: 502, data: { success: false, error: 'offline fixture' }, headers: {} };
        }
    }));
    const f = fixture({ Client: FirecrawlClient });
    const result = await f.enrichUrls(['https://example.com'], { timeoutMs: 6000 });
    assert.equal(result.size, 0);
    assert.equal(transportTimeout, 6000);
    assert.equal(requests, 1, 'maxRetries=1 in installed SDK means exactly one HTTP attempt');
});
