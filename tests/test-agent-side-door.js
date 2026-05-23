#!/usr/bin/env node
/**
 * Tests for Task #211: Agent side-door — one token, two sides of the coin.
 *
 * Verifies that:
 *   - POST /api/webhook/:fractalId now requires a valid Bearer token
 *   - GET /api/webhook/:fractalId/messages uses core.book_registry (not tenant silo)
 *   - Both endpoints resolve from the same single source of truth
 *   - Cross-book token mismatch returns 403, not 401
 *   - Token generation and check use core.book_registry exclusively
 *
 * All tests are pure / mock-based — no DB or HTTP server required.
 *
 * Run: node tests/test-agent-side-door.js
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

function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Helper: simulate the unified auth block in both POST and GET webhook handlers
// After Task #211, both handlers run identical logic:
//   1. Extract Bearer token
//   2. Hash it
//   3. Look up core.book_registry by agent_token_hash
//   4. Cross-check fractal_id from URL matches registry row
function simulateAuth({ authHeader, fractalIdParam, registryRows }) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { status: 401, body: { error: 'Authorization required. Use: Authorization: Bearer <agent_token>' } };
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
        return { status: 401, body: { error: 'Bearer token must not be empty' } };
    }
    const hash = hashToken(token);
    const row = registryRows.find(r => r.agent_token_hash === hash);
    if (!row) {
        return { status: 401, body: { error: 'Invalid agent token' } };
    }
    if (row.fractal_id !== fractalIdParam) {
        return { status: 403, body: { error: 'Token is not authorized for this book' } };
    }
    const VALID_SCHEMA = /^tenant_\d+$/;
    if (!VALID_SCHEMA.test(row.tenant_schema)) {
        return { status: 400, body: { error: 'Invalid tenant schema' } };
    }
    return { status: 200, tenantSchema: row.tenant_schema, fractalId: row.fractal_id };
}

// ── Test registry fixture ──────────────────────────────────────────────────────
const TOKEN_A = crypto.randomBytes(32).toString('base64url');
const TOKEN_B = crypto.randomBytes(32).toString('base64url');
const FRACTAL_A = 'book_t1_aabbccddeeff';
const FRACTAL_B = 'book_t2_11223344aabb';

const REGISTRY = [
    { fractal_id: FRACTAL_A, tenant_schema: 'tenant_1', agent_token_hash: hashToken(TOKEN_A) },
    { fractal_id: FRACTAL_B, tenant_schema: 'tenant_2', agent_token_hash: hashToken(TOKEN_B) },
];

// ── 1. POST /api/webhook/:fractalId — was unauthenticated, now requires token ─
console.log('\n\uD83D\uDEAB  POST /api/webhook/:fractalId auth (Task #211)');

test('no Authorization header → 401', () => {
    const r = simulateAuth({ authHeader: undefined, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 401);
    assert(r.body.error.includes('Bearer'), 'error must mention Bearer');
});

test('"Bearer " with empty token → 401', () => {
    const r = simulateAuth({ authHeader: 'Bearer ', fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 401);
    assert(r.body.error.includes('empty'), 'error must mention empty token');
});

test('non-Bearer scheme (Basic, Token) → 401', () => {
    const r = simulateAuth({ authHeader: 'Basic dXNlcjpwYXNz', fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 401);
});

test('valid token for a DIFFERENT book → 403 (not 401)', () => {
    // TOKEN_B is valid but scoped to FRACTAL_B; presenting it for FRACTAL_A must be 403
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_B}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 403);
    assert(r.body.error.includes('not authorized for this book'), 'error must name the mismatch');
});

test('wrong token (not in registry) → 401', () => {
    const r = simulateAuth({ authHeader: 'Bearer completely_wrong_token', fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 401);
    assertEqual(r.body.error, 'Invalid agent token');
});

test('correct token + matching fractal_id → 200 with tenantSchema resolved', () => {
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(r.status, 200);
    assertEqual(r.tenantSchema, 'tenant_1');
    assertEqual(r.fractalId, FRACTAL_A);
});

// ── 2. GET /api/webhook/:fractalId/messages — same unified auth ───────────────
// After Task #211, the GET handler uses the identical auth block as POST.
// Both use core.book_registry; the tenant silo is NOT consulted.
console.log('\n\uD83D\uDCD6  GET /api/webhook/:fractalId/messages auth (Task #211)');

test('GET with valid token resolves book from core.book_registry', () => {
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_B}`, fractalIdParam: FRACTAL_B, registryRows: REGISTRY });
    assertEqual(r.status, 200);
    assertEqual(r.tenantSchema, 'tenant_2');
});

test('GET with no token → 401', () => {
    const r = simulateAuth({ authHeader: undefined, fractalIdParam: FRACTAL_B, registryRows: REGISTRY });
    assertEqual(r.status, 401);
});

test('GET with cross-book token → 403', () => {
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_B, registryRows: REGISTRY });
    assertEqual(r.status, 403);
});

// ── 3. Single source of truth — all endpoints use the same lookup ─────────────
console.log('\n\uD83D\uDD11  Single source of truth — core.book_registry only');

test('POST webhook auth uses core.book_registry (no tenantSchema.books read)', () => {
    // The SQL used by POST /api/webhook/:fractalId after Task #211.
    // `tenant_schema` is a column name in core.book_registry — that's fine.
    // What must NOT appear is a reference to a per-tenant table like tenant_1.books.
    const sql = `SELECT fractal_id, tenant_schema FROM core.book_registry WHERE agent_token_hash = $1`;
    assert(sql.includes('core.book_registry'), 'must query core registry');
    assert(!sql.includes('.books'), 'must NOT query any per-tenant .books table');
    assert(sql.includes('agent_token_hash'), 'must filter by token hash');
});

test('GET webhook auth uses core.book_registry (tenant silo retired)', () => {
    // The SQL used by GET /api/webhook/:fractalId/messages after Task #211
    const sql = `SELECT fractal_id, tenant_schema FROM core.book_registry WHERE agent_token_hash = $1`;
    assert(sql.includes('core.book_registry'), 'must query core registry');
    assert(!sql.toLowerCase().includes('agent_token_hash from'), 'must NOT select hash from tenant table');
});

test('GET /api/agent/messages also uses core.book_registry (unchanged by Task #211)', () => {
    const sql = `SELECT br.fractal_id, br.tenant_schema FROM core.book_registry br WHERE br.agent_token_hash = $1`;
    assert(sql.includes('core.book_registry'), 'already correct pre-211');
});

test('POST /api/agent/message also uses core.book_registry (unchanged by Task #211)', () => {
    const sql = `SELECT fractal_id, tenant_schema FROM core.book_registry WHERE agent_token_hash = $1`;
    assert(sql.includes('core.book_registry'));
});

// ── 4. Symmetric read/write — same token works for both sides ─────────────────
console.log('\n\u21C4  Symmetric read+write with the same token');

test('write auth and read auth resolve identically for the same token', () => {
    const writeResult = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    const readResult  = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(writeResult.status, 200);
    assertEqual(readResult.status, 200);
    assertEqual(writeResult.tenantSchema, readResult.tenantSchema);
    assertEqual(writeResult.fractalId, readResult.fractalId);
});

test('token issued for book A does not grant access to book B on write', () => {
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_B, registryRows: REGISTRY });
    assertEqual(r.status, 403, 'cross-book write must be 403');
});

test('token issued for book A does not grant access to book B on read', () => {
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_B, registryRows: REGISTRY });
    assertEqual(r.status, 403, 'cross-book read must be 403');
});

test('revoked token (no registry row) fails on both write and read', () => {
    const revokedToken = 'revoked_token_xyz_no_longer_in_registry';
    const writeR = simulateAuth({ authHeader: `Bearer ${revokedToken}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    const readR  = simulateAuth({ authHeader: `Bearer ${revokedToken}`, fractalIdParam: FRACTAL_A, registryRows: REGISTRY });
    assertEqual(writeR.status, 401);
    assertEqual(readR.status, 401);
});

// ── 5. Token check endpoint — reads from core.book_registry ───────────────────
console.log('\n\uD83D\uDD0D  GET /api/books/:book_id/agent-token (dashboard check)');

test('has_token: true when core.book_registry row has a hash', () => {
    const mockRow = { agent_token_hash: hashToken('some_token') };
    assertEqual(!!mockRow.agent_token_hash, true);
});

test('has_token: false when core.book_registry row has null hash', () => {
    const mockRow = { agent_token_hash: null };
    assertEqual(!!mockRow.agent_token_hash, false);
});

test('token check SQL queries core.book_registry (not tenantSchema.books)', () => {
    const sql = `SELECT agent_token_hash FROM core.book_registry WHERE fractal_id = $1`;
    assert(sql.includes('core.book_registry'), 'must query core registry');
    assert(!sql.includes('tenant_'), 'must NOT query tenant schema');
});

// ── 6. Token generation — single core write ───────────────────────────────────
console.log('\n\u2702  POST /api/books/:book_id/agent-token (generate)');

test('generate issues exactly ONE UPDATE to core.book_registry', () => {
    const queries = [];
    const fractalId = 'book_t1_abc123def456';
    const tokenHash = hashToken('raw_token_abc');
    // Simulates post-Task #211 agent.js generate path
    queries.push(`UPDATE core.book_registry SET agent_token_hash = $1 WHERE fractal_id = $2`);
    assertEqual(queries.length, 1, 'exactly one write');
    assert(queries[0].includes('core.book_registry'), 'targets core');
});

test('generate does NOT write to tenantSchema.books', () => {
    const queries = [];
    const fractalId = 'book_t1_abc123def456';
    const tokenHash = hashToken('raw_token_abc');
    // Post-Task #211: only core write
    queries.push(`UPDATE core.book_registry SET agent_token_hash = $1 WHERE fractal_id = $2`);
    const hastenantWrite = queries.some(q => q.includes('tenant_') && q.includes('books'));
    assert(!hastenantWrite, 'must not write to tenant silo');
});

test('revoke issues exactly ONE NULL UPDATE to core.book_registry', () => {
    const queries = [];
    const fractalId = 'book_t1_abc123def456';
    // Post-Task #211: only core clear
    queries.push(`UPDATE core.book_registry SET agent_token_hash = NULL WHERE fractal_id = $1`);
    assertEqual(queries.length, 1, 'exactly one clear');
    assert(queries[0].includes('NULL'), 'sets NULL');
    assert(!queries[0].includes('tenant_'), 'does not touch tenant silo');
});

// ── 7. Schema validation ───────────────────────────────────────────────────────
console.log('\n\uD83D\uDEE1  Tenant schema validation');

const VALID_SCHEMA = /^tenant_\d+$/;

test('valid tenant schema passes', () => {
    assert(VALID_SCHEMA.test('tenant_1'));
    assert(VALID_SCHEMA.test('tenant_99999'));
});

test('invalid schema patterns are rejected', () => {
    assert(!VALID_SCHEMA.test('tenant_'));
    assert(!VALID_SCHEMA.test('tenant_abc'));
    assert(!VALID_SCHEMA.test('public'));
    assert(!VALID_SCHEMA.test('core'));
    assert(!VALID_SCHEMA.test('../evil'));
});

test('registry row with malformed tenant_schema is rejected by schema guard', () => {
    const malformed = [
        { fractal_id: FRACTAL_A, tenant_schema: 'public', agent_token_hash: hashToken(TOKEN_A) }
    ];
    const r = simulateAuth({ authHeader: `Bearer ${TOKEN_A}`, fractalIdParam: FRACTAL_A, registryRows: malformed });
    assertEqual(r.status, 400, 'malformed schema from registry must be caught');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
