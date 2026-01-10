/**
 * CapsuleChain - Immutable Cascading Audit Pipeline
 * 
 * Progressive data distillation through immutable capsules:
 * C0: Universe     → All book messages
 * C1: Time Match   → Filtered by date pattern (e.g., "December 2025")
 * C2: Action Match → Filtered by action keywords (e.g., "perbaikan")
 * C3: Aggregates   → Entity counts from C2
 * 
 * Each capsule is immutable. Answer comes from terminal capsule.
 * If a stage yields {}, the trail explains why.
 */

const PLATE_REGEX = /\b([A-Z]{1,2})\s*(\d{1,4})\s*([A-Z]{1,3})\b/gi;

const ACTION_KEYWORDS = {
    repair: ['perbaikan', 'perbaiki', 'servis', 'service', 'ganti', 'repair', 'fix', 'maintenance'],
    masuk: ['masuk', 'datang', 'tiba', 'arrive', 'check-in', 'checkin'],
    keluar: ['keluar', 'selesai', 'ambil', 'pick up', 'pickup', 'done', 'complete']
};

class Capsule {
    constructor(stage, inputCount, output, rationale, stats = {}) {
        this.stage = stage;
        this.inputCount = inputCount;
        this.output = output;
        this.outputCount = Array.isArray(output) ? output.length : Object.keys(output).length;
        this.rationale = rationale;
        this.stats = stats;
        this.createdAt = new Date().toISOString();
        Object.freeze(this);
    }
}

class CapsuleChain {
    constructor(traceId = null) {
        this.traceId = traceId || `audit_${Date.now()}`;
        this.capsules = [];
        this.query = null;
    }

    setQuery(query) {
        this.query = query;
    }

    addCapsule(stage, inputCount, output, rationale, stats = {}) {
        const capsule = new Capsule(stage, inputCount, output, rationale, stats);
        this.capsules.push(capsule);
        return capsule;
    }

    c0_universe(messages) {
        const copied = [...messages];
        return this.addCapsule(
            'C0_UNIVERSE',
            messages.length,
            copied,
            `Loaded ${messages.length} messages from book(s)`,
            { totalMessages: messages.length }
        );
    }

    c1_timeMatch(messages, datePatterns) {
        if (!datePatterns || datePatterns.length === 0) {
            const copied = [...messages];
            return this.addCapsule(
                'C1_TIME_MATCH',
                messages.length,
                copied,
                'No date filter applied - using all messages',
                { datePatterns: [], filtered: false }
            );
        }

        const filtered = messages.filter(m => {
            const date = m.timestamp?.split('T')[0] || '';
            return datePatterns.some(pattern => date.startsWith(pattern));
        });

        return this.addCapsule(
            'C1_TIME_MATCH',
            messages.length,
            filtered,
            `Filtered by date ${datePatterns.join('/')}: ${messages.length} → ${filtered.length}`,
            { datePatterns, inputCount: messages.length, outputCount: filtered.length }
        );
    }

    c2_actionMatch(messages, query) {
        const actionFilters = this._extractActionKeywords(query);
        
        if (actionFilters.length === 0) {
            const copied = [...messages];
            return this.addCapsule(
                'C2_ACTION_MATCH',
                messages.length,
                copied,
                'No action filter detected in query - using all time-matched messages',
                { actionKeywords: [], filtered: false }
            );
        }

        const allActionKeywords = actionFilters.flatMap(a => a.keywords);
        
        const filtered = messages.filter(m => {
            const content = (m.content || '').toLowerCase();
            return allActionKeywords.some(kw => content.includes(kw));
        });

        return this.addCapsule(
            'C2_ACTION_MATCH',
            messages.length,
            filtered,
            `Filtered by action [${allActionKeywords.slice(0, 3).join(', ')}...]: ${messages.length} → ${filtered.length}`,
            { actionKeywords: allActionKeywords, inputCount: messages.length, outputCount: filtered.length }
        );
    }

    c3_aggregates(messages) {
        const tallies = new Map();
        const entityMessages = new Map();

        for (const msg of messages) {
            const content = msg.content || '';
            const regex = new RegExp(PLATE_REGEX.source, 'gi');
            let match;
            
            while ((match = regex.exec(content)) !== null) {
                const normalized = match[0].replace(/\s+/g, ' ').toUpperCase().trim();
                tallies.set(normalized, (tallies.get(normalized) || 0) + 1);
                
                if (!entityMessages.has(normalized)) {
                    entityMessages.set(normalized, []);
                }
                entityMessages.get(normalized).push({
                    id: msg.id,
                    timestamp: msg.timestamp,
                    preview: content.substring(0, 80)
                });
            }
        }

        const aggregates = {};
        for (const [entity, count] of tallies) {
            aggregates[entity] = {
                count,
                messages: entityMessages.get(entity) || []
            };
        }

        const entityCount = Object.keys(aggregates).length;
        return this.addCapsule(
            'C3_AGGREGATES',
            messages.length,
            aggregates,
            `Counted ${entityCount} unique entities from ${messages.length} messages`,
            { entityCount, messageCount: messages.length }
        );
    }

    _extractActionKeywords(query) {
        const queryLower = query.toLowerCase();
        const foundActions = [];

        for (const [actionType, keywords] of Object.entries(ACTION_KEYWORDS)) {
            for (const kw of keywords) {
                if (queryLower.includes(kw)) {
                    foundActions.push({ type: actionType, keywords });
                    break;
                }
            }
        }

        return foundActions;
    }

    getTerminalCapsule() {
        return this.capsules[this.capsules.length - 1];
    }

    getTrace() {
        return this.capsules.map(c => `${c.stage}: ${c.inputCount}→${c.outputCount}`).join(' | ');
    }

    getTraceCompact() {
        const counts = this.capsules.map(c => c.outputCount);
        return counts.join(' → ');
    }

    toJSON() {
        return {
            traceId: this.traceId,
            query: this.query,
            trace: this.getTrace(),
            traceCompact: this.getTraceCompact(),
            capsules: this.capsules.map(c => ({
                stage: c.stage,
                inputCount: c.inputCount,
                outputCount: c.outputCount,
                rationale: c.rationale,
                stats: c.stats
            }))
        };
    }
}

module.exports = { CapsuleChain, Capsule, ACTION_KEYWORDS, PLATE_REGEX };
