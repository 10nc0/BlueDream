/**
 * AuditCapsule - Session-Scoped Temporal Cache for Dashboard Audit Pipeline
 * 
 * Philosophy: "Extract once, verify everywhere, burn after delivery"
 * 
 * Unlike DataPackage (persistent, multi-message), AuditCapsule is:
 * - Request-scoped: Lives only for one audit request
 * - Pre-computed: Caches entity extraction and tallies from S1
 * - Sharable: S2/S3 reuse S1's work without re-parsing
 * - Ephemeral: Destroyed after S3 delivery (no persistence)
 * 
 * Capsule Flow:
 *   Context Build → Capsule.hydrate(aggregates, messages)
 *   S1 Verify     → Capsule.extractClaims(response) + tally()
 *   S2 Retry      → Capsule.getRetryHints()
 *   S3 Deliver    → Capsule.getStatus() + Capsule.destroy()
 */

const logger = require('../lib/logger');
const { parseQueryScope, messageMatchesScope } = require('./query-scope');
const { PLATE_REGEX, PLATE_SHAPE_FRAGMENT } = require('../lib/entity-shapes');
const { extractClaims: extractCrossSourceClaims, parseCurrencyValue } = require('./claim-extractor');
const {
    buildCorrectionPatterns,
    COUNT_UNITS_FULL_FRAG,
    COUNT_UNITS_PAREN_FRAG,
    COUNT_UNITS_BASIC_FRAG
} = require('../lib/audit-lexicon');

// ── Claim-extraction patterns (parse LLM response for entity+count claims) ─
// Built from the shared entity-shape fragment and lexicon fragments so that
// every numeric bound and every count word appears exactly once in source.
//
//  _plate  — one capturing group around the shared plate shape; used in
//             patterns where the plate is the subject ("BA 9960 QO: 5 kali")
//  COUNT_PATTERN           — bare count+unit, used for general scanning
//  ENTITY_COUNT_PATTERN_*  — full entity+count sentence shapes matched in
//                             extractClaimsFromResponse()
//
// NOTE: these patterns use the same count-unit strings as the four
// applyCorrections templates built by buildCorrectionPatterns(), so adding a
// new unit to COUNT_UNITS_* propagates to both claim extraction and patching.
const _plate = `(${PLATE_SHAPE_FRAGMENT})`;

const COUNT_PATTERN = new RegExp(
    `(\\d+)\\s*(?:${COUNT_UNITS_PAREN_FRAG})\\b`, 'gi'
);
const ENTITY_COUNT_PATTERN_SEPARATOR = new RegExp(
    `${_plate}\\s*[-\u2013:]\\s*(\\d+)\\s*(?:${COUNT_UNITS_FULL_FRAG})`, 'gi'
);
const ENTITY_COUNT_PATTERN_PARENS = new RegExp(
    `${_plate}[^()]*\\((\\d+)\\s*(?:${COUNT_UNITS_PAREN_FRAG})\\)`, 'gi'
);
const ENTITY_COUNT_PATTERN_SUFFIX = new RegExp(
    `${_plate}\\s+(\\d+)\\s*(?:${COUNT_UNITS_BASIC_FRAG})\\b`, 'gi'
);

// ── Scope dimensions whose non-emptiness blocks pure-date augmentation ─────
// Adding a new scope dimension to this list opts it into "no rich-aggregate
// augment" without editing _buildScopedTally logic.
//
// Why 'plates' is NOT here:
//   Rich-aggregate rows carry timestamps and the entity is implicit — applying
//   a plate filter on top of a date filter is valid without needing full content
//   or sender fields.  The plate filter is applied INSIDE the augment block via
//   the existing `scope.plates.length > 0` guard.  Only dimensions that require
//   full message content (actionKeywords) or the sender field (senders) block
//   augmentation, because C3 rich rows don't reliably carry those.
const AUGMENT_BLOCKING_DIMENSIONS = ['actionKeywords', 'senders'];

class AuditCapsule {
    constructor(requestId, engine = 'unknown') {
        this.requestId = requestId;
        this.engine = engine;
        this.createdAt = Date.now();
        
        this.contextMessages = [];
        this.aggregates = {};
        this.richAggregates = {};
        this.hasAggregates = false;
        
        this.query = '';
        this.scope = null;
        this.scopedTally = new Map();
        this.scopeApplied = false;
        
        this.claimsExtracted = [];
        this.tallyByEntity = new Map();
        this.entityToMessages = new Map();
        
        // ── Task #228: cross-source verifier state ──────────────────────────
        // toolResults is the array of {name, args, result, error} records the
        // pipeline-orchestrator (or playground tool-runner) captured for THIS
        // turn.  When empty/absent, the cross-source verifier is a strict
        // no-op — every flow that hydrated() before #228 keeps its exact
        // prior behavior.
        this.toolResults = [];
        // toolClaims is populated by extractClaimsFromResponse() using the
        // anchored regex extractor in utils/claim-extractor.js.  Each entry:
        //   { kind, value, raw, sourceCited, position }
        this.toolClaims = [];
        
        this.pipelineLog = [];
        this.verified = null;
        this.corrected = false;
        this.corrections = [];
        this.unverifiable = [];
        this.needsHumanReview = false;
        
        this._destroyed = false;
    }
    
    hydrate({ contextMessages = [], aggregates = {}, richAggregates = null, query = '', now, tz, toolResults = [] }) {
        if (this._destroyed) return this;
        
        this.contextMessages = contextMessages;
        this.aggregates = aggregates;
        this.richAggregates = richAggregates || {};
        this.hasAggregates = Object.keys(aggregates).length > 0;
        // Cross-source verifier (Task #228) input.  Accept any iterable of
        // {name, args, result, error}; coerce non-arrays to [] so older
        // callers that pass nothing don't accidentally activate the verifier.
        this.toolResults = Array.isArray(toolResults) ? toolResults : [];
        
        this.query = query || '';
        // Pass { now, tz } so relative-time phrases (kemarin, bulan lalu, last
        // 3 months, YTD, …) expand against the SAME anchor the LLM saw via
        // the prompt-injected "Today" line — verifier and LLM stay aligned.
        this.scope = this.query ? parseQueryScope(this.query, { now, tz }) : { hasAny: false };
        
        this._buildTallyFromContext();
        
        if (this.scope && this.scope.hasAny) {
            this._buildScopedTally();
            this.scopeApplied = true;
            const dims = [];
            const dateCount = (this.scope.datePatterns?.length || 0) + (this.scope.dayPatterns?.length || 0);
            if (dateCount) dims.push(`date(${dateCount})`);
            if (this.scope.actionKeywords.length) dims.push(`action(${this.scope.actionKeywords.length})`);
            if (this.scope.plates.length) dims.push(`plate(${this.scope.plates.length})`);
            if (this.scope.senders.length) dims.push(`sender(${this.scope.senders.length})`);
            this.log(`Scope re-derived from query: [${dims.join(', ')}] → scopedTally(${this.scopedTally.size})`);
        }
        
        this.log(`Hydrated: ${contextMessages.length} messages, ${Object.keys(aggregates).length} aggregates`);
        return this;
    }
    
    /**
     * Independently re-derive the per-entity count from the user's query intent,
     * not from the same C0..C3 context the LLM saw.
     *
     * Two source choices, used per scope shape:
     *
     *   PRIMARY (always): re-filter `contextMessages` by ALL scope dimensions
     *   using each message's FULL content + sender + timestamp, then re-extract
     *   plates from the survivors and tally per entity. This is the most
     *   trustworthy source because it uses untruncated content (action keywords)
     *   and the original sender field — neither of which C3's per-entity rows
     *   reliably carry (preview is 80-char truncated, `from` is not stored).
     *
     *   AUGMENT (pure-date scope only): when the scope has ONLY date filters
     *   (no action / sender / specific-plate restrictions), also re-filter
     *   `richAggregates[entity].messages` by date. C3 rich rows carry exact
     *   timestamps and the entity is implicit, so the date filter is precise.
     *   We then take Math.max(contextCount, richCount) to recover from any
     *   contextMessages sampling (the audit pipeline samples to MAX_MESSAGES).
     *
     * For mixed scope (action/sender + …), we DO NOT augment from rich rows
     * because their truncated preview / missing sender would silently
     * undercount and falsely accuse the LLM.
     *
     * Stores result in `this.scopedTally`.
     */
    _buildScopedTally() {
        const scope = this.scope;
        if (!scope || !scope.hasAny) return;
        
        // ── PRIMARY: re-filter full contextMessages ──────────────────────────
        const ctxCounts = new Map();
        if (this.contextMessages.length > 0) {
            const filtered = this.contextMessages.filter(m => messageMatchesScope(m, scope));
            for (const msg of filtered) {
                const content = msg.content || msg.text || '';
                const plates = this._extractPlates(content);
                for (const plate of plates) {
                    const norm = this._normalizePlate(plate);
                    if (scope.plates.length > 0 && !scope.plates.includes(norm)) continue;
                    ctxCounts.set(norm, (ctxCounts.get(norm) || 0) + 1);
                }
            }
        }
        
        // ── AUGMENT (pure-date scope only) ───────────────────────────────────
        const hasDateDim = (scope.datePatterns?.length || 0) > 0
                           || (scope.dayPatterns?.length || 0) > 0;
        // Introspect over the declared blocking-dimension list rather than
        // hard-coding individual property checks.  Adding a new scope dimension
        // to AUGMENT_BLOCKING_DIMENSIONS is all that's needed to opt it in.
        const isPureDateScope = hasDateDim
            && AUGMENT_BLOCKING_DIMENSIONS.every(dim => (scope[dim]?.length || 0) === 0);
        
        if (isPureDateScope && this.richAggregates) {
            const dateOnlyScope = {
                datePatterns: scope.datePatterns || [],
                dayPatterns: scope.dayPatterns || [],
                actionKeywords: [],
                plates: [],
                senders: [],
                // Preserve the tenant timezone the LLM saw so messageMatchesScope
                // doesn't silently fall back to DEFAULT_TZ during rich-aggregate
                // augmentation. Without this, a query like "bulan ini" under a
                // non-Jakarta tenant tz would bucket UTC boundary messages into
                // the wrong local day and the verifier would overcount.
                temporalContext: scope.temporalContext,
                hasAny: true
            };
            for (const entity of Object.keys(this.richAggregates)) {
                const norm = this._normalizePlate(entity);
                if (scope.plates.length > 0 && !scope.plates.includes(norm)) continue;
                
                const rich = this.richAggregates[entity];
                const msgs = (rich && Array.isArray(rich.messages)) ? rich.messages : null;
                if (!msgs) continue;
                
                const richCount = msgs.filter(m => messageMatchesScope(m, dateOnlyScope)).length;
                const ctxCount = ctxCounts.get(norm) || 0;
                // Trust whichever is larger — context may be sampled, rich is exact for date.
                this.scopedTally.set(norm, Math.max(richCount, ctxCount));
            }
        }
        
        // Always include entities seen via context (even when rich-augment ran)
        for (const [norm, count] of ctxCounts) {
            if (!this.scopedTally.has(norm)) this.scopedTally.set(norm, count);
        }
    }
    
    _buildTallyFromContext() {
        for (const msg of this.contextMessages) {
            const content = msg.content || msg.text || '';
            const plates = this._extractPlates(content);
            
            for (const plate of plates) {
                const normalized = this._normalizePlate(plate);
                this.tallyByEntity.set(normalized, (this.tallyByEntity.get(normalized) || 0) + 1);
                
                if (!this.entityToMessages.has(normalized)) {
                    this.entityToMessages.set(normalized, []);
                }
                this.entityToMessages.get(normalized).push({
                    id: msg.id || msg.message_id,
                    preview: content.substring(0, 100),
                    timestamp: msg.timestamp
                });
            }
        }
        
        for (const [entity, count] of Object.entries(this.aggregates)) {
            const normalized = this._normalizePlate(entity);
            if (!this.tallyByEntity.has(normalized)) {
                this.tallyByEntity.set(normalized, count);
            }
        }
    }
    
    _extractPlates(text) {
        const matches = [];
        let match;
        const regex = new RegExp(PLATE_REGEX.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            matches.push(match[0]);
        }
        return matches;
    }
    
    _normalizePlate(plate) {
        return plate.replace(/\s+/g, ' ').toUpperCase().trim();
    }
    
    extractClaimsFromResponse(responseText) {
        if (this._destroyed) return [];
        
        this.claimsExtracted = [];
        const seenPositions = new Set();
        
        const patterns = [
            ENTITY_COUNT_PATTERN_SEPARATOR,
            ENTITY_COUNT_PATTERN_PARENS,
            ENTITY_COUNT_PATTERN_SUFFIX
        ];
        
        for (const patternBase of patterns) {
            let match;
            const regex = new RegExp(patternBase.source, 'gi');
            while ((match = regex.exec(responseText)) !== null) {
                const posKey = `${match.index}-${match[1]}`;
                if (seenPositions.has(posKey)) continue;
                seenPositions.add(posKey);
                
                const entity = this._normalizePlate(match[1]);
                const claimedCount = parseInt(match[2], 10);
                
                this.claimsExtracted.push({
                    entity,
                    claimedCount,
                    line: match[0],
                    position: match.index
                });
            }
        }
        
        // Cross-source claim extraction (Task #228): pull every numeric claim
        // with optional source attribution. Stored separately from
        // claimsExtracted because their lifecycle is different — these are
        // only verified when toolResults is non-empty, and they can't be
        // deterministically patched.
        this.toolClaims = extractCrossSourceClaims(responseText);
        
        this.log(`Extracted ${this.claimsExtracted.length} entity claims, ${this.toolClaims.length} tool/source claims from response`);
        return this.claimsExtracted;
    }
    
    /**
     * Cross-source verification (Task #228).
     *
     * For each numeric claim that the LLM emitted, check whether the
     * claimed value actually appears in the tool result the LLM cited
     * (or, when nothing was cited, in any tool result it was given).
     *
     * Mismatches become corrections with shape:
     *   { kind: 'tool_claim', claim, citedSource, searchedSources,
     *     nearestMatch, reason: 'tool_claim_unverified' }
     *
     * These are pushed into `this.corrections` alongside the existing
     * scope-tally corrections so the retry/patch path sees them in one
     * uniform array. The retry-hint builder differentiates by `kind`,
     * and `applyCorrections` skips tool-claim entries because they
     * carry no template-patchable count — they fall through to
     * `unverifiable` if the retry didn't fix them.
     *
     * Strict no-op when toolResults is empty.
     */
    _verifyToolClaims() {
        if (!this.toolResults || this.toolResults.length === 0) return [];
        if (!this.toolClaims || this.toolClaims.length === 0) return [];
        
        // Build a lookup table of stringified results per canonical tool name.
        // A single turn may call the same tool with multiple args; we
        // concatenate so the verifier sees the union.
        const byTool = new Map();
        for (const tr of this.toolResults) {
            if (!tr || tr.error) continue;
            const name = tr.name || 'unknown';
            const body = typeof tr.result === 'string'
                ? tr.result
                : (() => { try { return JSON.stringify(tr.result); } catch { return ''; } })();
            if (!body) continue;
            byTool.set(name, (byTool.get(name) || '') + '\n' + body);
        }
        
        const mismatches = [];
        for (const claim of this.toolClaims) {
            // Resolve which tool body to search.
            //   - If the claim cites a specific source AND that source is
            //     present in toolResults: search that body only (catches
            //     "source swap" — the number exists, just in a different tool).
            //   - If the claim cites a source that is NOT in toolResults:
            //     this is itself an unverified citation — do NOT silently
            //     fall back to all tools, otherwise we'd miss "fabricated
            //     attribution" cases.
            //   - If the claim is uncited: search every tool body.
            let targets;
            if (claim.sourceCited) {
                if (!byTool.has(claim.sourceCited)) {
                    mismatches.push({
                        kind: 'tool_claim',
                        claim: {
                            kind: claim.kind,
                            value: claim.value,
                            raw: claim.raw,
                            position: claim.position
                        },
                        citedSource: claim.sourceCited,
                        searchedSources: [],
                        nearestMatch: null,
                        reason: 'cited_source_absent_from_tools'
                    });
                    continue;
                }
                targets = [{ name: claim.sourceCited, body: byTool.get(claim.sourceCited) }];
            } else {
                targets = Array.from(byTool.entries()).map(([name, body]) => ({ name, body }));
            }
            
            if (targets.length === 0) continue;
            
            const { match, nearest, searchedNames } = this._findClaimInTools(claim, targets);
            if (match) continue;
            
            mismatches.push({
                kind: 'tool_claim',
                claim: {
                    kind: claim.kind,
                    value: claim.value,
                    raw: claim.raw,
                    position: claim.position
                },
                citedSource: claim.sourceCited,
                searchedSources: searchedNames,
                nearestMatch: nearest,
                reason: 'tool_claim_unverified'
            });
        }
        
        return mismatches;
    }
    
    /**
     * Search a list of tool bodies for the numeric value of a claim, within
     * the per-kind tolerance. Returns:
     *   { match: bool, nearest: number|null, searchedNames: string[] }
     *
     * Tolerances (per task spec):
     *   percent   ±0.5 percentage points (exact value compare)
     *   currency  ±1% of magnitude
     *   count     exact
     *   year      exact
     *   range     both bounds verified independently as percent/currency
     *             (whichever the trailing unit signals); approximated as
     *             ±1% to share the currency code path.
     */
    _findClaimInTools(claim, targets) {
        const searchedNames = targets.map(t => t.name);
        const NUM_RE = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;
        
        const toleranceCheck = (claimVal, candidate) => {
            switch (claim.kind) {
                case 'percent':
                    // ±0.5 percentage points
                    return Math.abs(candidate - claimVal) <= 0.5;
                case 'currency':
                    // ±1% of magnitude (min absolute 0.5 so tiny values don't
                    // require sub-cent precision in the tool body)
                    return Math.abs(candidate - claimVal) <= Math.max(0.5, Math.abs(claimVal) * 0.01);
                case 'count':
                case 'year':
                    return candidate === claimVal;
                case 'range':
                    // Range is two bounds; caller handles each side separately.
                    return false;
                default:
                    return candidate === claimVal;
            }
        };
        
        // Range claims: verify both bounds; both must match (within currency-style
        // tolerance) for the claim to count as verified.
        if (claim.kind === 'range' && Array.isArray(claim.value)) {
            const [lo, hi] = claim.value;
            const loVerify = this._findClaimInTools({ ...claim, kind: 'currency', value: lo }, targets);
            const hiVerify = this._findClaimInTools({ ...claim, kind: 'currency', value: hi }, targets);
            return {
                match: loVerify.match && hiVerify.match,
                nearest: loVerify.match ? hiVerify.nearest : loVerify.nearest,
                searchedNames
            };
        }
        
        const claimVal = claim.value;
        let nearest = null;
        let nearestDelta = Infinity;
        
        for (const { body } of targets) {
            NUM_RE.lastIndex = 0;
            let m;
            while ((m = NUM_RE.exec(body)) !== null) {
                // Use the SAME locale-aware parser the extractor uses, so
                // a tool body containing "Rp 5.000.000" (Indonesian
                // dot-grouping) matches a claim of 5000000 — not 5.
                const n = parseCurrencyValue(m[0]);
                if (n === null || !isFinite(n)) continue;
                if (toleranceCheck(claimVal, n)) {
                    return { match: true, nearest: n, searchedNames };
                }
                const delta = Math.abs(n - claimVal);
                if (delta < nearestDelta) {
                    nearestDelta = delta;
                    nearest = n;
                }
            }
        }
        
        return { match: false, nearest, searchedNames };
    }
    
    verify() {
        if (this._destroyed) return this;
        
        const mismatches = [];
        const unverifiable = [];
        
        
        for (const claim of this.claimsExtracted) {
            const broadCount = this.tallyByEntity.get(claim.entity) || 0;
            
            // When scope was independently re-derived from the query, ALWAYS
            // use the scoped tally as the authoritative actual — never silently
            // fall back to the broad tally (which came from the same C0..C3
            // pipeline the LLM saw, the very source we're trying not to trust).
            // Entities the scoped tally has no figure for resolve to 0 →
            // unverifiable, which is the honest answer when the verifier lacks
            // the evidence to confirm an in-scope count.
            const useScoped = this.scopeApplied;
            const actualCount = useScoped
                ? (this.scopedTally.get(claim.entity) || 0)
                : broadCount;
            
            if (claim.claimedCount !== actualCount) {
                if (actualCount === 0) {
                    unverifiable.push({
                        ...claim,
                        actual: 0,
                        reason: useScoped
                            ? 'Entity not found in scope (date/action/plate/sender filters applied independently)'
                            : 'Entity not found in context'
                    });
                } else {
                    mismatches.push({
                        ...claim,
                        actual: actualCount,
                        evidence: this.entityToMessages.get(claim.entity) || [],
                        // When the broad tally and the scoped tally disagree, the
                        // LLM's working set was likely too broad — flag it so
                        // observers (and tests) can prove the verifier caught it.
                        scopeFilterViolation: useScoped && broadCount !== actualCount,
                        broadCount: useScoped ? broadCount : undefined,
                        reason: useScoped && broadCount !== actualCount
                            ? 'scope_filter_violation'
                            : undefined
                    });
                }
            }
        }
        
        // Tag the legacy entity/count corrections so downstream consumers
        // (retry hints, applyCorrections, observability) can distinguish them
        // from the new tool-claim corrections added below.
        for (const m of mismatches) {
            if (!m.kind) m.kind = 'scope_tally';
        }
        
        // ── Cross-source verifier (Task #228) ────────────────────────────────
        // Runs AFTER scope-tally verification so its corrections stack into
        // the same array.  No-op when toolResults is empty.
        const toolClaimMismatches = this._verifyToolClaims();
        for (const m of toolClaimMismatches) mismatches.push(m);
        
        this.unverifiable = unverifiable;
        this.corrections = mismatches;
        this.verified = mismatches.length === 0 && unverifiable.length === 0;
        // Tool-claim mismatches are non-patchable (the LLM cited a number
        // that does not exist in the tool body it claimed) — they must
        // surface as needs-human-review even before applyCorrections has
        // had a chance to move them into `unverifiable`.
        this.needsHumanReview = unverifiable.length > 0 || toolClaimMismatches.length > 0;
        
        this.log(`Verified: ${this.claimsExtracted.length} entity claims, ${this.toolClaims.length} tool/source claims; ${mismatches.length} mismatches (${toolClaimMismatches.length} tool-claim), ${unverifiable.length} unverifiable`);
        return this;
    }
    
    getRetryHints() {
        if (this._destroyed) return [];
        
        return this.corrections.map(m => {
            if (m.kind === 'tool_claim') {
                // Tool-claim hints describe the source mismatch, not an
                // entity/count correction.  Shape kept superset-compatible
                // with the scope-tally shape so callers don't need to branch.
                const where = m.citedSource
                    ? `the ${m.citedSource} result you cited`
                    : `any tool result you were given`;
                const near = m.nearestMatch !== null && m.nearestMatch !== undefined
                    ? ` Nearest value present: ${m.nearestMatch}.`
                    : '';
                return {
                    kind: 'tool_claim',
                    claim: m.claim,
                    citedSource: m.citedSource,
                    hint: `The value ${m.claim.raw} (${m.claim.kind}) does not appear in ${where}.${near} Either correct the number to match the source, or remove the unsupported claim.`
                };
            }
            return {
                kind: 'scope_tally',
                entity: m.entity,
                claimed: m.claimedCount,
                actual: m.actual,
                hint: `${m.entity} appears ${m.actual} times in the provided context, not ${m.claimedCount}`
            };
        });
    }
    
    applyCorrections(responseText) {
        if (this._destroyed) return responseText;
        
        let correctedText = responseText;
        const appliedCorrections = [];
        
        // Tool-claim mismatches can't be patched deterministically — there is
        // no entity/template to rewrite, only an unsupported number that the
        // LLM emitted.  Push them straight to `unverifiable` so the dashboard
        // gets a human-review surface and the response text is left honest.
        const toolClaimMismatches = this.corrections.filter(m => m.kind === 'tool_claim');
        for (const tcm of toolClaimMismatches) {
            this.unverifiable.push({
                kind: 'tool_claim',
                claim: tcm.claim,
                citedSource: tcm.citedSource,
                searchedSources: tcm.searchedSources,
                nearestMatch: tcm.nearestMatch,
                reason: 'tool_claim_unverified'
            });
        }
        if (toolClaimMismatches.length > 0) {
            this.needsHumanReview = true;
            this.log(`toolClaimUnverified: ${toolClaimMismatches.length} numeric claim(s) absent from cited tool result`);
        }
        
        const correctableMismatches = this.corrections.filter(
            m => m.kind !== 'tool_claim' && m.actual > 0
        );
        
        for (const mismatch of correctableMismatches) {
            const entityPattern = mismatch.entity.replace(/\s+/g, '\\s*');
            // Templates are built from the shared lexicon in lib/audit-lexicon.js
            // so count-unit word lists appear exactly once in the codebase.
            const patterns = buildCorrectionPatterns(entityPattern, mismatch.claimedCount);
            
            let patched = false;
            for (const pattern of patterns) {
                if (pattern.test(correctedText)) {
                    correctedText = correctedText.replace(pattern, (match) => {
                        return match.replace(String(mismatch.claimedCount), String(mismatch.actual));
                    });
                    patched = true;
                    break;
                }
            }
            
            if (patched) {
                appliedCorrections.push({
                    entity: mismatch.entity,
                    from: mismatch.claimedCount,
                    to: mismatch.actual,
                    // Preserve scope-violation provenance through the patch
                    // step so downstream observers (and tests) can still see
                    // *why* the verifier overrode the LLM's count.
                    scopeFilterViolation: mismatch.scopeFilterViolation === true,
                    broadCount: mismatch.broadCount,
                    reason: mismatch.reason
                });
            } else {
                // Mismatch found but no sentence-shape template matched the
                // LLM's phrasing — this is a patch-template miss.  Surface it
                // explicitly so observers can distinguish it from a clean pass.
                // Field naming: `claimed` (not `claimedCount`) aligns with the
                // task spec {entity, claimed, actual} and the external API
                // contract exposed via getStatus().unverifiable.
                this.log(`patchTemplateMiss: entity=${mismatch.entity} claimed=${mismatch.claimedCount} actual=${mismatch.actual}`);
                this.unverifiable.push({
                    entity: mismatch.entity,
                    claimed: mismatch.claimedCount,
                    actual: mismatch.actual,
                    reason: 'patch_template_miss'
                });
                this.needsHumanReview = true;
            }
        }
        
        this.corrected = appliedCorrections.length > 0;
        this.corrections = appliedCorrections;
        this.log(`Applied ${appliedCorrections.length} corrections`);
        
        return correctedText;
    }
    
    getStatus() {
        const toolClaimCount = this.toolClaims.length;
        const toolClaimMismatches = this.corrections.filter(c => c.kind === 'tool_claim').length
            + this.unverifiable.filter(u => u.kind === 'tool_claim').length;
        return {
            requestId: this.requestId,
            engine: this.engine,
            verified: this.verified,
            corrected: this.corrected,
            corrections: this.corrections,
            unverifiable: this.unverifiable,
            needsHumanReview: this.needsHumanReview,
            claimCount: this.claimsExtracted.length,
            toolClaimCount,
            toolClaimMismatches,
            toolResultsCount: this.toolResults.length,
            contextSize: this.contextMessages.length,
            hasAggregates: this.hasAggregates,
            scopeApplied: this.scopeApplied,
            scope: this.scope && this.scope.hasAny ? {
                datePatterns: this.scope.datePatterns.length,
                actionKeywords: this.scope.actionKeywords.length,
                plates: this.scope.plates.length,
                senders: this.scope.senders.length
            } : null,
            pipelineLog: this.pipelineLog,
            latencyMs: Date.now() - this.createdAt
        };
    }
    
    log(message) {
        if (this._destroyed) return;
        this.pipelineLog.push(`[${this.engine}] ${message}`);
    }
    
    destroy() {
        this._destroyed = true;
        this.contextMessages = [];
        this.aggregates = {};
        this.tallyByEntity.clear();
        this.entityToMessages.clear();
        this.claimsExtracted = [];
        
        const status = this.getStatus();
        logger.debug(`🔥 AuditCapsule destroyed: ${this.requestId} (${status.latencyMs}ms)`);
        return status;
    }
    
    isDestroyed() {
        return this._destroyed;
    }
}

const capsuleRegistry = new Map();
const CAPSULE_TTL = 5 * 60 * 1000;

function createCapsule(requestId, engine) {
    const capsule = new AuditCapsule(requestId, engine);
    capsuleRegistry.set(requestId, capsule);
    
    // .unref() so the auto-destroy timer never keeps the Node event loop
    // alive on its own — tests and short-lived scripts can exit cleanly
    // after their last pipeline call without waiting CAPSULE_TTL.
    const t = setTimeout(() => {
        if (capsuleRegistry.has(requestId)) {
            const orphan = capsuleRegistry.get(requestId);
            if (!orphan.isDestroyed()) {
                console.warn(`⚠️ Orphan capsule auto-destroyed: ${requestId}`);
                orphan.destroy();
            }
            capsuleRegistry.delete(requestId);
        }
    }, CAPSULE_TTL);
    if (typeof t.unref === 'function') t.unref();
    
    return capsule;
}

function getCapsule(requestId) {
    return capsuleRegistry.get(requestId);
}

function destroyCapsule(requestId) {
    const capsule = capsuleRegistry.get(requestId);
    if (capsule) {
        const status = capsule.destroy();
        capsuleRegistry.delete(requestId);
        return status;
    }
    return null;
}

module.exports = {
    AuditCapsule,
    createCapsule,
    getCapsule,
    destroyCapsule,
    PLATE_REGEX,
    COUNT_PATTERN,
    ENTITY_COUNT_PATTERN_SEPARATOR,
    ENTITY_COUNT_PATTERN_PARENS,
    ENTITY_COUNT_PATTERN_SUFFIX
};
