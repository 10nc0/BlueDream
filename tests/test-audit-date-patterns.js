#!/usr/bin/env node
/**
 * Date-pattern extraction tests for utils/audit-context.js
 *
 * Covers Task #169: year-only date filter detection.
 *   - Indonesian: tahun YYYY, thn YYYY, taun YYYY, untuk YYYY
 *   - English:    in YYYY, year YYYY, during YYYY, for YYYY, of YYYY
 *   - Bare YYYY  with safeguards (range check, plate-collision rejection)
 *   - Backwards-compat: month-name+year and ISO YYYY-MM still work
 *
 * Plus a regression on the failing JC 2.0 query that motivated this task.
 *
 * Run: node tests/test-audit-date-patterns.js
 */

'use strict';

const { extractDatePatterns, buildCapsuleChain } = require('../utils/audit-context');

let passed = 0, failed = 0;
const failures = [];

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) {
        console.log(`  \u274C  ${label}`);
        console.log(`      ${e.message}`);
        failed++; failures.push({ label, error: e.message });
    }
}

function assertEqualSet(actual, expected, msg) {
    const a = new Set(actual);
    const e = new Set(expected);
    const missing = [...e].filter(x => !a.has(x));
    const extra   = [...a].filter(x => !e.has(x));
    if (missing.length || extra.length) {
        throw new Error(
            `${msg || 'set mismatch'}\n` +
            `      missing: [${missing.sort().join(',')}]\n` +
            `      extra:   [${extra.sort().join(',')}]\n` +
            `      got:     [${[...a].sort().join(',')}]`
        );
    }
}

function expandYear(year) {
    return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Year-only patterns (Indonesian)');

test('tahun 2026 \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('tahun 2026'), expandYear(2026));
});
test('thn 2026 \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('thn 2026'), expandYear(2026));
});
test('taun 2026 \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('taun 2026'), expandYear(2026));
});
test('di tahun 2026 (embedded) \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('perbaikan di tahun 2026'), expandYear(2026));
});
test('untuk 2026 \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('total untuk 2026'), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Year-only patterns (English)');

test('in 2026 \u2192 12 months', () => {
    assertEqualSet(extractDatePatterns('repairs in 2026'), expandYear(2026));
});
test('year 2026 \u2192 12 months', () => {
    assertEqualSet(extractDatePatterns('plates with most repairs year 2026'), expandYear(2026));
});
test('during 2026 \u2192 12 months', () => {
    assertEqualSet(extractDatePatterns('events during 2026'), expandYear(2026));
});
test('for 2026 \u2192 12 months', () => {
    assertEqualSet(extractDatePatterns('totals for 2026'), expandYear(2026));
});
test('of 2026 \u2192 12 months', () => {
    assertEqualSet(extractDatePatterns('events of 2026'), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Bare year (no prefix keyword)');

test('"data 2026" \u2192 12 months of 2026', () => {
    assertEqualSet(extractDatePatterns('show me data 2026'), expandYear(2026));
});
test('out-of-range year (1899) \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('test 1899 data'), []);
});
test('out-of-range year (2100) \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('test 2100 data'), []);
});
test('5-digit number 20260 \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('test 20260 records'), []);
});
test('digit 1234 (in range but boundary-broken in long token) \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('id-12345-record'), []);
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDEAB Plate-collision negative case');

test('"BA 2026 QO" \u2192 bare 2026 NOT extracted (plate shape)', () => {
    assertEqualSet(extractDatePatterns('BA 2026 QO'), []);
});
test('"Plat BA 2026 QO ditemukan" \u2192 plate guard holds', () => {
    assertEqualSet(extractDatePatterns('Plat BA 2026 QO ditemukan'), []);
});
test('"B 2026 ABC" \u2192 plate guard holds (1-letter prefix)', () => {
    assertEqualSet(extractDatePatterns('B 2026 ABC'), []);
});
test('"ba 2026 qo" (lowercase plate) \u2192 plate guard still holds', () => {
    assertEqualSet(extractDatePatterns('ba 2026 qo'), []);
});
test('"berapa perbaikan ba 2026 qo" (lowercase plate query) \u2192 no year filter', () => {
    assertEqualSet(extractDatePatterns('berapa perbaikan ba 2026 qo'), []);
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD00 Mixed query');

test('year keyword + plate-shaped 2026 in same query \u2192 year only (12 months)', () => {
    assertEqualSet(
        extractDatePatterns('top plat di tahun 2026 (BA 2026 QO?)'),
        expandYear(2026)
    );
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Backwards-compat: month-name + year');

test('Desember 2026 \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('Desember 2026'), ['2026-12']);
});
test('January 2026 \u2192 2026-01 only', () => {
    assertEqualSet(extractDatePatterns('January 2026'), ['2026-01']);
});
test('mei 2026 \u2192 2026-05 only', () => {
    assertEqualSet(extractDatePatterns('mei 2026'), ['2026-05']);
});
test('agustus 2025 \u2192 2025-08 only', () => {
    assertEqualSet(extractDatePatterns('agustus 2025'), ['2025-08']);
});
test('"Desember, 2026" (comma separator) \u2192 2026-12 only (NOT full year)', () => {
    assertEqualSet(extractDatePatterns('Desember, 2026'), ['2026-12']);
});
test('"Desember/2026" (slash separator) \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('total Desember/2026'), ['2026-12']);
});
test('"Desember-2026" (hyphen separator) \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('Desember-2026 stats'), ['2026-12']);
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Backwards-compat: month-abbrev + year (single-month)');

test('"Des 2026" \u2192 2026-12 only (NOT full year)', () => {
    assertEqualSet(extractDatePatterns('Des 2026'), ['2026-12']);
});
test('"Jan 2025" \u2192 2025-01 only', () => {
    assertEqualSet(extractDatePatterns('Jan 2025'), ['2025-01']);
});
test('"Okt 2024" \u2192 2024-10 only', () => {
    assertEqualSet(extractDatePatterns('Okt 2024'), ['2024-10']);
});
test('"perbaikan Des 2026" (embedded) \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('perbaikan Des 2026'), ['2026-12']);
});
test('"repairs Mar 2025" (embedded English abbrev) \u2192 2025-03 only', () => {
    assertEqualSet(extractDatePatterns('repairs Mar 2025'), ['2025-03']);
});
test('"mrt 2025" (Dutch-style maret abbrev) \u2192 2025-03 only', () => {
    assertEqualSet(extractDatePatterns('mrt 2025'), ['2025-03']);
});
test('"agu 2025" (agustus abbrev) \u2192 2025-08 only', () => {
    assertEqualSet(extractDatePatterns('agu 2025'), ['2025-08']);
});
test('"sept 2025" (4-letter september abbrev) \u2192 2025-09 only', () => {
    assertEqualSet(extractDatePatterns('sept 2025'), ['2025-09']);
});
test('"des/2026" (slash separator with abbrev) \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('total des/2026'), ['2026-12']);
});
test('"Des, 2026" (comma separator with abbrev) \u2192 2026-12 only (NOT bare year)', () => {
    assertEqualSet(extractDatePatterns('Des, 2026'), ['2026-12']);
});
test('plate "BA 2026 QO" still NOT picked up by abbrev step (no abbrev letters)', () => {
    // Sanity: enabling abbrevs in step 1 must not regress the plate guard.
    assertEqualSet(extractDatePatterns('BA 2026 QO'), []);
});
test('plate-adjacent abbrev "Des 2026 BA 2027 QO" \u2192 2026-12 only (plate 2027 guarded)', () => {
    // "Des 2026" matches step 1; "BA 2027 QO" is a plate shape and is skipped.
    assertEqualSet(extractDatePatterns('Des 2026 BA 2027 QO'), ['2026-12']);
});
test('bare year word "2026" still expands to full year (abbrev change does not affect plain bare year)', () => {
    assertEqualSet(extractDatePatterns('show me 2026'), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Backwards-compat: ISO month');

test('2026-12 \u2192 2026-12 only', () => {
    assertEqualSet(extractDatePatterns('events on 2026-12'), ['2026-12']);
});
test('2026-1 \u2192 2026-01 only (zero-padded)', () => {
    assertEqualSet(extractDatePatterns('check 2026-1 data'), ['2026-01']);
});
test('2026-13 (invalid month) \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('check 2026-13 data'), []);
});
test('2026-00 (invalid month) \u2192 ignored', () => {
    assertEqualSet(extractDatePatterns('check 2026-00 data'), []);
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD00 Combined (year-only + specific month)');

test('"tahun 2026 dan Desember 2026" \u2192 12 months (year subsumes month)', () => {
    assertEqualSet(
        extractDatePatterns('tahun 2026 dan Desember 2026'),
        expandYear(2026)
    );
});
test('"Desember 2025 dan tahun 2026" \u2192 2025-12 + 12 months of 2026', () => {
    assertEqualSet(
        extractDatePatterns('Desember 2025 dan tahun 2026'),
        ['2025-12', ...expandYear(2026)]
    );
});
test('"Desember 2025 dan 2026" (bare second year) \u2192 2025-12 + 12 months of 2026', () => {
    // Locks intended behavior: a bare year next to a separate month+year is
    // treated as its own year-only mention, not subsumed by the adjacent month.
    assertEqualSet(
        extractDatePatterns('Desember 2025 dan 2026'),
        ['2025-12', ...expandYear(2026)]
    );
});
test('"perbaikan Desember 2025, juga 2026 secara umum" \u2192 2025-12 + 12 months of 2026', () => {
    assertEqualSet(
        extractDatePatterns('perbaikan Desember 2025, juga 2026 secara umum'),
        ['2025-12', ...expandYear(2026)]
    );
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83C\uDF10 Empty / no-date queries');

test('no date at all \u2192 []', () => {
    assertEqualSet(extractDatePatterns('plat paling banyak perbaikan'), []);
});
test('empty string \u2192 []', () => {
    assertEqualSet(extractDatePatterns(''), []);
});
test('null \u2192 []', () => {
    assertEqualSet(extractDatePatterns(null), []);
});
test('non-string \u2192 []', () => {
    assertEqualSet(extractDatePatterns(12345), []);
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Date ranges (Indonesian: antara X dan Y)');

test('"antara 2024 dan 2026" \u2192 36 months (2024-01 .. 2026-12)', () => {
    assertEqualSet(
        extractDatePatterns('antara 2024 dan 2026'),
        [...expandYear(2024), ...expandYear(2025), ...expandYear(2026)]
    );
});
test('"antara 2025 dan 2026" \u2192 24 months', () => {
    assertEqualSet(
        extractDatePatterns('berapa perbaikan antara 2025 dan 2026'),
        [...expandYear(2025), ...expandYear(2026)]
    );
});
test('"antara Desember 2025 dan Maret 2026" \u2192 4 months only', () => {
    assertEqualSet(
        extractDatePatterns('antara Desember 2025 dan Maret 2026'),
        ['2025-12', '2026-01', '2026-02', '2026-03']
    );
});
test('"antara januari 2026 dan maret 2026" \u2192 3 months', () => {
    assertEqualSet(
        extractDatePatterns('antara januari 2026 dan maret 2026'),
        ['2026-01', '2026-02', '2026-03']
    );
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Date ranges (English: between/from..to)');

test('"between 2024 and 2026" \u2192 36 months', () => {
    assertEqualSet(
        extractDatePatterns('between 2024 and 2026'),
        [...expandYear(2024), ...expandYear(2025), ...expandYear(2026)]
    );
});
test('"from Jan 2025 to Mar 2026" \u2192 15 months (combined month+year range)', () => {
    assertEqualSet(
        extractDatePatterns('from Jan 2025 to Mar 2026'),
        [...expandYear(2025), '2026-01', '2026-02', '2026-03']
    );
});
test('"from January 2025 to March 2026" (full month names) \u2192 15 months', () => {
    assertEqualSet(
        extractDatePatterns('from January 2025 to March 2026'),
        [...expandYear(2025), '2026-01', '2026-02', '2026-03']
    );
});
test('"between October 2025 and February 2026" \u2192 5 months crossing year boundary', () => {
    assertEqualSet(
        extractDatePatterns('between October 2025 and February 2026'),
        ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02']
    );
});
test('"from 2025-03 to 2025-07" (ISO endpoints) \u2192 5 months', () => {
    assertEqualSet(
        extractDatePatterns('from 2025-03 to 2025-07'),
        ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07']
    );
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Date ranges (Indonesian: dari/sampai/hingga)');

test('"dari Januari 2025 sampai Maret 2026" \u2192 15 months', () => {
    assertEqualSet(
        extractDatePatterns('dari Januari 2025 sampai Maret 2026'),
        [...expandYear(2025), '2026-01', '2026-02', '2026-03']
    );
});
test('"dari 2025 hingga 2026" \u2192 24 months', () => {
    assertEqualSet(
        extractDatePatterns('dari 2025 hingga 2026'),
        [...expandYear(2025), ...expandYear(2026)]
    );
});
test('"Desember 2025 sampai Maret 2026" (bare connector) \u2192 4 months', () => {
    assertEqualSet(
        extractDatePatterns('Desember 2025 sampai Maret 2026'),
        ['2025-12', '2026-01', '2026-02', '2026-03']
    );
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Quarter patterns (Q1..Q4 YYYY)');

test('"Q1 2026" \u2192 Jan/Feb/Mar of 2026', () => {
    assertEqualSet(extractDatePatterns('Q1 2026'), ['2026-01', '2026-02', '2026-03']);
});
test('"Q2 2026" \u2192 Apr/May/Jun of 2026', () => {
    assertEqualSet(extractDatePatterns('Q2 2026'), ['2026-04', '2026-05', '2026-06']);
});
test('"Q3 2026" \u2192 Jul/Aug/Sep of 2026', () => {
    assertEqualSet(extractDatePatterns('Q3 2026'), ['2026-07', '2026-08', '2026-09']);
});
test('"Q4 2026" \u2192 Oct/Nov/Dec of 2026', () => {
    assertEqualSet(extractDatePatterns('Q4 2026'), ['2026-10', '2026-11', '2026-12']);
});
test('"q1 2026" (lowercase) \u2192 Q1 of 2026', () => {
    assertEqualSet(extractDatePatterns('q1 2026'), ['2026-01', '2026-02', '2026-03']);
});
test('"penjualan Q2 2025" (embedded) \u2192 Apr/May/Jun of 2025', () => {
    assertEqualSet(extractDatePatterns('penjualan Q2 2025'), ['2025-04', '2025-05', '2025-06']);
});
test('"Q1 2026 dan Q3 2026" (two quarters) \u2192 6 months', () => {
    assertEqualSet(
        extractDatePatterns('Q1 2026 dan Q3 2026'),
        ['2026-01', '2026-02', '2026-03', '2026-07', '2026-08', '2026-09']
    );
});
test('"Q5 2026" (invalid quarter) \u2192 ignored, falls through to bare year', () => {
    // Q5 doesn't match the Q[1-4] regex, so the string falls through to step 4
    // which extracts the bare 2026 as a full year.
    assertEqualSet(extractDatePatterns('Q5 2026'), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC5 Range edge cases');

test('reversed range "from 2026 to 2024" \u2192 still 36 months (auto-swap)', () => {
    assertEqualSet(
        extractDatePatterns('from 2026 to 2024'),
        [...expandYear(2024), ...expandYear(2025), ...expandYear(2026)]
    );
});
test('range does not double-count its endpoints via bare-year step', () => {
    // Confirms masking works: "antara 2025 dan 2026" produces exactly 24 months,
    // not 24 + extra duplicates from steps 2/4 re-extracting "2025" or "2026".
    const result = extractDatePatterns('antara 2025 dan 2026');
    if (result.length !== 24) {
        throw new Error(`expected exactly 24 months, got ${result.length}: ${result.join(',')}`);
    }
});
test('range adjacent to plate "BA 2026 QO antara 2025 dan 2026" \u2192 24 months (plate guard intact)', () => {
    // Range is detected first and masked; bare-year step then sees only the
    // plate-shaped 2026 which is correctly skipped by the plate guard.
    assertEqualSet(
        extractDatePatterns('BA 2026 QO antara 2025 dan 2026'),
        [...expandYear(2025), ...expandYear(2026)]
    );
});
test('range + extra month outside it: "antara Jan 2025 dan Mar 2025, juga Desember 2025"', () => {
    assertEqualSet(
        extractDatePatterns('antara Jan 2025 dan Mar 2025, juga Desember 2025'),
        ['2025-01', '2025-02', '2025-03', '2025-12']
    );
});
test('"antara 2024 dan 2026 untuk 2027" (range + separate year) \u2192 36 + 12 months', () => {
    // Range covers 2024-2026 (36 months), "untuk 2027" adds 12 more.
    assertEqualSet(
        extractDatePatterns('antara 2024 dan 2026 untuk 2027'),
        [...expandYear(2024), ...expandYear(2025), ...expandYear(2026), ...expandYear(2027)]
    );
});
test('non-range phrase "I want to 2026" does NOT trigger range', () => {
    // "to 2026" alone shouldn't match because there is no valid endpoint
    // immediately before "to" (the word "want" is not a date endpoint).
    // Result should be the same as a plain bare-year mention: 12 months.
    assertEqualSet(extractDatePatterns('I want to 2026'), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCCA Regression: original failing JC 2.0 query');

test('Original JC 2.0 query produces 2026 year filter', () => {
    const q = 'Plat nomor berapa (BA ...) yang paling banyak perbaikan di tahun 2026?\n\ntop 5';
    assertEqualSet(extractDatePatterns(q), expandYear(2026));
});

// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD17 Capsule chain integration (year filter end-to-end)');

test('Capsule chain on "tahun 2026" excludes 2025 plates from C3 aggregates', () => {
    // 5 BA 9960 QO repairs in 2025, 5 in 2026 — same plate, both with "perbaikan"
    const fixture = [];
    for (let i = 0; i < 5; i++) {
        fixture.push({
            id: 100 + i,
            content: 'BA 9960 QO perbaikan rutin',
            timestamp: `2025-1${i % 2 ? 1 : 0}-${10 + i}T10:00:00Z`
        });
    }
    for (let i = 0; i < 5; i++) {
        fixture.push({
            id: 200 + i,
            content: 'BA 9960 QO perbaikan rem',
            timestamp: `2026-0${i + 1}-15T10:00:00Z`
        });
    }
    // 3 BA 8993 AU repairs in 2026 only
    for (let i = 0; i < 3; i++) {
        fixture.push({
            id: 300 + i,
            content: 'BA 8993 AU perbaikan ganti oli',
            timestamp: `2026-0${i + 6}-12T10:00:00Z`
        });
    }

    const chain = buildCapsuleChain(
        fixture,
        'Plat nomor berapa (BA ...) yang paling banyak perbaikan di tahun 2026? top 5'
    );

    const c1 = chain.capsules.find(c => c.stage === 'C1_TIME_MATCH');
    if (!c1.stats.filtered) throw new Error('C1 should have applied a date filter, but stats.filtered is false');
    if (c1.outputCount !== 8) throw new Error(`C1 should keep 8 of 13 messages (5 BA9960 + 3 BA8993 in 2026), got ${c1.outputCount}`);

    const aggregates = chain.getTerminalCapsule().output;
    if (!aggregates['BA 9960 QO']) throw new Error('expected BA 9960 QO in aggregates');
    if (aggregates['BA 9960 QO'].count !== 5) {
        throw new Error(`BA 9960 QO count should be 5 (2026 only), got ${aggregates['BA 9960 QO'].count}`);
    }
    if (aggregates['BA 8993 AU'].count !== 3) {
        throw new Error(`BA 8993 AU count should be 3, got ${aggregates['BA 8993 AU'].count}`);
    }
});

test('Capsule chain WITHOUT year filter (control) keeps all 2025+2026 messages', () => {
    const fixture = [
        { id: 1, content: 'BA 9960 QO perbaikan', timestamp: '2025-11-15T10:00:00Z' },
        { id: 2, content: 'BA 9960 QO perbaikan', timestamp: '2025-12-20T10:00:00Z' },
        { id: 3, content: 'BA 9960 QO perbaikan', timestamp: '2026-01-05T10:00:00Z' },
    ];
    // No year keyword — control case must not filter
    const chain = buildCapsuleChain(fixture, 'plat paling banyak perbaikan');
    const c1 = chain.capsules.find(c => c.stage === 'C1_TIME_MATCH');
    if (c1.stats.filtered) throw new Error('C1 should NOT filter when no date pattern is present');
    if (c1.outputCount !== 3) throw new Error(`C1 should keep all 3 messages, got ${c1.outputCount}`);
    const aggregates = chain.getTerminalCapsule().output;
    if (aggregates['BA 9960 QO'].count !== 3) throw new Error(`expected count 3 (no filter), got ${aggregates['BA 9960 QO'].count}`);
});

// ────────────────────────────────────────────────────────────────────────
console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
