'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { publicAIError } = require('../lib/ai-errors');
const capacity = require('../utils/ai-capacity');

const noop = () => {};
const logger = { info: noop, debug: noop, error: noop, warn: noop };
function load(file, stubs) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), {
        module, exports: module.exports,
        require: name => stubs[name] || (name === 'node:crypto' ? require(name)
            : name === '../lib/playground-latency' ? require(name) : {}),
        process: { env: {} }, console: logger,
        AbortController, AbortSignal, URL, Buffer, setTimeout, clearTimeout, Date
    }, { filename: file });
    return module.exports;
}
function routes(result, gate = { allowed: true }) {
    const handlers = {}, events = [];
    let disposed = 0;
    let executionCount = 0, capacityCount = 0;
    const shared = {
        logger,
        orchestrator: { execute: async () => {
            executionCount++;
            if (result instanceof Error) throw result;
            return result;
        } },
        setupSSE: res => ({
            isClientDisconnected: () => false,
            sseStage: event => events.push(event),
            cleanup: () => res.end()
        }),
        fastStreamPersonality: async (res, answer) => { events.push({ type: 'done', fullContent: answer }); res.end(); }
    };
    const module = load('../routes/nyan-ai/playground', {
        'express-rate-limit': () => noop,
        '../../lib/playground-input': require('../lib/playground-input'),
        './shared': shared,
        './media': { normalizePhotoList: () => [], normalizeDocList: () => [], collectAudioList: () => [],
            buildDocAttachmentMeta: () => [], extractZipAttachments: async () => ({ photos: [], audios: [], documents: [] }),
            transcribeAudioList: async () => [], fetchUrlsFromMessage: async () => {} },
        '../../utils/doc-cache': { processAndCacheDocList: async () => {} },
        '../../utils/attachment-ingestion': { AttachmentIngestion: { ingest: async () => ({}) } },
        '../../utils/context-extractor': { recordInMemory: noop },
        '../../utils/preflight-router': { detectCompoundQuery: () => null },
        '../../lib/url-fetcher': { extractUrls: () => [] },
        '../../utils/url-anchor-store': { tickAnchors: noop },
        '../../utils/playground-capacity': { recordActivity: noop, consumeToken: async () => { capacityCount++; return gate; } },
        '../../lib/public-reader': { PublicReader: class { async dispose() { disposed++; } } },
        '../../lib/ai-errors': { publicAIError }
    });
    module.registerPlaygroundRoutes({
        get: noop, delete: noop, post: (path, ...args) => { handlers[path] = args.at(-1); }
    }, {});
    return {
        events,
        get disposed() { return disposed; },
        get executionCount() { return executionCount; },
        get capacityCount() { return capacityCount; },
        async run(path, body = { message: 'synthetic question' }) {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.set = (key, value) => { res.headers[key] = value; return res; };
            res.status = status => { res.statusCode = status; return res; };
            res.json = body => { res.body = body; return res; };
            res.write = noop;
            res.end = () => { res.ended = true; res.emit('finish'); };
            await handlers[path]({ ip: 'fixture', body, connection: { remoteAddress: 'fixture' } }, res);
            assert.equal(res.listenerCount('close'), 0);
            return res;
        }
    };
}

test('both playground endpoints reject empty and malformed input before spending capacity', async () => {
    for (const path of ['/api/playground', '/api/playground/stream']) {
        for (const body of [{ message: '' }, { message: '  \n ' }, {}, null, { message: 42 }]) {
            const fixture = routes({ success: true, answer: 'must not run', badge: 'unverified' });
            const response = await fixture.run(path, body);
            assert.equal(response.statusCode, 400);
            assert.equal(response.body.code, 'PLAYGROUND_INPUT_REQUIRED');
            assert.equal(fixture.capacityCount, 0);
            assert.equal(fixture.executionCount, 0);
            assert.equal(fixture.disposed, 0);
        }
    }
});

test('both playground endpoints still accept attachment-only requests', async () => {
    for (const path of ['/api/playground', '/api/playground/stream']) {
        const fixture = routes({ success: true, answer: 'attachment answer', badge: 'unverified' });
        const response = await fixture.run(path, { document: { data: 'ZmFrZQ==', name: 'notes.txt' } });
        assert.equal(response.statusCode, 200);
        assert.equal(fixture.capacityCount, 1);
        assert.equal(fixture.executionCount, 1);
    }
});

test('JSON and SSE report the same sanitized capacity/provider failures', async t => {
    const accounting = Object.assign(capacity.problem('private internal detail', 503), {
        providerCompleted: true, capacityOperation: 'settlement'
    });
    const errors = [
        capacity.problem('Shared daily AI budget exhausted.'),
        Object.assign(capacity.problem('private internal detail', 503), { capacityReason: 'deadline' }),
        accounting,
        Object.assign(new Error('provider private detail'), { response: { status: 429 } }),
        Object.assign(new Error('provider private detail'), { response: { status: 401 } }),
        ...['AI_RESPONSE_EMPTY', 'AI_RESPONSE_TRUNCATED', 'AI_AUDIT_INVALID']
            .map(code => Object.assign(new Error('provider private detail'), { code }))
    ];
    for (const error of errors) {
        const failure = publicAIError(error);
        await t.test(`${failure.code}/${failure.status}/${error.capacityReason || 'provider'}`, async () => {
            const fixture = routes({ success: false, error: error.message, failure });
            const json = await fixture.run('/api/playground');
            await fixture.run('/api/playground/stream');
            assert.equal(json.statusCode, failure.status);
            assert.equal(json.body.code, failure.code);
            assert.equal(json.body.error, failure.message);
            const event = fixture.events.find(event => event.type === 'error');
            assert.equal(event.message, failure.message);
            assert.equal(event.status, failure.status);
            assert.equal(event.code, failure.code);
            assert.doesNotMatch(JSON.stringify([json.body, event]), /private detail|private internal/);
            assert.equal(fixture.disposed, 2);
        });
    }
    await t.test('early admission facade failures retain 503 instead of being forced to 429', async () => {
        const failure = publicAIError(capacity.problem('private accounting error', 503));
        const fixture = routes(null, { allowed: false, ...failure, reason: failure.message });
        const json = await fixture.run('/api/playground');
        const stream = await fixture.run('/api/playground/stream');
        assert.equal(json.statusCode, 503);
        assert.equal(fixture.events.find(e => e.type === 'error').status, 503);
        assert.equal(stream.ended, true);
    });
    await t.test('thrown capacity failures follow the same contract and clean up the stream', async () => {
        const fixture = routes(accounting);
        const json = await fixture.run('/api/playground');
        const stream = await fixture.run('/api/playground/stream');
        assert.equal(json.statusCode, 503);
        assert.match(fixture.events.find(e => e.type === 'error').message, /usage could not be recorded/);
        assert.equal(stream.ended, true);
        assert.equal(fixture.disposed, 2);
    });
    await t.test('normal provider answers pass through both surfaces unchanged', async () => {
        const answer = 'Natural fixture answer, not a canned identity response.';
        const fixture = routes({ success: true, answer, badge: 'unverified', fastPath: true });
        const json = await fixture.run('/api/playground');
        await fixture.run('/api/playground/stream');
        assert.equal(json.statusCode, 200);
        assert.equal(json.body.response, answer);
        assert.equal(fixture.events.find(e => e.type === 'done').fullContent, answer);
    });
});

test('reasoning and pipeline retain error classification and actual attempts', async () => {
    const failure = Object.assign(capacity.problem('Shared AI capacity could not be checked.', 503), {
        attempts: 1, capacityOperation: 'reservation'
    });
    const backend = () => ({ model: 'fixture-model', url: 'https://fixture.invalid', timeouts: { reasoning: 1000 } });
    const { PipelineOrchestrator, PipelineState } = load('../utils/pipeline-orchestrator', {
        '../lib/logger': logger,
        '../lib/ai-errors': { publicAIError },
        '../lib/llm-completion': require('../lib/llm-completion'),
        '../config/constants': { getLLMBackend: backend, getAuditBackend: backend, AI_MODELS: {} },
        './time-format': { createQueryTimestamp: () => ({}) },
        './data-package': { DataPackage: class { writeStage() {} }, STAGE_IDS: {} },
        './pipeline-checkpoint': { globalCheckpointStore: { restore: () => null, save: noop, clear: noop },
            buildResumableSnapshot: () => ({}) },
        './attachment-ingestion': { AttachmentIngestion: { ingest: async () => ({ hasAttachments: false, files: [], extractedText: '' }) } },
        './context-extractor': { extractContext: () => ({ attachmentContext: null }),
            mergeContextForTickerDetection: () => 'synthetic question' }
    });
    const orchestrator = new PipelineOrchestrator({ groqWithRetry: async () => { throw failure; } });
    await assert.rejects(orchestrator.stepReasoning(new PipelineState(), { query: 'synthetic question' }),
        e => e === failure && e.attempts === 1);
    orchestrator.stepPreflight = async state => { state.preflight = {}; };
    orchestrator.stepContextBuild = async state => { state.systemMessages = []; };
    const result = await orchestrator.run({ query: 'synthetic question' });
    assert.equal(result.success, false);
    assert.equal(result.error, failure.message);
    assert.equal(result.failure.code, 'AI_CAPACITY');
    assert.equal(result.failure.status, 503);
    assert.equal(result.attempts, 1);
    assert.doesNotMatch(result.error, /Groq|3 retries/);
});

test('invalid audit contracts stop the pipeline without paid search or generation retries', async () => {
    const backend = () => ({ model: 'fixture-model', url: 'https://fixture.invalid', timeouts: {} });
    let auditCalls = 0;
    const { PipelineOrchestrator } = load('../utils/pipeline-orchestrator', {
        '../lib/logger': logger,
        '../lib/ai-errors': { publicAIError },
        '../lib/llm-completion': require('../lib/llm-completion'),
        '../config/constants': { getLLMBackend: backend, getAuditBackend: backend, AI_MODELS: {} },
        '../prompts/audit-protocol': { isFalseDichotomy: () => false },
        './time-format': { createQueryTimestamp: () => ({}) },
        './two-pass-verification': { runAuditPass: async () => {
            auditCalls++;
            return { verdict: 'REJECTED', confidence: 0, providerContractValid: false, error: 'JSON_PARSE_ERROR' };
        } }
    });
    const orchestrator = new PipelineOrchestrator({});
    orchestrator.isIdentityQuery = () => false;
    const state = { mode: 'general', draftAnswer: 'An answer', preflight: {},
        transition: noop, writeToPackage: () => assert.fail('invalid audit must not checkpoint as valid') };
    await assert.rejects(orchestrator.stepAudit(state, { query: 'Synthetic question?', extractedContent: [] }),
        error => error.code === 'AI_AUDIT_INVALID' && error.providerCompleted);
    assert.equal(auditCalls, 1);
});

test('compound questions stop on a capacity failure rather than paying for later parts', async () => {
    const failure = publicAIError(Object.assign(capacity.problem('accounting failure', 503), { providerCompleted: true }));
    let calls = 0;
    const { executeCompoundQuery } = load('../routes/nyan-ai/shared', {
        '../../lib/logger': logger,
        '../../utils/groq-client': { resolveAIToken: () => 'synthetic-fixture' },
        '../../config/constants': {
            getLLMBackend: () => ({ url: 'https://fixture.invalid' }),
            getAuditBackend: () => ({ url: 'https://fixture.invalid' })
        },
        '../../lib/tools/registry': { loadTools: noop },
        '../../utils/pipeline-orchestrator': { createPipelineOrchestrator: () => ({
            execute: async () => { calls++; return { success: false, failure }; }
        }) }
    });
    await assert.rejects(executeCompoundQuery([
        { label: 'one', query: 'synthetic one' }, { label: 'two', query: 'synthetic two' }
    ], {}), e => e.code === 'AI_CAPACITY' && e.status === 503);
    assert.equal(calls, 1);
});
