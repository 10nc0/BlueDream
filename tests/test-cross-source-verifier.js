/**
 * End-to-end tests for the cross-source verifier (Task #228).
 *
 * Boundaries under test:
 *   - AuditCapsule.hydrate accepts toolResults; absent → no-op (existing
 *     #171 scope-tally verifier still wins; no false positives).
 *   - When toolResults is non-empty, _verifyToolClaims catches:
 *       (a) "made-up number" — claim absent from any tool body
 *       (b) "source swap"    — number exists in toolResults BUT not in the
 *                              cited tool body
 *       (c) "paraphrase drift outside tolerance"
 *     and lets pass:
 *       (d) "paraphrase drift inside tolerance" (±0.5pp / ±1% currency)
 *       (e) "exact match"
 *   - runDashboardAuditPipeline forwards toolResults to capsule and emits
 *     the observability log line.
 */

'use strict';

const { AuditCapsule } = require('../utils/audit-capsule');
const { runDashboardAuditPipeline } = require('../utils/dashboard-audit-pipeline');

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(() => { passed++; console.log(`  ✓ ${name}`); },
                          e => { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); });
        }
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
}

// ── Capsule-level tests ──────────────────────────────────────────────────────
console.log('cross-source verifier: AuditCapsule._verifyToolClaims');

test('no-op when toolResults absent (backward compat)', () => {
    const cap = new AuditCapsule('t1', 'test');
    cap.hydrate({ query: 'growth?', contextMessages: [{ content: 'note' }] });
    cap.extractClaimsFromResponse('According to World Bank, GDP grew 5.2%.');
    cap.verify();
    // No toolResults → cross-source verifier is silent. No tool_claim
    // corrections should appear, irrespective of what's in the response.
    const toolMismatches = cap.corrections.filter(c => c.kind === 'tool_claim');
    eq(toolMismatches.length, 0, 'expected no tool-claim corrections with empty toolResults');
});

test('exact match: no correction', () => {
    const cap = new AuditCapsule('t2', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'GDP growth: 5.2 percent' }]
    });
    cap.extractClaimsFromResponse('According to World Bank, GDP grew 5.2%.');
    cap.verify();
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 0);
});

test('paraphrase drift INSIDE tolerance (±0.5pp): pass', () => {
    const cap = new AuditCapsule('t3', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'GDP growth: 5.0 percent' }]
    });
    // 5.0% in tool, 5.3% in response — within 0.5pp
    cap.extractClaimsFromResponse('According to World Bank, GDP grew 5.3%.');
    cap.verify();
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 0,
        'drift within tolerance must not produce a correction');
});

test('paraphrase drift OUTSIDE tolerance (>0.5pp): caught', () => {
    const cap = new AuditCapsule('t4', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'GDP growth: 5.0 percent' }]
    });
    // 5.0 vs 12 — way outside tolerance
    cap.extractClaimsFromResponse('According to World Bank, GDP grew 12%.');
    cap.verify();
    const corrections = cap.corrections.filter(c => c.kind === 'tool_claim');
    eq(corrections.length, 1);
    eq(corrections[0].reason, 'tool_claim_unverified');
    eq(corrections[0].citedSource, 'world-bank');
    assert(corrections[0].nearestMatch === 5 || corrections[0].nearestMatch === 5.0,
        `expected nearestMatch~5, got ${corrections[0].nearestMatch}`);
});

test('made-up number: claim absent from any tool body', () => {
    const cap = new AuditCapsule('t5', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [
            { name: 'world-bank', args: {}, result: 'GDP growth: 3.1 percent' },
            { name: 'brave-search', args: {}, result: 'inflation 7.0 percent' }
        ]
    });
    cap.extractClaimsFromResponse('Growth was 99.9%.');  // not in either body
    cap.verify();
    const corrections = cap.corrections.filter(c => c.kind === 'tool_claim');
    eq(corrections.length, 1);
    eq(corrections[0].citedSource, null);
    // searched both tools when uncited
    assert(corrections[0].searchedSources.includes('world-bank'));
    assert(corrections[0].searchedSources.includes('brave-search'));
});

test('source swap: number exists in OTHER tool, not in cited one', () => {
    const cap = new AuditCapsule('t6', 'test');
    cap.hydrate({
        query: 'inflation?',
        contextMessages: [{ content: 'note' }],
        toolResults: [
            { name: 'world-bank',   args: {}, result: 'GDP growth: 3.1 percent' },
            { name: 'brave-search', args: {}, result: 'inflation 12 percent' }
        ]
    });
    // LLM says world-bank shows 12% — but 12% is actually only in Brave.
    cap.extractClaimsFromResponse('According to World Bank, inflation is 12%.');
    cap.verify();
    const corrections = cap.corrections.filter(c => c.kind === 'tool_claim');
    eq(corrections.length, 1, 'source swap should be caught');
    eq(corrections[0].citedSource, 'world-bank');
    // searchedSources is restricted to the cited body when source is named
    eq(corrections[0].searchedSources, ['world-bank']);
});

test('currency tolerance: ±1% magnitude', () => {
    const cap = new AuditCapsule('t7', 'test');
    cap.hydrate({
        query: 'price?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'uk-lr', args: {}, result: 'Average price: £500,000' }]
    });
    // £504,000 = 0.8% above £500,000 → within ±1%
    cap.extractClaimsFromResponse('UK Land Registry shows £504,000 average.');
    cap.verify();
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 0,
        'currency drift within 1% must pass');
});

test('currency miss outside tolerance: caught', () => {
    const cap = new AuditCapsule('t8', 'test');
    cap.hydrate({
        query: 'price?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'uk-lr', args: {}, result: 'Average price: £500,000' }]
    });
    cap.extractClaimsFromResponse('UK Land Registry shows £800,000 average.');
    cap.verify();
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 1);
});

test('count claim: exact match required', () => {
    const cap = new AuditCapsule('t9', 'test');
    cap.hydrate({
        query: 'messages?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'book', args: {}, result: '{"matches":[{"id":1},{"id":2},{"id":3},{"id":4},{"id":5}]}' }]
    });
    // Tool result mentions "5" (in id:5). LLM claims "5 messages" — match.
    cap.extractClaimsFromResponse('Your book shows 5 messages.');
    cap.verify();
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 0);
});

test('tool with error is ignored', () => {
    const cap = new AuditCapsule('t10', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [
            { name: 'world-bank', args: {}, error: 'timeout', result: null },
            { name: 'brave-search', args: {}, result: 'growth was 5 percent' }
        ]
    });
    cap.extractClaimsFromResponse('Growth was 5%.');
    cap.verify();
    // brave-search has the number 5; world-bank error is skipped.
    eq(cap.corrections.filter(c => c.kind === 'tool_claim').length, 0);
});

test('tool_claim corrections surface to unverifiable after applyCorrections', () => {
    const cap = new AuditCapsule('t11', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'growth 5.0 percent' }]
    });
    cap.extractClaimsFromResponse('World Bank shows 99%.');
    cap.verify();
    const before = cap.corrections.filter(c => c.kind === 'tool_claim').length;
    eq(before, 1);
    const out = cap.applyCorrections('World Bank shows 99%.');
    // Text is left honest (no template patch for unsupported numbers).
    eq(out, 'World Bank shows 99%.');
    eq(cap.needsHumanReview, true);
    eq(cap.unverifiable.filter(u => u.kind === 'tool_claim').length, 1);
});

test('getStatus exposes toolClaim counters', () => {
    const cap = new AuditCapsule('t12', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'growth 5 percent' }]
    });
    cap.extractClaimsFromResponse('World Bank shows 12%.');
    cap.verify();
    const s = cap.getStatus();
    eq(s.toolResultsCount, 1);
    assert(s.toolClaimCount >= 1);
    assert(s.toolClaimMismatches >= 1);
});

// Regression: architect review caught that verify() was early-returning on
// empty context before running _verifyToolClaims. With non-empty toolResults
// but zero book context, tool-claim mismatches MUST still surface.
test('regression: empty context + tool results still runs tool-claim verify', () => {
    const cap = new AuditCapsule('t13', 'test');
    cap.hydrate({
        query: 'inflation?',
        contextMessages: [],   // no book context
        aggregates: {},        // no aggregates either
        toolResults: [{ name: 'world-bank', args: {}, result: 'inflation is 5 percent' }]
    });
    cap.extractClaimsFromResponse('Inflation is 12%.');
    cap.verify();
    const toolMismatches = (cap.corrections || []).filter(c => c.kind === 'tool_claim');
    assert(toolMismatches.length >= 1, 'expected tool-claim mismatch even with no context');
    assert(cap.needsHumanReview === true, 'expected needsHumanReview=true');
});

// Regression: architect review caught that a claim citing a source NOT
// present in toolResults was falling back to "search all tools" — that
// hides fabricated attributions. It must surface as cited_source_absent.
test('regression: cited source absent from tools → mismatch (no fallback)', () => {
    const cap = new AuditCapsule('t14', 'test');
    cap.hydrate({
        query: 'growth?',
        contextMessages: [{ content: 'note' }],
        // Brave is present, world-bank is NOT
        toolResults: [{ name: 'brave-search', args: {}, result: 'growth is 12 percent' }]
    });
    // Claim cites world-bank, but only brave-search exists. The number 12%
    // does live in brave-search, but we must NOT use that as a fallback.
    cap.extractClaimsFromResponse('According to World Bank, growth is 12%.');
    cap.verify();
    const cited = (cap.corrections || []).filter(c => c.kind === 'tool_claim');
    assert(cited.length === 1, `expected exactly 1 mismatch, got ${cited.length}`);
    assert(cited[0].reason === 'cited_source_absent_from_tools',
        `expected reason=cited_source_absent_from_tools, got ${cited[0].reason}`);
});

// Regression (architect re-review): _findClaimInTools used parseFloat with
// only comma-stripping, breaking dot-grouped locales like "Rp 5.000.000"
// (parsed as 5). Must use the locale-aware parseCurrencyValue so exact
// matches in Indonesian/European formatting do not surface false positives.
test('regression: dot-grouped locale number (Rp 5.000.000) matches exactly', () => {
    const cap = new AuditCapsule('t15', 'test');
    cap.hydrate({
        query: 'income?',
        contextMessages: [{ content: 'note' }],
        toolResults: [{ name: 'world-bank', args: {}, result: 'Median income is Rp 5.000.000 per month' }]
    });
    cap.extractClaimsFromResponse('According to World Bank, median income is Rp 5.000.000.');
    cap.verify();
    const toolMismatches = (cap.corrections || []).filter(c => c.kind === 'tool_claim');
    assert(toolMismatches.length === 0,
        `dot-grouped exact match should not mismatch; got ${JSON.stringify(toolMismatches)}`);
});

// ── Pipeline-level tests ─────────────────────────────────────────────────────
console.log('\ncross-source verifier: runDashboardAuditPipeline');

(async () => {

await test('pipeline forwards toolResults to capsule', async () => {
    const result = await runDashboardAuditPipeline({
        query: 'inflation?',
        initialResponse: 'According to World Bank, inflation is 99%.',
        contextMessages: [{ content: 'note' }],
        entityAggregates: {},
        toolResults: [{ name: 'world-bank', args: {}, result: 'inflation 3 percent' }],
        engine: 'test'
    });
    // Verifier detected divergence → corrections present (or surfaced as
    // unverifiable after applyCorrections runs since tool_claim is
    // non-patchable). Either way: needsHumanReview must be true.
    assert(result.needsHumanReview === true || (result.corrections && result.corrections.length > 0),
        'expected human-review surface for source mismatch');
});

await test('regression: pipeline no-context + divergent tool claim surfaces mismatch', async () => {
    const result = await runDashboardAuditPipeline({
        query: 'inflation?',
        initialResponse: 'According to World Bank, inflation is 12%.',
        contextMessages: [],   // no book context
        entityAggregates: {},  // no aggregates
        toolResults: [{ name: 'world-bank', args: {}, result: 'inflation is 5 percent' }],
        engine: 'test'
    });
    assert(result.noContext === true, 'expected noContext=true');
    assert(result.needsHumanReview === true, 'expected needsHumanReview=true even without book context');
    assert(Array.isArray(result.corrections) && result.corrections.length >= 1,
        `expected ≥1 correction; got ${JSON.stringify(result.corrections)}`);
    assert(result.corrections.every(c => c.kind === 'tool_claim'),
        'all surfaced corrections in no-context branch must be tool_claim');
});

await test('pipeline no-op when no toolResults (existing #171 path unchanged)', async () => {
    const result = await runDashboardAuditPipeline({
        query: 'inflation?',
        initialResponse: 'According to World Bank, inflation is 99%.',
        contextMessages: [{ content: 'note' }],
        entityAggregates: {},
        // toolResults intentionally omitted
        engine: 'test'
    });
    // Without toolResults, the response has no entity/count claims to fail
    // and no tool-claim mismatches — pipeline reports verified=null/true.
    assert(result.needsHumanReview !== true || (result.unverifiable || []).every(u => u.kind !== 'tool_claim'),
        'no toolResults should not produce tool_claim unverifiables');
});

console.log(`\ncross-source verifier: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})();
