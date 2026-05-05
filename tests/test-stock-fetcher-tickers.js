#!/usr/bin/env node
/**
 * Stock fetcher ticker handling — unit tests
 *
 * Asserts:
 *   1. US class shares (.A/.B) are normalized to hyphen form Yahoo expects.
 *   2. Yahoo Finance international exchange suffixes (.JK/.HK/.T/.L/...) are
 *      preserved as-is — no hyphen rewrite.
 *   3. Digit-leading Asian tickers (0700.HK, 7203.T) survive validation.
 *   4. The dollar-prefix detector captures international tickers including
 *      digit-leading ones.
 *   5. The multi-ticker splitter preserves exchange suffixes when comparing.
 *
 * Optional live test: set LIVE_YAHOO=1 to actually fetch BBCA.JK from Yahoo.
 *
 * Run: node tests/test-stock-fetcher-tickers.js
 */

'use strict';

const assert = require('assert');
const {
    sanitizeTicker,
    detectStockTicker,
} = require('../utils/stock-fetcher');
const { splitMultiTicker } = require('../utils/psi-ema-extract');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
        failed++;
    }
}

console.log('\n── sanitizeTicker: US class shares (hyphenate) ──');

test('BRK.A → BRK-A', () => {
    assert.strictEqual(sanitizeTicker('BRK.A'), 'BRK-A');
});
test('BRK.B → BRK-B', () => {
    assert.strictEqual(sanitizeTicker('BRK.B'), 'BRK-B');
});
test('BF.B → BF-B', () => {
    assert.strictEqual(sanitizeTicker('BF.B'), 'BF-B');
});
test('lowercase brk.a → BRK-A', () => {
    assert.strictEqual(sanitizeTicker('brk.a'), 'BRK-A');
});

console.log('\n── sanitizeTicker: Yahoo international exchanges (preserve dot) ──');

test('BBCA.JK → BBCA.JK (Jakarta)', () => {
    assert.strictEqual(sanitizeTicker('BBCA.JK'), 'BBCA.JK');
});
test('0700.HK → 0700.HK (Hong Kong, digit-leading)', () => {
    assert.strictEqual(sanitizeTicker('0700.HK'), '0700.HK');
});
test('7203.T → 7203.T (Tokyo, single-letter suffix)', () => {
    assert.strictEqual(sanitizeTicker('7203.T'), '7203.T');
});
test('SHEL.L → SHEL.L (London, single-letter suffix)', () => {
    assert.strictEqual(sanitizeTicker('SHEL.L'), 'SHEL.L');
});
test('AIR.PA → AIR.PA (Paris)', () => {
    assert.strictEqual(sanitizeTicker('AIR.PA'), 'AIR.PA');
});
test('BMW.DE → BMW.DE (Frankfurt/Xetra)', () => {
    assert.strictEqual(sanitizeTicker('BMW.DE'), 'BMW.DE');
});
test('BHP.AX → BHP.AX (ASX)', () => {
    assert.strictEqual(sanitizeTicker('BHP.AX'), 'BHP.AX');
});
test('TWO suffix preserved (Taiwan OTC)', () => {
    assert.strictEqual(sanitizeTicker('1234.TWO'), '1234.TWO');
});
test('lowercase bbca.jk → BBCA.JK', () => {
    assert.strictEqual(sanitizeTicker('bbca.jk'), 'BBCA.JK');
});

console.log('\n── sanitizeTicker: plain US tickers (unchanged) ──');

test('NVDA → NVDA', () => {
    assert.strictEqual(sanitizeTicker('NVDA'), 'NVDA');
});
test('AAPL → AAPL', () => {
    assert.strictEqual(sanitizeTicker('AAPL'), 'AAPL');
});
test('crypto BTC-USD → BTC-USD (already hyphenated)', () => {
    assert.strictEqual(sanitizeTicker('BTC-USD'), 'BTC-USD');
});

console.log('\n── sanitizeTicker: invalid inputs (null) ──');

test('empty string → null', () => {
    assert.strictEqual(sanitizeTicker(''), null);
});
test('null → null', () => {
    assert.strictEqual(sanitizeTicker(null), null);
});
test('undefined → null', () => {
    assert.strictEqual(sanitizeTicker(undefined), null);
});
test('non-string → null', () => {
    assert.strictEqual(sanitizeTicker(12345), null);
});
test('punctuation only → null', () => {
    assert.strictEqual(sanitizeTicker('!!!'), null);
});
test('over 12 chars → null', () => {
    assert.strictEqual(sanitizeTicker('VERYLONGTICKERSYMBOL'), null);
});

console.log('\n── detectStockTicker: $TICKER detection with suffixes ──');

test('detects $BBCA.JK in psi-ema query', () => {
    assert.strictEqual(detectStockTicker('$BBCA.JK psi ema'), 'BBCA.JK');
});
test('detects $0700.HK (digit-leading)', () => {
    assert.strictEqual(detectStockTicker('analyze $0700.HK'), '0700.HK');
});
test('detects $7203.T (single-letter exchange)', () => {
    assert.strictEqual(detectStockTicker('$7203.T trend'), '7203.T');
});
test('detects $BRK.A (class share preserved as captured)', () => {
    assert.strictEqual(detectStockTicker('$BRK.A psi ema'), 'BRK.A');
});
test('detects plain $NVDA', () => {
    assert.strictEqual(detectStockTicker('$NVDA chart'), 'NVDA');
});
test('detects $005930.KS (Samsung, 9-char digit-leading)', () => {
    // Regression: previous ≤8 cap caused fallthrough to ALL-CAPS path returning "KS"
    assert.strictEqual(detectStockTicker('check $005930.KS psi ema'), '005930.KS');
});
test('detects $600519.SS (Kweichow Moutai, 9-char Shanghai)', () => {
    assert.strictEqual(detectStockTicker('$600519.SS analysis'), '600519.SS');
});
test('detects $GAZP.ME (Moscow exchange in allowlist)', () => {
    assert.strictEqual(sanitizeTicker('GAZP.ME'), 'GAZP.ME');
});

console.log('\n── splitMultiTicker: international comparisons preserve suffix ──');

test('two Indonesian tickers preserved', () => {
    const out = splitMultiTicker('$BBCA.JK $BMRI.JK psi ema');
    assert.ok(out, 'expected non-null');
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].label, '$BBCA.JK');
    assert.strictEqual(out[1].label, '$BMRI.JK');
    assert.ok(out[0].query.startsWith('$BBCA.JK '), `got: ${out[0].query}`);
});
test('mixed US + international preserved', () => {
    const out = splitMultiTicker('$NVDA $7203.T momentum');
    assert.ok(out);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map(t => t.label).sort(), ['$7203.T', '$NVDA']);
});
test('"vs" comparison returns null (single-ticker path)', () => {
    const out = splitMultiTicker('$BBCA.JK vs $BMRI.JK');
    assert.strictEqual(out, null);
});

// Optional live test — only when explicitly enabled (avoids flaky CI on no-net runs)
if (process.env.LIVE_YAHOO === '1') {
    console.log('\n── LIVE Yahoo Finance fetch (LIVE_YAHOO=1) ──');
    (async () => {
        const { fetchStockPrices } = require('../utils/stock-fetcher');
        try {
            const data = await fetchStockPrices('BBCA.JK');
            test('$BBCA.JK returns ~1 year of daily bars (200-260 closes)', () => {
                // Yahoo returns ~252 trading days/year. Allow 200 (holidays + IDX
                // closures) on the low end; cap at 260 to catch accidental
                // multi-year fetches.
                assert.ok(
                    data.closes.length >= 200 && data.closes.length <= 260,
                    `expected 200-260, got ${data.closes.length}`
                );
            });
            test('$BBCA.JK currency is IDR', () => {
                assert.strictEqual(data.currency, 'IDR');
            });
            test('$BBCA.JK ticker echoed back', () => {
                assert.strictEqual(data.ticker, 'BBCA.JK');
            });
        } catch (err) {
            console.log(`  ✗ live fetch threw: ${err.message}`);
            failed++;
        }
        finalize();
    })();
} else {
    finalize();
}

function finalize() {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}
