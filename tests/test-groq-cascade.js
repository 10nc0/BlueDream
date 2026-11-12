#!/usr/bin/env node
'use strict';
// Compatibility entrypoint for the former cascade suite: all app-managed
// inference now uses one provider, never an unrelated fallback model.
const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const usage = require('../utils/playground-usage');
const { groqWithRetry, kimiFirst, resolveAIToken } = require('../utils/groq-client');
const { callWithTools, runToolCall } = require('../utils/llm-tool-runner');
const { LLM_MODEL, LLM_API_URL } = require('../config/llm');
const { AI_MODELS, getLLMBackend, getFastLLMBackend, getAuditBackend, LLM_BACKENDS } = require('../config/constants');

const request = () => ({ url: 'https://api.groq.com/openai/v1/chat/completions',
    data: { model: 'old-model', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 8 },
    config: { timeout: 1000, headers: { Authorization: 'Bearer old-provider-key' } } });

test('Muse Ember provider contracts (offline)', async t => {
    const original = axios.post;
    const record = usage.recordUsage;
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'offline-fixture-openrouter';
    usage.recordUsage = () => {};
    try {
        await t.test('all configured roles, image and audio use the same model', () => {
            assert.equal(LLM_MODEL, 'meta/muse-ember');
            for (const backend of [...Object.values(LLM_BACKENDS), getLLMBackend(), getFastLLMBackend(), getAuditBackend()]) {
                assert.equal(backend.model, LLM_MODEL);
                assert.equal(backend.url, LLM_API_URL);
            }
            for (const role of ['TEXT_MODEL', 'VISION_MODEL', 'VISION', 'AUDIO_MODEL'])
                assert.equal(AI_MODELS[role], LLM_MODEL);
            for (const role of ['audit', 'vision', 'playground'])
                assert.equal(resolveAIToken(role), 'offline-fixture-openrouter');
        });
        await t.test('legacy and Kimi entrypoints both use OpenRouter; preserve body and total deadline', async () => {
            let calls = 0;
            axios.post = async (url, data, options) => {
                calls++;
                assert.equal(url, LLM_API_URL);
                assert.equal(data.model, LLM_MODEL);
                assert.equal(data.max_tokens, 8);
                assert.equal(options.headers.Authorization, 'Bearer offline-fixture-openrouter');
                assert.ok(options.signal instanceof AbortSignal);
                return { data: { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } } };
            };
            await groqWithRetry(request(), 0);
            await kimiFirst(request(), 0);
            assert.equal(calls, 2);
        });
        await t.test('transient retries keep one model and the same signal', async () => {
            const signals = [];
            axios.post = async (_url, body, options) => {
                signals.push(options.signal);
                assert.equal(body.model, LLM_MODEL);
                assert.deepEqual(body.reasoning, { effort: 'low' });
                if (signals.length === 1) throw Object.assign(new Error('busy'), {
                    response: { status: 429, headers: { 'retry-after': '0' } }
                });
                return { data: {} };
            };
            await groqWithRetry(request(), 1);
            assert.equal(signals.length, 2);
            assert.equal(signals[0], signals[1]);
        });
        await t.test('auth/client failures never cascade or retry', async () => {
            for (const status of [400, 401, 403, 404]) {
                let calls = 0;
                const failure = Object.assign(new Error('client failure'), { response: { status } });
                axios.post = async () => { calls++; throw failure; };
                await assert.rejects(groqWithRetry(request(), 3), e => e === failure);
                assert.equal(calls, 1);
            }
        });
        await t.test('missing OpenRouter key fails before any other provider is tried', async () => {
            delete process.env.OPENROUTER_API_KEY;
            axios.post = async () => { throw new Error('must not call'); };
            await assert.rejects(groqWithRetry(request()), /OPENROUTER_API_KEY/);
            process.env.OPENROUTER_API_KEY = 'offline-fixture-openrouter';
        });
        await t.test('local admission/budget failures never retry', async () => {
            let calls = 0;
            const failure = Object.assign(new Error('budget limit'), { code: 'AI_CAPACITY', status: 429 });
            axios.post = async () => { calls++; throw failure; };
            await assert.rejects(groqWithRetry(request(), 3), e => e === failure);
            assert.equal(calls, 1);
        });
        await t.test('pre-cancelled request makes no provider call', async () => {
            const controller = new AbortController();
            controller.abort(new Error('caller left'));
            const input = request();
            input.config.signal = controller.signal;
            axios.post = async () => { throw new Error('must not call'); };
            await assert.rejects(groqWithRetry(input), /caller left/);
        });
        await t.test('cancellation in flight stops waiting and prevents another attempt', async () => {
            const controller = new AbortController();
            const input = request();
            input.config.signal = controller.signal;
            let calls = 0;
            axios.post = () => { calls++; queueMicrotask(() => controller.abort(new Error('disconnect'))); return new Promise(() => {}); };
            await assert.rejects(groqWithRetry(input, 3), /disconnect/);
            assert.equal(calls, 1);
        });
        await t.test('zero retries means exactly one attempt on transient errors', async () => {
            let calls = 0;
            axios.post = async () => { calls++; throw Object.assign(new Error('unavailable'), { response: { status: 503 } }); };
            await assert.rejects(groqWithRetry(request(), 0), /unavailable/);
            assert.equal(calls, 1);
        });
        await t.test('malformed tool arguments fail explicitly instead of becoming an empty object', async () => {
            await assert.rejects(runToolCall({
                function: { name: 'add_numbers', arguments: '{"a":' }
            }, () => ({ name: 'add-numbers', parameters: {}, execute: () => 42 })),
            error => error.code === 'LLM_TOOL_ARGUMENTS_INVALID');
            await assert.rejects(runToolCall({
                function: { name: 'add_numbers', arguments: '[]' }
            }, () => ({ name: 'add-numbers', parameters: {}, execute: () => 42 })),
            error => error.code === 'LLM_TOOL_ARGUMENTS_INVALID');
        });
        await t.test('tool requests preserve bounded retries, output and provider routing', async () => {
            let requestArgs;
            const result = await callWithTools({
                groqCall: async (...args) => {
                    requestArgs = args;
                    return { data: { model: LLM_MODEL, choices: [{ message: { tool_calls: [] } }] } };
                },
                url: LLM_API_URL,
                model: LLM_MODEL,
                messages: [{ role: 'user', content: 'synthetic fixture' }],
                tools: [],
                toolChoice: 'required',
                maxTokens: 96,
                maxRetries: 0,
                provider: { allow_fallbacks: false }
            });
            assert.equal(requestArgs[1], 0, 'live smoke can cap provider attempts at one per call');
            assert.equal(requestArgs[0].data.max_tokens, 96);
            assert.deepEqual(requestArgs[0].data.provider, { allow_fallbacks: false });
            assert.equal(result.model, LLM_MODEL);
        });
        await t.test('audio uses input_audio chat content and returns the transcription contract', async () => {
            const { transcribeAudio } = require('../utils/attachment-cascade');
            axios.post = async (url, body) => {
                assert.equal(url, LLM_API_URL);
                assert.equal(body.model, LLM_MODEL);
                const audio = body.messages[0].content.find(part => part.type === 'input_audio');
                assert.equal(audio.input_audio.format, 'ogg');
                assert.equal(audio.input_audio.data, Buffer.from('synthetic-audio').toString('base64'));
                return { data: { choices: [{ message: { content: 'synthetic transcription' } }] } };
            };
            const result = await transcribeAudio(Buffer.from('synthetic-audio'), 'voice.ogg', {});
            assert.deepEqual(result, { success: true, data: { text: 'synthetic transcription', type: 'transcription' } });
        });
        await t.test('unsupported audio fails explicitly without paid work', async () => {
            const { transcribeAudio } = require('../utils/attachment-cascade');
            axios.post = async () => { throw new Error('must not call'); };
            const result = await transcribeAudio(Buffer.from('fixture'), 'voice.unknown', {});
            assert.equal(result.success, false);
            assert.match(result.error, /Unsupported audio format/);
        });
    } finally {
        axios.post = original;
        usage.recordUsage = record;
        if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = previous;
    }
});
