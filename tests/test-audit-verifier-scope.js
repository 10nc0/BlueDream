#!/usr/bin/env node
/**
 * Task #171 — proves the dashboard audit verifier independently re-derives
 * its counting scope from the user query and CATCHES filter-gap regressions
 * (the same class of bug as #169). When the verifier's scoped count diverges
 * from the LLM's claim, the existing retry/patch path corrects the answer.
 *
 * Run: node tests/test-audit-verifier-scope.js
 */

'use strict';

const { runDashboardAuditPipeline } = require('../utils/dashboard-audit-pipeline');
const { AuditCapsule } = require('../utils/audit-capsule');

let passed = 0, failed = 0;

function test(label, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => { console.log(`  \u2705  ${label}`); passed++; })
        .catch(e => { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ────────────────────────────────────────────────────────────────────────
// Build a fixture that simulates the Task #169 bug: the upstream capsule
// chain failed to honor the year filter, so the LLM (and the broad tally)
// see 10 BA 9960 QO repairs spanning 2025+2026, but the user actually
// asked about "tahun 2026" — only 5 of those messages are in scope.
// ────────────────────────────────────────────────────────────────────────
function makeBuggyContext() {
    const messages = [];
    // 5 in 2025 (Nov/Dec)
    for (let i = 0; i < 5; i++) {
        const month = i < 3 ? '11' : '12';
        const day = String(10 + i).padStart(2, '0');
        messages.push({
            id: `m25-${i}`,
            content: 'BA 9960 QO perbaikan rutin',
            timestamp: `2025-${month}-${day}T10:00:00.000Z`
        });
    }
    // 5 in 2026 (Jan/Feb)
    for (let i = 0; i < 5; i++) {
        const month = i < 3 ? '01' : '02';
        const day = String(10 + i).padStart(2, '0');
        messages.push({
            id: `m26-${i}`,
            content: 'BA 9960 QO perbaikan rem',
            timestamp: `2026-${month}-${day}T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    return { messages, aggregates };
}

const main = async () => {

console.log('\n\uD83D\uDD25 #169-class regression: filter-gap caught by independent verifier');

await test('Year-only query — verifier scopes to 2026 and corrects 10 \u2192 5', async () => {
    const { messages, aggregates } = makeBuggyContext();
    const llmAnswer = 'BA 9960 QO: 10 kali perbaikan';
    
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan paling banyak di tahun 2026?',
        initialResponse: llmAnswer,
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null, // no retry — force deterministic patch path
        engine: 'test',
        maxRetries: 0
    });
    
    assert(result.corrected === true, `expected corrected=true, got ${result.corrected}`);
    assertEqual(result.corrections.length, 1, `expected 1 correction, got ${result.corrections.length}`);
    assertEqual(result.corrections[0].entity, 'BA 9960 QO');
    assertEqual(result.corrections[0].from, 10);
    assertEqual(result.corrections[0].to, 5);
    assert(/5\s*kali/.test(result.text), `corrected text should contain "5 kali", got: ${result.text}`);
    const scopeLog = result.pipelineLog.find(l => l.includes('Independent scope re-derived'));
    assert(scopeLog, 'expected pipelineLog to mention independent scope re-derivation');
    const violationLog = result.pipelineLog.find(l => l.includes('scope_filter_violation'));
    assert(violationLog, 'expected pipelineLog to mention scope_filter_violation');
});

await test('Capsule reports scopeApplied:true and scope dimensions in status', async () => {
    const { messages, aggregates } = makeBuggyContext();
    const cap = new AuditCapsule('t-status', 'test');
    cap.hydrate({
        contextMessages: messages,
        aggregates: { 'BA 9960 QO': 10 },
        richAggregates: aggregates,
        query: 'berapa perbaikan tahun 2026'
    });
    cap.extractClaimsFromResponse('BA 9960 QO: 10 kali perbaikan');
    cap.verify();
    const st = cap.getStatus();
    assertEqual(st.scopeApplied, true);
    assert(st.scope, 'status.scope should not be null');
    assertEqual(st.scope.datePatterns, 12);
    assert(st.scope.actionKeywords > 0);
    assert(cap.corrections.length === 1);
    assertEqual(cap.corrections[0].scopeFilterViolation, true);
    assertEqual(cap.corrections[0].broadCount, 10);
    assertEqual(cap.corrections[0].actual, 5);
    assertEqual(cap.corrections[0].reason, 'scope_filter_violation');
});

console.log('\n\u2696\uFE0F  Control: query without scope dims \u2192 no spurious correction');

await test('Same context, scopeless query "berapa perbaikan" \u2192 no scope filter, count stays 10', async () => {
    const { messages, aggregates } = makeBuggyContext();
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan', // action keyword present, but no date
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    // scope has actionKeywords (perbaikan); every message has perbaikan in
    // content too, so scopedTally == broadTally == 10. Verified, no patch.
    assert(result.verified === true || result.corrected === false,
           `expected verified or no-correction; got verified=${result.verified} corrected=${result.corrected}`);
    if (result.corrections && result.corrections.length > 0) {
        throw new Error(`expected zero corrections, got ${result.corrections.length}`);
    }
});

await test('Empty query \u2192 scopeApplied is false (full backward compat)', async () => {
    const { messages, aggregates } = makeBuggyContext();
    const result = await runDashboardAuditPipeline({
        query: '',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    const scopeLog = (result.pipelineLog || []).find(l => l.includes('Independent scope re-derived'));
    assert(!scopeLog, 'no scope log expected for empty query');
});

console.log('\n\uD83D\uDC64 Sender filter: verifier counts only msgs from named sender');

await test('"dari 62812345678" \u2192 verifier ignores other senders', async () => {
    const messages = [];
    // 4 from target sender
    for (let i = 0; i < 4; i++) {
        messages.push({
            id: `me-${i}`,
            from: '+62812345678',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-15T10:00:00.000Z`
        });
    }
    // 6 from another sender (should be excluded by scope)
    for (let i = 0; i < 6; i++) {
        messages.push({
            id: `o-${i}`,
            from: '+62899999999',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 9) + 1}-20T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content, from: m.from }))
        }
    };
    
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan dari 62812345678',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    
    assert(result.corrected === true, 'expected corrected=true (sender filter should reduce count)');
    assertEqual(result.corrections[0].to, 4, `expected scoped count 4, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

// ────────────────────────────────────────────────────────────────────────
// Edge cases recommended by code review (architect):
//   (a) plate-scoped query with off-scope claimed entity → unverifiable
//   (b) sender scope with C3-shaped rich rows lacking `from` → context wins
//   (c) action keyword present only beyond preview truncation → context wins
//   (d) Date-object timestamp (not string) → still scopes correctly
// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83E\uDDEA Edge cases');

await test('(a) Plate-scoped query — off-scope claim flagged unverifiable, never confirmed by broad tally', async () => {
    // Two plates in data; user asks specifically about BA 9960 QO; LLM
    // hallucinates BA 8993 AU. Without the verifier's scope-aware actual,
    // the broad tally would happily confirm it; we want it caught.
    const messages = [];
    for (let i = 0; i < 4; i++) {
        messages.push({
            id: `a-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-01-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 5; i++) {
        messages.push({
            id: `b-${i}`,
            content: 'BA 8993 AU perbaikan',
            timestamp: `2026-02-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': { count: 4, messages: messages.slice(0, 4).map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content })) },
        'BA 8993 AU': { count: 5, messages: messages.slice(4).map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content })) }
    };
    
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan BA 9960 QO?', // plate-restricted scope
        initialResponse: 'BA 8993 AU: 5 kali perbaikan', // off-scope claim
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    
    // Off-scope entity must NOT be silently verified by broad tally.
    // Either flagged needsHumanReview or treated as unverifiable.
    assert(result.verified !== true, `expected verified !== true; got verified=${result.verified}`);
    const claimedNotVerified = !!result.needsHumanReview
        || (result.unverifiable && result.unverifiable.some(u => u.entity === 'BA 8993 AU'));
    assert(claimedNotVerified, `expected BA 8993 AU to be flagged unverifiable; got result=${JSON.stringify(result, null, 2)}`);
});

await test('(b) Sender scope + C3-shaped rich rows lacking `from` → context.from is the source of truth', async () => {
    // C3 in production stores only {id, timestamp, preview} per entity — NO
    // sender field. The verifier must therefore lean on contextMessages (which
    // do carry sender) to evaluate sender scope, not silently undercount.
    const messages = [];
    for (let i = 0; i < 3; i++) {
        messages.push({
            id: `me-${i}`,
            from: '+62812345678',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-15T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 7; i++) {
        messages.push({
            id: `o-${i}`,
            from: '+62899999999',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 9) + 1}-20T10:00:00.000Z`
        });
    }
    // Rich rows DELIBERATELY lack `from` — mirrors real C3 c3_aggregates() shape.
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan dari 62812345678',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, 'expected corrected=true');
    assertEqual(result.corrections[0].to, 3, `expected scoped count 3, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

await test('(c) Action keyword only in FULL content (preview truncated) → contextMessages re-filter still finds it', async () => {
    // C3 preview is sliced to 80 chars. If the action keyword sits past byte 80,
    // a verifier that trusted the rich preview would falsely undercount. Our
    // primary path uses contextMessages with full content, so it must not.
    const longPrefix = 'A'.repeat(120); // pushes "perbaikan" well past 80-char preview
    const messages = [];
    for (let i = 0; i < 5; i++) {
        messages.push({
            id: `c-${i}`,
            content: `${longPrefix} BA 9960 QO perbaikan rem`,
            timestamp: `2026-01-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`
        });
    }
    // Rich rows have truncated preview lacking "perbaikan"
    const aggregates = {
        'BA 9960 QO': {
            count: 5,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content.substring(0, 80) }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan tahun 2026', // mixed: date + action
        initialResponse: 'BA 9960 QO: 5 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    // Verifier should agree: scopedTally = 5, no correction needed.
    if (result.corrections && result.corrections.length > 0) {
        throw new Error(`expected no corrections (preview truncation must not falsely undercount); got: ${JSON.stringify(result.corrections)}`);
    }
    assert(result.verified === true, `expected verified=true; got ${result.verified}`);
});

await test('(d) Date-object timestamps (not strings) → scope filter normalizes via toISOString', async () => {
    const messages = [];
    for (let i = 0; i < 3; i++) {
        messages.push({
            id: `d25-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: new Date(`2025-12-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`)
        });
    }
    for (let i = 0; i < 4; i++) {
        messages.push({
            id: `d26-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: new Date(`2026-03-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`)
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 7,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'tahun 2026',
        initialResponse: 'BA 9960 QO: 7 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, 'expected corrected=true');
    assertEqual(result.corrections[0].to, 4, `expected scoped count 4 (only 2026), got ${result.corrections[0].to}`);
});

// ────────────────────────────────────────────────────────────────────────
// Temporal-Resolver end-to-end: relative-time scoping must reach the verifier
// via the same `now`/`tz` injection the LLM-side prompt uses, so a "bulan
// lalu" question can no longer slip past the audit safety net.
// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDD25 Temporal-Resolver: relative scope is honored by the verifier');

await test('"bulan lalu" with injected now=2026-05-05 → verifier scopes to 2026-04', async () => {
    const messages = [];
    // 5 in 2026-04 (in scope per "bulan lalu")
    for (let i = 0; i < 5; i++) {
        messages.push({
            id: `apr-${i}`,
            content: 'BA 9960 QO perbaikan rutin',
            timestamp: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`
        });
    }
    // 3 in 2026-05 (current month — out of scope)
    for (let i = 0; i < 3; i++) {
        messages.push({
            id: `may-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-05-0${i + 1}T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 8,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan bulan lalu',
        initialResponse: 'BA 9960 QO: 8 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0,
        now: new Date('2026-05-05T03:00:00.000Z'),
        tz: 'Asia/Jakarta'
    });
    assert(result.corrected === true, 'expected corrected=true');
    assertEqual(result.corrections[0].to, 5,
        `expected scoped count 5 (only 2026-04), got ${result.corrections[0].to}`);
    assert(result.corrections[0].scopeFilterViolation === true,
        'expected scopeFilterViolation flag');
});

await test('"kemarin" with injected now → day-precision scope', async () => {
    const messages = [];
    // 2 on 2026-05-04 (yesterday relative to 2026-05-05 in Asia/Jakarta)
    for (let i = 0; i < 2; i++) {
        messages.push({
            id: `y-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-05-04T${String(8 + i).padStart(2, '0')}:00:00.000Z`
        });
    }
    // 4 on OTHER May days — explicitly skip 04 so the fixture cleanly
    // separates yesterday from non-yesterday.
    for (const day of ['01', '02', '03', '06']) {
        messages.push({
            id: `o-${day}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-05-${day}T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 6,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan kemarin',
        initialResponse: 'BA 9960 QO: 6 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0,
        now: new Date('2026-05-05T03:00:00.000Z'),
        tz: 'Asia/Jakarta'
    });
    assert(result.corrected === true, 'expected corrected=true');
    assertEqual(result.corrections[0].to, 2,
        `expected scoped count 2 (only 2026-05-04), got ${result.corrections[0].to}`);
});

await test('TZ boundary — UTC-late-evening msg counts as NEXT local day in Asia/Jakarta', async () => {
    // 2026-04-30T20:00:00Z = 2026-05-01T03:00:00 in Asia/Jakarta (+07:00).
    // Query "bulan ini" at 2026-05-05 local Jakarta → datePatterns=['2026-05'].
    // Naive UTC-substring filter would put this msg in 2026-04 and DROP it;
    // the tenant-tz anchor must keep it in May so the verifier counts it.
    const msgs = [
        // The boundary message — should land in May 2026 *locally*.
        { id: 'b-0', content: 'BA 9960 QO perbaikan',
          timestamp: '2026-04-30T20:00:00.000Z' },
        // A clean April message that must remain excluded.
        { id: 'a-0', content: 'BA 9960 QO perbaikan',
          timestamp: '2026-04-15T10:00:00.000Z' },
        // A clean local-May message.
        { id: 'm-0', content: 'BA 9960 QO perbaikan',
          timestamp: '2026-05-03T10:00:00.000Z' }
    ];
    const aggregates = {
        'BA 9960 QO': {
            count: 3,
            messages: msgs.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan bulan ini',
        initialResponse: 'BA 9960 QO: 3 kali perbaikan',
        contextMessages: msgs,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0,
        now: new Date('2026-05-05T03:00:00.000Z'),
        tz: 'Asia/Jakarta'
    });
    assert(result.corrected === true, 'expected corrected=true');
    assertEqual(result.corrections[0].to, 2,
        `expected scoped count 2 (boundary msg + clean May msg), got ${result.corrections[0].to}`);
});

// ────────────────────────────────────────────────────────────────────────
// Task #177 — entity-shapes + lexicon consolidation fixtures
//
// (a) Prove the shared PLATE_REGEX (imported via lib/entity-shapes) still
//     produces identical matches to the old inline copy.
// (b) Prove that a mismatch whose surrounding sentence shape doesn't match
//     any of the four templates produces a `patch_template_miss` unverifiable
//     entry instead of silently looking like a clean pass.
// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCE6 Task #177 — entity-shapes + lexicon consolidation');

await test('(177a) Shared PLATE_REGEX matches all canonical plate forms identically', async () => {
    const { PLATE_REGEX } = require('../lib/entity-shapes');
    const fixtures = [
        { text: 'BA 9960 QO perbaikan',    expect: 'BA 9960 QO' },
        { text: 'B1234ABC masuk',          expect: 'B 1234 ABC'.replace(/ /g, '') },
        { text: 'D 12 XY keluar',          expect: 'D 12 XY' },
        { text: 'Plat BK9820QF ganti oli', expect: 'BK9820QF' }
    ];
    for (const { text, expect: raw } of fixtures) {
        const re = new RegExp(PLATE_REGEX.source, 'gi');
        const found = [];
        let m;
        while ((m = re.exec(text)) !== null) found.push(m[0]);
        assert(found.length >= 1, `PLATE_REGEX found nothing in: "${text}"`);
        const normalized = found[0].replace(/\s+/g, ' ').toUpperCase().trim();
        const expectedNorm = raw.replace(/\s+/g, ' ').toUpperCase().trim();
        assertEqual(normalized, expectedNorm, `expected "${expectedNorm}" in "${text}", got "${normalized}"`);
    }
});

await test('(177a) buildCorrectionPatterns produces same behaviour as old inline templates', async () => {
    const { buildCorrectionPatterns } = require('../lib/audit-lexicon');
    const entity = 'BA 9960 QO';
    const ep = entity.replace(/\s+/g, '\\s*');
    const claimed = 10;
    const patterns = buildCorrectionPatterns(ep, claimed);
    // Each template should match its canonical sentence shape
    const cases = [
        { idx: 0, text: 'BA 9960 QO: 10 kali perbaikan' },
        { idx: 1, text: 'BA 9960 QO (10 kali)'          },
        { idx: 2, text: 'BA 9960 QO 10 kali masuk'      },
        { idx: 3, text: '10 perbaikan untuk BA 9960 QO'  }
    ];
    for (const { idx, text } of cases) {
        const re = new RegExp(patterns[idx].source, 'gi');
        assert(re.test(text), `pattern[${idx}] should match: "${text}"`);
    }
});

await test('(177a) PLATE_SHAPE_FRAGMENT used in claim-extraction patterns matches same text as PLATE_REGEX', async () => {
    const { PLATE_SHAPE_FRAGMENT } = require('../lib/entity-shapes');
    const { COUNT_UNITS_FULL_FRAG } = require('../lib/audit-lexicon');
    // Verify that the separator claim-extraction pattern derived from the
    // shared fragments matches the canonical example sentence identically.
    const separatorPattern = new RegExp(
        `(${PLATE_SHAPE_FRAGMENT})\\s*[-\u2013:]\\s*(\\d+)\\s*(?:${COUNT_UNITS_FULL_FRAG})`, 'gi'
    );
    const sentence = 'BA 9960 QO: 5 kali perbaikan';
    const m = separatorPattern.exec(sentence);
    assert(m, 'separator pattern should match the canonical sentence');
    const normalized = m[1].replace(/\s+/g, ' ').toUpperCase().trim();
    assertEqual(normalized, 'BA 9960 QO', `expected entity BA 9960 QO, got ${normalized}`);
    assertEqual(m[2], '5', `expected count 5, got ${m[2]}`);
});

await test('(177a) plates scope does NOT block rich-aggregate augmentation (policy lock)', async () => {
    // Plate-scope queries can still use the rich-aggregate path because C3 rich
    // rows carry timestamps + entity (plate is implicit) — no full content or
    // sender field is needed.  Only actionKeywords/senders block augmentation.
    // This test locks that policy so a future AUGMENT_BLOCKING_DIMENSIONS edit
    // can't silently break plate+date queries.
    const messages = [];
    // 6 messages in 2026, 4 in 2025 — for plate "BA 9960 QO"
    for (let i = 0; i < 6; i++) {
        messages.push({
            id: `p26-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 6) + 1}-10T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 4; i++) {
        messages.push({
            id: `p25-${i}`,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2025-12-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan BA 9960 QO tahun 2026',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, `expected corrected=true (scoped to 2026 only); got ${result.corrected}`);
    assertEqual(result.corrections[0].to, 6,
        `expected scoped count 6 (only 2026 messages), got ${result.corrections[0].to}`);
});

await test('(177b) Unknown sentence shape → unverifiable[].reason === "patch_template_miss"', async () => {
    // The claim-extraction patterns and the four correction templates are
    // symmetric, so any sentence that yields a claim can also be patched.
    // The cleanest way to test the patch-miss path is to unit-test
    // applyCorrections() directly: inject a real mismatch into the capsule
    // (skipping extraction) and then call applyCorrections() with a sentence
    // whose count word ("kunjungan") doesn't appear in any template so zero
    // templates match — this is the realistic case of LLM phrasing drift.
    const { AuditCapsule } = require('../utils/audit-capsule');

    const cap = new AuditCapsule('t-miss-177', 'test');

    // Simulate what verify() would have populated after finding a mismatch
    // where actual > 0 (correctable in principle, but not patchable).
    cap.corrections = [{
        entity: 'BA 9960 QO',
        claimedCount: 10,
        actual: 5,
        evidence: [],
        scopeFilterViolation: false,
        broadCount: undefined,
        reason: undefined
    }];
    cap.unverifiable = [];
    cap.verified = false;
    cap.needsHumanReview = false;

    // Sentence whose count unit ("kunjungan") is NOT in any of the four
    // templates — simulates an LLM that chose a novel phrasing.
    const unknownShape = 'BA 9960 QO: 10 kunjungan dalam data bengkel.';
    const patchedText = cap.applyCorrections(unknownShape);

    // The text must be returned unchanged (no template matched, no replacement)
    assertEqual(patchedText, unknownShape, 'text should be unchanged when no template matched');

    // corrected must be false
    assert(cap.corrected === false,
        `cap.corrected should be false, got ${cap.corrected}`);

    // unverifiable must contain exactly one patch_template_miss entry
    const missEntry = cap.unverifiable.find(u => u.reason === 'patch_template_miss');
    assert(missEntry,
        `expected patch_template_miss in cap.unverifiable; got: ${JSON.stringify(cap.unverifiable)}`);
    assertEqual(missEntry.entity, 'BA 9960 QO',
        `expected entity BA 9960 QO, got ${missEntry && missEntry.entity}`);
    assertEqual(missEntry.claimed, 10,
        `expected claimed 10, got ${missEntry && missEntry.claimed}`);
    assertEqual(missEntry.actual, 5,
        `expected actual 5, got ${missEntry && missEntry.actual}`);

    // pipelineLog must contain the patchTemplateMiss signal line
    const missLog = cap.pipelineLog.find(l => l.includes('patchTemplateMiss'));
    assert(missLog, 'expected pipelineLog to contain a patchTemplateMiss line');
});

// ────────────────────────────────────────────────────────────────────────
// Task #180 — Sender shape generalization (multi-inpipe)
//
// Five shapes: phone (regression), email, @handle, Discord snowflake,
// LINE user id.  Each test proves the verifier correctly scopes to only
// the messages whose sender field matches the token extracted from the
// query, regardless of shape.
// ────────────────────────────────────────────────────────────────────────
console.log('\n\uD83D\uDCEC Task #180 — Sender shape generalization (multi-inpipe)');

/* ── unit: extractSendersFromQuery shape tagging ── */
await test('#180 extractSendersFromQuery — phone returns { raw, normalized, shape }', async () => {
    const { extractSendersFromQuery } = require('../utils/query-scope');
    const result = extractSendersFromQuery('berapa pesan dari +62812345678');
    assertEqual(result.length, 1, `expected 1 sender, got ${result.length}`);
    assertEqual(result[0].shape, 'phone');
    assertEqual(result[0].normalized, '62812345678');
    assert(result[0].raw, 'raw must be present');
});

await test('#180 extractSendersFromQuery — email', async () => {
    const { extractSendersFromQuery } = require('../utils/query-scope');
    const result = extractSendersFromQuery('pesan dari john@acme.com bulan ini');
    assertEqual(result.length, 1, `expected 1 sender, got ${result.length}`);
    assertEqual(result[0].shape, 'email');
    assertEqual(result[0].normalized, 'john@acme.com');
});

await test('#180 extractSendersFromQuery — @handle', async () => {
    const { extractSendersFromQuery } = require('../utils/query-scope');
    const result = extractSendersFromQuery('messages from @alice');
    assertEqual(result.length, 1, `expected 1 sender, got ${result.length}`);
    assertEqual(result[0].shape, 'handle');
    assertEqual(result[0].normalized, 'alice');
});

await test('#180 extractSendersFromQuery — LINE user id', async () => {
    const { extractSendersFromQuery } = require('../utils/query-scope');
    const uid = 'Uf0123456789abcdef0123456789abcde'; // U + exactly 32 hex chars
    const result = extractSendersFromQuery(`pesan dari ${uid}`);
    assertEqual(result.length, 1, `expected 1 sender, got ${result.length}`);
    assertEqual(result[0].shape, 'line_uid');
    assertEqual(result[0].normalized, uid.toLowerCase());
});

await test('#180 extractSendersFromQuery — Discord snowflake (17-19 digits)', async () => {
    const { extractSendersFromQuery } = require('../utils/query-scope');
    const snowflake = '123456789012345678'; // 18 digits
    const result = extractSendersFromQuery(`dari user ${snowflake}`);
    assertEqual(result.length, 1, `expected 1 sender, got ${result.length}`);
    assertEqual(result[0].shape, 'snowflake');
    assertEqual(result[0].normalized, snowflake);
});

/* ── verifier-scope: email sender ── */
await test('#180 email sender — verifier scopes to only matching sender', async () => {
    const messages = [];
    for (let i = 0; i < 3; i++) {
        messages.push({
            id: `em-${i}`,
            from: 'john@acme.com',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-15T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 7; i++) {
        messages.push({
            id: `eo-${i}`,
            from: 'other@acme.com',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 6) + 1}-20T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'berapa perbaikan dari john@acme.com',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, `expected corrected=true (email sender filter); got corrected=${result.corrected}`);
    assertEqual(result.corrections[0].to, 3, `expected scoped count 3, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

/* ── verifier-scope: @handle sender ── */
await test('#180 @handle sender — verifier scopes to only matching sender', async () => {
    const messages = [];
    for (let i = 0; i < 4; i++) {
        messages.push({
            id: `ha-${i}`,
            from: '@alice',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-10T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 6; i++) {
        messages.push({
            id: `hb-${i}`,
            from: '@bob',
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 6) + 1}-20T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: 'perbaikan dari @alice',
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, `expected corrected=true (@handle filter); got corrected=${result.corrected}`);
    assertEqual(result.corrections[0].to, 4, `expected scoped count 4, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

/* ── verifier-scope: LINE user id ── */
await test('#180 LINE user id sender — verifier scopes to only matching sender', async () => {
    const targetUid = 'Uf0123456789abcdef0123456789abcde'; // U + exactly 32 hex chars
    const otherUid  = 'U99887766554433221100aabbccddeeff'; // U + exactly 32 hex chars
    const messages = [];
    for (let i = 0; i < 5; i++) {
        messages.push({
            id: `lu-${i}`,
            from: targetUid,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-10T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 5; i++) {
        messages.push({
            id: `lo-${i}`,
            from: otherUid,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-20T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: `perbaikan dari ${targetUid}`,
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, `expected corrected=true (LINE uid filter); got corrected=${result.corrected}`);
    assertEqual(result.corrections[0].to, 5, `expected scoped count 5, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

/* ── verifier-scope: Discord snowflake ── */
await test('#180 Discord snowflake sender — verifier scopes to only matching sender', async () => {
    const targetSnowflake = '123456789012345678';
    const otherSnowflake  = '987654321098765432';
    const messages = [];
    for (let i = 0; i < 2; i++) {
        messages.push({
            id: `sf-${i}`,
            from: targetSnowflake,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${i + 1}-10T10:00:00.000Z`
        });
    }
    for (let i = 0; i < 8; i++) {
        messages.push({
            id: `so-${i}`,
            from: otherSnowflake,
            content: 'BA 9960 QO perbaikan',
            timestamp: `2026-0${(i % 6) + 1}-20T10:00:00.000Z`
        });
    }
    const aggregates = {
        'BA 9960 QO': {
            count: 10,
            messages: messages.map(m => ({ id: m.id, timestamp: m.timestamp, preview: m.content }))
        }
    };
    const result = await runDashboardAuditPipeline({
        query: `perbaikan dari ${targetSnowflake}`,
        initialResponse: 'BA 9960 QO: 10 kali perbaikan',
        contextMessages: messages,
        entityAggregates: aggregates,
        llmCallFn: null,
        engine: 'test',
        maxRetries: 0
    });
    assert(result.corrected === true, `expected corrected=true (snowflake filter); got corrected=${result.corrected}`);
    assertEqual(result.corrections[0].to, 2, `expected scoped count 2, got ${result.corrections[0].to}`);
    assertEqual(result.corrections[0].from, 10);
});

/* ── regression: phone shape unchanged ── */
await test('#180 phone shape regression — existing digit-suffix logic preserved', async () => {
    const { messageMatchesScope, parseQueryScope } = require('../utils/query-scope');
    const scope = parseQueryScope('berapa pesan dari 62812345678');
    assertEqual(scope.senders.length, 1, 'expected 1 sender');
    assertEqual(scope.senders[0].shape, 'phone');
    // Full number stored as digits
    const msg = { from: '+62812345678', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    assert(messageMatchesScope(msg, scope), 'full number with country code should match via suffix');
    // Non-matching sender must not pass
    const other = { from: '+62899999999', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    assert(!messageMatchesScope(other, scope), 'different phone must not match');
});

/* ── empty senders is a no-op (backward compat) ── */
await test('#180 empty senders scope is no-op (no sender in query)', async () => {
    const { messageMatchesScope, parseQueryScope } = require('../utils/query-scope');
    const scope = parseQueryScope('berapa perbaikan tahun 2026');
    assertEqual(scope.senders.length, 0, 'expected 0 senders');
    // Any sender must pass the sender dimension
    const msg = { from: 'anyone', content: 'BA 9960 QO perbaikan', timestamp: '2026-03-01T00:00:00Z' };
    assert(messageMatchesScope(msg, scope), 'sender dimension must be no-op when senders is empty');
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

};

main().catch(e => { console.error(e); process.exit(1); });
