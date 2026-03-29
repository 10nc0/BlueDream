const axios = require('axios');
const logger = require('../../lib/logger');
const { resolveAIToken, groqWithRetry } = require('../../utils/groq-client');
const { isIdentityQuery } = require('../../utils/query-classifiers');
const { extractPsiEma } = require('../../utils/psi-ema-extract');
const { createPipelineOrchestrator, fastStreamPersonality } = require('../../utils/pipeline-orchestrator');
const { AI_MODELS, getLLMBackend } = require('../../config/constants');
const { loadTools, getTool } = require('../../lib/tools/registry');
const { cascade: searchCascade, cascadeMulti: searchCascadeMulti } = require('../../lib/tools/search-cascade');

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

async function extractCoreQuestion(message) {
    if (!message || typeof message !== 'string') return 'general query';
    const trimmed = message.trim();
    if (trimmed.length === 0) return 'general query';
    if (!PLAYGROUND_GROQ_TOKEN || trimmed.length < 100) return trimmed.substring(0, 200);

    const isNyanProtocol = /\{money|city|land price|empire|collapse|extinction|inequality|φ|cycle|breath\}/i.test(message) ||
        /price.*income|land.*afford|fertility|700.*m²|housing.*cost/i.test(message);

    try {
        logger.debug({ messageLen: message.length }, '🧠 Extracting core question');
        const systemPrompt = isNyanProtocol
            ? 'Extract the core question about land price, housing affordability, or city cost. Include "50 years ago" or "historical" to get comparative data. Return ONLY a short English search query (max 30 words). No explanation.'
            : 'Extract the core question or topic from the user message. If the message is not in English, translate the topic to English. Return ONLY a short English search query (max 25 words). No explanation, just the English query.';

        const response = await axios.post(
            _llm.url,
            {
                model: _llm.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: message.substring(0, 1000) }
                ],
                temperature: 0.1,
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
            if (isNyanProtocol && !extractedQuery.toLowerCase().includes('ago') && !extractedQuery.toLowerCase().includes('historical')) {
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
            isVisionRequest: !!(part.includePhotos && photoList?.length > 0),
            ...(sseStage && { streaming: true, onStageChange: sseStage }),
            ...(contextAttachments && (part.includePhotos || part.includeDocuments) && { contextAttachments })
        };

        const subResult = await orchestrator.execute(subInput);

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
