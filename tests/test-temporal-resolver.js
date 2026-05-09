#!/usr/bin/env node
/**
 * Tests for utils/temporal-resolver.js — the one shared module that both the
 * LLM-side prompt builder and the audit verifier use to understand "when?"
 * the user is asking about. All cases use a frozen `now` so timezone-aware
 * relative phrases (kemarin / bulan lalu / last 3 months / YTD / …) resolve
 * deterministically.
 *
 * Run: node tests/test-temporal-resolver.js
 */

'use strict';

const {
    resolveTemporalScope,
    extractDatePatterns,
    getTemporalContext,
    DEFAULT_TZ,
    _internals
} = require('../utils/temporal-resolver');

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

// Frozen clock — Tuesday, 5 May 2026 at 03:00 UTC = 10:00 in Asia/Jakarta
// (Jakarta is UTC+7, no DST). Choosing midweek + mid-month so week, month,
// and quarter boundaries don't accidentally align.
const NOW = new Date('2026-05-05T03:00:00.000Z');
const TZ = 'Asia/Jakarta';

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E getTemporalContext — TZ-aware "today"');

test('Today in Asia/Jakarta when now=2026-05-05T03:00Z', () => {
    const ctx = getTemporalContext({ now: NOW, tz: TZ });
    assertEqual(ctx.todayLocalISO, '2026-05-05');
    assertEqual(ctx.currentYM, '2026-05');
    assertEqual(ctx.tz, 'Asia/Jakarta');
});

test('Same instant in UTC tz still resolves to 2026-05-05 (>=03:00 UTC)', () => {
    const ctx = getTemporalContext({ now: NOW, tz: 'UTC' });
    assertEqual(ctx.todayLocalISO, '2026-05-05');
});

test('Late-evening UTC instant rolls into next-day Jakarta', () => {
    // 2026-05-05T20:00Z = 2026-05-06T03:00 in Jakarta
    const ctx = getTemporalContext({ now: new Date('2026-05-05T20:00:00Z'), tz: TZ });
    assertEqual(ctx.todayLocalISO, '2026-05-06');
});

test('Default tz is Asia/Jakarta', () => {
    assertEqual(DEFAULT_TZ, 'Asia/Jakarta');
    const ctx = getTemporalContext({ now: NOW });
    assertEqual(ctx.tz, 'Asia/Jakarta');
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E resolveTemporalScope — absolute (regression: must keep working)');

test('"tahun 2026" → 12 monthly prefixes', () => {
    const r = resolveTemporalScope('tahun 2026', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 12);
    assert(r.hasTemporal);
    assertEqual(r.dayPatterns.length, 0);
});
test('"Desember 2026" → 1 prefix', () => {
    const r = resolveTemporalScope('Desember 2026', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-12']);
});
test('"Des 2026" abbrev → 1 prefix', () => {
    const r = resolveTemporalScope('Des 2026', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-12']);
});
test('"Q2 2026" → 3 prefixes Apr/May/Jun', () => {
    const r = resolveTemporalScope('Q2 2026', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04', '2026-05', '2026-06']);
});
test('"BA 2026 QO" plate-shape → no temporal', () => {
    const r = resolveTemporalScope('berapa perbaikan BA 2026 QO', { now: NOW, tz: TZ });
    assertEqual(r.hasTemporal, false);
});
test('"from Jan 2025 to Mar 2026" range → 15 monthly prefixes', () => {
    const r = resolveTemporalScope('from Jan 2025 to Mar 2026', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 15);
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E resolveTemporalScope — Indonesian relative');

test('"hari ini" → today only (day-precision)', () => {
    const r = resolveTemporalScope('berapa pesan hari ini', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, ['2026-05-05']);
    assertSetEqual(r.datePatterns, ['2026-05']);
});
test('"kemarin" → yesterday only', () => {
    const r = resolveTemporalScope('kemarin', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, ['2026-05-04']);
});
test('"kemarin lusa" → 2 days ago', () => {
    const r = resolveTemporalScope('kemarin lusa', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, ['2026-05-03']);
});
test('"bulan ini" → 2026-05', () => {
    const r = resolveTemporalScope('berapa perbaikan bulan ini', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-05']);
});
test('"bulan lalu" → 2026-04', () => {
    const r = resolveTemporalScope('berapa perbaikan bulan lalu', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04']);
});
test('"bulan depan" → 2026-06', () => {
    const r = resolveTemporalScope('jadwal bulan depan', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-06']);
});
test('"tahun lalu" → 12 months of 2025', () => {
    const r = resolveTemporalScope('total tahun lalu', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 12);
    assert(r.datePatterns.every(p => p.startsWith('2025-')), 'all 2025');
});
test('"minggu lalu" → 7 day-prefixes ending Sunday before this week', () => {
    // 2026-05-05 is Tuesday. ISO week: Mon=2026-05-04, Sun=2026-05-10.
    // Last week: Mon=2026-04-27, Sun=2026-05-03.
    const r = resolveTemporalScope('rekap minggu lalu', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, [
        '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30',
        '2026-05-01', '2026-05-02', '2026-05-03'
    ]);
});
test('"3 bulan terakhir" → Mar/Apr/May 2026', () => {
    const r = resolveTemporalScope('3 bulan terakhir', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-03', '2026-04', '2026-05']);
});
test('"2 bulan lalu" (point) → 2026-03', () => {
    const r = resolveTemporalScope('2 bulan lalu', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-03']);
});
test('"7 hari terakhir" → 7 day-prefixes ending today', () => {
    const r = resolveTemporalScope('7 hari terakhir', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, [
        '2026-04-29', '2026-04-30',
        '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'
    ]);
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E resolveTemporalScope — English relative');

test('"yesterday"', () => {
    const r = resolveTemporalScope('yesterday', { now: NOW, tz: TZ });
    assertSetEqual(r.dayPatterns, ['2026-05-04']);
});
test('"last month" → 2026-04', () => {
    const r = resolveTemporalScope('last month', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04']);
});
test('"this quarter" → 2026-04..06 (Q2)', () => {
    const r = resolveTemporalScope('this quarter total', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04', '2026-05', '2026-06']);
});
test('"last 3 months" → Mar/Apr/May 2026', () => {
    const r = resolveTemporalScope('last 3 months', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-03', '2026-04', '2026-05']);
});
test('"past 7 days" → today + 6 prior', () => {
    const r = resolveTemporalScope('past 7 days', { now: NOW, tz: TZ });
    assertEqual(r.dayPatterns.length, 7);
    assert(r.dayPatterns.includes('2026-05-05'));
    assert(r.dayPatterns.includes('2026-04-29'));
});
test('"3 months ago" → 2026-02 only', () => {
    const r = resolveTemporalScope('3 months ago revenue', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-02']);
});
test('"in the last 4 weeks" → 28 day-prefixes', () => {
    const r = resolveTemporalScope('in the last 4 weeks', { now: NOW, tz: TZ });
    assertEqual(r.dayPatterns.length, 28);
});
test('"next year" → 12 months of 2027', () => {
    const r = resolveTemporalScope('plan next year', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 12);
    assert(r.datePatterns.every(p => p.startsWith('2027-')));
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E resolveTemporalScope — XTD + sejak/since');

test('"YTD" → Jan..May 2026 (5 months through current)', () => {
    const r = resolveTemporalScope('YTD revenue', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
});
test('"tahun berjalan" alias for YTD', () => {
    const r = resolveTemporalScope('total tahun berjalan', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 5);
});
test('"MTD" → just 2026-05', () => {
    const r = resolveTemporalScope('MTD count', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-05']);
});
test('"QTD" → Apr+May 2026 (Q2 through current month)', () => {
    const r = resolveTemporalScope('QTD report', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04', '2026-05']);
});
test('"sejak Januari 2025" → Jan 2025 through May 2026 (17 months)', () => {
    const r = resolveTemporalScope('total sejak Januari 2025', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 17);
});
test('"since 2024" → Jan 2024 through May 2026 (29 months)', () => {
    const r = resolveTemporalScope('since 2024', { now: NOW, tz: TZ });
    assertEqual(r.datePatterns.length, 29);
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E year-boundary correctness');

test('At 2026-01-15, "bulan lalu" → 2025-12 (crosses year)', () => {
    const NOW_JAN = new Date('2026-01-15T03:00:00Z');
    const r = resolveTemporalScope('bulan lalu', { now: NOW_JAN, tz: TZ });
    assertSetEqual(r.datePatterns, ['2025-12']);
});
test('At 2026-01-15, "12 bulan terakhir" → Feb 2025..Jan 2026', () => {
    const NOW_JAN = new Date('2026-01-15T03:00:00Z');
    const r = resolveTemporalScope('12 bulan terakhir', { now: NOW_JAN, tz: TZ });
    assertEqual(r.datePatterns.length, 12);
    assert(r.datePatterns.includes('2025-02'));
    assert(r.datePatterns.includes('2026-01'));
});
test('At 2026-01-02, "7 hari terakhir" → 2025-12-27..2026-01-02', () => {
    const NOW_JAN = new Date('2026-01-02T03:00:00Z');
    const r = resolveTemporalScope('7 hari terakhir', { now: NOW_JAN, tz: TZ });
    assert(r.dayPatterns.includes('2025-12-27'));
    assert(r.dayPatterns.includes('2026-01-02'));
    assertEqual(r.dayPatterns.length, 7);
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E backward-compat shim');

test('extractDatePatterns(query) — single-arg signature unchanged', () => {
    const arr = extractDatePatterns('Desember 2026');
    assertSetEqual(arr, ['2026-12']);
});
test('extractDatePatterns with relative phrase + now flows through', () => {
    const arr = extractDatePatterns('bulan lalu', { now: NOW, tz: TZ });
    assertSetEqual(arr, ['2026-04']);
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD0E combined queries');

test('"perbaikan bulan lalu" yields scope + matched phrase trace', () => {
    const r = resolveTemporalScope('perbaikan bulan lalu', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-04']);
    assert(r.matchedPhrases.some(p => /bulan/.test(p)), 'matched phrase recorded');
});
test('"servis sejak Maret 2026" → 3 months', () => {
    const r = resolveTemporalScope('total servis sejak Maret 2026', { now: NOW, tz: TZ });
    assertSetEqual(r.datePatterns, ['2026-03', '2026-04', '2026-05']);
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
