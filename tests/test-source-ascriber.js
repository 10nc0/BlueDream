#!/usr/bin/env node
/**
 * Source-Ascriber + extractSources — regression tests
 *
 * Guards the three bugs fixed in Task #122:
 *   Bug 1 — stripLLMSources: 📚? without `u` flag never stripped bare **Sources:** blocks
 *   Bug 2 — injectSourceLine: sigIdx searched /\n\n🔥/ but strip consumed one \n → -1 → 📚 after 🔥
 *   Bug 3 — extractSources: matched first **Sources:** (empty bullet header) not canonical 📚 form
 *
 * Run: node tests/test-source-ascriber.js
 */

'use strict';

const { stripLLMSources, injectSourceLine } = require('../utils/source-ascriber');

// ── extractSources is a browser-side pure function with no Node deps.
// Extracted verbatim from public/js/playground.js — keep in sync.
function extractSources(content) {
    const m1emoji = content.match(/\n📚\s*\*\*Sources:\*\*[ \t]*([^\n]*)/);
    if (m1emoji) {
        return {
            body:    content.slice(0, m1emoji.index) + content.slice(m1emoji.index + m1emoji[0].length),
            sources: m1emoji[1].trim(),
            format:  'inline'
        };
    }
    const m1bare = content.match(/\n\*\*Sources:\*\*[ \t]*([^\n]*[^\s][^\n]*)/);
    if (m1bare) {
        return {
            body:    content.slice(0, m1bare.index) + content.slice(m1bare.index + m1bare[0].length),
            sources: m1bare[1].trim(),
            format:  'inline'
        };
    }
    const m2 = content.match(/\n\n\*\*Sources:\*\*\n((?:[ \t]*[*\-][^\n]*\n?)+)/);
    if (m2) {
        return {
            body:    content.slice(0, m2.index) + content.slice(m2.index + m2[0].length),
            sources: m2[1].trim(),
            format:  'bullets'
        };
    }
    return { body: content, sources: null, format: null };
}

// ── harness ────────────────────────────────────────────────────────────────
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

// ── stripLLMSources ────────────────────────────────────────────────────────
console.log('\n── stripLLMSources ──');

test('bare multi-line Sources block is stripped (Bug 1 regression)', () => {
    const input = 'Body.\n\n**Sources:**\n- [Redfin](https://redfin.com)\n- [Zillow](https://zillow.com)\n\n🔥 ~nyan\n[ts]';
    const out = stripLLMSources(input);
    assert(!out.includes('**Sources:**'), 'bare **Sources:** header should be gone');
    assert(!out.includes('Redfin'), 'Redfin bullet should be gone');
    assert(!out.includes('Zillow'), 'Zillow bullet should be gone');
    assert(out.includes('🔥 ~nyan'), 'signature must survive');
});

test('emoji-prefixed multi-line Sources block is stripped', () => {
    const input = 'Body.\n\n📚 **Sources:**\n- [A](url)\n- [B](url)\n\n🔥 ~nyan\n[ts]';
    const out = stripLLMSources(input);
    assert(!out.includes('**Sources:**'), '📚 **Sources:** header should be gone');
    assert(out.includes('🔥 ~nyan'), 'signature must survive');
});

test('bare single-line Sources line is stripped', () => {
    const input = 'Body.\n**Sources:** brave.com, llm data\n\n🔥 ~nyan\n[ts]';
    const out = stripLLMSources(input);
    assert(!out.includes('**Sources:**'), 'single-line Sources should be gone');
    assert(out.includes('🔥 ~nyan'), 'signature must survive');
});

test('emoji single-line Sources line is stripped', () => {
    const input = 'Body.\n\n📚 **Sources:** brave.com, llm data\n\n🔥 ~nyan\n[ts]';
    const out = stripLLMSources(input);
    assert(!out.includes('**Sources:**'), 'emoji single-line Sources should be gone');
    assert(out.includes('🔥 ~nyan'), 'signature must survive');
});

test('body text with no Sources block is returned unchanged', () => {
    const input = 'Clean body.\n\n🔥 ~nyan\n[ts]';
    const out = stripLLMSources(input);
    assert(out.includes('Clean body.'), 'body text must be preserved');
    assert(out.includes('🔥 ~nyan'), 'signature must survive');
});

test('triple newlines are collapsed to double', () => {
    const input = 'A.\n\n\n\nB.';
    const out = stripLLMSources(input);
    assert(!out.includes('\n\n\n'), 'triple newlines should collapse');
    assert(out.includes('A.'), 'content A preserved');
    assert(out.includes('B.'), 'content B preserved');
});

// ── injectSourceLine ───────────────────────────────────────────────────────
console.log('\n── injectSourceLine ──');

test('📚 line is placed BEFORE 🔥 signature (Bug 2 regression)', () => {
    const input = 'Table.\n\nCoda.\n\n**Sources:**\n- [Redfin](url)\n\n🔥 ~nyan\n[ts]';
    const out = injectSourceLine(input, { seedMetricDirectOutput: true });
    const sigIdx = out.indexOf('🔥');
    const srcIdx = out.indexOf('📚');
    assert(srcIdx !== -1, '📚 Sources line must exist');
    assert(srcIdx < sigIdx, '📚 must appear before 🔥 (got srcIdx=' + srcIdx + ' sigIdx=' + sigIdx + ')');
});

test('Sources appears exactly once when input has bare bullet block (double-sources regression)', () => {
    const input = 'Table.\n\n**Sources:**\n- [A](url)\n- [B](url)\n\n🔥 ~nyan\n[ts]';
    const out = injectSourceLine(input, { seedMetricDirectOutput: true });
    const count = (out.match(/\*\*Sources:\*\*/g) || []).length;
    assert(count === 1, 'Expected exactly 1 **Sources:** occurrence, got ' + count);
});

test('Sources appears exactly once when input already has emoji Sources line', () => {
    const input = 'Table.\n\n📚 **Sources:** existing.com\n\n🔥 ~nyan\n[ts]';
    const out = injectSourceLine(input, { seedMetricDirectOutput: true });
    const count = (out.match(/\*\*Sources:\*\*/g) || []).length;
    assert(count === 1, 'Expected exactly 1 **Sources:** occurrence, got ' + count);
});

test('📚 line appended to end when no signature present', () => {
    const input = 'Table without signature.';
    const out = injectSourceLine(input, { seedMetricDirectOutput: true });
    assert(out.includes('📚 **Sources:**'), '📚 Sources line must exist');
    assert(out.endsWith('BIS · FRED · World Bank · Numbeo (live data)'), 'Sources appended to end');
});

test('seed metric with real source URLs shows named links not generic label', () => {
    const smUrls = [
        { title: 'FRED MEDLISPRIPERSQUFEE — Los Angeles', url: 'https://fred.stlouisfed.org/series/MEDLISPRIPERSQUFEELAXX' },
        { title: 'World Bank GNI per capita (NY.GNP.PCAP.CN)', url: 'https://api.worldbank.org/v2/country/US/indicator/NY.GNP.PCAP.CN?format=json' },
        { title: 'Numbeo Property Investment — Los Angeles', url: 'https://www.numbeo.com/property-investment/in/Los-Angeles' },
    ];
    const out = injectSourceLine('Table.', { seedMetricDirectOutput: true, seedMetricSourceUrls: smUrls });
    assert(out.includes('fred.stlouisfed.org'), 'FRED hostname must appear');
    assert(out.includes('api.worldbank.org'), 'World Bank hostname must appear');
    assert(out.includes('numbeo.com'), 'Numbeo hostname must appear');
    assert(!out.includes('BIS · FRED · World Bank · Numbeo (live data)'), 'Generic fallback must NOT appear when real URLs are given');
});

test('signature preserved and not duplicated after inject', () => {
    const input = 'Table.\n\nCoda.\n\n**Sources:**\n- [X](url)\n\n🔥 ~nyan\n[ts]';
    const out = injectSourceLine(input, { seedMetricDirectOutput: true });
    const sigCount = (out.match(/🔥 ~nyan/g) || []).length;
    assert(sigCount === 1, 'Signature must appear exactly once, got ' + sigCount);
    assert(out.includes('🔥 ~nyan'), 'Signature must be present');
});

// ── extractSources ─────────────────────────────────────────────────────────
console.log('\n── extractSources (frontend) ──');

test('emoji 📚 form wins over earlier bare bullet block (Bug 3 regression)', () => {
    const input = 'Table\n\n**Sources:**\n- [Redfin](url)\n- [Zillow](url)\n\n📚 **Sources:** brave.com, llm data\n\n🔥 ~nyan';
    const r = extractSources(input);
    assert(r.sources === 'brave.com, llm data',
        'should capture emoji form, got: ' + JSON.stringify(r.sources));
    assert(!r.body.includes('brave.com'), 'emoji line should be removed from body');
});

test('emoji form: sources content captured, body has line removed', () => {
    const input = 'Table.\n\n📚 **Sources:** fred.stlouisfed.org, llm data\n\n🔥 ~nyan';
    const r = extractSources(input);
    assert(r.sources !== null, 'sources should not be null');
    assert(r.sources.includes('fred'), 'should capture fred');
    assert(r.format === 'inline', 'format should be inline');
    assert(!r.body.includes('📚'), 'emoji line should not remain in body');
});

test('bare single-line form works as fallback (no emoji form present)', () => {
    const input = 'Analysis.\n**Sources:** training data\n\n🔥 ~nyan';
    const r = extractSources(input);
    assert(r.sources !== null, 'sources should not be null');
    assert(r.sources.includes('training data'), 'should capture source label');
    assert(r.format === 'inline', 'format should be inline');
});

test('bare empty Sources header does NOT match bare single-line fallback', () => {
    const input = 'Table.\n\n**Sources:**\n- [A](url)\n- [B](url)\n\n🔥 ~nyan';
    const r = extractSources(input);
    // bare header line has no non-whitespace after **Sources:** — m1bare requires [^\s] in content
    // so it should fall through to the bullet Format 2 match
    assert(r.format === 'bullets', 'should use bullet format, not capture empty inline, got: ' + r.format);
    assert(r.sources && r.sources.includes('[A]'), 'bullet content should be captured');
});

test('bullet block fallback captures consecutive bullet lines', () => {
    const input = 'Analysis.\n\n**Sources:**\n- [Site A](urlA)\n- [Site B](urlB)\n\n🔥 ~nyan';
    const r = extractSources(input);
    assert(r.format === 'bullets', 'should detect bullet format');
    assert(r.sources.includes('[Site A]'), 'bullet A in sources');
    assert(r.sources.includes('[Site B]'), 'bullet B in sources');
    assert(!r.body.includes('Site A'), 'bullet content removed from body');
});

test('no sources returns null', () => {
    const input = 'Just a plain response.\n\n🔥 ~nyan';
    const r = extractSources(input);
    assert(r.sources === null, 'sources should be null');
    assert(r.format === null, 'format should be null');
    assert(r.body === input, 'body should be unchanged');
});

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(56)}`);
console.log(`📊 Source Ascriber Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
}
console.log('='.repeat(56));
process.exit(failed > 0 ? 1 : 0);
