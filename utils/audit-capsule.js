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
        
        this.pipelineLog = [];
        this.verified = null;
        this.corrected = false;
        this.corrections = [];
        this.unverifiable = [];
        this.needsHumanReview = false;
        
        this._destroyed = false;
    }
    
    hydrate({ contextMessages = [], aggregates = {}, richAggregates = null, query = '', now, tz }) {
        if (this._destroyed) return this;
        
        this.contextMessages = contextMessages;
        this.aggregates = aggregates;
        this.richAggregates = richAggregates || {};
        this.hasAggregates = Object.keys(aggregates).length > 0;
        
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
        
        this.log(`Extracted ${this.claimsExtracted.length} claims from response`);
        return this.claimsExtracted;
    }
    
    verify() {
        if (this._destroyed) return this;
        
        const mismatches = [];
        const unverifiable = [];
        
        if (this.contextMessages.length === 0 && !this.hasAggregates) {
            this.verified = null;
            this.needsHumanReview = this.claimsExtracted.length > 0;
            this.unverifiable = this.claimsExtracted.map(c => ({
                ...c,
                reason: 'No context available to verify'
            }));
            this.log(`Verification skipped: no context, ${this.claimsExtracted.length} claims unverifiable`);
            return this;
        }
        
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
        
        this.unverifiable = unverifiable;
        this.corrections = mismatches;
        this.verified = mismatches.length === 0 && unverifiable.length === 0;
        this.needsHumanReview = unverifiable.length > 0;
        
        this.log(`Verified: ${this.claimsExtracted.length} claims, ${mismatches.length} mismatches, ${unverifiable.length} unverifiable`);
        return this;
    }
    
    getRetryHints() {
        if (this._destroyed) return [];
        
        return this.corrections.map(m => ({
            entity: m.entity,
            claimed: m.claimedCount,
            actual: m.actual,
            hint: `${m.entity} appears ${m.actual} times in the provided context, not ${m.claimedCount}`
        }));
    }
    
    applyCorrections(responseText) {
        if (this._destroyed) return responseText;
        
        let correctedText = responseText;
        const appliedCorrections = [];
        
        const correctableMismatches = this.corrections.filter(m => m.actual > 0);
        
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
        return {
            requestId: this.requestId,
            engine: this.engine,
            verified: this.verified,
            corrected: this.corrected,
            corrections: this.corrections,
            unverifiable: this.unverifiable,
            needsHumanReview: this.needsHumanReview,
            claimCount: this.claimsExtracted.length,
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
    
    setTimeout(() => {
        if (capsuleRegistry.has(requestId)) {
            const orphan = capsuleRegistry.get(requestId);
            if (!orphan.isDestroyed()) {
                console.warn(`⚠️ Orphan capsule auto-destroyed: ${requestId}`);
                orphan.destroy();
            }
            capsuleRegistry.delete(requestId);
        }
    }, CAPSULE_TTL);
    
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
