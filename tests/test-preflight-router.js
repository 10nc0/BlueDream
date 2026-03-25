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

// Dollar-prefix ($TICK) or "stock/stocks" keyword signals ticker context and bypasses
// ALL geo / seed-metric detection — mirrors the actual preflight router pre-check.
// detectSeedMetricIntent does NOT know about the dollar prefix ($SF → still matches SF+price),
// so this guard must fire BEFORE calling detectSeedMetricIntent.
const TICKER_CONTEXT_RE = /\$[A-Z]{1,5}\b|\b(stock|stocks)\b/i;

function routeQuery(query) {
    if (PSI_EMA_RE.test(query))                         return 'psi-ema-identity'; // step 0: explicit psi-ema always wins
    if (isForexQuery(query) || detectForexPair(query)) return 'forex';             // step 1: forex
    if (TICKER_CONTEXT_RE.test(query))                  return 'psi-ema';          // step 2: ticker override
    if (detectSeedMetricIntent(query))                  return 'seed-metric';      // step 3: geo / housing
    return 'psi-ema'; // default — psi-ema is the general path
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

test('$LA price → geo-veto does NOT fire (dollar prefix on city abbrev = ticker context)', () => {
    assert(!geoVetoWouldFire('$LA price'), 'geo-veto should not fire for "$LA price"');
});

test('SF stock price → geo-veto does NOT fire ("stock" = ticker cue)', () => {
    assert(!geoVetoWouldFire('SF stock price'), 'geo-veto should not fire for "SF stock price"');
});

test('LA stocks → geo-veto does NOT fire ("stocks" = ticker cue)', () => {
    assert(!geoVetoWouldFire('LA stocks'), 'geo-veto should not fire');
});

// ----------------------------------------------------------------
// SECTION 3: Psi-EMA identity keyword (step 0 — overrides all other routes)
// Forex is also a price wave time series → "EURUSD psi-ema" routes to psi-ema, not forex
// ----------------------------------------------------------------
console.log('\n🌀 Ψ-EMA identity detection');

test('"What is psi-ema?" → psi-ema-identity', () => {
    assert(routeQuery('What is psi-ema?') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"explain Ψ-EMA" → psi-ema-identity (Unicode Ψ)', () => {
    assert(routeQuery('explain Ψ-EMA') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"psi ema" → psi-ema-identity (space variant — no hyphen)', () => {
    assert(routeQuery('psi ema') === 'psi-ema-identity', 'expected psi-ema-identity for space variant');
});

test('"NVDA psi ema" → psi-ema-identity (equity + space variant)', () => {
    assert(routeQuery('NVDA psi ema') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"EURUSD psi-ema" → psi-ema-identity (forex pair — psi-ema explicit request beats forex detection)', () => {
    assert(routeQuery('EURUSD psi-ema') === 'psi-ema-identity', 'expected psi-ema-identity, not forex');
});

test('"SF psi-ema" → psi-ema-identity (city abbrev — psi-ema explicit request beats seed-metric)', () => {
    assert(routeQuery('SF psi-ema') === 'psi-ema-identity', 'expected psi-ema-identity, not seed-metric');
});

// ----------------------------------------------------------------
// SECTION 4: Forex detection (step 1 — after psi-ema-identity, before seed-metric)
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
// SECTION 6: Full routing cascade — key edge cases
// Tests routeQuery() end-to-end for cases that require cascade ordering to be correct
// ----------------------------------------------------------------
console.log('\n🔀 Full routing cascade');

test('"$SF price" → psi-ema (Stifel ticker — dollar prefix overrides geo, seed-metric bypassed)', () => {
    const result = routeQuery('$SF price');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"$AAPL rent" → psi-ema (dollar prefix on unambiguous ticker)', () => {
    const result = routeQuery('$AAPL rent');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"NVDA price" → psi-ema (Bloomberg-spec: equity ticker + price, no geo)', () => {
    const result = routeQuery('NVDA price');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"AAPL earnings" → psi-ema (Bloomberg-spec: equity context, no geo)', () => {
    const result = routeQuery('AAPL earnings');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"what did Elon tweet?" → psi-ema (general query — psi-ema is the default path)', () => {
    const result = routeQuery('what did Elon tweet?');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"EURUSD price" → forex (forex step fires first, before geo-veto or seed-metric)', () => {
    // EURUSD is a currency pair — forex step 0 catches it before any other check
    const result = routeQuery('EURUSD price');
    assert(result === 'forex', `expected forex, got ${result}`);
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
