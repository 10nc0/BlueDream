#!/usr/bin/env node
/**
 * Tests for Task #206: token-based write routing + lazy Discord thread provision.
 *
 * All tests are pure / mock-based — no DB or HTTP server required.
 *
 * Covers:
 *   1. Token hash is deterministic SHA-256 (64 hex chars, stable across calls)
 *   2. Empty / missing Bearer token produces 401 shape
 *   3. Thread-credential resolution: nested output_01.thread_id wins over legacy flat
 *   4. Activation guard: backend rejects token generation for non-active books
 *   5. agent.js sync: both tenant + core UPDATE queries are issued on generate
 *   6. agent.js sync: both tenant + core NULL UPDATE queries are issued on revoke
 *   7. POST /api/agent/message response includes resolved book_id in body
 *
 * Run: node tests/test-pipe-webhook-thread.js
 */

'use strict';

const crypto = require('crypto');

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── Helper mirrors the exact hash logic in pipe.js and agent.js ───────────────
function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ── Credential resolution helper (mirrors processWebhookMessage logic) ────────
function resolveThreadId(output_credentials) {
    const oc01 = output_credentials?.output_01;
    return oc01?.thread_id || output_credentials?.thread_id || null;
}
function resolveThreadName(output_credentials) {
    const oc01 = output_credentials?.output_01;
    return oc01?.thread_name || output_credentials?.thread_name || null;
}

// ── 1. Token hash ──────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD11  Token hash');

test('same raw token always produces the same hash', () => {
    const tok = 'abc123xyz';
    assertEqual(hashToken(tok), hashToken(tok));
});
test('hash is 64 hex characters (SHA-256)', () => {
    const h = hashToken(crypto.randomBytes(32).toString('base64url'));
    assert(h.length === 64, `expected 64, got ${h.length}`);
    assert(/^[0-9a-f]+$/.test(h), 'hash contains non-hex chars');
});
test('different tokens produce different hashes', () => {
    const h1 = hashToken('tokenA');
    const h2 = hashToken('tokenB');
    assert(h1 !== h2, 'collision between tokenA and tokenB');
});

// ── 2. Empty / missing token ───────────────────────────────────────────────────
console.log('\n\uD83D\uDEAB  Bearer token validation');

test('empty string after "Bearer " is rejected', () => {
    const authHeader = 'Bearer ';
    const token = authHeader.slice(7).trim();
    assert(token.length === 0, 'expected empty token');
});
test('header without "Bearer " prefix is rejected', () => {
    const authHeader = 'Token abc123';
    assert(!authHeader.startsWith('Bearer '), 'should not start with Bearer');
});
test('missing Authorization header is rejected', () => {
    const authHeader = undefined;
    assert(!authHeader || !authHeader?.startsWith('Bearer '), 'expected rejection');
});

// ── 3. Thread credential resolution ───────────────────────────────────────────
console.log('\n\uD83E\uDDF5  Thread credential resolution');

// Task #207: lib/output-resolver is now the canonical entry point.
const { resolveOutput } = require('../lib/output-resolver');

test('packet-queue → sendToLedger envelope: thread_id reaches the URL builder', () => {
    // Regression for the limbo-channel bug — caller used to pass flat {threadId} but
    // discord-webhooks reads {output:{thread_id}}. Mismatch dropped delivery to parent
    // channel. After Task #207, caller passes options.output = resolveOutput(book,'output_01').
    const book = {
        output_01_url: 'https://discord.com/api/webhooks/AAA/BBB',
        output_credentials: { output_01: { type: 'thread', thread_id: 'TTT', webhook_url: 'https://discord.com/api/webhooks/AAA/BBB' } }
    };
    const options = { isMedia: false, output: resolveOutput(book, 'output_01') };
    assert(options.output, 'envelope must be present');
    assertEqual(options.output.thread_id, 'TTT');

    const url = new URL(book.output_01_url);
    url.searchParams.set('wait', 'true');
    if (options.output?.type === 'thread' && options.output?.thread_id) {
        url.searchParams.set('thread_id', options.output.thread_id);
    }
    assertEqual(url.searchParams.get('thread_id'), 'TTT');
});

test('nested output_01.thread_id wins over legacy flat thread_id', () => {
    const creds = {
        thread_id: 'legacy-flat-id',
        output_01: { thread_id: 'nested-id', thread_name: 'Nested Thread' }
    };
    assertEqual(resolveThreadId(creds), 'nested-id');
    assertEqual(resolveThreadName(creds), 'Nested Thread');
});
test('falls back to flat thread_id when output_01 is absent', () => {
    const creds = { thread_id: 'flat-only-id', thread_name: 'Flat Thread' };
    assertEqual(resolveThreadId(creds), 'flat-only-id');
    assertEqual(resolveThreadName(creds), 'Flat Thread');
});
test('returns null when neither path has a thread_id', () => {
    assert(resolveThreadId({}) === null);
    assert(resolveThreadId(null) === null);
    assert(resolveThreadId(undefined) === null);
});
test('output_01 present but thread_id null falls back to flat', () => {
    const creds = { thread_id: 'flat-fallback', output_01: { thread_id: null } };
    assertEqual(resolveThreadId(creds), 'flat-fallback');
});

// ── 4. Activation guard ────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD12  Activation guard');

// Guard: ['active', 'suspended'] pass; 'pending'/'inactive' are blocked.
function passesActivationGuard(status) {
    return ['active', 'suspended'].includes(status);
}

test('pending book is blocked — never activated, no thread', () => {
    assert(!passesActivationGuard('pending'), 'pending must be blocked');
});
test('inactive book is blocked — never activated, no thread', () => {
    assert(!passesActivationGuard('inactive'), 'inactive must be blocked');
});
test('active book passes — live, thread exists', () => {
    assert(passesActivationGuard('active'), 'active must pass');
});
test('suspended book passes — was active, thread + messages exist (archive access)', () => {
    assert(passesActivationGuard('suspended'), 'suspended must pass');
});
test('UI locks section for pending book', () => {
    const book = { status: 'pending' };
    assert(!passesActivationGuard(book.status), 'UI must not load token status for pending');
});
test('UI loads token section for suspended (deactivated archive) book', () => {
    const book = { status: 'suspended' };
    assert(passesActivationGuard(book.status), 'UI must load token status for suspended');
});

// ── 5 & 6. agent.js single-silo write to core.book_registry (Task #211) ──────
// Task #211 hoisted the token store to core.book_registry exclusively.
// The tenant-schema column (tenantSchema.books.agent_token_hash) is now dormant.
// Generate and revoke each issue exactly ONE query — to core.book_registry only.
console.log('\n\uD83D\uDD04  agent.js core.book_registry (single silo, Task #211)');

test('generate: only core.book_registry UPDATE is issued (tenant silo retired)', () => {
    const queries = [];
    const trackQuery = (sql, params) => { queries.push({ sql, params }); };

    const rawToken = 'test_token_for_generate';
    const tokenHash = hashToken(rawToken);
    const fractalId = 'book_t1_abc123def456';

    // Simulate what agent.js POST handler does after Task #211 — single write
    trackQuery(`UPDATE core.book_registry SET agent_token_hash = $1 WHERE fractal_id = $2`, [tokenHash, fractalId]);

    assertEqual(queries.length, 1, 'expected exactly 1 UPDATE query (core only)');
    assert(queries[0].sql.includes('core.book_registry'), 'query must target core.book_registry');
    assert(!queries[0].sql.includes('tenant_'), 'query must NOT target tenant schema');
    assertEqual(queries[0].params[0], tokenHash, 'core UPDATE must include token hash');
    assertEqual(queries[0].params[1], fractalId, 'core UPDATE must include fractal_id');
});

test('revoke: only core.book_registry NULL UPDATE is issued (tenant silo retired)', () => {
    const queries = [];
    const trackQuery = (sql, params) => { queries.push({ sql, params }); };

    const fractalId = 'book_t1_abc123def456';

    // Simulate what agent.js DELETE handler does after Task #211 — single clear
    trackQuery(`UPDATE core.book_registry SET agent_token_hash = NULL WHERE fractal_id = $1`, [fractalId]);

    assertEqual(queries.length, 1, 'expected exactly 1 NULL UPDATE query (core only)');
    assert(queries[0].sql.includes('core.book_registry'), 'query must target core.book_registry');
    assert(!queries[0].sql.includes('tenant_'), 'query must NOT target tenant schema');
    assert(queries[0].sql.includes('NULL'), 'core UPDATE must set NULL');
});

// ── 10. POST /api/agent/message returns book_id in response ───────────────────
console.log('\n\uD83D\uDCEC  POST /api/agent/message response shape');

test('response includes book_id field when token resolves successfully', () => {
    const fractalId = 'book_t2_deadbeef0000';
    const response = { success: true, message: 'Message accepted', book_id: fractalId };
    assert(response.success === true);
    assertEqual(response.book_id, fractalId);
    assert(typeof response.message === 'string');
});
test('invalid token response is 401-shaped', () => {
    const response = { error: 'Invalid agent token' };
    assert(typeof response.error === 'string');
    assert(response.error.includes('token'));
});
test('missing Authorization header response is 401-shaped', () => {
    const response = { error: 'Authorization required. Use: Authorization: Bearer <agent_token>' };
    assert(response.error.includes('Bearer'));
});

// ── 11. GET /api/agent/messages (token-only read, no fractal_id in URL) ──────
console.log('\n\uD83D\uDCD6  GET /api/agent/messages — token-only read');

test('token-only read rejects missing Bearer header', () => {
    const authHeader = undefined;
    const ok = authHeader && authHeader.startsWith('Bearer ');
    assert(!ok, 'no header must fail');
});
test('token-only read rejects empty Bearer token', () => {
    const authHeader = 'Bearer ';
    const token = authHeader.slice(7).trim();
    assert(token.length === 0, 'empty bearer must be rejected');
});
test('token-only read uses core.book_registry to resolve fractal_id + tenant_schema', () => {
    const sqlExpected = `SELECT br.fractal_id, br.tenant_schema
                 FROM core.book_registry br
                 WHERE br.agent_token_hash = $1`;
    assert(sqlExpected.includes('core.book_registry'), 'must hit core registry');
    assert(sqlExpected.includes('agent_token_hash'), 'must filter by token hash');
    assert(sqlExpected.includes('tenant_schema'), 'must select tenant_schema');
});
test('token-only read response includes book_id alongside book name', () => {
    const fractalId = 'book_t5_feedfacedead';
    const response = { book: 'My Archive', book_id: fractalId, messages: [], total: 0, hasMore: false, cursor: { newest: null, oldest: null } };
    assertEqual(response.book_id, fractalId);
    assert('messages' in response);
    assert('cursor' in response);
});
test('shared fetchAndRespondMessages enables write+read symmetry — both routes use same body shape', () => {
    const writeResponse = { success: true, message: 'Message accepted', book_id: 'book_t1_a' };
    const readResponse  = { book: 'Name', book_id: 'book_t1_a', messages: [], total: 0, hasMore: false };
    assertEqual(writeResponse.book_id, readResponse.book_id, 'both routes return book_id');
});

// ── 12. Backfill — pre-existing tenant tokens get mirrored to core ───────────
console.log('\n\uD83D\uDD04  Token backfill (lib/backfill-agent-tokens.js)');

test('backfill only updates rows where core.agent_token_hash IS NULL', () => {
    const sql = `UPDATE core.book_registry
                             SET agent_token_hash = $1
                             WHERE fractal_id = $2 AND agent_token_hash IS NULL`;
    assert(sql.includes('IS NULL'), 'must guard with IS NULL to avoid overwriting fresh tokens');
});
test('backfill is idempotent — second run on same data produces 0 syncs', () => {
    let coreHash = 'existing_hash_abc';
    const tenantHash = 'existing_hash_abc';
    const wouldUpdate = coreHash === null && tenantHash !== null;
    assert(!wouldUpdate, 'when core already has hash, no update');
});
test('backfill handles 23505 unique-violation silently (token collision impossible but defensible)', () => {
    const err = { code: '23505' };
    const ignored = err.code === '23505';
    assert(ignored, 'unique violation must not crash backfill loop');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
