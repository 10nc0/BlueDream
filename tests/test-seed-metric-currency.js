/**
 * Seed Metric Currency Normaliser — unit tests
 * Covers: normaliseCurrency (all symbol/word/ISO paths) and
 *         the World Bank USD Atlas fallback when LCU returns null.
 * Run: node tests/test-seed-metric-currency.js
 */

'use strict';

const { normaliseCurrency } = require('../utils/geo-data');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    console.error(`       expected: ${JSON.stringify(expected)}`);
    console.error(`       got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── 1. Already-ISO codes pass through unchanged ──────────────────────────────
console.log('\n─ ISO pass-through ─');
assert('USD stays USD', normaliseCurrency('USD'), 'USD');
assert('JPY stays JPY', normaliseCurrency('JPY'), 'JPY');
assert('KRW stays KRW', normaliseCurrency('KRW'), 'KRW');
assert('lowercase jpy → JPY', normaliseCurrency('jpy'), 'JPY');
assert('mixed Krw → KRW', normaliseCurrency('Krw'), 'KRW');
assert('EUR stays EUR', normaliseCurrency('EUR'), 'EUR');
assert('GBP stays GBP', normaliseCurrency('GBP'), 'GBP');
assert('SGD stays SGD', normaliseCurrency('SGD'), 'SGD');

// ── 2. Unambiguous symbols ────────────────────────────────────────────────────
console.log('\n─ Unambiguous symbols ─');
assert('€ → EUR', normaliseCurrency('€'), 'EUR');
assert('£ → GBP', normaliseCurrency('£'), 'GBP');
assert('₩ → KRW', normaliseCurrency('₩'), 'KRW');
assert('₹ → INR', normaliseCurrency('₹'), 'INR');
assert('฿ → THB', normaliseCurrency('฿'), 'THB');
assert('₫ → VND', normaliseCurrency('₫'), 'VND');
assert('₱ → PHP', normaliseCurrency('₱'), 'PHP');
assert('₦ → NGN', normaliseCurrency('₦'), 'NGN');
assert('₺ → TRY', normaliseCurrency('₺'), 'TRY');
assert('₽ → RUB', normaliseCurrency('₽'), 'RUB');

// ── 3. Text name mappings ─────────────────────────────────────────────────────
console.log('\n─ Text name mappings ─');
assert('yen → JPY', normaliseCurrency('yen'), 'JPY');
assert('Yen → JPY', normaliseCurrency('Yen'), 'JPY');
assert('won → KRW', normaliseCurrency('won'), 'KRW');
assert('yuan → CNY', normaliseCurrency('yuan'), 'CNY');
assert('renminbi → CNY', normaliseCurrency('renminbi'), 'CNY');
assert('baht → THB', normaliseCurrency('baht'), 'THB');
assert('dong → VND', normaliseCurrency('dong'), 'VND');
assert('ringgit → MYR', normaliseCurrency('ringgit'), 'MYR');
assert('rupee → INR', normaliseCurrency('rupee'), 'INR');
assert('rupiah → IDR', normaliseCurrency('rupiah'), 'IDR');
assert('real → BRL', normaliseCurrency('real'), 'BRL');
assert('franc → CHF', normaliseCurrency('franc'), 'CHF');
assert('dirham → AED', normaliseCurrency('dirham'), 'AED');
assert('rand → ZAR', normaliseCurrency('rand'), 'ZAR');

// ── 4. Ambiguous ¥ — city-hint disambiguation ─────────────────────────────────
console.log('\n─ Ambiguous ¥ ─');
assert('¥ no hint → JPY (default)', normaliseCurrency('¥'), 'JPY');
assert('¥ city=tokyo → JPY', normaliseCurrency('¥', 'tokyo'), 'JPY');
assert('¥ city=osaka → JPY', normaliseCurrency('¥', 'osaka'), 'JPY');
assert('¥ city=beijing → CNY', normaliseCurrency('¥', 'beijing'), 'CNY');
assert('¥ city=shanghai → CNY', normaliseCurrency('¥', 'shanghai'), 'CNY');
assert('￥ no hint → JPY (default)', normaliseCurrency('￥'), 'JPY');

// ── 5. Ambiguous $ — city-hint disambiguation ─────────────────────────────────
console.log('\n─ Ambiguous $ ─');
assert('$ no hint → USD (default)', normaliseCurrency('$'), 'USD');
assert('$ city=new york → USD', normaliseCurrency('$', 'new york'), 'USD');
assert('$ city=sydney → AUD', normaliseCurrency('$', 'sydney'), 'AUD');
assert('$ city=toronto → CAD', normaliseCurrency('$', 'toronto'), 'CAD');
assert('$ city=singapore → SGD', normaliseCurrency('$', 'singapore'), 'SGD');
assert('$ city=hong kong → HKD', normaliseCurrency('$', 'hong kong'), 'HKD');

// ── 6. Null / undefined passthrough ──────────────────────────────────────────
console.log('\n─ Edge cases ─');
assert('null passthrough', normaliseCurrency(null), null);
assert('undefined passthrough', normaliseCurrency(undefined), undefined);
assert('empty string → empty string', normaliseCurrency(''), '');

// ── 7. Unrecognised token — return as-is ─────────────────────────────────────
console.log('\n─ Unrecognised pass-through ─');
assert('unknown token kept', normaliseCurrency('XYZ123'), 'XYZ123');

// ── 8. Integration: currency guard uses normalised values ─────────────────────
console.log('\n─ Currency guard integration ─');
// Simulate the path: price stored as '¥' (symbol), income stored as 'JPY' (ISO).
// After normalisation both become 'JPY' → guard allows division.
const { buildSeedMetricTable } = require('../utils/seed-metric-calculator');

const parsedDataSymbolPrice = {
  cities: {
    tokyo: {
      current: {
        pricePerSqm: { value: 6700000, currency: '¥' },
        income:      { value: 4200000, currency: 'JPY' },
      },
      historical: {
        pricePerSqm: { value: 6300000, currency: '¥' },
        income:      { value: 3200000, currency: 'JPY' },
      },
      parseLog: [],
    },
  },
  parseLog: [],
};

const tableOutput = buildSeedMetricTable(parsedDataSymbolPrice, '2000s', null);
const hasNAYears = /\|\s*N\/A\s*\|/.test(tableOutput);
if (!hasNAYears) {
  console.log('  ✅  currency guard: ¥ price + JPY income → years computed (not N/A)');
  passed++;
} else {
  console.error('  ❌  currency guard: ¥ price + JPY income still produced N/A years');
  console.error('       table:\n' + tableOutput.slice(0, 500));
  failed++;
}

// ── 9. Integration: Seoul ₩ symbol resolves correctly ──────────────────────────
const parsedDataSeoul = {
  cities: {
    seoul: {
      current: {
        pricePerSqm: { value: 18000000, currency: '₩' },
        income:      { value: 42000000, currency: 'KRW' },
      },
      historical: {
        pricePerSqm: { value: 7900000, currency: '₩' },
        income:      { value: 22000000, currency: 'KRW' },
      },
      parseLog: [],
    },
  },
  parseLog: [],
};

const seoulTable = buildSeedMetricTable(parsedDataSeoul, '2000s', null);
const seoulHasNAYears = /\|\s*N\/A\s*\|/.test(seoulTable);
if (!seoulHasNAYears) {
  console.log('  ✅  Seoul: ₩ price + KRW income → years computed (not N/A)');
  passed++;
} else {
  console.error('  ❌  Seoul: ₩ price + KRW income still produced N/A years');
  failed++;
}

// ── 10. World Bank USD Atlas fallback (mock) ──────────────────────────────────
console.log('\n─ World Bank fallback (mock) ─');
// Simulates the income column being populated from USD Atlas when LCU is null.
// Even with USD income vs JPY price, the income field is populated (not null).
const parsedDataUsdFallback = {
  cities: {
    tokyo: {
      current: {
        pricePerSqm: { value: 6700000, currency: 'JPY' },
        income:      { value: 35000, currency: 'USD' },   // USD Atlas fallback
      },
      historical: {
        pricePerSqm: { value: 6300000, currency: 'JPY' },
        income:      { value: 17000, currency: 'USD' },
      },
      parseLog: [],
    },
  },
  parseLog: [],
};

const usdFallbackTable = buildSeedMetricTable(parsedDataUsdFallback, '2000s', null);
// Years must be N/A (price JPY, income USD — guard fires correctly)
const usdHasNAYears = /\|\s*N\/A\s*\|/.test(usdFallbackTable);
// Income column must NOT be N/A (USD value should appear)
const usdHasIncomeValue = /\$35,000|\$17,000|\$35K|\$17K|35,000|17,000/.test(usdFallbackTable);

if (usdHasNAYears) {
  console.log('  ✅  USD fallback: years correctly N/A when price/income currencies differ');
  passed++;
} else {
  console.error('  ❌  USD fallback: expected N/A years when JPY price vs USD income');
  failed++;
}

if (usdHasIncomeValue) {
  console.log('  ✅  USD fallback: income column populated (not blank)');
  passed++;
} else {
  // Softer check — income value may be formatted differently; just ensure no "N/A" in income col
  const rows = usdFallbackTable.split('\n').filter(l => l.includes('|') && /Tokyo/i.test(l));
  const incomeColBlank = rows.some(r => {
    const cols = r.split('|').map(c => c.trim());
    return cols.some(c => c === 'N/A');
  });
  if (!incomeColBlank) {
    console.log('  ✅  USD fallback: income column shows a value');
    passed++;
  } else {
    console.error('  ❌  USD fallback: income column still blank when USD Atlas provides a value');
    failed++;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
