#!/usr/bin/env node
/**
 * Regression tests for the fractal ID format guard used in
 * POST /api/webhook/:fractalId and GET /api/webhook/:fractalId/messages.
 *
 * Task #199: the old guard regex /^bridge_[a-z][0-9a-z]_.../ rejected every
 * ID the server actually generates (book_t{N}_… and dev_book_t{N}_…).
 * These tests lock the correct behaviour: parse via fractal-id.js, then
 * accept only 'book' and 'bridge' types.
 *
 * Run: node tests/test-pipe-id-format.js
 */

'use strict';

const { parse } = require('../utils/fractal-id');

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── Mirrors the exact guard logic now in pipe.js ─────────────────────────────
// Inline here so the test is self-contained and doesn't depend on an HTTP
// server — the guard is pure synchronous logic.
function isValidPipeId(fractalId) {
    const p = parse(fractalId);
    return !!(p && p.tenantId && (p.type === 'book' || p.type === 'bridge'));
}

// ── IDs that must be ACCEPTED ─────────────────────────────────────────────────
console.log('\n\u2705  IDs that must pass the pipe guard');

test('book_t1_abc123def456 — standard book ID', () => {
    assert(isValidPipeId('book_t1_abc123def456'), 'expected true');
});
test('dev_book_t1_4b8d1fa5ebe9 — dev-admin book ID (the bug report fixture)', () => {
    assert(isValidPipeId('dev_book_t1_4b8d1fa5ebe9'), 'expected true');
});
test('bridge_t3_aabbccddeeff — legacy bridge type still accepted', () => {
    assert(isValidPipeId('bridge_t3_aabbccddeeff'), 'expected true');
});
test('book_t12_abcdef123456 — two-digit tenant ID accepted', () => {
    assert(isValidPipeId('book_t12_abcdef123456'), 'expected true');
});
test('book_t999_abcdef123456 — three-digit tenant ID accepted', () => {
    assert(isValidPipeId('book_t999_abcdef123456'), 'expected true');
});

// ── IDs that must be REJECTED ─────────────────────────────────────────────────
console.log('\n\u274C  IDs that must fail the pipe guard');

test('msg_t1_abc123def456 — msg type must be rejected', () => {
    assert(!isValidPipeId('msg_t1_abc123def456'), 'expected false');
});
test('"garbage string" — random text must be rejected', () => {
    assert(!isValidPipeId('garbage string'), 'expected false');
});
test('"" — empty string must be rejected', () => {
    assert(!isValidPipeId(''), 'expected false');
});
test('null — null must be rejected', () => {
    assert(!isValidPipeId(null), 'expected false');
});
test('bridge_XX_abc123 — old legacy guard format must be rejected', () => {
    // The old regex accepted this; parse() now rejects it (XX isn't t+digits).
    assert(!isValidPipeId('bridge_XX_abc123'), 'expected false');
});
test('dev_book_t1_4b8d1fa5ebe9_extra — trailing junk must be rejected', () => {
    assert(!isValidPipeId('dev_book_t1_4b8d1fa5ebe9_extra'), 'expected false');
});

// ── Correct component extraction ──────────────────────────────────────────────
console.log('\n\uD83D\uDD0D  Component extraction');

test('dev_book_t1_4b8d1fa5ebe9 — type=book, tenantId=1, envPrefix=dev', () => {
    const p = parse('dev_book_t1_4b8d1fa5ebe9');
    assert(p, 'parse returned null');
    assertEqual(p.type, 'book');
    assertEqual(p.tenantId, 1);
    assertEqual(p.envPrefix, 'dev');
    assertEqual(p.hash, '4b8d1fa5ebe9');
});
test('book_t12_abcdef123456 — type=book, tenantId=12, envPrefix=undefined', () => {
    const p = parse('book_t12_abcdef123456');
    assert(p, 'parse returned null');
    assertEqual(p.type, 'book');
    assertEqual(p.tenantId, 12);
    assertEqual(p.envPrefix, undefined);
});
test('bridge_t3_aabbccddeeff — type=bridge, tenantId=3', () => {
    const p = parse('bridge_t3_aabbccddeeff');
    assert(p, 'parse returned null');
    assertEqual(p.type, 'bridge');
    assertEqual(p.tenantId, 3);
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
