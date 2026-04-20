const axios = require('axios');
const logger = require('../../lib/logger');
const { resolveAIToken, groqWithRetry } = require('../../utils/groq-client');
const { isIdentityQuery } = require('../../utils/query-classifiers');
const { extractPsiEma } = require('../../utils/psi-ema-extract');
const { createPipelineOrchestrator, fastStreamPersonality } = require('../../utils/pipeline-orchestrator');
const { AI_MODELS, getLLMBackend } = require('../../config/constants');
const { loadTools, getTool } = require('../../lib/tools/registry');
const { cascade: searchCascade, cascadeMulti: searchCascadeMulti } = require('../../lib/tools/search-cascade');
const { searchKernel } = require('../../lib/tools/search-kernel');

const _llm = getLLMBackend();
const PLAYGROUND_GROQ_TOKEN = resolveAIToken('playground');

const API_UNITS = {
    'psi-ema': {
        theta: '°', z: 'σ', R: 'ratio', currentPrice: 'currency',
        pe: 'ratio', forwardPE: 'ratio', marketCap: 'currency',
        bars: 'count', processingMs: 'ms'
    },
    'seed-metric': {
        pricePerSqm: 'currency/m²', price700sqm: 'currency',
        income: 'currency/year', yearsToOwn: 'years',
        regime: 'label', processingMs: 'ms'
    },
    'forex': { rate: 'ratio', amount: 'currency', processingMs: 'ms' },
    common: { confidence: '%', processingMs: 'ms' }
};

loadTools();
const searchDuckDuckGo = (...args) => { const t = getTool('duckduckgo'); return t ? t.execute(...args) : null; };
const searchBrave      = (...args) => { const t = getTool('brave-search'); return t ? t.execute(...args) : null; };

// Pronouns that indicate a follow-up referencing a prior conversation subject.
const PRONOUN_RE = /\b(he|she|his|her|they|their|them|it|its|this|that)\b/i;

async function extractCoreQuestion(message, conversationHistory = [], urlAnchors = []) {
    if (!message || typeof message !== 'string') return 'general query';
    const trimmed = message.trim();
    if (trimmed.length === 0) return 'general query';

    const isShort = trimmed.length < 100;
    // A pronoun in a short query with prior context → must resolve the reference.
    // Guard: only fire when history exists so the shortcut is never broken for fresh sessions.
    const hasPronoun = isShort && PRONOUN_RE.test(trimmed) && conversationHistory.length > 0;

    // Short queries without pronouns take the fast path — no LLM call, no latency added.
    if (!PLAYGROUND_GROQ_TOKEN || (isShort && !hasPronoun)) return trimmed.substring(0, 200);

    const isNyanProtocol = /\{money|city|land price|empire|collapse|extinction|inequality|φ|cycle|breath\}/i.test(message) ||
        /price.*income|land.*afford|fertility|700.*m²|housing.*cost/i.test(message);

    // For pronoun-containing follow-ups, inject the last assistant turn as context.
    let userContent = message.substring(0, 1000);
    let systemPrompt;

    if (hasPronoun) {
        const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
        const contextSnippet = lastAssistant
            ? `Recent context: ${lastAssistant.content.substring(0, 300)}\n\n`
            : '';
        // URL anchors survive beyond the φ-8 window — inject them when resolving vague references.
        const anchorHint = urlAnchors.length > 0
            ? `Previously linked sources in this conversation: ${urlAnchors.map(a => a.url).join(', ')}. Prefer these if the user's question refers to them.\n\n`
            : '';
        userContent = `${anchorHint}${contextSnippet}User question: ${message.substring(0, 500)}`;
        systemPrompt = 'Given the recent conversation context and the user\'s follow-up question, extract a self-contained search query that resolves any pronouns or vague references. If not in English, translate to English. Return ONLY a short English search query (max 25 words). No explanation.';
        logger.debug({ pronoun: true, historyLen: conversationHistory.length, anchors: urlAnchors.length }, '🧠 Pronoun follow-up: injecting conversation context + anchors');
    } else {
        systemPrompt = isNyanProtocol
            ? 'Extract the core question about land price, housing affordability, or city cost. Include "50 years ago" or "historical" to get comparative data. Return ONLY a short English search query (max 30 words). No explanation.'
            : 'Extract the core question or topic from the user message. If the message is not in English, translate the topic to English. Return ONLY a short English search query (max 25 words). No explanation, just the English query.';
    }

    try {
        logger.debug({ messageLen: message.length }, '🧠 Extracting core question');
        const response = await axios.post(
            _llm.url,
            {
                model: _llm.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                temperature: AI_MODELS.TEMPERATURE_PRECISE,
                max_tokens: 40
            },
            {
                headers: { 'Authorization': `Bearer ${PLAYGROUND_GROQ_TOKEN}`, 'Content-Type': 'application/json' },
                timeout: _llm.timeouts.extract
            }
        );
        const extractedQuery = response.data?.choices?.[0]?.message?.content?.trim();
        if (extractedQuery && extractedQuery.length > 3) {
            logger.debug({ extracted: extractedQuery }, '🧠 Core question extracted');
            if (isNyanProtocol && !hasPronoun && !extractedQuery.toLowerCase().includes('ago') && !extractedQuery.toLowerCase().includes('historical')) {
                const enhancedQuery = extractedQuery + ' vs 50 years ago';
                logger.debug({ enhanced: enhancedQuery }, '🧠 Historical context appended');
                return enhancedQuery;
            }
            return extractedQuery;
        }
        return message.substring(0, 200);
    } catch (err) {
        logger.error({ err }, '🧠 Query extraction error');
        return message.substring(0, 200);
    }
}

const orchestrator = createPipelineOrchestrator({
    groqToken: resolveAIToken('playground'),
    auditToken: resolveAIToken('playground'),
    groqVisionToken: resolveAIToken('vision'),
    searchKernel,
    // Deprecated — kept for one-release backward compat; kernel takes precedence
    searchBrave,
    searchDuckDuckGo,
    searchCascade,
    searchCascadeMulti,
    extractCoreQuestion,
    isIdentityQuery,
    groqWithRetry
});

async function executeCompoundQuery(compoundParts, opts) {
    const { extractedContent, photoList, docList, history, clientIp, contextAttachments, sseStage, isClientDisconnected } = opts;

    const sections = [];
    let worstBadge = 'verified';
    let totalConfidence = 0;
    let confidenceCount = 0;
    let anySearchRetry = false;
    let carriedSessionLens = opts.sessionLens || {};

    for (let i = 0; i < compoundParts.length; i++) {
        const part = compoundParts[i];
        if (isClientDisconnected?.()) break;

        if (sseStage) {
            sseStage({ type: 'status', message: `Processing part ${i + 1}/${compoundParts.length}: ${part.label}...` });
        }

        const subInput = {
            message: part.query,
            photos: part.includePhotos ? (photoList || []) : [],
            documents: part.includeDocuments ? (docList || []) : [],
            extractedContent: part.includeDocuments ? (extractedContent || []) : [],
            history: history || [],
            clientIp,
            sessionLens: carriedSessionLens,
            isVisionRequest: !!(part.includePhotos && photoList?.length > 0),
            ...(sseStage && { streaming: true, onStageChange: sseStage }),
            ...(contextAttachments && (part.includePhotos || part.includeDocuments) && { contextAttachments })
        };

        const subResult = await orchestrator.execute(subInput);
        // Compound session lens across sub-queries in the same turn
        if (subResult.sessionLens && Object.keys(subResult.sessionLens).length > 0) {
            carriedSessionLens = subResult.sessionLens;
        }

        if (subResult.success && subResult.answer) {
            const section = {
                label: part.label,
                answer: subResult.answer,
                response: subResult.answer,
                mode: subResult.mode || 'general',
                badge: subResult.badge || 'unverified',
                confidence: subResult.audit?.confidence ?? null,
                didSearchRetry: subResult.didSearchRetry || false,
                passCount: subResult.passCount || 1,
                fastPath: subResult.fastPath || false
            };
            if (subResult.preflight?.ticker) section.ticker = subResult.preflight.ticker;
            const psiEma = extractPsiEma(subResult.preflight);
            if (psiEma) section.psiEma = psiEma;
            sections.push(section);

            if (subResult.badge === 'unverified') worstBadge = 'unverified';
            if (subResult.audit?.confidence != null) {
                totalConfidence += subResult.audit.confidence;
                confidenceCount++;
            }
            if (subResult.didSearchRetry) anySearchRetry = true;
        } else {
            sections.push({
                label: part.label,
                answer: '*Could not process this part. Please try asking separately.*',
                response: 'Could not process this part. Please try asking separately.',
                mode: 'error',
                badge: 'unverified',
                confidence: null,
                didSearchRetry: false,
                passCount: 0,
                fastPath: false
            });
            worstBadge = 'unverified';
        }
    }

    const mergedAnswer = sections.map((s, i) => {
        const header = `## ${i + 1}. ${s.label}`;
        const separator = i < sections.length - 1 ? '\n\n---\n\n' : '';
        return `${header}\n\n${s.answer}${separator}`;
    }).join('');

    const avgConfidence = confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : null;

    return {
        sections,
        mergedAnswer,
        worstBadge,
        avgConfidence,
        anySearchRetry,
        totalPassCount: sections.reduce((sum, s) => sum + (s.passCount || 0), 0)
    };
}

function setupSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const isClientDisconnected = () => res.writableEnded || res.destroyed || !res.writable;
    const sseStage = (event) => {
        if (!isClientDisconnected()) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const cleanup = () => { if (!res.writableEnded) res.end(); };
    return { isClientDisconnected, sseStage, cleanup };
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = {
    logger,
    _llm,
    API_UNITS,
    PLAYGROUND_GROQ_TOKEN,
    orchestrator,
    executeCompoundQuery,
    setupSSE,
    formatUptime,
    formatBytes,
    fastStreamPersonality,
    searchDuckDuckGo,
    searchBrave,
    extractCoreQuestion,
    groqWithRetry
};
