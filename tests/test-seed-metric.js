/**
 * Seed Metric — unit tests
 * Covers: rescueTotalPrice, rescueDroppedSuffix, calculateSeedMetric, formatCurrency
 * Run: node tests/test-seed-metric.js
 */

const {
  rescueTotalPrice,
  rescueDroppedSuffix,
  calculateSeedMetric,
  formatCurrency,
  rescueIncome,
  validateSeedMetricInvariants,
  emptyCityRecord,
  parseTFR,
} = require('../utils/seed-metric-calculator');
const { CITY_TO_COUNTRY, ISO2_TO_CURRENCY } = require('../utils/geo-data');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
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

// ─── rescueTotalPrice ────────────────────────────────────────────────────────

console.log('\n── rescueTotalPrice: per-sqm trust cases ──');

assert(
  'explicit /sqm label → trust value as-is',
  rescueTotalPrice(6000, 'Residential price is $6,000/sqm in 2025.'),
  6000
);
assert(
  'explicit per m² label → trust value',
  rescueTotalPrice(8500, 'Average apartment price: 8,500 USD per m² in Tokyo.'),
  8500
);
assert(
  'explicit per square meter label → trust value',
  rescueTotalPrice(12000, 'Price per square meter in Singapore is $12,000.'),
  12000
);
assert(
  'psm abbreviation → trust value',
  rescueTotalPrice(9200, 'Typical rate is HKD 9200 psm for residential units.'),
  9200
);

console.log('\n── rescueTotalPrice: sqft → sqm conversion ──');

assert(
  'per sqft label → ×10.764 exact conversion',
  rescueTotalPrice(550, 'Los Angeles homes average $550 per sqft in 2025.'),
  Math.round(550 * 10.764)   // 5920
);
assert(
  'per sq ft (spaced) label → ×10.764',
  rescueTotalPrice(400, 'Historical price was $400 per sq ft in the 2000s.'),
  Math.round(400 * 10.764)   // 4306
);
assert(
  '/sqft shorthand → ×10.764',
  rescueTotalPrice(300, 'San Francisco: $300/sqft median.'),
  Math.round(300 * 10.764)   // 3229
);

console.log('\n── rescueTotalPrice: total-price contamination → null ──');

assert(
  'median home price (LA 2000s bug case) → null',
  rescueTotalPrice(585000, 'The median home price in Los Angeles was $585,000 in 2006.'),
  null
);
assert(
  'average home value → null',
  rescueTotalPrice(420000, 'Average home value in Phoenix: $420,000.'),
  null
);
assert(
  'median sale price → null',
  rescueTotalPrice(750000, 'Median sale price for homes in the area: $750,000.'),
  null
);
assert(
  'asking price for a house → null',
  rescueTotalPrice(650000, 'Average asking price for a house in Boston is $650,000.'),
  null
);
assert(
  'property prices in the city → null',
  rescueTotalPrice(480000, 'Property prices in the city have risen to $480,000 on average.'),
  null
);
assert(
  'home prices in county → null',
  rescueTotalPrice(395000, 'Prices for homes in the county averaged $395,000 last year.'),
  null
);

console.log('\n── rescueTotalPrice: no-signal passthrough ──');

assert(
  'value with no contextual signal → passthrough',
  rescueTotalPrice(5500, 'Real estate data shows various figures for the region.'),
  5500
);
assert(
  'small value, no signal → passthrough',
  rescueTotalPrice(1200, 'Some housing data was available.'),
  1200
);

console.log('\n── rescueTotalPrice: edge cases ──');

assert('null value → null', rescueTotalPrice(null, 'any text'), null);
assert('zero value → zero (falsy, returned unchanged)', rescueTotalPrice(0, 'any text'), 0);
assert('empty text → value unchanged', rescueTotalPrice(5000, ''), 5000);
assert('per-sqm label beats total-price language → trust',
  rescueTotalPrice(6000, 'Median home price $600,000. Price per sqm: $6,000.'),
  6000
);

// ─── rescueDroppedSuffix ─────────────────────────────────────────────────────

console.log('\n── rescueDroppedSuffix ──');

assert('bare 54 + "54K/sqm" in text → 54000', rescueDroppedSuffix(54, 'Rp54K/sqm'), 54000);
assert('bare 5 + "5M/sqm" in text → 5000000', rescueDroppedSuffix(5, '¥5M/sqm data'), 5000000);
assert('no suffix in text → unchanged', rescueDroppedSuffix(6000, '$6,000 per sqm'), 6000);
assert('null value → null', rescueDroppedSuffix(null, 'any'), null);

// ─── calculateSeedMetric ─────────────────────────────────────────────────────

console.log('\n── calculateSeedMetric ──');

function assertSeedMetric(label, pricePerSqm, income, expectedYears, expectedRegime) {
  const r = calculateSeedMetric(pricePerSqm, income);
  const yearsOk = Math.abs(r.years - expectedYears) < 1;
  const regimeOk = r.regime === expectedRegime;
  if (yearsOk && regimeOk) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label} — years=${r.years?.toFixed(1)} regime=${r.regime}`);
    failed++;
  }
}

assertSeedMetric('SF 2025: $1120/sqm, $98K income → ~8yr Optimism', 1120, 98000, 8, 'Optimism');
assertSeedMetric('LA 2025: $6285/sqm, $70K income → ~63yr Fatalism', 6285, 70000, 62.9, 'Fatalism');
assertSeedMetric('10yr boundary → Extraction', 1000, 70000, 10, 'Extraction');  // 1000×700=700K / 70K = 10
assertSeedMetric('25yr boundary → Fatalism', 2500, 70000, 25, 'Extraction');   // 2500×700=1.75M / 70K = 25
assertSeedMetric('>25yr → Fatalism', 2501, 70000, 25, 'Fatalism');

const nullResult = calculateSeedMetric(null, 70000);
assert('null price → N/A', nullResult.regime, 'N/A');
assert('null price → price700sqm is null', nullResult.price700sqm, null);
const zeroIncome = calculateSeedMetric(5000, 0);
assert('zero income → N/A', zeroIncome.regime, 'N/A');
assert('zero income → price700sqm still computed', zeroIncome.price700sqm, 5000 * 700);
const nullIncome = calculateSeedMetric(5000, null);
assert('null income → N/A years', nullIncome.years, null);
assert('null income → price700sqm still computed (3.5M)', nullIncome.price700sqm, 3500000);

// LCU match: Tokyo ¥765K price, ¥5.2M income → ~102yr Fatalism
assertSeedMetric('Tokyo LCU match: ¥765K/sqm, ¥5237835/yr → ~102yr Fatalism', 765000, 5237835, 102, 'Fatalism');

// LCU match: Singapore S$2225/sqm, S$30000/yr (historical) → ~52yr Fatalism
assertSeedMetric('Singapore LCU match: S$2225/sqm, S$30000/yr → ~52yr Fatalism', 2225, 30000, 52, 'Fatalism');

// Currency mismatch guard (simulated): when caller passes null income, years must be N/A
// This mirrors what buildSeedMetricTable does when pricePerSqm.currency !== income.currency
const mismatchResult = calculateSeedMetric(765000, null);
assert('currency mismatch guard: null income → years null', mismatchResult.years, null);
assert('currency mismatch guard: price700sqm still rendered', mismatchResult.price700sqm, 765000 * 700);

// ─── formatCurrency ──────────────────────────────────────────────────────────

console.log('\n── formatCurrency ──');

assert('409500000 USD → $409.5M', formatCurrency(409500000, 'USD'), '$409.5M');
assert('6285 USD → $6K', formatCurrency(6285, 'USD'), '$6K');
assert('70000 USD → $70K', formatCurrency(70000, 'USD'), '$70K');
assert('null → N/A', formatCurrency(null, 'USD'), 'N/A');
assert('NaN → N/A', formatCurrency(NaN, 'USD'), 'N/A');

// ─── CITY_TO_COUNTRY: US city overrides (Bug A) ──────────────────────────────

console.log('\n── CITY_TO_COUNTRY: US city overrides ──');

const US = 'United States';
for (const city of [
  'san francisco', 'los angeles', 'chicago', 'boston', 'seattle', 'miami',
  'austin', 'denver', 'washington dc', 'phoenix', 'dallas', 'houston',
  'atlanta', 'portland', 'san diego', 'philadelphia', 'las vegas',
  'minneapolis', 'nashville', 'detroit', 'honolulu',
]) {
  assert(`CITY_TO_COUNTRY['${city}'] === 'United States'`, CITY_TO_COUNTRY[city], US);
}
// new york should still work (was already set via auto-inversion)
assert("CITY_TO_COUNTRY['new york'] resolves to a country", typeof CITY_TO_COUNTRY['new york'], 'string');

// ─── ISO2_TO_CURRENCY ────────────────────────────────────────────────────────

console.log('\n── ISO2_TO_CURRENCY ──');

assert("ISO2_TO_CURRENCY['US'] === 'USD'", ISO2_TO_CURRENCY['US'], 'USD');
assert("ISO2_TO_CURRENCY['JP'] === 'JPY'", ISO2_TO_CURRENCY['JP'], 'JPY');
assert("ISO2_TO_CURRENCY['GB'] === 'GBP'", ISO2_TO_CURRENCY['GB'], 'GBP');
assert("ISO2_TO_CURRENCY['SG'] === 'SGD'", ISO2_TO_CURRENCY['SG'], 'SGD');
assert("ISO2_TO_CURRENCY['AU'] === 'AUD'", ISO2_TO_CURRENCY['AU'], 'AUD');
assert("ISO2_TO_CURRENCY['DE'] === 'EUR'", ISO2_TO_CURRENCY['DE'], 'EUR');
assert("ISO2_TO_CURRENCY['KR'] === 'KRW'", ISO2_TO_CURRENCY['KR'], 'KRW');

// ─── microExtractPrompt — income plausibility guard ───────────────────────────
// Verifies the prompt is currency-aware (names JPY/KRW/IDR) and does NOT contain
// a hardcoded FX conversion table (design rule: no static numbers that rot).

const fs = require('fs');
const path = require('path');
const orchestratorSrc = fs.readFileSync(
  path.join(__dirname, '../utils/pipeline-orchestrator.js'), 'utf8'
);
// Extract the microExtractPrompt string (between its start and closing backtick)
const promptStart = orchestratorSrc.indexOf('const microExtractPrompt = `');
const promptEnd   = orchestratorSrc.indexOf('`;', promptStart);
const promptText  = promptStart !== -1 && promptEnd !== -1
  ? orchestratorSrc.slice(promptStart, promptEnd)
  : '';

function assertPrompt(label, condition) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

console.log('\n── microExtractPrompt income plausibility guard ──');
assertPrompt('prompt extracted (non-empty)', promptText.length > 0);
assertPrompt('prompt mentions JPY for high-denomination currency guidance',  promptText.includes('JPY'));
assertPrompt('prompt mentions KRW for high-denomination currency guidance',  promptText.includes('KRW'));
assertPrompt('prompt mentions IDR for high-denomination currency guidance',  promptText.includes('IDR'));
assertPrompt('prompt contains 300,000 USD-equivalent threshold statement',   promptText.includes('300,000 USD-equivalent'));
// Design rule: no hardcoded FX table (a static number followed by | separator is the table pattern)
assertPrompt('prompt has no hardcoded FX conversion table (anti-fragile design)',
  !promptText.includes('JPY 45,000,000') && !promptText.includes('KRW 400,000,000'));

// ─── rescueIncome ────────────────────────────────────────────────────────────

console.log('\n── rescueIncome: trust cases ──');
// Mock ceiling map ≈ Monaco/Switz/Lux median × 1.5 ≈ 210K USD; LCU pre-converted
const CEIL = { USD: 210000, JPY: 31_500_000, KRW: 280_000_000, EUR: 195_000, SGD: 285_000, CNY: 1_500_000 };

assert(
  'plausible USD wage with no contamination → trusted',
  rescueIncome(75000, 'Average annual income in Phoenix is $75,000 in 2025.', 'USD', CEIL),
  75000
);
assert(
  'plausible JPY wage well under ceiling → trusted',
  rescueIncome(4_500_000, 'Average wage in Tokyo: ¥4.5M annually.', 'JPY', CEIL),
  4_500_000
);
assert(
  'plausible KRW wage well under ceiling → trusted',
  rescueIncome(45_000_000, 'Seoul average income ₩45M per year.', 'KRW', CEIL),
  45_000_000
);
assert(
  'missing ceiling map entry → still trusts (graceful skip of structural guard)',
  rescueIncome(50000, 'Average income $50,000 per year.', 'XYZ', CEIL),
  50000
);
assert(
  'no ceiling map at all → trusts on text/min-sanity guards alone',
  rescueIncome(50000, 'Average income $50,000 per year.', 'USD'),
  50000
);

console.log('\n── rescueIncome: property-price contamination → null ──');

assert(
  'home value mistakenly grabbed as income → null',
  rescueIncome(585000, 'The median home price in Los Angeles was $585,000 in 2024.', 'USD', CEIL),
  null
);
assert(
  'asking price language → null',
  rescueIncome(420000, 'Average house price in Phoenix: $420,000.', 'USD', CEIL),
  null
);
assert(
  'sold for X language → null',
  rescueIncome(750000, 'Property sold for $750,000 in Q3.', 'USD', CEIL),
  null
);

console.log('\n── rescueIncome: wrong income type → null ──');

assert(
  'GDP per capita figure → null',
  rescueIncome(85000, 'GDP per capita in 2024 was $85,000.', 'USD', CEIL),
  null
);
assert(
  'household income → null (not single-earner)',
  rescueIncome(120000, 'Median household income in Boston is $120,000.', 'USD', CEIL),
  null
);
assert(
  'dual income → null',
  rescueIncome(180000, 'Average dual income for couples: $180,000.', 'USD', CEIL),
  null
);
assert(
  'family income → null',
  rescueIncome(140000, 'Family income median: $140,000 in 2024.', 'USD', CEIL),
  null
);

console.log('\n── rescueIncome: structural ceiling guard ──');

assert(
  'USD income above ceiling (looks like a property price) → null',
  rescueIncome(500000, 'Annual earnings of $500,000.', 'USD', CEIL),
  null
);
assert(
  'JPY value above ceiling (mis-tagged condo price) → null',
  rescueIncome(80_000_000, 'Reported income ¥80M last year.', 'JPY', CEIL),
  null
);
assert(
  'KRW value above ceiling (apartment price disguised as income) → null',
  rescueIncome(900_000_000, 'Earnings reached ₩900M.', 'KRW', CEIL),
  null
);

console.log('\n── rescueIncome: min-sanity + degenerate inputs ──');

assert(
  'value below 1000 → null (impossibly low annual wage)',
  rescueIncome(500, 'Income of $500.', 'USD', CEIL),
  null
);
assert(
  'null value → null',
  rescueIncome(null, 'text', 'USD', CEIL),
  null
);
assert(
  'NaN value → null',
  rescueIncome(NaN, 'text', 'USD', CEIL),
  null
);
assert(
  'negative value → null',
  rescueIncome(-50000, 'text', 'USD', CEIL),
  null
);
assert(
  'currency case-insensitive lookup (lowercase usd resolves)',
  rescueIncome(75000, 'Annual income $75,000.', 'usd', CEIL),
  75000
);

// ─── validateSeedMetricInvariants ────────────────────────────────────────────

console.log('\n── validateSeedMetricInvariants: I1 currency mismatch ──');

let pd = {
  cities: {
    tokyo: {
      current:    { pricePerSqm: { value: 1_500_000, currency: 'JPY' }, income: { value: 75000, currency: 'USD' } },
      historical: { pricePerSqm: null, income: null },
    },
  },
};
let v = validateSeedMetricInvariants(pd, null);
assert(
  'I1: detects price/income currency mismatch',
  v.some(x => x.startsWith('I1') && x.includes('tokyo')),
  true
);

console.log('\n── validateSeedMetricInvariants: I2 temporal income direction ──');

pd = {
  cities: {
    seoul: {
      current:    { pricePerSqm: null, income: { value: 45_000_000, currency: 'KRW' } },
      historical: { pricePerSqm: null, income: { value: 80_000_000, currency: 'KRW' } }, // > current!
    },
  },
};
v = validateSeedMetricInvariants(pd, null);
assert(
  'I2: detects historical > current income',
  v.some(x => x.startsWith('I2') && x.includes('seoul')),
  true
);
assert(
  'I2: nulls historical income after detection',
  pd.cities.seoul.historical.income,
  null
);
assert(
  'I2: leaves current income untouched',
  pd.cities.seoul.current.income,
  { value: 45_000_000, currency: 'KRW' }
);

// I2 only fires when currencies match — different currencies should NOT trigger it
// (handled by I1; nulling on cross-currency comparison would be unsafe).
pd = {
  cities: {
    osaka: {
      current:    { pricePerSqm: null, income: { value: 5_000_000, currency: 'JPY' } },
      historical: { pricePerSqm: null, income: { value: 60_000, currency: 'USD' } }, // different currency
    },
  },
};
v = validateSeedMetricInvariants(pd, null);
assert(
  'I2: does NOT fire on cross-currency comparison',
  v.some(x => x.startsWith('I2')),
  false
);

// I1/I2 case-insensitivity — 'usd' vs 'USD' must not trigger a false mismatch.
pd = {
  cities: {
    boston: {
      current:    { pricePerSqm: { value: 8000, currency: 'USD' }, income: { value: 75000, currency: 'usd' } },
      historical: { pricePerSqm: null, income: null },
    },
  },
};
v = validateSeedMetricInvariants(pd, null);
assert(
  'I1: case-insensitive — USD vs usd does NOT trigger mismatch',
  v.some(x => x.startsWith('I1')),
  false
);

pd = {
  cities: {
    seoul: {
      current:    { pricePerSqm: null, income: { value: 45_000_000, currency: 'KRW' } },
      historical: { pricePerSqm: null, income: { value: 80_000_000, currency: 'krw' } }, // mixed case
    },
  },
};
v = validateSeedMetricInvariants(pd, null);
assert(
  'I2: case-insensitive — KRW vs krw still detects historical > current',
  v.some(x => x.startsWith('I2') && x.includes('seoul')),
  true
);

console.log('\n── validateSeedMetricInvariants: I3 TFR cross-period plausibility ──');

let tfr = { Tokyo: { current: 1.2, historical: 1.4 } };
v = validateSeedMetricInvariants({ cities: { tokyo: { current: {}, historical: {} } } }, tfr);
assert(
  'I3: normal TFR swing (0.2) → no violation',
  v.some(x => x.startsWith('I3')),
  false
);

tfr = { Seoul: { current: 0.7, historical: 4.5 } };  // 3.8 swing — Korea's real history
v = validateSeedMetricInvariants({ cities: { seoul: { current: {}, historical: {} } } }, tfr);
assert(
  'I3: large but real-world swing (3.8) → no violation',
  v.some(x => x.startsWith('I3')),
  false
);

tfr = { Tokyo: { current: 7.5, historical: 1.2 } };  // 6.3 swing — extraction error
v = validateSeedMetricInvariants({ cities: { tokyo: { current: {}, historical: {} } } }, tfr);
assert(
  'I3: implausible swing (>5) → violation logged',
  v.some(x => x.startsWith('I3') && x.includes('tokyo')),
  true
);
assert(
  'I3: nulls both current and historical TFR after detection',
  [tfr.Tokyo.current, tfr.Tokyo.historical],
  [null, null]
);

console.log('\n── validateSeedMetricInvariants: degenerate inputs ──');

assert(
  'null parsedData returns empty violations',
  validateSeedMetricInvariants(null, null),
  []
);
assert(
  'parsedData with no cities returns empty violations',
  validateSeedMetricInvariants({}, null),
  []
);
assert(
  'all-clean data returns empty violations',
  validateSeedMetricInvariants({
    cities: {
      paris: {
        current:    { pricePerSqm: { value: 12000, currency: 'EUR' }, income: { value: 45000, currency: 'EUR' } },
        historical: { pricePerSqm: { value: 6000,  currency: 'EUR' }, income: { value: 28000, currency: 'EUR' } },
      },
    },
  }, null),
  []
);

// ─── emptyCityRecord factory — schema lock ───────────────────────────────────
// These tests pin the canonical empty city record so any future schema drift
// (extra fields, renamed buckets) requires a deliberate test update rather
// than silently regressing the 7 init sites in pipeline-orchestrator.

assert(
  'emptyCityRecord() with no decade returns canonical bare skeleton',
  emptyCityRecord(),
  { current: { pricePerSqm: null, income: null }, historical: { pricePerSqm: null, income: null } }
);
assert(
  'emptyCityRecord(histDecade) stamps decade onto historical bucket',
  emptyCityRecord('1995-2005'),
  { current: { pricePerSqm: null, income: null }, historical: { pricePerSqm: null, income: null, decade: '1995-2005' } }
);
assert(
  'emptyCityRecord(undefined) is identical to emptyCityRecord()',
  emptyCityRecord(undefined),
  emptyCityRecord()
);
assert(
  'emptyCityRecord(null) is identical to emptyCityRecord() (no decade stamp)',
  emptyCityRecord(null),
  emptyCityRecord()
);
assert(
  'emptyCityRecord("") treats empty string as no-decade (falsy)',
  emptyCityRecord(''),
  emptyCityRecord()
);
// Independence: each call must return a fresh object (no shared reference)
{
  const a = emptyCityRecord('2000s');
  const b = emptyCityRecord('2000s');
  a.current.pricePerSqm = { value: 999 };
  assert(
    'emptyCityRecord returns independent objects (mutation isolation)',
    b.current.pricePerSqm,
    null
  );
}

// ─── parseTFR: year-leak guards ──────────────────────────────────────────────

console.log('\n── parseTFR: strict-year guard (no cross-period leak) ──');

// Snippet talks ONLY about 2024 — query for 2000 must NOT silently grab the 2024 number.
const snippetCurrentOnly = 'United States total fertility rate in 2024 was 1.6 births per woman.';
assert(
  'parseTFR: targetYear=2000 with only-2024 snippet → null (no leak)',
  parseTFR(snippetCurrentOnly, 'United States', '2000'),
  null
);
assert(
  'parseTFR: targetYear=2024 with only-2024 snippet → 1.6 (year-anchored hit)',
  parseTFR(snippetCurrentOnly, 'United States', '2024'),
  1.6
);

// Snippet has both years far enough apart that each query lands in its own window.
// (parseTFR uses a ±200-char window for year-proximity, so realistic snippets
// where the two years sit in separate paragraphs / list items disambiguate cleanly.)
const PADDING = ' '.repeat(250);
const snippetBoth =
  'United States: in 2000 the total fertility rate was 2.06 births per woman.' +
  PADDING +
  'By 2024 the United States rate had fallen to 1.62 births per woman.';
assert(
  'parseTFR: targetYear=2000 with separated mixed snippet → 2.06 (period-correct)',
  parseTFR(snippetBoth, 'United States', '2000'),
  2.06
);
assert(
  'parseTFR: targetYear=2024 with separated mixed snippet → 1.62 (period-correct)',
  parseTFR(snippetBoth, 'United States', '2024'),
  1.62
);

// Year-agnostic mode (empty targetYear) keeps old permissive behaviour — first match wins.
assert(
  'parseTFR: empty targetYear (agnostic) → first valid match (current-only fallback path)',
  parseTFR(snippetCurrentOnly, 'United States', ''),
  1.6
);

// Regression: the original leak — 2000 query against a 2025-only page returned the 2025 value.
const snippetOnly2025 = 'Los Angeles fertility rate 2025: 3.8 (preliminary).';
assert(
  'parseTFR: regression — 2000 query against 2025-only snippet → null (was leaking 3.8)',
  parseTFR(snippetOnly2025, 'Los Angeles', '2000'),
  null
);

// Adversarial dense snippet: both years and both values within the same 200-char
// window — using real-world phrasing each value can match. Earlier tie-on-proximity
// logic returned pool[0] for both targets, collapsing the two periods to the same
// value. Nearest-year-token scoring must disambiguate by char-distance.
const denseSnippet =
  'United States fertility rate was 2.06 births per woman in 2000 and ' +
  'fell to 1.62 births per woman by 2024.';
assert(
  'parseTFR: dense snippet, target=2000 → 2.06 (nearest-token disambig)',
  parseTFR(denseSnippet, 'United States', '2000'),
  2.06
);
assert(
  'parseTFR: dense snippet, target=2024 → 1.62 (nearest-token disambig, no collapse)',
  parseTFR(denseSnippet, 'United States', '2024'),
  1.62
);

// Decadal-target adversarial: "2000s" decade label vs. explicit "2024" year.
const denseDecadeSnippet =
  'United States fertility rate averaged 2.05 children per woman across the 2000s ' +
  'but fell to 1.62 children per woman in 2024.';
assert(
  'parseTFR: dense snippet, target=2000 (decadal context) → 2.05',
  parseTFR(denseDecadeSnippet, 'United States', '2000'),
  2.05
);
assert(
  'parseTFR: dense snippet, target=2024 (decadal context) → 1.62',
  parseTFR(denseDecadeSnippet, 'United States', '2024'),
  1.62
);

// List-style snippet with year prefix on the LEFT of each value
// ("YEAR: VALUE births per woman"). Must work as well as right-side patterns.
const listLeftSnippet =
  'United States fertility rate by year: 2000: 2.06 births per woman; ' +
  '2024: 1.62 births per woman.';
assert(
  'parseTFR: left-side year list, target=2000 → 2.06',
  parseTFR(listLeftSnippet, 'United States', '2000'),
  2.06
);
assert(
  'parseTFR: left-side year list, target=2024 → 1.62',
  parseTFR(listLeftSnippet, 'United States', '2024'),
  1.62
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(54)}`);
console.log(`📊 Seed Metric Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(54));
process.exit(failed > 0 ? 1 : 0);
