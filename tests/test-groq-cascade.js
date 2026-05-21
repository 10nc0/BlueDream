#!/usr/bin/env node
/**
 * Groq → OpenRouter → Ollama cascade tests — standalone, no live API calls.
 *
 * Tests the three-tier fallback logic in utils/groq-client.js:
 *   - Groq succeeds → OpenRouter and Ollama never called
 *   - Groq 5xx → OpenRouter tried and succeeds → Ollama never called
 *   - Groq and OpenRouter both fail → Ollama tried and succeeds
 *   - All three fail → final error propagated to caller
 *   - No Groq token (offline mode) → Groq skipped → Ollama used directly
 *   - Groq 4xx (client error) → not forwarded to OpenRouter or Ollama
 *
 * Mocking strategy: require-cache injection before the module is first loaded.
 * No sinon, nock, or other test dependencies required.
 *
 * Run: node tests/test-groq-cascade.js
 */

'use strict';

const path = require('path');

// ── Resolve canonical paths so the injected stubs land in the right cache keys ──
const AXIOS_PATH        = require.resolve('axios');
const LOGGER_PATH       = require.resolve('../lib/logger');
const USAGE_PATH        = require.resolve('../utils/playground-usage');
const CONFIG_PATH       = require.resolve('../config');
const BRAND_PATH        = require.resolve('../config/brand');
const GROQ_CLIENT_PATH  = require.resolve('../utils/groq-client');

// ── Mutable axios stub — tests swap _axiosPostImpl per scenario ──────────────
let _axiosPostImpl = async () => { throw new Error('axios.post not configured for this test'); };
let _axiosCallLog  = [];   // [ url, ... ] — records every post() invocation

function resetAxios(impl) {
    _axiosCallLog  = [];
    _axiosPostImpl = async (url, data, cfg) => {
        _axiosCallLog.push(url);
        return impl(url, data, cfg);
    };
}

// ── Inject stubs before anything else loads ───────────────────────────────────

// axios stub
require.cache[AXIOS_PATH] = {
    id: AXIOS_PATH, filename: AXIOS_PATH, loaded: true,
    exports: {
        post: (url, data, cfg) => _axiosPostImpl(url, data, cfg),
    },
};

// silent logger stub
const silentLogger = {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    child: () => silentLogger,
};
require.cache[LOGGER_PATH] = {
    id: LOGGER_PATH, filename: LOGGER_PATH, loaded: true,
    exports: silentLogger,
};

// no-op usage tracker stub
require.cache[USAGE_PATH] = {
    id: USAGE_PATH, filename: USAGE_PATH, loaded: true,
    exports: { recordUsage: () => {} },
};

// minimal config stub
require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH, filename: CONFIG_PATH, loaded: true,
    exports: { config: { ai: { dashboardAiKey: 'test-dashboard-key' } } },
};

// minimal brand stub
require.cache[BRAND_PATH] = {
    id: BRAND_PATH, filename: BRAND_PATH, loaded: true,
    exports: {
        BRAND: {
            openrouterReferer: 'https://test.example.com',
            openrouterTitle:   'NyanBook-Test',
        },
    },
};

// Now it is safe to load the module under test
const { groqWithRetry, resolveOllamaModel } = require('../utils/groq-client');

// ── Known provider URL constants (must match groq-client internals) ───────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OLLAMA_BASE    = 'http://localhost:11434';
const OLLAMA_URL     = `${OLLAMA_BASE}/v1/chat/completions`;
const GROQ_URL       = 'https://api.groq.com/openai/v1/chat/completions';

// ── Helpers ───────────────────────────────────────────────────────────────────
const SUCCESS_RESPONSE = {
    data: {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
};

function makeAxiosError(status) {
    const err = new Error(`HTTP ${status}`);
    err.response = { status, headers: {}, data: { error: `HTTP ${status}` } };
    return err;
}

function makeAxiosConfig(authHeader = `Bearer real-groq-key-1234567890`) {
    return {
        url:    GROQ_URL,
        data:   { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] },
        config: { headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, timeout: 30000 },
    };
}

function setEnv({ groqKey = undefined, openrouterKey = undefined, ollamaBase = undefined } = {}) {
    delete process.env.PLAYGROUND_AI_KEY;
    delete process.env.PLAYGROUND_GROQ_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_API_KEY;
    if (groqKey)       process.env.PLAYGROUND_AI_KEY   = groqKey;
    if (openrouterKey) process.env.OPENROUTER_API_KEY  = openrouterKey;
    if (ollamaBase)    process.env.OLLAMA_BASE_URL      = ollamaBase;
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed   = 0;
let failed   = 0;
const failures = [];

async function test(label, fn) {
    try {
        await fn();
        console.log(`  ✅  ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${label}`);
        console.log(`      ${e.message}`);
        failed++;
        failures.push({ label, error: e.message });
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function main() {

    // ── SECTION 1: Groq succeeds ─────────────────────────────────────────────
    console.log('\n🟢 Tier 1 — Groq succeeds');

    await test('Groq success → response returned', async () => {
        setEnv({ groqKey: 'gsk_real' });
        resetAxios(async () => SUCCESS_RESPONSE);

        const result = await groqWithRetry(makeAxiosConfig(), 0);
        assertEqual(result.data.choices[0].message.content, 'ok', 'unexpected response body');
    });

    await test('Groq success → OpenRouter never called', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real' });
        resetAxios(async () => SUCCESS_RESPONSE);

        await groqWithRetry(makeAxiosConfig(), 0);
        assert(!_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter was called but should not have been');
    });

    await test('Groq success → Ollama never called', async () => {
        setEnv({ groqKey: 'gsk_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async () => SUCCESS_RESPONSE);

        await groqWithRetry(makeAxiosConfig(), 0);
        assert(!_axiosCallLog.includes(OLLAMA_URL), 'Ollama was called but should not have been');
    });

    // ── SECTION 2: Groq 5xx → OpenRouter succeeds ────────────────────────────
    console.log('\n🔀 Tier 2 — Groq 5xx → OpenRouter fallback');

    await test('Groq 5xx → OpenRouter tried', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real' });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(500);
            if (url === OPENROUTER_URL)  return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        await groqWithRetry(makeAxiosConfig(), 0);
        assert(_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter was not called on Groq 5xx');
    });

    await test('Groq 5xx → OpenRouter succeeds → Ollama never called', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(503);
            if (url === OPENROUTER_URL)  return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        await groqWithRetry(makeAxiosConfig(), 0);
        assert(!_axiosCallLog.includes(OLLAMA_URL), 'Ollama was called even though OpenRouter succeeded');
    });

    await test('Groq 5xx → OpenRouter response returned to caller', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real' });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(502);
            if (url === OPENROUTER_URL)  return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await groqWithRetry(makeAxiosConfig(), 0);
        assertEqual(result.data.choices[0].message.content, 'ok', 'unexpected response from OpenRouter fallback');
    });

    // ── SECTION 3: Groq + OpenRouter both fail → Ollama succeeds ─────────────
    console.log('\n🦙 Tier 3 — Groq + OpenRouter fail → Ollama fallback');

    await test('Groq + OpenRouter 5xx → Ollama tried', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(500);
            if (url === OPENROUTER_URL)  throw makeAxiosError(500);
            if (url === OLLAMA_URL)      return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        await groqWithRetry(makeAxiosConfig(), 0);
        assert(_axiosCallLog.includes(OLLAMA_URL), 'Ollama was not called after both cloud providers failed');
    });

    await test('Groq + OpenRouter fail → Ollama response returned to caller', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(500);
            if (url === OPENROUTER_URL)  throw makeAxiosError(502);
            if (url === OLLAMA_URL)      return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await groqWithRetry(makeAxiosConfig(), 0);
        assertEqual(result.data.choices[0].message.content, 'ok', 'unexpected response from Ollama fallback');
    });

    // ── SECTION 4: All three fail → error propagated ─────────────────────────
    console.log('\n💥 All providers fail → error propagated');

    await test('All three fail → groqWithRetry rejects', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(503);
            if (url === OPENROUTER_URL)  throw makeAxiosError(503);
            if (url === OLLAMA_URL)      throw makeAxiosError(503);
            throw new Error(`Unexpected URL: ${url}`);
        });

        let threw = false;
        try {
            await groqWithRetry(makeAxiosConfig(), 0);
        } catch {
            threw = true;
        }
        assert(threw, 'groqWithRetry should have thrown when all providers fail');
    });

    await test('All three fail → all three providers were attempted', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL)        throw makeAxiosError(503);
            if (url === OPENROUTER_URL)  throw makeAxiosError(503);
            if (url === OLLAMA_URL)      throw makeAxiosError(503);
            throw new Error(`Unexpected URL: ${url}`);
        });

        try { await groqWithRetry(makeAxiosConfig(), 0); } catch { /* expected */ }

        assert(_axiosCallLog.includes(GROQ_URL),       'Groq was not called');
        assert(_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter was not called');
        assert(_axiosCallLog.includes(OLLAMA_URL),     'Ollama was not called');
    });

    await test('No providers configured → descriptive error thrown', async () => {
        setEnv();  // clear all keys
        resetAxios(async () => { throw new Error('should not be called'); });

        let errorMessage = '';
        try {
            await groqWithRetry(makeAxiosConfig('Bearer undefined'), 0);
        } catch (e) {
            errorMessage = e.message;
        }
        assert(errorMessage.length > 0, 'Expected an error to be thrown');
        assert(
            errorMessage.toLowerCase().includes('no llm provider') ||
            errorMessage.toLowerCase().includes('provider'),
            `Expected "no llm provider" message, got: ${errorMessage}`
        );
    });

    // ── SECTION 5: No Groq token → Groq skipped, Ollama used directly ────────
    console.log('\n⚡ Offline mode — no Groq token → Ollama sole provider');

    await test('No Groq token → Groq tier skipped entirely', async () => {
        setEnv({ ollamaBase: OLLAMA_BASE });   // no PLAYGROUND_AI_KEY
        resetAxios(async (url) => {
            if (url === OLLAMA_URL) return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL called without Groq token: ${url}`);
        });

        // Auth header mimics what callers produce when resolveAIToken() returns undefined
        await groqWithRetry(makeAxiosConfig('Bearer undefined'), 0);
        assert(!_axiosCallLog.includes(GROQ_URL), 'Groq was called even though no token was configured');
    });

    await test('No Groq token → Ollama succeeds as sole provider', async () => {
        setEnv({ ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === OLLAMA_URL) return SUCCESS_RESPONSE;
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await groqWithRetry(makeAxiosConfig('Bearer undefined'), 0);
        assertEqual(result.data.choices[0].message.content, 'ok', 'Ollama sole-provider response mismatch');
        assert(_axiosCallLog.includes(OLLAMA_URL), 'Ollama was not called in offline mode');
    });

    // ── SECTION 6: Groq 4xx → NOT forwarded to fallback providers ────────────
    console.log('\n🚫 Groq 4xx — client error must not cascade to next tier');

    await test('Groq 400 → error thrown without trying OpenRouter', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL) throw makeAxiosError(400);
            throw new Error(`Unexpected URL called after Groq 4xx: ${url}`);
        });

        let threw = false;
        try {
            await groqWithRetry(makeAxiosConfig(), 0);
        } catch {
            threw = true;
        }
        assert(threw, 'groqWithRetry should have rethrown the 4xx error');
        assert(!_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter was called after Groq 4xx — should not cascade');
        assert(!_axiosCallLog.includes(OLLAMA_URL),     'Ollama was called after Groq 4xx — should not cascade');
    });

    await test('Groq 401 (bad API key) → error thrown, no fallback', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real', ollamaBase: OLLAMA_BASE });
        resetAxios(async (url) => {
            if (url === GROQ_URL) throw makeAxiosError(401);
            throw new Error(`Unexpected URL called after Groq 4xx: ${url}`);
        });

        let threw = false;
        try {
            await groqWithRetry(makeAxiosConfig(), 0);
        } catch {
            threw = true;
        }
        assert(threw, 'groqWithRetry should have rethrown the 401');
        assert(!_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter should not be tried after a 401');
    });

    await test('Groq 422 (unprocessable entity) → error thrown, no fallback', async () => {
        setEnv({ groqKey: 'gsk_real', openrouterKey: 'or_real' });
        resetAxios(async (url) => {
            if (url === GROQ_URL) throw makeAxiosError(422);
            throw new Error(`Unexpected URL called after Groq 4xx: ${url}`);
        });

        let threw = false;
        try {
            await groqWithRetry(makeAxiosConfig(), 0);
        } catch {
            threw = true;
        }
        assert(threw, 'groqWithRetry should have rethrown the 422');
        assert(!_axiosCallLog.includes(OPENROUTER_URL), 'OpenRouter should not be tried after a 422');
    });

    // ── SECTION 7: resolveOllamaModel utility ────────────────────────────────
    console.log('\n🔧 resolveOllamaModel utility');

    await test('Known Groq model maps to Ollama tag', () => {
        delete process.env.OLLAMA_MODEL;
        const tag = resolveOllamaModel('llama-3.3-70b-versatile');
        assertEqual(tag, 'llama3.3', `unexpected Ollama tag: ${tag}`);
    });

    await test('Unknown Groq model falls back to llama3.2', () => {
        delete process.env.OLLAMA_MODEL;
        const tag = resolveOllamaModel('some-unknown-model');
        assertEqual(tag, 'llama3.2', `expected llama3.2 fallback, got ${tag}`);
    });

    await test('OLLAMA_MODEL env var overrides the map', () => {
        process.env.OLLAMA_MODEL = 'custom-model:latest';
        const tag = resolveOllamaModel('llama-3.3-70b-versatile');
        delete process.env.OLLAMA_MODEL;
        assertEqual(tag, 'custom-model:latest', `expected env override, got ${tag}`);
    });

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailed tests:');
        failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
    }
    console.log('='.repeat(50));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Unexpected error in test runner:', e);
    process.exit(1);
});
