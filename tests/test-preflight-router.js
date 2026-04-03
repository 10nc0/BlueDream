#!/usr/bin/env node
/**
 * Preflight Router Unit Tests — standalone, no live server required.
 *
 * Routing cascade:
 *   Step 0  city abbreviation (no $) → seed-metric   (longevity > profit — city beats ambiguous ticker)
 *   Step 1  dollar-prefix / stock kw → psi-ema        (unambiguous ticker = analysis)
 *   Step 2  forex pair + psi-ema kw  → psi-ema        (run analysis on pair)
 *           forex pair alone         → forex
 *   Step 3  seed-metric proxy kw     → seed-metric    (city+affordability PRIMARY; sqm; long-form city;
 *                                                    literal "seed metric" phrase is least common)
 *   Step n-1 bare psi-ema kw (no asset context) → psi-ema-identity  (self-reflect from codebase)
 *   Default → psi-ema
 *
 * psi-ema-identity: "what is psi-ema?", "who are you?" — needs no external data,
 *   just injects PSI_EMA_DOCUMENTATION as H0 ground truth. Fires LAST so a real
 *   asset query with "psi-ema" in it (EURUSD psi-ema) runs analysis instead.
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
// Routing helpers
// ----------------------------------------------------------------
const CITY_ABBREV_RE   = /\b(la|ny|sf|dc|hk|kl)\b/i;
const AFFORDABILITY_RE = /\b(price|prices|housing|property|rent|land|cost|income|salary|afford)\b/i;
const STOCK_CUE_RE     = /\$[A-Z]{1,5}\b|\b(stock|stocks)\b/i;

function geoVetoWouldFire(query) {
    const hasCityAbbrev    = CITY_ABBREV_RE.test(query);
    const hasAffordability = AFFORDABILITY_RE.test(query);
    const hasStockCue      = STOCK_CUE_RE.test(query);
    return hasCityAbbrev && hasAffordability && !hasStockCue;
}

// NOTE: \b does not work with non-ASCII Unicode (ψ/Ψ). Use lookaround instead.
const PSI_EMA_RE = /(?:^|[\s,;.!?])(psi|ψ)[\s\-]?ema(?:$|[\s,;.!?])/i;

function routeQuery(query) {
    const hasDollarTicker = /\$[A-Z]{1,5}\b/.test(query);
    const hasStockKw      = /\b(stock|stocks)\b/i.test(query);
    const hasCityAbbrev   = CITY_ABBREV_RE.test(query) && !hasDollarTicker; // bare city, no $ prefix
    const hasForex        = isForexQuery(query) || detectForexPair(query);
    const hasPsiEma       = PSI_EMA_RE.test(query);

    // Step 0: bare city abbreviation → seed-metric (longevity > profit)
    // "SF psi-ema" → seed-metric  (SF = San Francisco, not Stifel — less known ticker,
    //   routing to equity would risk output hallucination on a poorly-known name)
    // "$SF psi-ema" → NOT here (dollar prefix = unambiguous Stifel, handled below)
    if (hasCityAbbrev) return 'seed-metric';

    // Step 1: dollar-prefix ($TICK) or "stock/stocks" → psi-ema (unambiguous ticker analysis)
    if (hasDollarTicker || hasStockKw) return 'psi-ema';

    // Step 2: forex pair
    // "EURUSD psi-ema" → psi-ema (run psi-ema analysis on the pair from YF — forex is
    //   also a price wave time series; explicit psi-ema request = run the algorithm)
    // "EURUSD price"   → forex   (plain price query, no psi-ema intent)
    if (hasForex) return hasPsiEma ? 'psi-ema' : 'forex';

    // Step 3: explicit seed-metric keywords (no city abbrev — handled above)
    if (detectSeedMetricIntent(query)) return 'seed-metric';

    // Step n-1: bare psi-ema keyword with no asset context → self-reflection / identity
    // "what is psi-ema?", "psi ema" — no external data needed; injects PSI_EMA_DOCUMENTATION
    if (hasPsiEma) return 'psi-ema-identity';

    // Default
    return 'psi-ema';
}

// ----------------------------------------------------------------
// SECTION 1: detectSeedMetricIntent — proxy-triggered, not keyword-literal
//
// "Seed Metric" is a housing affordability index ($/sqm triangulation).
// The router detects it via contextual proxy signals, not by matching
// the phrase "seed metric" literally. Primary triggers:
//   • City abbreviation (SF/LA/NY/DC/HK/KL) + affordability keyword
//     (price, housing, rent, property, land, cost, income, salary, afford)
//   • Area-unit patterns (sqm, sqft) implying triangulation intent
//   • Affordability keywords + long-form city name (no abbreviation needed)
//   • Explicit phrase "seed metric" — least common; aliases all the above
//
// Step 0 of routeQuery() is an additional proxy layer: bare city abbreviation
// (no $ prefix) → seed-metric, even without an affordability keyword present.
// This catches "SF psi-ema" (no housing word) before detectSeedMetricIntent
// would see it, because city context alone implies housing/land intent.
// ----------------------------------------------------------------
console.log('\n🔍 detectSeedMetricIntent() — proxy-triggered');

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

test('seed metric → seed-metric (explicit phrase — least common proxy; city+affordability is primary)', () => {
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
// SECTION 3: Ψ-EMA identity (step n-1 — self-reflection, no external data)
// Only fires when there is NO recognisable asset context (no city, no forex, no ticker).
// "EURUSD psi-ema" = run analysis on the pair (step 2), NOT identity.
// "SF psi-ema"     = city abbrev wins (step 0) → seed-metric, NOT identity.
// ----------------------------------------------------------------
console.log('\n🌀 Ψ-EMA identity detection');

test('"What is psi-ema?" → psi-ema-identity (meta question, no asset context)', () => {
    assert(routeQuery('What is psi-ema?') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"explain Ψ-EMA" → psi-ema-identity (Unicode Ψ, no asset context)', () => {
    assert(routeQuery('explain Ψ-EMA') === 'psi-ema-identity', 'expected psi-ema-identity');
});

test('"psi ema" → psi-ema-identity (space variant — no asset context)', () => {
    assert(routeQuery('psi ema') === 'psi-ema-identity', 'expected psi-ema-identity for space variant');
});

// ----------------------------------------------------------------
// SECTION 4: Forex detection (step 2 — after city + ticker checks)
// ----------------------------------------------------------------
console.log('\n💱 Forex detection');

test('EURUSD price → forex (plain price query, no psi-ema intent)', () => {
    assert(routeQuery('EURUSD price') === 'forex', 'expected forex for "EURUSD price"');
});

test('USD/JPY rate → forex', () => {
    assert(routeQuery('USD/JPY rate') === 'forex', 'expected forex');
});

test('dollar to euro → forex', () => {
    assert(routeQuery('dollar to euro') === 'forex', 'expected forex');
});

// ----------------------------------------------------------------
// SECTION 5: Seed-metric routing
// City abbreviation is step 0 — wins even when "psi-ema" is appended.
// ----------------------------------------------------------------
console.log('\n🏠 Seed Metric routing');

test('"SF price" → seed-metric', () => {
    assert(routeQuery('SF price') === 'seed-metric', `expected seed-metric, got ${routeQuery('SF price')}`);
});

test('"LA housing" → seed-metric', () => {
    assert(routeQuery('LA housing') === 'seed-metric', `expected seed-metric, got ${routeQuery('LA housing')}`);
});

test('"SF psi-ema" → seed-metric (city abbrev wins — SF = San Francisco, not Stifel; longevity > profit)', () => {
    const result = routeQuery('SF psi-ema');
    assert(result === 'seed-metric', `expected seed-metric, got ${result}`);
});

// ----------------------------------------------------------------
// SECTION 6: Full routing cascade — key edge cases
// ----------------------------------------------------------------
console.log('\n🔀 Full routing cascade');

test('"$SF price" → psi-ema (Stifel — dollar prefix makes ticker unambiguous)', () => {
    const result = routeQuery('$SF price');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"$SF psi-ema" → psi-ema (Stifel + psi-ema analysis — dollar prefix wins over geo)', () => {
    const result = routeQuery('$SF psi-ema');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"$AAPL rent" → psi-ema (dollar prefix on unambiguous ticker)', () => {
    const result = routeQuery('$AAPL rent');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"EURUSD psi-ema" → psi-ema (run psi-ema analysis on the pair — forex is a price wave time series)', () => {
    const result = routeQuery('EURUSD psi-ema');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"NVDA price" → psi-ema (equity, no geo, no forex pair detected)', () => {
    const result = routeQuery('NVDA price');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"AAPL earnings" → psi-ema (equity context, no geo)', () => {
    const result = routeQuery('AAPL earnings');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"what did Elon tweet?" → psi-ema (general query — psi-ema is the default path)', () => {
    const result = routeQuery('what did Elon tweet?');
    assert(result === 'psi-ema', `expected psi-ema, got ${result}`);
});

test('"EURUSD price" → forex (no psi-ema keyword — plain forex query)', () => {
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
    failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
}
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
