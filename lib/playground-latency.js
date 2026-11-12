'use strict';
const logger = require('./logger');

class RequestTiming {
    constructor(started = Date.now()) { this.started = started; this.values = {}; }
    mark(name) { this.values[name] = Date.now() - this.started; }
    async measure(name, operation) {
        const start = Date.now();
        try { return await operation(); }
        finally { this.values[name] = Date.now() - start; }
    }
    report() { logger.info(`Playground timing ${JSON.stringify(this.values)}`); return this.values; }
}

function canStreamDraft(state, input) {
    const flags = state.preflight?.routingFlags || {};
    const contextText = [input.query || input.message || '',
        ...(input.conversationHistory || input.history || []).map(message => String(message.content || ''))].join('\n');
    return input.surface === 'playground' && input.streaming === true &&
        typeof input.onDraftDelta === 'function' && state.retryCount === 0 &&
        state.mode === 'general' && !state.hasImageAttachment &&
        !input.isVisionRequest && !(input.extractedContent?.length) &&
        !(input.photos?.length) && !(input.documents?.length) &&
        !(input.contextAttachments?.length) && !(input.attachments?.length) &&
        !input.contextAttachments && !input.byokToken &&
        !(input.attachmentHistory?.length) && !(input.audios?.length) &&
        !Object.entries(flags).some(([key, value]) => value && /financial|legal|forex|chem|medical/i.test(key)) &&
        !/\b(medic|medical|diagnos|dose|dosage|treatment|symptom|pregnan|suicid|legal|lawyer|lawsuit|contract|financial|invest|stock|forex|loan|tax|mortgage|audit|book|document|obat|dosis|sakit|hukum|pajak|saham|kontrak)\w*\b|医|药|法(?:律|务)|投[资資]/i.test(contextText);
}

module.exports = { RequestTiming, canStreamDraft };
