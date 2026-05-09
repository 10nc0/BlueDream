#!/usr/bin/env node
/**
 * Sanity-check tests for the per-locale modules in utils/temporal-locales/.
 * These are shape tests only — they verify the exported structure is correct
 * so that a broken locale file is caught immediately rather than causing a
 * cryptic failure deep inside the resolver.
 *
 * Run: node tests/test-temporal-locales.js
 */

'use strict';

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

const CANONICAL_UNITS = new Set(['day', 'week', 'month', 'quarter', 'year']);

function checkLocaleShape(locale, id) {
    test(`${id}: exports _id === '${id}'`, () => {
        assertEqual(locale._id, id);
    });
    test(`${id}: monthNames is an array of 12 lowercase strings`, () => {
        assert(Array.isArray(locale.monthNames), 'monthNames must be an array');
        assertEqual(locale.monthNames.length, 12, 'monthNames must have 12 entries');
        for (const n of locale.monthNames) {
            assert(typeof n === 'string' && n.length > 0, `month name "${n}" must be a non-empty string`);
            assert(n === n.toLowerCase(), `month name "${n}" must be lowercase`);
        }
    });
    test(`${id}: monthAbbrevs is an array of 12 arrays`, () => {
        assert(Array.isArray(locale.monthAbbrevs), 'monthAbbrevs must be an array');
        assertEqual(locale.monthAbbrevs.length, 12, 'monthAbbrevs must have 12 entries');
        for (let i = 0; i < 12; i++) {
            assert(Array.isArray(locale.monthAbbrevs[i]),
                `monthAbbrevs[${i}] must be an array`);
            for (const a of locale.monthAbbrevs[i]) {
                assert(typeof a === 'string' && a.length > 0,
                    `abbreviation "${a}" must be a non-empty string`);
            }
        }
    });
    test(`${id}: unitMap values are all canonical unit strings`, () => {
        assert(locale.unitMap && typeof locale.unitMap === 'object', 'unitMap must be an object');
        assert(Object.keys(locale.unitMap).length > 0, 'unitMap must not be empty');
        for (const [k, v] of Object.entries(locale.unitMap)) {
            assert(typeof k === 'string' && k.length > 0, `unitMap key "${k}" must be non-empty`);
            assert(CANONICAL_UNITS.has(v),
                `unitMap["${k}"] = "${v}" must be one of ${[...CANONICAL_UNITS].join(', ')}`);
        }
    });
    test(`${id}: relFragments is present with expected keys`, () => {
        const rf = locale.relFragments;
        assert(rf && typeof rf === 'object', 'relFragments must be an object');
        assert('unitPrefixMap' in rf, 'relFragments must have unitPrefixMap (may be null)');
        assert('unitSuffixMap' in rf, 'relFragments must have unitSuffixMap (may be null)');
        assert('lastNPrefix' in rf, 'relFragments must have lastNPrefix (may be null)');
        assert('lastNSuffixLastN' in rf, 'relFragments must have lastNSuffixLastN (may be null)');
        assert('lastNSuffixNAgo' in rf, 'relFragments must have lastNSuffixNAgo (may be null)');
        assert('agoSuffix' in rf, 'relFragments must have agoSuffix (may be null)');
    });
    test(`${id}: relFragments maps (if present) have numeric offsets in {-1,0,1}`, () => {
        const VALID = new Set([-1, 0, 1]);
        for (const mapKey of ['unitPrefixMap', 'unitSuffixMap']) {
            const map = locale.relFragments[mapKey];
            if (!map) continue;
            for (const [word, offset] of Object.entries(map)) {
                assert(VALID.has(offset),
                    `relFragments.${mapKey}["${word}"] = ${offset} must be -1, 0, or 1`);
            }
        }
    });
    test(`${id}: todayRegex / yesterdayRegex / dayBeforeYesterdayRegex are string or null`, () => {
        for (const key of ['todayRegex', 'yesterdayRegex', 'dayBeforeYesterdayRegex']) {
            const v = locale[key];
            assert(v === null || typeof v === 'string',
                `${key} must be a string or null; got ${typeof v}`);
            if (typeof v === 'string') assert(v.length > 0, `${key} must not be empty string`);
        }
    });
    test(`${id}: dayBeforeYesterdayLabel is a non-empty string (human-readable, not regex)`, () => {
        const v = locale.dayBeforeYesterdayLabel;
        assert(typeof v === 'string' && v.length > 0,
            `dayBeforeYesterdayLabel must be a non-empty string; got ${JSON.stringify(v)}`);
        assert(!/[\\()|?*+{}[\]^$]/.test(v),
            `dayBeforeYesterdayLabel must not contain regex metacharacters; got "${v}"`);
    });
    test(`${id}: xtdAliases has ytd, mtd, qtd keys (string or null)`, () => {
        const xa = locale.xtdAliases;
        assert(xa && typeof xa === 'object', 'xtdAliases must be an object');
        for (const key of ['ytd', 'mtd', 'qtd']) {
            assert(key in xa, `xtdAliases must have key "${key}"`);
            const v = xa[key];
            assert(v === null || typeof v === 'string',
                `xtdAliases.${key} must be string or null; got ${typeof v}`);
        }
    });
}

// ── English locale ────────────────────────────────────────────────────
console.log('\n\uD83C\uDDEC\uD83C\uDDE7  English locale (en.js)');
const enLocale = require('../utils/temporal-locales/en');
checkLocaleShape(enLocale, 'en');

test('en: monthNames[0] is "january" and monthNames[11] is "december"', () => {
    assertEqual(enLocale.monthNames[0],  'january');
    assertEqual(enLocale.monthNames[11], 'december');
});
test('en: unitMap has "day", "month", "year" etc. (English-only entries)', () => {
    assertEqual(enLocale.unitMap['day'],     'day');
    assertEqual(enLocale.unitMap['months'],  'month');
    assertEqual(enLocale.unitMap['years'],   'year');
    assertEqual(enLocale.unitMap['quarter'], 'quarter');
});
test('en: unitPrefixMap covers this/last/next with correct offsets', () => {
    const pm = enLocale.relFragments.unitPrefixMap;
    assert(pm, 'unitPrefixMap should not be null for EN');
    assertEqual(pm['this'],     0);
    assertEqual(pm['last'],    -1);
    assertEqual(pm['next'],     1);
    assertEqual(pm['previous'],-1);
});
test('en: lastNPrefix is non-null and contains "last"', () => {
    assert(enLocale.relFragments.lastNPrefix !== null, 'EN must have lastNPrefix');
    assert(/last/.test(enLocale.relFragments.lastNPrefix), 'lastNPrefix must contain "last"');
});
test('en: agoSuffix is "ago"', () => {
    assertEqual(enLocale.relFragments.agoSuffix, 'ago');
});
test('en: monthAbbrevs[0] includes "jan"', () => {
    assert(enLocale.monthAbbrevs[0].includes('jan'));
});
test('en: xtdAliases.ytd contains "year"', () => {
    assert(/year/.test(enLocale.xtdAliases.ytd));
});

// ── Indonesian locale ─────────────────────────────────────────────────
console.log('\n\uD83C\uDDEE\uD83C\uDDE9  Indonesian locale (id.js)');
const idLocale = require('../utils/temporal-locales/id');
checkLocaleShape(idLocale, 'id');

test('id: monthNames[0] is "januari" and monthNames[11] is "desember"', () => {
    assertEqual(idLocale.monthNames[0],  'januari');
    assertEqual(idLocale.monthNames[11], 'desember');
});
test('id: unitMap has Indonesian-specific entries', () => {
    assertEqual(idLocale.unitMap['hari'],   'day');
    assertEqual(idLocale.unitMap['bulan'],  'month');
    assertEqual(idLocale.unitMap['tahun'],  'year');
    assertEqual(idLocale.unitMap['minggu'], 'week');
    assertEqual(idLocale.unitMap['pekan'],  'week');
    assertEqual(idLocale.unitMap['kuartal'],'quarter');
    assertEqual(idLocale.unitMap['thn'],    'year');
});
test('id: unitSuffixMap covers ini/lalu/depan with correct offsets', () => {
    const sm = idLocale.relFragments.unitSuffixMap;
    assert(sm, 'unitSuffixMap should not be null for ID');
    assertEqual(sm['ini'],   0);
    assertEqual(sm['lalu'], -1);
    assertEqual(sm['depan'], 1);
    assertEqual(sm['kemarin'], -1);
    assertEqual(sm['sebelumnya'], -1);
    assertEqual(sm['berikutnya'], 1);
});
test('id: lastNSuffixLastN covers "terakhir"', () => {
    assert(idLocale.relFragments.lastNSuffixLastN !== null, 'ID must have lastNSuffixLastN');
    assert(/terakhir/.test(idLocale.relFragments.lastNSuffixLastN));
});
test('id: lastNSuffixNAgo covers "lalu"', () => {
    assert(idLocale.relFragments.lastNSuffixNAgo !== null, 'ID must have lastNSuffixNAgo');
    assert(/lalu/.test(idLocale.relFragments.lastNSuffixNAgo));
});
test('id: monthAbbrevs[7] includes "agu" and "ags" (Indonesian for August)', () => {
    assert(idLocale.monthAbbrevs[7].includes('agu'), 'should include agu');
    assert(idLocale.monthAbbrevs[7].includes('ags'), 'should include ags');
});
test('id: monthAbbrevs[9] includes "okt" (Oktober)', () => {
    assert(idLocale.monthAbbrevs[9].includes('okt'));
});
test('id: monthAbbrevs[11] includes "des" (Desember)', () => {
    assert(idLocale.monthAbbrevs[11].includes('des'));
});
test('id: xtdAliases.ytd contains "tahun"', () => {
    assert(/tahun/.test(idLocale.xtdAliases.ytd));
});
test('id: dayBeforeYesterdayRegex contains "kemarin" and "lusa"', () => {
    assert(/kemarin/.test(idLocale.dayBeforeYesterdayRegex));
    assert(/lusa/.test(idLocale.dayBeforeYesterdayRegex));
});

// ── Registry integration: MONTH_ABBREVS merge ─────────────────────────
console.log('\n\uD83D\uDD17  Registry integration');
const { MONTH_NAMES_EN, MONTH_NAMES_ID, MONTH_ABBREVS } = require('../utils/temporal-resolver');

test('MONTH_NAMES_EN sourced from en.js locale', () => {
    assertEqual(MONTH_NAMES_EN[0],  'january');
    assertEqual(MONTH_NAMES_EN[11], 'december');
    assertEqual(MONTH_NAMES_EN.length, 12);
});
test('MONTH_NAMES_ID sourced from id.js locale', () => {
    assertEqual(MONTH_NAMES_ID[0],  'januari');
    assertEqual(MONTH_NAMES_ID[11], 'desember');
    assertEqual(MONTH_NAMES_ID.length, 12);
});
test('MONTH_ABBREVS merges EN and ID abbreviations (aug + agu + ags all present at index 7)', () => {
    assert(MONTH_ABBREVS[7].includes('aug'), 'aug should be in merged index 7');
    assert(MONTH_ABBREVS[7].includes('agu'), 'agu should be in merged index 7');
    assert(MONTH_ABBREVS[7].includes('ags'), 'ags should be in merged index 7');
});
test('MONTH_ABBREVS merges oct + okt at index 9', () => {
    assert(MONTH_ABBREVS[9].includes('oct'), 'oct at index 9');
    assert(MONTH_ABBREVS[9].includes('okt'), 'okt at index 9');
});
test('MONTH_ABBREVS merges dec + des at index 11', () => {
    assert(MONTH_ABBREVS[11].includes('dec'), 'dec at index 11');
    assert(MONTH_ABBREVS[11].includes('des'), 'des at index 11');
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
