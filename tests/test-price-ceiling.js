#!/usr/bin/env node
/**
 * Tests for the physical-market price/sqm ceiling guard.
 *
 * Task #202 (Part D) — Tokyo LCU/sqm anomaly (¥67.1M/sqm) was caused by the
 * Numbeo regex bleeding across HTML rows and capturing a TOTAL apartment
 * price as the per-sqm value. Two-pronged fix:
 *   (1) Tighten the Numbeo BUY_REGEX to disallow newlines / HTML-tag crossings
 *       and cap the gap between label and value at 200/80 chars.
 *   (2) Add `rescuePricePerSqm(value, currency)` — per-currency physical
 *       ceilings (~2-3× peak prime market) that nulls obviously impossible
 *       values before they reach the user.
 *
 * Run: node tests/test-price-ceiling.js
 */

'use strict';

const {
    rescuePricePerSqm,
    PHYSICAL_PRICE_CEILING_PER_SQM
} = require('../utils/seed-metric-calculator');

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── The Tokyo bug fixture ─────────────────────────────────────────────────────
console.log('\n\u26A0\uFE0F  Tokyo anomaly — the bug that motivated this guard');

test('JPY ¥67,100,000/sqm (the reported Tokyo value) → null', () => {
    assertEqual(rescuePricePerSqm(67100000, 'JPY'), null);
});
test('JPY ¥80,000,000 (typical Tokyo total-apartment price scraped as /sqm) → null', () => {
    assertEqual(rescuePricePerSqm(80000000, 'JPY'), null);
});
test('JPY ¥2,225,000/sqm (real Numbeo Tokyo City Centre value) → unchanged', () => {
    assertEqual(rescuePricePerSqm(2225000, 'JPY'), 2225000);
});
test('JPY ¥4,000,000/sqm (Ginza penthouse peak) → unchanged (below ¥10M ceiling)', () => {
    assertEqual(rescuePricePerSqm(4000000, 'JPY'), 4000000);
});

// ── Per-currency ceiling sanity ───────────────────────────────────────────────
console.log('\n\uD83C\uDFE0  Per-currency ceiling — accept real prime, reject the absurd');

test('USD $30,000/sqm (Manhattan prime) → unchanged', () => {
    assertEqual(rescuePricePerSqm(30000, 'USD'), 30000);
});
test('USD $250,000/sqm → null', () => {
    assertEqual(rescuePricePerSqm(250000, 'USD'), null);
});
test('EUR €40,000/sqm (Monaco) → unchanged', () => {
    assertEqual(rescuePricePerSqm(40000, 'EUR'), 40000);
});
test('GBP £35,000/sqm (London Mayfair) → unchanged', () => {
    assertEqual(rescuePricePerSqm(35000, 'GBP'), 35000);
});
test('HKD HK$200,000/sqm (The Peak) → unchanged', () => {
    assertEqual(rescuePricePerSqm(200000, 'HKD'), 200000);
});
test('HKD HK$1,000,000/sqm → null', () => {
    assertEqual(rescuePricePerSqm(1000000, 'HKD'), null);
});
test('KRW ₩20,000,000/sqm (Seoul Gangnam) → unchanged', () => {
    assertEqual(rescuePricePerSqm(20000000, 'KRW'), 20000000);
});
test('KRW ₩100,000,000/sqm → null', () => {
    assertEqual(rescuePricePerSqm(100000000, 'KRW'), null);
});
test('IDR Rp80,000,000/sqm (Jakarta Menteng) → unchanged', () => {
    assertEqual(rescuePricePerSqm(80000000, 'IDR'), 80000000);
});
test('IDR Rp500,000,000/sqm → null', () => {
    assertEqual(rescuePricePerSqm(500000000, 'IDR'), null);
});

// ── Currency-code normalisation ───────────────────────────────────────────────
console.log('\n\uD83D\uDD24  Currency-code handling');

test('lowercase jpy → matched to JPY ceiling', () => {
    assertEqual(rescuePricePerSqm(67100000, 'jpy'), null);
});
test('mixed-case Usd → matched to USD ceiling', () => {
    assertEqual(rescuePricePerSqm(250000, 'Usd'), null);
});

// ── Defensive — pass through when guard can't apply ──────────────────────────
console.log('\n\uD83D\uDEE1\uFE0F  Defensive pass-through (no false rejections)');

test('Unknown currency (XAU) → unchanged (no ceiling = no opinion)', () => {
    assertEqual(rescuePricePerSqm(50000, 'XAU'), 50000);
});
test('null currency → unchanged value (defensive)', () => {
    assertEqual(rescuePricePerSqm(1500, null), 1500);
});
test('empty-string currency → unchanged value', () => {
    assertEqual(rescuePricePerSqm(1500, ''), 1500);
});

// ── Bad input → null (never throw, never bypass) ──────────────────────────────
console.log('\n\uD83D\uDEAB  Bad input handling');

test('null value → null', () => {
    assertEqual(rescuePricePerSqm(null, 'USD'), null);
});
test('undefined value → null', () => {
    assertEqual(rescuePricePerSqm(undefined, 'USD'), null);
});
test('0 → null', () => {
    assertEqual(rescuePricePerSqm(0, 'USD'), null);
});
test('negative value → null', () => {
    assertEqual(rescuePricePerSqm(-1000, 'USD'), null);
});
test('NaN → null', () => {
    assertEqual(rescuePricePerSqm(NaN, 'USD'), null);
});
test('Infinity → null', () => {
    assertEqual(rescuePricePerSqm(Infinity, 'JPY'), null);
});

// ── Tightened Numbeo regex — the regex bleed that started it all ──────────────
console.log('\n\uD83D\uDD0D  Numbeo regex — must not bleed across HTML rows');

const TIGHTENED_BUY_REGEX = /Price\s+per\s+Square\s+(Fe(?:et|et)|Met(?:er|re))[^\n<]{0,200}?(?:to\s+Buy\s+)?[^\n<]{0,80}?City\s+Cent(?:re|er)\s+(\$|[¥€£₩₹])\s*([\d,]+(?:\.\d+)?)/i;

test('Real Numbeo Tokyo row → captures ¥2,225,000 (not the apartment total)', () => {
    // Realistic Numbeo HTML shape: each row is on its own line. The label and
    // its value sit close together; unrelated rows (Apartment Price in City
    // Centre — ¥80,000,000) live below on separate lines.
    const text = 'Price per Square Meter to Buy Apartment in City Centre ¥ 2,225,000.00\nApartment (3 bedrooms) in City Centre ¥ 80,000,000.00';
    const m = text.match(TIGHTENED_BUY_REGEX);
    assertEqual(m && m[3], '2,225,000.00');
});

test('Bleed-attempt: tag-separated rows — regex MUST NOT cross </td> boundaries', () => {
    // The pre-fix regex used naked `.*?` which would skip across HTML tags and
    // grab the apartment total. The tightened `[^\n<]{0,200}?` refuses to cross
    // a `<` so the apartment-total ¥80M row is unreachable from the label.
    const html = 'Price per Square Meter to Buy Apartment in City Centre</td><td>¥ 80,000,000.00</td>';
    const m = html.match(TIGHTENED_BUY_REGEX);
    // Either no match, or it matches but the captured value isn't the ¥80M total.
    if (m) {
        if (m[3] === '80,000,000.00') {
            throw new Error('regex bled across </td><td> tag boundary and captured the apartment total');
        }
    }
});

test('Bleed-attempt: newline-separated rows — regex MUST NOT cross \\n', () => {
    const text = 'Price per Square Meter to Buy Apartment\n[unrelated row]\nApartment Price in City Centre ¥ 80,000,000.00';
    const m = text.match(TIGHTENED_BUY_REGEX);
    if (m && m[3] === '80,000,000.00') {
        throw new Error('regex bled across newlines and captured the apartment total');
    }
});

// ── Ceiling map shape ─────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCC8  Ceiling map shape');

test('PHYSICAL_PRICE_CEILING_PER_SQM is a plain object', () => {
    if (!PHYSICAL_PRICE_CEILING_PER_SQM || typeof PHYSICAL_PRICE_CEILING_PER_SQM !== 'object') {
        throw new Error('expected exported object');
    }
});
test('Major currencies all have ceilings', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'CNY', 'SGD', 'HKD', 'IDR']) {
        if (!(code in PHYSICAL_PRICE_CEILING_PER_SQM)) {
            throw new Error(`${code} missing from ceiling map`);
        }
    }
});
test('JPY ceiling is ¥10M (the spec figure)', () => {
    assertEqual(PHYSICAL_PRICE_CEILING_PER_SQM.JPY, 10000000);
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
