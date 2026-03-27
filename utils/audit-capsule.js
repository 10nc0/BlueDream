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
const PLATE_REGEX = /\b([A-Z]{1,2})\s*(\d{1,4})\s*([A-Z]{1,3})\b/gi;
const COUNT_PATTERN = /(\d+)\s*(?:kali|times?|x)\b/gi;
const ENTITY_COUNT_PATTERN_SEPARATOR = /([A-Z]{1,2}\s*\d{1,4}\s*[A-Z]{1,3})\s*[-–:]\s*(\d+)\s*(?:kali|times?|perbaikan|repair)/gi;
const ENTITY_COUNT_PATTERN_PARENS = /([A-Z]{1,2}\s*\d{1,4}\s*[A-Z]{1,3})[^()]*\((\d+)\s*(?:kali|times?|x)\)/gi;
const ENTITY_COUNT_PATTERN_SUFFIX = /([A-Z]{1,2}\s*\d{1,4}\s*[A-Z]{1,3})\s+(\d+)\s*(?:kali|times?)\b/gi;

class AuditCapsule {
    constructor(requestId, engine = 'unknown') {
        this.requestId = requestId;
        this.engine = engine;
        this.createdAt = Date.now();
        
        this.contextMessages = [];
        this.aggregates = {};
        this.hasAggregates = false;
        
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
    
    hydrate({ contextMessages = [], aggregates = {} }) {
        if (this._destroyed) return this;
        
        this.contextMessages = contextMessages;
        this.aggregates = aggregates;
        this.hasAggregates = Object.keys(aggregates).length > 0;
        
        this._buildTallyFromContext();
        
        this.log(`Hydrated: ${contextMessages.length} messages, ${Object.keys(aggregates).length} aggregates`);
        return this;
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
            const actualCount = this.tallyByEntity.get(claim.entity) || 0;
            
            if (claim.claimedCount !== actualCount) {
                if (actualCount === 0) {
                    unverifiable.push({
                        ...claim,
                        actual: 0,
                        reason: 'Entity not found in context'
                    });
                } else {
                    mismatches.push({
                        ...claim,
                        actual: actualCount,
                        evidence: this.entityToMessages.get(claim.entity) || []
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
            const patterns = [
                new RegExp(`(${entityPattern})\\s*[-–:]\\s*${mismatch.claimedCount}\\s*(kali|times?|perbaikan|repair)`, 'gi'),
                new RegExp(`(${entityPattern})[^()]*\\(${mismatch.claimedCount}\\s*(kali|times?|x)\\)`, 'gi'),
                new RegExp(`(${entityPattern})\\s+${mismatch.claimedCount}\\s*(kali|times?)\\b`, 'gi'),
                new RegExp(`${mismatch.claimedCount}\\s*(kali|times?|perbaikan|repair)\\s*(?:untuk|for)?\\s*(${entityPattern})`, 'gi')
            ];
            
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
                    to: mismatch.actual
                });
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
