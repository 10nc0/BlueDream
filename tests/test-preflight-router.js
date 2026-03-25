#!/usr/bin/env node
/**
 * Preflight Router Unit Tests — standalone, no live server required.
 *
 * Tests the routing cascade that determines whether a query goes to:
 *   seed-metric | psi-ema | psi-ema-identity | forex | general
 *
 * Covers the two fixes shipped in the routing refactor:
 *   1. City abbreviation + affordability keyword → Seed Metric (not Ψ-EMA)
 *   2. Bloomberg-spec Ψ-EMA: ticker + price sufficient (no "stock/shares" required)
 *
 * Run: node tests/test-preflight-router.js
 */

'use strict';

const { detectSeedMetricIntent } = require('../prompts/seed-metric');
const { detectForexPair, isForexQuery }  = require('../utils/forex-fetcher');

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

// ----------------------------------------------------------------
// Geo-veto helper (mirrors utils/preflight-router.js logic)
// ----------------------------------------------------------------
const CITY_ABBREV_RE   = /\b(la|ny|sf|dc|hk|kl)\b/i;
const AFFORDABILITY_RE = /\b(price|prices|housing|property|rent|land|cost|income|salary|afford)\b/i;
const STOCK_CUE_RE     = /\$[A-Z]{1,5}\b|\b(stock|stocks)\b/i;

function geoVetoWouldFire(query) {
    const hasCityAbbrev   = CITY_ABBREV_RE.test(query);
    const hasAffordability = AFFORDABILITY_RE.test(query);
    const hasStockCue      = STOCK_CUE_RE.test(query);
    return hasCityAbbrev && hasAffordability && !hasStockCue;
}

// NOTE: \b does not work with non-ASCII Unicode (ψ/Ψ). Use lookaround with \s|^|$ instead.
const PSI_EMA_RE = /(?:^|[\s,;.!?])(psi|ψ)[\s\-]?ema(?:$|[\s,;.!?])/i;

function routeQuery(query) {
    if (isForexQuery(query) || detectForexPair(query)) return 'forex';
    if (detectSeedMetricIntent(query))                  return 'seed-metric';
    if (PSI_EMA_RE.test(query))                         return 'psi-ema-identity';
    if (geoVetoWouldFire(query))                        return 'seed-metric';
    return 'psi-ema-or-general';
}

// ----------------------------------------------------------------
// SECTION 1: detectSeedMetricIntent
// ----------------------------------------------------------------
console.log('\n🔍 detectSeedMetricIntent()');

test('SF housing price → seed-metric (city abbrev + housing keyword)', () => {
    assert(detectSeedMetricIntent('SF housing price'), 'expected true for "SF housing price"');
});

test('SF price → seed-metric (city abbrev + price keyword)', () => {
    assert(detectSeedMetricIntent('SF price'), 'expected true for "SF price"');
});

test('SF price? → seed-metric (trailing punctuation)', () => {
    assert(detectSeedMetricIntent('SF price?'), 'expected true for "SF price?"');
});

test('LA housing market → seed-metric', () => {
    assert(detectSeedMetricIntent('LA housing market'), 'expected true for "LA housing market"');
});

test('NY rent → seed-metric', () => {
    assert(detectSeedMetricIntent('NY rent'), 'expected true for "NY rent"');
});

test('HK property → seed-metric', () => {
    assert(detectSeedMetricIntent('HK property'), 'expected true for "HK property"');
});

test('KL land cost → seed-metric', () => {
    assert(detectSeedMetricIntent('KL land cost'), 'expected true for "KL land cost"');
});

test('price in SF → seed-metric (keyword before abbrev)', () => {
    assert(detectSeedMetricIntent('what is the price in SF'), 'expected true for "what is the price in SF"');
});

test('housing in LA → seed-metric (keyword before abbrev)', () => {
    assert(detectSeedMetricIntent('housing in LA'), 'expected true for "housing in LA"');
});

test('LA vs NY housing → seed-metric (existing vs-pattern preserved)', () => {
    assert(detectSeedMetricIntent('LA vs NY housing'), 'expected true for "LA vs NY housing"');
});

test('DC housing → seed-metric (DC abbreviation covered)', () => {
    assert(detectSeedMetricIntent('DC housing'), 'expected true for "DC housing"');
});

test('seed metric → seed-metric (explicit trigger)', () => {
    assert(detectSeedMetricIntent('seed metric for Tokyo'), 'expected true');
});

test('housing affordability → seed-metric', () => {
    assert(detectSeedMetricIntent('housing affordability in Vietnam'), 'expected true');
});

test('700sqm → seed-metric', () => {
    assert(detectSeedMetricIntent('700 sqm formula'), 'expected true');
});

test('NVDA price alone → NOT seed-metric (no geo abbrev)', () => {
    assert(!detectSeedMetricIntent('NVDA price'), 'expected false for bare "NVDA price"');
});

test('BTC price → NOT seed-metric (crypto ticker, no geo)', () => {
    assert(!detectSeedMetricIntent('BTC price'), 'expected false for "BTC price"');
});

test('general question → NOT seed-metric', () => {
    assert(!detectSeedMetricIntent('what did Elon Musk tweet yesterday?'), 'expected false');
});

// ----------------------------------------------------------------
// SECTION 2: Geo-veto guard
// ----------------------------------------------------------------
console.log('\n🌍 Geo-veto guard');

test('SF housing price → geo-veto fires', () => {
    assert(geoVetoWouldFire('SF housing price'), 'geo-veto should fire');
});

test('SF price → geo-veto fires', () => {
    assert(geoVetoWouldFire('SF price'), 'geo-veto should fire');
});

test('$SF price → geo-veto does NOT fire (dollar prefix = ticker)', () => {
    assert(!geoVetoWouldFire('$SF price'), 'geo-veto should not fire for "$SF price"');
});

test('$DC price → geo-veto does NOT fire (dollar prefix, non-SF city)', () => {
    assert(!geoVetoWouldFire('$DC price'), 'geo-veto should not fire for "$DC price"');
});

test('SF stock price → geo-veto does NOT fire ("stock" = ticker cue)', () => {
    assert(!geoVetoWouldFire('SF stock price'), 'geo-veto should not fire for "SF stock price"');
});

test('LA stocks → geo-veto does NOT fire ("stocks" = ticker cue)', () => {
    assert(!geoVetoWouldFire('LA stocks'), 'geo-veto should not fire');
});

// ----------------------------------------------------------------
// SECTION 3: Psi-EMA identity keyword
// ----------------------------------------------------------------
console.log('\n🌀 Ψ-EMA identity detection');

test('"What is psi-ema?" → psi-ema-identity route', () => {
    assert(routeQuery('What is psi-ema?') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"explain Ψ-EMA" → psi-ema-identity route', () => {
    assert(routeQuery('explain Ψ-EMA') === 'psi-ema-identity', 'expected psi-ema-identity');
});

// ----------------------------------------------------------------
// SECTION 4: Forex detection (step 0 — runs before seed-metric)
// ----------------------------------------------------------------
console.log('\n💱 Forex detection');

test('EURUSD price → forex route', () => {
    assert(routeQuery('EURUSD price') === 'forex', 'expected forex for "EURUSD price"');
});

test('USD/JPY rate → forex route', () => {
    assert(routeQuery('USD/JPY rate') === 'forex', 'expected forex');
});

test('dollar to euro → forex route', () => {
    assert(routeQuery('dollar to euro') === 'forex', 'expected forex');
});

// ----------------------------------------------------------------
// SECTION 5: Seed-metric takes priority over psi-ema
// ----------------------------------------------------------------
console.log('\n🏠 Seed Metric priority over Ψ-EMA');

test('"SF price" routed via seed-metric (not psi-ema)', () => {
    assert(routeQuery('SF price') === 'seed-metric', `expected seed-metric, got ${routeQuery('SF price')}`);
});

test('"LA housing" routed via seed-metric', () => {
    assert(routeQuery('LA housing') === 'seed-metric', `expected seed-metric, got ${routeQuery('LA housing')}`);
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ❌ ${f.label}`));
}
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
