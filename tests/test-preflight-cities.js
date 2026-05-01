#!/usr/bin/env node
/**
 * Preflight City Detection — regression tests
 *
 * Guards the three city-detection fixes from Task #128:
 *   Fix 1 — 'ny' added to KNOWN_CITIES_REGEX (was missing; only 'nyc' and 'new york' existed)
 *   Fix 2 — matchedCity gate: city.length > 2 guard removed so 2-letter abbreviations
 *            can also match via the raw cityWordBoundary pattern
 *   Fix 3 — Belt-and-suspenders: Round 1 city expansion scans LLM tool-call queries
 *            and adds any newly-found cities to the cities array + parsedData
 *
 * Run: node tests/test-preflight-cities.js
 */

'use strict';

const { KNOWN_CITIES_REGEX, CITY_EXPAND } = require('../utils/geo-data');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
    try {
        fn();
        console.log(`  ✅  ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${label}`);
        console.log(`      ${e.message}`);
        failed++;
        failures.push({ label, error: e.message });
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

// ── Helper: extract cities from a query string (mirrors preflight-router line 413) ───────────
function extractCitiesFromQuery(query) {
    return [...new Set(
        (query.match(new RegExp(KNOWN_CITIES_REGEX.source, 'gi')) || []).map(c => c.toLowerCase())
    )];
}

// ── Helper: matchedCity logic (mirrors pipeline-orchestrator lines 1571-1582) ────────────────
function matchedCityFor(searchQuery, cities) {
    const queryLower = searchQuery.toLowerCase();
    for (const city of cities) {
        const expanded = CITY_EXPAND[city] || city;
        const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedExpanded = expanded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cityWordBoundary = new RegExp(`(?:^|\\s|[^a-z])${escapedCity}(?:$|\\s|[^a-z])`, 'i');
        const expandedWordBoundary = new RegExp(`(?:^|\\s|[^a-z])${escapedExpanded}(?:$|\\s|[^a-z])`, 'i');
        if (expandedWordBoundary.test(queryLower) || cityWordBoundary.test(queryLower)) {
            return city;
        }
    }
    return null;
}

// ── SECTION 1: KNOWN_CITIES_REGEX — abbreviation coverage ─────────────────────────────────────
console.log('\n── KNOWN_CITIES_REGEX abbreviation coverage (Bug 1 regression) ──');

test('"ny" matched by KNOWN_CITIES_REGEX (Fix 1 regression guard)', () => {
    const matches = extractCitiesFromQuery('check NY and SF seed metrics');
    assert(matches.includes('ny'), `'ny' must be matched; got: ${JSON.stringify(matches)}`);
    assert(matches.includes('sf'), `'sf' must also be matched; got: ${JSON.stringify(matches)}`);
});

test('"NY" uppercase matched by KNOWN_CITIES_REGEX (case-insensitive)', () => {
    const matches = extractCitiesFromQuery('NY housing prices');
    assert(matches.includes('ny'), `'ny' expected; got: ${JSON.stringify(matches)}`);
});

test('"nyc" still matched (not broken by adding ny)', () => {
    const matches = extractCitiesFromQuery('NYC apartment costs');
    assert(matches.includes('nyc'), `'nyc' expected; got: ${JSON.stringify(matches)}`);
});

test('"new york" long-form still matched', () => {
    const matches = extractCitiesFromQuery('New York housing market');
    assert(matches.includes('new york'), `'new york' expected; got: ${JSON.stringify(matches)}`);
});

test('"sf" matched (regression — was already working)', () => {
    const matches = extractCitiesFromQuery('SF seed metric 2025');
    assert(matches.includes('sf'), `'sf' expected; got: ${JSON.stringify(matches)}`);
});

test('"la" matched', () => {
    const matches = extractCitiesFromQuery('LA housing affordability');
    assert(matches.includes('la'), `'la' expected; got: ${JSON.stringify(matches)}`);
});

test('"kl" matched (another 2-letter abbreviation in the regex)', () => {
    const matches = extractCitiesFromQuery('KL property price per sqm');
    assert(matches.includes('kl'), `'kl' expected; got: ${JSON.stringify(matches)}`);
});

test('"ny" does NOT match inside a longer word ("pony", "any", "tony")', () => {
    const matches = extractCitiesFromQuery('any pony tony player');
    assert(!matches.includes('ny'), `'ny' must NOT match inside longer words; got: ${JSON.stringify(matches)}`);
});

test('multi-city "NY and SF" both detected from one query', () => {
    const matches = extractCitiesFromQuery('check NY and SF seed metrics');
    assert(matches.length >= 2, `expected ≥2 cities; got: ${JSON.stringify(matches)}`);
    assert(matches.includes('ny'), 'ny missing');
    assert(matches.includes('sf'), 'sf missing');
});

test('three-city query extracts all three', () => {
    const matches = extractCitiesFromQuery('compare NY, SF and Tokyo housing');
    assert(matches.includes('ny'), 'ny missing');
    assert(matches.includes('sf'), 'sf missing');
    assert(matches.includes('tokyo'), 'tokyo missing');
});

// ── SECTION 2: matchedCity gate — short abbreviation matching (Bug 2 fix) ────────────────────
console.log('\n── matchedCity gate — 2-letter abbreviations (Bug 2 fix) ──');

test('"ny" in cities: "New York residential property..." matches city ny via expanded form', () => {
    const result = matchedCityFor('New York residential property price per square meter USD 2026', ['ny', 'sf']);
    assert(result === 'ny', `expected 'ny', got '${result}'`);
});

test('"sf" in cities: "San Francisco residential property..." matches city sf via expanded form', () => {
    const result = matchedCityFor('San Francisco residential property price per square meter USD 2026', ['ny', 'sf']);
    assert(result === 'sf', `expected 'sf', got '${result}'`);
});

test('"ny" in cities: "New York average income 2026" matches ny', () => {
    const result = matchedCityFor('New York average income 2026', ['ny', 'sf']);
    assert(result === 'ny', `expected 'ny', got '${result}'`);
});

test('"sf" in cities: "SF historical price 2000s" matches sf via raw form (no city.length>2 gate)', () => {
    const result = matchedCityFor('SF historical price 2000s', ['ny', 'sf']);
    assert(result === 'sf', `expected 'sf', got '${result}'`);
});

test('"la" in cities: "Los Angeles income 2025" matches la via expanded form', () => {
    const result = matchedCityFor('Los Angeles income 2025', ['la', 'tokyo']);
    assert(result === 'la', `expected 'la', got '${result}'`);
});

test('tokyo in cities: "Tokyo property price 2025" matches tokyo (long city, regression)', () => {
    const result = matchedCityFor('Tokyo property price 2025', ['ny', 'tokyo']);
    assert(result === 'tokyo', `expected 'tokyo', got '${result}'`);
});

test('unrecognised query returns null (no false positive)', () => {
    const result = matchedCityFor('NVIDIA earnings beat estimates', ['ny', 'sf']);
    assert(result === null, `expected null, got '${result}'`);
});

// ── SECTION 3: Belt-and-suspenders Round 1 expansion simulation (Bug 3 fix) ──────────────────
console.log('\n── Round-1 city expansion (belt-and-suspenders) ──');

// Mirrors pipeline-orchestrator Round-1 expansion logic (including canonicalization fix)
const _cityContract = Object.fromEntries(Object.entries(CITY_EXPAND).map(([abbr, full]) => [full, abbr]));

function canonicalize(found) {
    return CITY_EXPAND[found] ? found : (_cityContract[found] || found);
}

function simulateRound1Expansion(prefetchCities, round1Queries, histDecade) {
    const cities = [...prefetchCities];
    const parsedData = { cities: {} };
    for (const c of cities) {
        parsedData.cities[c] = { current: { pricePerSqm: null, income: null }, historical: { pricePerSqm: null, income: null, decade: histDecade } };
    }

    for (const q of round1Queries) {
        const tcQuery = q.toLowerCase();
        const found = (tcQuery.match(new RegExp(KNOWN_CITIES_REGEX.source, 'gi')) || []).map(c => c.toLowerCase());
        for (const f of found) {
            const canonical = canonicalize(f);
            if (!cities.includes(canonical)) {
                cities.push(canonical);
                parsedData.cities[canonical] = { current: { pricePerSqm: null, income: null }, historical: { pricePerSqm: null, income: null, decade: histDecade } };
            }
        }
    }
    return { cities, parsedData };
}

test('preflight misses NY, Round 1 adds it from actual search queries (canonical key = ny)', () => {
    const { cities } = simulateRound1Expansion(
        ['sf'],  // preflight only detected sf
        [
            'New York residential property price per square meter USD 2026',
            'New York average income 2026',
            'New York housing price per square meter historical 2000s',
            'New York average income 2000s'
        ],
        '2000s'
    );
    assert(cities.includes('sf'), 'sf must remain');
    // 'New York' in the query matches 'new york' via KNOWN_CITIES_REGEX → canonicalized to 'ny'
    assert(cities.includes('ny'), `canonical 'ny' must be added from Round 1 queries; cities: ${JSON.stringify(cities)}`);
    assert(!cities.includes('new york'), `'new york' must NOT be added as a separate key; cities: ${JSON.stringify(cities)}`);
});

test('cities already present are not duplicated by Round 1 expansion', () => {
    const { cities } = simulateRound1Expansion(
        ['sf', 'tokyo'],
        [
            'San Francisco residential property price per square meter 2026',
            'Tokyo residential property price per square meter 2026'
        ],
        '2000s'
    );
    const sfCount = cities.filter(c => c === 'sf').length;
    const tkCount = cities.filter(c => c === 'tokyo').length;
    assert(sfCount === 1, `sf must appear exactly once; got ${sfCount}`);
    assert(tkCount === 1, `tokyo must appear exactly once; got ${tkCount}`);
});

test('parsedData.cities initialised for each Round 1 expansion city', () => {
    const { parsedData } = simulateRound1Expansion(
        ['sf'],
        ['New York average income 2026'],
        '2000s'
    );
    assert(parsedData.cities['ny'] !== undefined, "'ny' entry must be created (canonical key)");
    assert(parsedData.cities['ny'].current !== undefined, 'current sub-object must exist');
    assert(parsedData.cities['ny'].historical !== undefined, 'historical sub-object must exist');
    assert(parsedData.cities['new york'] === undefined, "'new york' must NOT be a separate key");
});

test('alias collision: preflight adds ny, Round 1 searches "new york" — only ONE key created', () => {
    const { cities, parsedData } = simulateRound1Expansion(
        ['ny'],  // preflight added abbreviation
        ['New York residential property price per square meter USD 2026'],  // LLM uses long form
        '2000s'
    );
    assert(cities.filter(c => c === 'ny').length === 1, "'ny' must appear exactly once");
    assert(!cities.includes('new york'), "'new york' must NOT be a separate city entry");
    assert(parsedData.cities['ny'] !== undefined, 'parsedData.cities must use canonical key ny');
    assert(parsedData.cities['new york'] === undefined, "'new york' must NOT be a separate parsedData key");
});

test('alias collision: preflight adds sf, Round 1 searches "san francisco" — only ONE key created', () => {
    const { cities, parsedData } = simulateRound1Expansion(
        ['sf'],
        ['San Francisco residential property price per square meter 2026'],
        '2000s'
    );
    assert(cities.filter(c => c === 'sf').length === 1, "'sf' must appear exactly once");
    assert(!cities.includes('san francisco'), "'san francisco' must NOT be a separate entry");
    assert(parsedData.cities['sf'] !== undefined, 'parsedData.cities must use canonical key sf');
    assert(parsedData.cities['san francisco'] === undefined, "'san francisco' key must not exist");
});

test('canonicalize helper: ny → ny, new york → ny, chicago → chicago', () => {
    assert(canonicalize('ny') === 'ny', "'ny' should stay 'ny'");
    assert(canonicalize('new york') === 'ny', "'new york' should map to 'ny'");
    assert(canonicalize('sf') === 'sf', "'sf' should stay 'sf'");
    assert(canonicalize('san francisco') === 'sf', "'san francisco' should map to 'sf'");
    assert(canonicalize('chicago') === 'chicago', "'chicago' has no abbreviation, stays 'chicago'");
    assert(canonicalize('tokyo') === 'tokyo', "'tokyo' has no abbreviation, stays 'tokyo'");
});

// ── SECTION 4: Preflight extraction canonicalization ──────────────────────────────────────────
// Simulates Phase 0 cities array extraction in pipeline-orchestrator with the new canonicalization.
console.log('\n── Preflight extraction canonicalization ──');

function simulatePreflightExtract(seedMetricSearchQueries) {
    return [...new Set(seedMetricSearchQueries.map(q => {
        const match = q.match(/^([a-z\s]+)\s+(?:residential|average|median|housing|apartment)/i);
        if (!match) return null;
        const raw = match[1].trim().toLowerCase();
        return _cityContract[raw] || raw;
    }).filter(Boolean))];
}

test('preflight extracts canonical ny from "new york residential property..." query', () => {
    const cities = simulatePreflightExtract([
        'new york residential property price per square meter USD 2026',
        'new york average income 2026'
    ]);
    assert(cities.includes('ny'), `'ny' must be extracted; got ${JSON.stringify(cities)}`);
    assert(!cities.includes('new york'), `'new york' must NOT appear as a separate key; got ${JSON.stringify(cities)}`);
});

test('preflight extracts canonical sf from "san francisco residential property..." query', () => {
    const cities = simulatePreflightExtract([
        'san francisco residential property price per square meter USD 2026',
        'san francisco average income 2026'
    ]);
    assert(cities.includes('sf'), `'sf' must be extracted; got ${JSON.stringify(cities)}`);
    assert(!cities.includes('san francisco'), `'san francisco' must NOT appear separately; got ${JSON.stringify(cities)}`);
});

test('"check New York and SF" preflight produces exactly [ny, sf] with no duplicates', () => {
    const cities = simulatePreflightExtract([
        'new york residential property price per square meter USD 2026',
        'new york average income 2026',
        'new york residential property price per square meter historical 2000s',
        'new york average income 2000s',
        'sf residential property price per square meter USD 2026',
        'sf average income 2026',
        'sf residential property price per square meter historical 2000s',
        'sf average income 2000s'
    ]);
    const sorted = cities.slice().sort().join(',');
    assert(sorted === 'ny,sf', `expected 'ny,sf', got '${sorted}'`);
});

test('"check New York and SF" + Round 1 expansion produces no extra keys', () => {
    const prefetch = simulatePreflightExtract([
        'new york residential property price per square meter USD 2026',
        'sf residential property price per square meter USD 2026'
    ]);
    // Round 1 LLM queries reference long-form 'New York' — must NOT add a second key
    const { cities, parsedData } = simulateRound1Expansion(prefetch, [
        'New York residential property price per square meter USD 2026',
        'San Francisco residential property price per square meter 2026'
    ], '2000s');
    const sorted = cities.slice().sort().join(',');
    assert(sorted === 'ny,sf', `cities must be 'ny,sf'; got '${sorted}'`);
    const pdKeys = Object.keys(parsedData.cities).sort().join(',');
    assert(pdKeys === 'ny,sf', `parsedData keys must be 'ny,sf'; got '${pdKeys}'`);
});

// ── SECTION 5: CITY_EXPAND integration ────────────────────────────────────────────────────────
console.log('\n── CITY_EXPAND coverage ──');

test("CITY_EXPAND maps 'ny' → 'new york'", () => {
    assert(CITY_EXPAND['ny'] === 'new york', `expected 'new york', got '${CITY_EXPAND['ny']}'`);
});

test("CITY_EXPAND maps 'sf' → 'san francisco'", () => {
    assert(CITY_EXPAND['sf'] === 'san francisco', `got '${CITY_EXPAND['sf']}'`);
});

test("CITY_EXPAND maps 'la' → 'los angeles'", () => {
    assert(CITY_EXPAND['la'] === 'los angeles', `got '${CITY_EXPAND['la']}'`);
});

// ── Summary ────────────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(58)}`);
console.log(`📊 Preflight Cities Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
}
console.log('='.repeat(58));
process.exit(failed > 0 ? 1 : 0);
