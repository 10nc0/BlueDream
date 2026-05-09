#!/usr/bin/env node
/**
 * Tests for utils/query-scope.js — independent intent extraction used by
 * the audit verifier (Task #171).
 *
 * Run: node tests/test-query-scope.js
 */

'use strict';

const {
    parseQueryScope,
    messageMatchesScope,
    extractActionKeywordsFromQuery,
    extractPlatesFromQuery,
    extractSendersFromQuery
} = require('../utils/query-scope');

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}
function assertSetEqual(actual, expected, msg) {
    const a = new Set(actual), e = new Set(expected);
    if (a.size !== e.size || [...e].some(x => !a.has(x))) {
        throw new Error(`${msg || 'set mismatch'}\n  expected: [${[...e].sort()}]\n  got:      [${[...a].sort()}]`);
    }
}

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E parseQueryScope — date dimension');

test('"tahun 2026" \u2192 12 datePatterns, no other dims', () => {
    const s = parseQueryScope('tahun 2026');
    assertEqual(s.datePatterns.length, 12);
    assertEqual(s.actionKeywords.length, 0);
    assertEqual(s.plates.length, 0);
    assertEqual(s.senders.length, 0);
    assert(s.hasAny, 'hasAny should be true');
});
test('"Desember 2026" \u2192 1 datePattern (2026-12)', () => {
    const s = parseQueryScope('Desember 2026');
    assertSetEqual(s.datePatterns, ['2026-12']);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E parseQueryScope — action keywords');

test('"berapa perbaikan tahun 2026" \u2192 repair group + date', () => {
    const s = parseQueryScope('berapa perbaikan tahun 2026');
    assert(s.actionKeywords.includes('perbaikan'), 'includes perbaikan');
    assert(s.actionKeywords.includes('servis'), 'includes synonym servis');
    assertEqual(s.datePatterns.length, 12);
});
test('"berapa kali masuk bengkel" \u2192 masuk group only', () => {
    const s = parseQueryScope('berapa kali masuk bengkel');
    assert(s.actionKeywords.includes('masuk'));
    assertEqual(s.datePatterns.length, 0);
});
test('query with no action verb \u2192 actionKeywords []', () => {
    const s = parseQueryScope('list semua plat');
    assertEqual(s.actionKeywords.length, 0);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E parseQueryScope — plates');

test('"perbaikan BA 9960 QO" \u2192 plate captured', () => {
    const s = parseQueryScope('perbaikan BA 9960 QO');
    assertSetEqual(s.plates, ['BA 9960 QO']);
});
test('"plat BA 9960 QO dan BA 8993 AU" \u2192 both captured & deduped', () => {
    const s = parseQueryScope('plat BA 9960 QO dan BA 8993 AU dan BA 9960 QO lagi');
    assertSetEqual(s.plates, ['BA 9960 QO', 'BA 8993 AU']);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E parseQueryScope — senders');

test('"+62812345678" \u2192 sender captured as { raw, normalized, shape }', () => {
    const s = parseQueryScope('pesan dari +62812345678');
    assertEqual(s.senders.length, 1, `expected 1 sender, got ${s.senders.length}`);
    assertEqual(s.senders[0].shape, 'phone');
    assertEqual(s.senders[0].normalized, '62812345678');
    assert(s.senders[0].raw, 'raw must be present');
});
test('"81234567" (8 digits, edge of range) \u2192 captured as phone shape', () => {
    const s = parseQueryScope('hp 81234567');
    assertEqual(s.senders.length, 1, `expected 1 sender, got ${s.senders.length}`);
    assertEqual(s.senders[0].shape, 'phone');
    assertEqual(s.senders[0].normalized, '81234567');
});
test('short "1234" \u2192 NOT captured (under 8 digits)', () => {
    const s = parseQueryScope('id 1234');
    assertEqual(s.senders.length, 0);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E parseQueryScope — empty / falsy');

test('empty string \u2192 hasAny false', () => {
    const s = parseQueryScope('');
    assertEqual(s.hasAny, false);
});
test('null \u2192 hasAny false', () => {
    const s = parseQueryScope(null);
    assertEqual(s.hasAny, false);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD17 messageMatchesScope — date filter');

test('msg in 2026 matches "tahun 2026" scope', () => {
    const s = parseQueryScope('tahun 2026');
    assertEqual(messageMatchesScope({ timestamp: '2026-03-15T10:00:00Z' }, s), true);
});
test('msg in 2025 does NOT match "tahun 2026" scope', () => {
    const s = parseQueryScope('tahun 2026');
    assertEqual(messageMatchesScope({ timestamp: '2025-12-15T10:00:00Z' }, s), false);
});
test('msg without timestamp does NOT match a date-restricted scope', () => {
    const s = parseQueryScope('tahun 2026');
    assertEqual(messageMatchesScope({ content: 'foo' }, s), false);
});
test('empty scope matches every message', () => {
    const s = parseQueryScope('');
    assertEqual(messageMatchesScope({ content: 'whatever' }, s), true);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD17 messageMatchesScope — action keyword filter');

test('msg with "perbaikan" matches action scope', () => {
    const s = parseQueryScope('berapa perbaikan');
    assertEqual(messageMatchesScope({ content: 'BA 9960 QO perbaikan rem' }, s), true);
});
test('msg without any action keyword does NOT match', () => {
    const s = parseQueryScope('berapa perbaikan');
    assertEqual(messageMatchesScope({ content: 'BA 9960 QO masuk parkir' }, s), false);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD17 messageMatchesScope — sender filter');

test('msg from matching sender passes', () => {
    const s = parseQueryScope('dari 62812345678');
    assertEqual(messageMatchesScope({ from: '+62812345678', content: 'foo' }, s), true);
});
test('msg from different sender fails', () => {
    const s = parseQueryScope('dari 62812345678');
    assertEqual(messageMatchesScope({ from: '+62899999999', content: 'foo' }, s), false);
});
test('msg with no sender field fails sender-restricted scope', () => {
    const s = parseQueryScope('dari 62812345678');
    assertEqual(messageMatchesScope({ content: 'foo' }, s), false);
});

// ──────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD17 messageMatchesScope — combined dimensions (AND)');

test('msg passes only when ALL non-empty dims match (date + action)', () => {
    const s = parseQueryScope('perbaikan tahun 2026');
    assertEqual(messageMatchesScope({ timestamp: '2026-03-15T00:00:00Z', content: 'perbaikan rem' }, s), true);
    assertEqual(messageMatchesScope({ timestamp: '2025-03-15T00:00:00Z', content: 'perbaikan rem' }, s), false);
    assertEqual(messageMatchesScope({ timestamp: '2026-03-15T00:00:00Z', content: 'masuk parkir'  }, s), false);
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
