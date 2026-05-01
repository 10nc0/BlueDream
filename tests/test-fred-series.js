'use strict';

const assert = require('assert');
const { _findNearestRowForYear } = require('../lib/tools/fred-series');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
    try {
        fn();
        console.log(`  ✅  ${label}`);
        passed++;
    } catch (err) {
        console.log(`  ❌  ${label}`);
        console.log(`      ${err.message}`);
        failed++;
        failures.push({ label, error: err.message });
    }
}

// Mock rows mimicking MEDLISPRIPERSQUFEE series (starts 2016 for NY/SF MSAs)
const MOCK_ROWS_2016_START = [
    { date: '2016-01-01', value: 250 },
    { date: '2017-01-01', value: 270 },
    { date: '2018-01-01', value: 285 },
    { date: '2019-01-01', value: 295 },
    { date: '2020-01-01', value: 300 },
    { date: '2021-01-01', value: 330 },
    { date: '2022-01-01', value: 380 },
    { date: '2023-01-01', value: 350 },
    { date: '2024-01-01', value: 360 }
];

console.log('\n── _findNearestRowForYear: no hard-cutoff logic ──');

test('exact year match returns that row', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, '2020');
    assert(result !== null, 'must not return null');
    assert(result.date === '2020-01-01', `expected 2020-01-01, got ${result.date}`);
    assert(result.value === 300, `expected 300, got ${result.value}`);
});

test('targetYear before series start (2000) returns earliest available row (2016)', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, '2000');
    assert(result !== null, 'must NOT return null — no hard cutoff');
    assert(result.date === '2016-01-01', `expected earliest row 2016-01-01, got ${result.date}`);
    assert(result.value === 250, `expected 250, got ${result.value}`);
});

test('targetYear 2001 also returns 2016 row (nearest with dist=15)', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, '2001');
    assert(result !== null, 'must not return null');
    assert(result.date === '2016-01-01', `expected 2016-01-01, got ${result.date}`);
});

test('targetYear 2005 returns 2016 row (dist=11, no cutoff)', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, '2005');
    assert(result !== null, 'must not return null even for dist=11');
    assert(result.date === '2016-01-01', `expected 2016-01-01, got ${result.date}`);
});

test('targetYear 2025 (after last row 2024) returns last row', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, '2025');
    assert(result !== null, 'must not return null');
    assert(result.date === '2024-01-01', `expected 2024-01-01, got ${result.date}`);
});

test('picks the closer of two equidistant candidates (2018 vs 2020 for target 2019)', () => {
    const rows = [{ date: '2018-01-01', value: 100 }, { date: '2020-01-01', value: 200 }];
    const result = _findNearestRowForYear(rows, '2019');
    assert(result !== null, 'must not return null');
    // dist(2018, 2019)=1, dist(2020, 2019)=1 — either is valid; both equal dist, first wins
    assert(['2018-01-01', '2020-01-01'].includes(result.date), `unexpected date ${result.date}`);
});

test('null rows returns null', () => {
    const result = _findNearestRowForYear(null, '2020');
    assert(result === null, 'null input must return null');
});

test('empty rows array returns null', () => {
    const result = _findNearestRowForYear([], '2020');
    assert(result === null, 'empty array must return null');
});

test('invalid targetYear string returns null', () => {
    const result = _findNearestRowForYear(MOCK_ROWS_2016_START, 'notayear');
    assert(result === null, 'invalid year must return null');
});

test('rows with missing dates are skipped', () => {
    const rows = [
        { date: null, value: 999 },
        { date: '', value: 888 },
        { date: '2019-01-01', value: 300 }
    ];
    const result = _findNearestRowForYear(rows, '2019');
    assert(result !== null, 'must find the valid row');
    assert(result.value === 300, `expected 300, got ${result.value}`);
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(58)}`);
console.log(`📊 FRED Series Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
}
console.log('='.repeat(58));
process.exit(failed > 0 ? 1 : 0);
