/**
 * Unit tests for utils/claim-extractor.js
 *
 * Anchored regex extractor for numeric claims + source attributions.
 * Conservative by design — these tests enforce that posture by checking
 * BOTH positive matches AND that bare numbers without count nouns are
 * NOT mis-classified as counts.
 */

'use strict';

const {
    extractClaims,
    canonicalSourceName,
    parseCurrencyValue,
} = require('../utils/claim-extractor');

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
    }
}

function eq(actual, expected, msg) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
function truthy(actual, msg) { if (!actual) throw new Error(msg || 'expected truthy'); }
function falsy(actual, msg) { if (actual) throw new Error(msg || 'expected falsy, got ' + JSON.stringify(actual)); }

console.log('claim-extractor: source-name canonicalisation');
test('exact English match', () => eq(canonicalSourceName('World Bank'), 'world-bank'));
test('exact Indonesian match', () => eq(canonicalSourceName('Bank Dunia'), 'world-bank'));
test('case-insensitive', () => eq(canonicalSourceName('UK LAND REGISTRY'), 'uk-lr'));
test('substring fallback', () => eq(canonicalSourceName("the World Bank's data"), 'world-bank'));
test('book aliases', () => eq(canonicalSourceName('your books'), 'book'));
test('unknown source returns null', () => eq(canonicalSourceName('SomeRandomThing'), null));
test('empty/null safe', () => { eq(canonicalSourceName(''), null); eq(canonicalSourceName(null), null); });

console.log('\nclaim-extractor: currency number parsing');
test('comma-grouped thousands', () => eq(parseCurrencyValue('1,234'), 1234));
test('dot decimal', () => eq(parseCurrencyValue('1,234.56'), 1234.56));
test('european grouping', () => eq(parseCurrencyValue('1.234,56'), 1234.56));
test('triple-group european', () => eq(parseCurrencyValue('5.000.000'), 5000000));
test('comma as decimal', () => eq(parseCurrencyValue('1,5'), 1.5));
test('plain integer', () => eq(parseCurrencyValue('500'), 500));
test('invalid returns null', () => eq(parseCurrencyValue('abc'), null));

console.log('\nclaim-extractor: percent claims');
test('basic %', () => {
    const c = extractClaims('Growth was 5.2%.');
    eq(c.length, 1);
    eq(c[0].kind, 'percent');
    eq(c[0].value, 5.2);
});
test('"percent" word form', () => {
    const c = extractClaims('Growth was 8.1 percent.');
    eq(c[0].value, 8.1);
    eq(c[0].kind, 'percent');
});
test('Indonesian "persen"', () => {
    const c = extractClaims('Inflasi 4 persen.');
    eq(c[0].value, 4);
    eq(c[0].kind, 'percent');
});
test('percent followed by period (regression: trailing \\b)', () => {
    const c = extractClaims('Inflation hit 4.5%. The next bit.');
    eq(c.length, 1);
    eq(c[0].value, 4.5);
});

console.log('\nclaim-extractor: currency claims');
test('prefix $', () => {
    const c = extractClaims('Cost was $1,200 yesterday.');
    eq(c[0].kind, 'currency');
    eq(c[0].value, 1200);
});
test('prefix £', () => {
    const c = extractClaims('£500 per unit.');
    eq(c[0].value, 500);
});
test('Rp with dot grouping', () => {
    const c = extractClaims('Harga Rp 5.000.000 sebulan.');
    eq(c[0].value, 5000000);
});
test('suffix USD', () => {
    const c = extractClaims('Total: 10000 USD.');
    eq(c[0].kind, 'currency');
    eq(c[0].value, 10000);
});
test('suffix dollars word', () => {
    const c = extractClaims('Total: 50 dollars.');
    eq(c[0].kind, 'currency');
    eq(c[0].value, 50);
});

console.log('\nclaim-extractor: count claims');
test('messages count', () => {
    const c = extractClaims('There are 7 messages and 3 transactions.');
    eq(c.length, 2);
    eq(c[0].kind, 'count');
    eq(c[0].value, 7);
    eq(c[1].value, 3);
});
test('Indonesian "kali"', () => {
    const c = extractClaims('Perbaikan dilakukan 12 kali.');
    eq(c[0].kind, 'count');
    eq(c[0].value, 12);
});
test('bare number is NOT a count claim', () => {
    const c = extractClaims('The answer is 42 and life goes on.');
    falsy(c.some(x => x.kind === 'count'), 'should not classify "42" as a count without a count noun');
});

console.log('\nclaim-extractor: year claims');
test('valid year', () => {
    const c = extractClaims('It happened in 2024.');
    truthy(c.some(x => x.kind === 'year' && x.value === 2024));
});
test('year not extracted inside currency span', () => {
    const c = extractClaims('Price was $2024.');
    eq(c.length, 1);
    eq(c[0].kind, 'currency');
});
test('year not extracted inside percent span', () => {
    const c = extractClaims('Growth was 2024%.');
    truthy(c.some(x => x.kind === 'percent'));
    falsy(c.some(x => x.kind === 'year'), 'no year inside percent');
});
test('out-of-range year ignored', () => {
    const c = extractClaims('The number 1500 is interesting.');
    falsy(c.some(x => x.kind === 'year'));
});

console.log('\nclaim-extractor: source attribution');
test('"according to X"', () => {
    const c = extractClaims('According to the World Bank, growth was 5.2%.');
    const pct = c.find(x => x.kind === 'percent');
    truthy(pct);
    eq(pct.sourceCited, 'world-bank');
});
test('"X shows"', () => {
    const c = extractClaims('UK Land Registry shows £1,200 average.');
    const cur = c.find(x => x.kind === 'currency');
    eq(cur.sourceCited, 'uk-lr');
});
test('parenthetical (source: X)', () => {
    const c = extractClaims('(source: HDB) Average price was S$500,000.');
    const cur = c.find(x => x.kind === 'currency');
    eq(cur.sourceCited, 'sgp-hdb');
});
test('Indonesian "menurut X"', () => {
    const c = extractClaims('Menurut Bank Dunia, ekonomi tumbuh 4.5%.');
    const pct = c.find(x => x.kind === 'percent');
    eq(pct.sourceCited, 'world-bank');
});
test('Chinese 根据X', () => {
    const c = extractClaims('根据世界银行, GDP增长了 5.2%.');
    const pct = c.find(x => x.kind === 'percent');
    eq(pct.sourceCited, 'world-bank');
});
test('uncited claim has null sourceCited', () => {
    const c = extractClaims('Growth was 5%.');
    eq(c[0].sourceCited, null);
});
test('sentence boundary scopes attribution', () => {
    // The "Brave says..." stops at the period; the second claim has no
    // active attribution.
    const c = extractClaims('Brave says 12%. Then growth was 5%.');
    const first = c.find(x => x.value === 12);
    const second = c.find(x => x.value === 5);
    eq(first.sourceCited, 'brave-search');
    eq(second.sourceCited, null);
});

console.log('\nclaim-extractor: range claims');
test('percent range', () => {
    const c = extractClaims('Growth ranged 5-10%.');
    truthy(c.some(x => x.kind === 'range'));
});
test('currency range', () => {
    const c = extractClaims('Prices were $1,000-$2,000.');
    truthy(c.some(x => x.kind === 'currency' && x.value === 1000));
    truthy(c.some(x => x.kind === 'currency' && x.value === 2000));
});

console.log('\nclaim-extractor: edge cases');
test('empty input', () => eq(extractClaims(''), []));
test('null input', () => eq(extractClaims(null), []));
test('no claims', () => eq(extractClaims('hello world'), []));
test('position is correct', () => {
    const text = 'Prefix and then 5% later.';
    const c = extractClaims(text);
    eq(c[0].position, text.indexOf('5%'));
});
test('claims sorted by position', () => {
    const c = extractClaims('First 10% then $500 then 2024.');
    for (let i = 1; i < c.length; i++) {
        if (c[i].position < c[i - 1].position) throw new Error('claims not sorted by position');
    }
});

console.log(`\nclaim-extractor: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
