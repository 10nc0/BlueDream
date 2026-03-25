const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const JSZip = require('jszip');
const rateLimit = require('express-rate-limit');
const logger = require('../lib/logger');
const { createPipelineOrchestrator, fastStreamPersonality, applyPersonalityFormat } = require('../utils/pipeline-orchestrator');
const { AttachmentIngestion } = require('../utils/attachment-ingestion');
const { recordInMemory, clearSessionMemory } = require('../utils/context-extractor');
const { getMemoryManager, cleanupOldSessions } = require('../utils/memory-manager');
const capacityManager = require('../utils/playground-capacity');
const usageTracker = require('../utils/playground-usage');
const { AI_MODELS, getLLMBackend } = require('../config/constants');
const _llm = getLLMBackend();
const { config } = require('../config');
const { PsiEMADashboard, deriveReading } = require('../utils/psi-EMA');
const { fetchStockPrices, calculateDataAge, sanitizeTicker } = require('../utils/stock-fetcher');

const API_UNITS = {
    'psi-ema': {
        theta: '°',
        z: 'σ',
        R: 'ratio',
        currentPrice: 'currency',
        pe: 'ratio',
        forwardPE: 'ratio',
        marketCap: 'currency',
        bars: 'count',
        processingMs: 'ms'
    },
    'seed-metric': {
        pricePerSqm: 'currency/m²',
        price700sqm: 'currency',
        income: 'currency/year',
        yearsToOwn: 'years',
        regime: 'label',
        processingMs: 'ms'
    },
    'forex': {
        rate: 'ratio',
        amount: 'currency',
        processingMs: 'ms'
    },
    common: {
        confidence: '%',
        processingMs: 'ms'
    }
};

const PLAYGROUND_GROQ_TOKEN = process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
const H0_TEMPERATURE = AI_MODELS.TEMPERATURE_REASONING;

const IDENTITY_PATTERNS = [
    /who\s+(?:are|is)\s+(?:you|nyan)/i,
    /what\s+(?:are|is)\s+(?:you|nyan)/i,
    /are\s+you\s+(?:related|connected|linked)\s+to/i,
    /who\s+(?:made|created|built)\s+(?:you|nyan|this)/i,
    /your\s+(?:creator|origin|source|developer)/i,
    /tell\s+me\s+about\s+(?:yourself|nyan)/i,
    /introduce\s+yourself/i,
    /what\s+is\s+nyan.*protocol/i,
    /nyan.*protocol.*what/i,
    /github\.com\/.*nyan/i,
    /10nc0/i,
    /void\s*nyan/i,
    /nyanbook.*(?:what|who|origin|about)/i,
    /(?:any\s+)?trace.*(?:on|in|at|from)\s+/i,
    /where\s+(?:can\s+I\s+)?find\s+you/i,
    /your\s+(?:presence|account|profile|website|handle)/i,
    /do\s+you\s+(?:exist|have\s+a|are\s+on)/i,
    /like\s+(?:perplexity|chatgpt|claude|copilot|gemini)/i,
    /similar\s+to\s+(?:perplexity|chatgpt|claude)/i,
    /compared\s+to\s+/i,
    /competitor\s+(?:to|of)\s+/i,
    /(?:so\s+)?you\s+are\s+(?:like|a|some|just)\s+/i,
    /what\s+makes?\s+you\s+(?:different|unique)/i,
    /how\s+(?:are|do)\s+you\s+(?:differ|compare)/i,
    /(?:our|this)\s+(?:chat|conversation|dialogue|history)/i,
    /what\s+(?:have\s+)?we\s+(?:discussed|talked|covered)/i,
    /describe\s+me\s+from\s+(?:our|this)/i,
    /what\s+do\s+you\s+know\s+about\s+me/i,
    /from\s+(?:our|this)\s+(?:chat|conversation)/i,
    /summarize\s+(?:our|this)\s+(?:chat|conversation)/i,
    /remember\s+(?:me|what|our)/i,
    /(?:in|during)\s+(?:this|our)\s+(?:chat|conversation)/i,
    /can\s+you\s+(?:recap|review|recall|remind)\s+/i,
];

const PSI_EMA_SYSTEM_PATTERNS = [
    /what\s+is\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema/i,
    /(?:explain|describe|tell\s+me\s+about)\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema/i,
    /how\s+does\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\s+work/i,
    /(?:psi|ψ)[\s\-]?ema\s+(?:system|oscillator|indicator|analysis)/i,
    /what\s+(?:are|is)\s+(?:the\s+)?(?:theta|θ|z|r)\s+(?:in|for)\s+(?:psi|ψ)[\s\-]?ema/i,
    /(?:psi|ψ)[\s\-]?ema\s+(?:dimensions?|parameters?|metrics?)/i,
];

const PSI_EMA_SYSTEM_EXPLANATION = `Ψ-EMA (Psi-Exponential Moving Average) is Nyan AI's novel three-dimensional time series oscillator for analyzing oscillating systems. Unlike traditional indicators, it uses φ (phi, 1.618) as the ONLY measurement threshold.

**THREE DIMENSIONS:**

**θ (Theta) - Phase Position**
• Formula: atan2(Flow, Stock) → 0° to 360°
• Measures WHERE in the cycle the system is
• 0°-90° = Early Expansion 🟢
• 90°-180° = Late Expansion 🟡
• 180°-270° = Early Contraction 🔴
• 270°-360° = Late Contraction 🔵

**z (Anomaly) - Deviation from Equilibrium**
• Formula: Robust z-score using Median Absolute Deviation (MAD)
• |z| < φ (1.618): Normal range
• |z| > φ: Alert zone
• |z| > φ² (2.618): Extreme deviation

**R (Convergence) - Amplitude Ratio**
• Formula: |z(t)| / |z(t-1)|
• R < φ⁻¹ (0.618): Decay (weakening)
• R ∈ [φ⁻¹, φ]: Stable oscillation (sustainable)
• R > φ: Amplification (potentially unsustainable)

**KEY INSIGHT:** All thresholds derive from φ = 1.618 (golden ratio from x = 1 + 1/x), making the system substrate-agnostic - applicable to markets, climate, demographics, or any oscillating system.

To analyze a specific stock, ask: "show me $NVDA psi ema" or "analyze $AAPL chart" nyan~

🔥 ~nyan`;

function isPsiEmaSystemQuery(message) {
    if (!message) return false;
    const trimmed = message.trim().toLowerCase();
    return PSI_EMA_SYSTEM_PATTERNS.some(pattern => pattern.test(trimmed));
}

const NOT_FOUND_PATTERNS = [
    /couldn'?t\s+find/i,
    /could\s+not\s+find/i,
    /no\s+(?:information|results?|data|records?|matches?)\s+(?:found|available|on|about|for)/i,
    /unable\s+to\s+(?:find|locate)/i,
    /(?:didn'?t|did\s+not)\s+find/i,
    /no\s+(?:Forbes|Wikipedia|LinkedIn|Twitter|X)\s+(?:profile|page|entry|article)/i,
    /(?:doesn'?t|does\s+not)\s+(?:appear|seem)\s+to\s+(?:exist|have|be)/i,
    /i\s+(?:couldn'?t|could\s+not|wasn'?t\s+able\s+to)\s+(?:find|locate|discover)/i,
    /not\s+(?:a\s+)?public\s+figure/i,
    /(?:may\s+be|might\s+be|is\s+(?:likely\s+)?a)\s+private\s+individual/i,
];

function isIdentityQuery(message) {
    if (!message) return false;
    const trimmed = message.trim().toLowerCase();
    return IDENTITY_PATTERNS.some(pattern => pattern.test(trimmed));
}

function containsNotFoundClaim(answer) {
    if (!answer) return false;
    return NOT_FOUND_PATTERNS.some(pattern => pattern.test(answer));
}

const sessionDocumentCache = new Map();
const SESSION_DOC_TTL = 30 * 60 * 1000;
const globalDocumentCache = new Map();
const documentUploadCounter = new Map();
const GLOBAL_DOC_TTL = 2 * 60 * 60 * 1000;
const GLOBAL_CACHE_THRESHOLD = 3;

function getDocumentHash(docData, docName) {
    const rawData = typeof docData === 'string' ? docData : JSON.stringify(docData);
    const hash = crypto.createHash('sha256')
        .update(docName + ':' + rawData)
        .digest('hex');
    return hash;
}

function getSessionCacheKey(clientIp, fileHash) {
    return `${clientIp}:${fileHash}`;
}

function incrementDocumentUpload(fileHash) {
    const current = documentUploadCounter.get(fileHash) || 0;
    const newCount = current + 1;
    documentUploadCounter.set(fileHash, newCount);
    return newCount;
}

function getCachedDocumentContext(fileHash, clientIp) {
    const now = Date.now();
    
    if (clientIp) {
        const sessionKey = getSessionCacheKey(clientIp, fileHash);
        const sessionCached = sessionDocumentCache.get(sessionKey);
        if (sessionCached && now - sessionCached.timestamp < SESSION_DOC_TTL) {
            sessionCached.timestamp = now;
            logger.debug({ hash: fileHash.substring(0, 16), ip: clientIp }, '📂 Document cache hit (session)');
            return sessionCached;
        }
        if (sessionCached) {
            sessionDocumentCache.delete(sessionKey);
        }
    }
    
    const globalCached = globalDocumentCache.get(fileHash);
    if (globalCached && now - globalCached.timestamp < GLOBAL_DOC_TTL) {
        logger.debug({ hash: fileHash.substring(0, 16), ageMin: Math.round((now - globalCached.timestamp) / 60000) }, '📂 Document cache hit (global)');
        return globalCached;
    }
    if (globalCached) {
        globalDocumentCache.delete(fileHash);
        documentUploadCounter.delete(fileHash);
    }
    
    return null;
}

function setCachedDocumentContext(fileHash, context, clientIp) {
    const now = Date.now();
    
    if (clientIp) {
        const sessionKey = getSessionCacheKey(clientIp, fileHash);
        sessionDocumentCache.set(sessionKey, {
            ...context,
            timestamp: now,
            fileHash
        });
        logger.debug({ hash: fileHash.substring(0, 16), ip: clientIp }, '📂 Document cache set (session)');
        
        while (sessionDocumentCache.size > 500) {
            const oldestKey = sessionDocumentCache.keys().next().value;
            sessionDocumentCache.delete(oldestKey);
        }
    }
    
    const uploadCount = documentUploadCounter.get(fileHash) || 0;
    if (uploadCount >= GLOBAL_CACHE_THRESHOLD) {
        globalDocumentCache.set(fileHash, {
            ...context,
            timestamp: now
        });
        logger.debug({ hash: fileHash.substring(0, 16), uploads: uploadCount }, '📂 Document cache set (global)');
        
        while (globalDocumentCache.size > 100) {
            const oldestKey = globalDocumentCache.keys().next().value;
            globalDocumentCache.delete(oldestKey);
            documentUploadCounter.delete(oldestKey);
        }
    }
    
    return true;
}

function getCachedDocumentByHash(fileHash, clientIp) {
    return getCachedDocumentContext(fileHash, clientIp);
}

setInterval(() => {
    const now = Date.now();
    let sessionEvicted = 0, globalEvicted = 0;
    
    for (const [key, value] of sessionDocumentCache.entries()) {
        if (now - value.timestamp > SESSION_DOC_TTL) {
            sessionDocumentCache.delete(key);
            sessionEvicted++;
        }
    }
    
    for (const [key, value] of globalDocumentCache.entries()) {
        if (now - value.timestamp > GLOBAL_DOC_TTL) {
            globalDocumentCache.delete(key);
            documentUploadCounter.delete(key);
            globalEvicted++;
        }
    }
    
    if (sessionEvicted > 0 || globalEvicted > 0) {
        logger.debug({ sessionEvicted, globalEvicted }, 'Document cache cleanup');
    }
}, 10 * 60 * 1000);

async function processAndCacheDocList(docList, cachedFileHashes, clientIp, extractedContent, responseFileHashes) {
    for (const doc of docList) {
        const fileHash = getDocumentHash(doc.data, doc.name);
        incrementDocumentUpload(fileHash);
        
        const cached = getCachedDocumentContext(fileHash, clientIp);
        if (cached && cached.extractedText) {
            logger.debug({ doc: doc.name }, 'Document cache hit');
            extractedContent.push(cached.extractedText);
            responseFileHashes.push({ name: doc.name, hash: fileHash });
            continue;
        }
        
        try {
            const { processDocumentForAI } = require('../utils/attachment-cascade');
            const result = await processDocumentForAI(doc.data, doc.name, doc.type, { tenantId: clientIp });
            if (result && result.text) {
                extractedContent.push(result.text);
                setCachedDocumentContext(fileHash, { extractedText: result.text }, clientIp);
                responseFileHashes.push({ name: doc.name, hash: fileHash });
            }
        } catch (docError) {
            logger.error({ doc: doc.name, err: docError }, 'Document processing error');
        }
    }
    
    if (cachedFileHashes && Array.isArray(cachedFileHashes)) {
        for (const hashEntry of cachedFileHashes) {
            const cached = getCachedDocumentByHash(hashEntry.hash, clientIp);
            if (cached && cached.extractedText) {
                logger.debug({ doc: hashEntry.name }, 'Restored cached document context');
                extractedContent.push(cached.extractedText);
            }
        }
    }
}

async function searchDuckDuckGo(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return null;
    }
    const sanitizedQuery = query.trim().substring(0, 500);
    
    const params = {
        q: sanitizedQuery,
        format: 'json',
        no_html: 1,
        skip_disambig: 1,
        t: 'nyanbook'
    };
    const url = `https://api.duckduckgo.com/?${querystring.stringify(params)}`;
    
    try {
        const response = await axios.get(url, { timeout: 5000, responseType: 'json' });
        const data = response.data;
        
        if (!data || typeof data !== 'object') {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: non-JSON response, skipping');
            return null;
        }
        
        const context = [];
        if (data.AbstractText) {
            const src = data.AbstractSource ? ` [${data.AbstractSource}]` : '';
            const srcUrl = data.AbstractURL ? ` — ${data.AbstractURL}` : '';
            context.push(`📚 ${data.AbstractText}${src}${srcUrl}`);
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: instant answer found');
        }
        if (data.RelatedTopics && Array.isArray(data.RelatedTopics) && data.RelatedTopics.length > 0) {
            const relevantTopics = data.RelatedTopics.filter(t => t && t.Text && !t.FirstURL).slice(0, 3);
            if (relevantTopics.length > 0) {
                context.push('Related information:');
                relevantTopics.forEach(topic => {
                    if (topic.Text) context.push(`  • ${topic.Text}`);
                });
            }
        }
        
        if (context.length > 0) {
            logger.debug({ count: context.length }, '🔍 DDG: injecting results');
            return context.join('\n');
        } else {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: no results, using base knowledge');
            return null;
        }
    } catch (err) {
        logger.error({ err }, '🔍 DDG search error');
        return null;
    }
}

async function extractCoreQuestion(message) {
    if (!message || typeof message !== 'string') {
        return 'general query';
    }
    
    const trimmed = message.trim();
    if (trimmed.length === 0) {
        return 'general query';
    }
    
    const GROQ_TOKEN = process.env.DEEPSEEK_API || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
    if (!GROQ_TOKEN || trimmed.length < 100) {
        return trimmed.substring(0, 200);
    }
    
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
                headers: {
                    'Authorization': `Bearer ${GROQ_TOKEN}`,
                    'Content-Type': 'application/json'
                },
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

/**
 * searchBrave — Web search via Brave Search API.
 *
 * @param {string}  query     Search query (max 500 chars).
 * @param {string}  clientIp  Caller IP for capacity throttling (optional).
 * @param {Object}  opts      Options:
 *   opts.format  'text' (default) — numbered list string for general prompts
 *                'json' — structured JSON array for LLM tool-call paths (e.g. seed metric walk-the-dog)
 *                         Each item: { title, url, description, age }
 *                         Gives the LLM machine-readable quantity to triangulate prices from.
 *
 * Architecture note — "Live API over Dogma":
 *   This function is a pure data transport. It returns what Brave says — no filtering,
 *   no value extraction, no heuristics. The caller (LLM or parser) interprets the data.
 *   Routing decisions (is this a price query? is this a city?) happen BEFORE this call.
 */
async function searchBrave(query, clientIp = null, opts = {}) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return null;
    }
    const sanitizedQuery = query.trim().substring(0, 500);
    const format = opts.format || 'text'; // 'text' | 'json'
    
    const BRAVE_API_KEY = process.env.PLAYGROUND_BRAVE_API;
    if (!BRAVE_API_KEY) {
        logger.debug('🦁 Brave: API key not configured, skipping');
        return null;
    }
    
    if (clientIp) {
        const braveCapacity = await capacityManager.consumeToken(clientIp, 'brave');
        if (!braveCapacity.allowed) {
            logger.debug({ ip: clientIp, reason: braveCapacity.reason }, '🦁 Brave: capacity exhausted');
            return null;
        }
    }
    
    try {
        logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🦁 Brave: searching for real-time context');
        const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': BRAVE_API_KEY
            },
            params: {
                q: sanitizedQuery,
                count: 5,
                text_decorations: false,
                safesearch: 'moderate'
            },
            timeout: 5000
        });
        
        const results = response.data?.web?.results || [];
        if (results.length === 0) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🦁 Brave: no results found');
            return null;
        }
        
        logger.debug({ count: results.length, format }, '🦁 Brave: injecting results into prompt');

        if (format === 'json') {
            // Raw JSON — gives LLM structured quantity to extract prices from.
            // "Walk the dog" philosophy: LLM reads raw results and derives $/sqm itself.
            const structured = results.slice(0, 5).map(r => ({
                title: r.title || '',
                url: r.url || '',
                description: r.description || '',
                age: r.age || null  // publish date if available — helps distinguish historical vs current
            }));
            return JSON.stringify(structured);
        }

        // Default: formatted text for general prompts — include URL so LLM can cite source
        const context = results.slice(0, 5).map((r, i) =>
            `${i + 1}. ${r.title || 'Untitled'}\n   ${r.description || ''}\n   Source: ${r.url || ''}`
        ).join('\n\n');
        return `🌐 Web search results:\n${context}`;
    } catch (err) {
        logger.error({ err }, 'Brave search error');
        return null;
    }
}

async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(axiosConfig.url, axiosConfig.data, axiosConfig.config);
            
            if (response.data?.usage) {
                usageTracker.recordUsage(serviceType, response.data.usage);
            }
            
            return response;
        } catch (error) {
            lastError = error;
            
            const status = error.response?.status;
            const headers = error.response?.headers || {};
            const errorBody = error.response?.data;
            
            const promptTokensEstimate = axiosConfig.data?.messages 
                ? JSON.stringify(axiosConfig.data.messages).length / 4 
                : null;
            logger.warn({
                attempt: attempt + 1,
                maxAttempts: maxRetries + 1,
                status,
                rateLimitRequests: headers['x-ratelimit-limit-requests'] || null,
                rateLimitRemaining: headers['x-ratelimit-remaining-requests'] || null,
                retryAfter: headers['retry-after'] || null,
                promptTokensEstimate: typeof promptTokensEstimate === 'number' ? Math.round(promptTokensEstimate) : null,
                errorBody
            }, 'Groq API error');
            
            if (status === 429 && attempt < maxRetries) {
                const retryAfter = headers['retry-after'];
                const delayMs = retryAfter 
                    ? parseInt(retryAfter) * 1000 
                    : Math.min(1000 * Math.pow(2, attempt), 8000);
                logger.debug({ delayMs, attempt: attempt + 1, maxRetries }, 'Groq 429: retrying');
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

const orchestrator = createPipelineOrchestrator({
    groqToken: process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN,
    auditToken: process.env.DEEPSEEK_API || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN,
    groqVisionToken: process.env.PLAYGROUND_GROQ_VISION_TOKEN,
    searchBrave,
    searchDuckDuckGo,
    extractCoreQuestion,
    isIdentityQuery,
    groqWithRetry
});

const { detectCompoundQuery } = require('../utils/preflight-router');
const { AUDIT } = require('../config/constants');
const { buildAuditContext } = require('../utils/audit-context');
const { runDashboardAuditPipeline } = require('../utils/dashboard-audit-pipeline');
const { formatExecutiveResponse } = require('../utils/executive-formatter');
const { buildExecutiveAuditPrompt, buildRetryPrompt } = require('../prompts/executive-audit');

function registerNyanAIRoutes(app, deps) {
    const { pool, middleware, bots } = deps;
    const requireAuth = middleware?.requireAuth;
    const thothBot = bots?.thoth;
    const idrisBot = bots?.idris;

    const auditLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        keyGenerator: (req) => req.userId || req.ip,
        validate: { keyGeneratorIpFallback: false },
        handler: (req, res) => {
            logger.warn({ userId: req.userId }, '⚠️ Audit rate limit exceeded');
            res.status(429).json({ error: 'Too many audit requests. Max 20 per minute.' });
        },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.post('/api/nyan-ai/audit', requireAuth, auditLimiter, async (req, res) => {
        const { query, bookIds, language } = req.body;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userRole = req.userRole;
        const startTime = Date.now();
        
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return res.status(400).json({ error: 'Query is required' });
        }
        
        logger.info({ userId: req.userId, bookCount: bookIds?.length || 0 }, 'Nyan AI Audit query');
        
        try {
            let bookContext = null;
            let contextPrompt = '';
            
            // Trust frontend auth - fetch context from provided bookIds
            if (bookIds && Array.isArray(bookIds) && bookIds.length > 0) {
                bookContext = await buildAuditContext(bookIds, tenantSchema, query, {
                    pool,
                    thothBot,
                    userRole,
                    maxMessages: AUDIT.MAX_MESSAGES
                });
                
                if (bookContext && bookContext.totalMessages > 0) {
                    const bookSummary = bookContext.books.map(b => `- ${b.name}: ${b.totalMessages} messages`).join('\n');
                    const contextNote = bookContext.contextNote || '';
                    const overflowWarning = bookContext.overflowWarning ? `\n\n⚠️ IMPORTANT: ${bookContext.overflowWarning}` : '';
                    
                    const messagesText = bookContext.recentMessages
                        .map(m => `[${m.bookName}] ${m.timestamp.split('T')[0]}: ${m.content}`)
                        .join('\n');
                    
                    contextPrompt = `
You have access to the user's book data from their Nyanbook ledger.

BOOKS IN CONTEXT (${bookContext.bookCount} book(s), ${bookContext.totalMessages} total messages):
${bookSummary}
(${contextNote})

MESSAGES FROM THESE BOOKS:
${messagesText}

USER QUERY:
${query}${overflowWarning}

Analyze the data and answer the user's question. Count carefully when asked about quantities. Reference actual messages.`;
                } else {
                    contextPrompt = `The user asked about their books but no messages were found. Please let them know their selected books have no messages yet.\n\nUSER QUERY: ${query}`;
                }
            } else {
                contextPrompt = query;
            }
            
            // Use DeepSeek (if available) or NYANBOOK_AI_KEY for authenticated audit
            const response = await groqWithRetry({
                url: _llm.url,
                data: {
                    model: _llm.model,
                    messages: [
                        {
                            role: 'system',
                            content: buildExecutiveAuditPrompt(language)
                        },
                        { role: 'user', content: contextPrompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 4096
                },
                config: {
                    headers: {
                        'Authorization': `Bearer ${config.ai.deepseekKey || config.ai.dashboardAiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            });
            
            let answer = response.data?.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
            const processingTime = Date.now() - startTime;
            
            // S0-S3: Dashboard Audit Pipeline - verify and correct count mismatches
            let auditCorrected = false;
            let corrections = [];
            let needsHumanReview = false;
            let unverifiable = [];
            let pipelineVerified = null;
            if (bookContext && bookContext.totalMessages > 0) {
                const retryFn = async (retryPrompt, options) => {
                    const retryResp = await groqWithRetry({
                        url: _llm.url,
                        data: {
                            model: _llm.model,
                            messages: [
                                {
                                    role: 'system',
                                    content: buildRetryPrompt()
                                },
                                { role: 'user', content: retryPrompt }
                            ],
                            temperature: options.temperature || 0.1,
                            max_tokens: 4096
                        },
                        config: {
                            headers: {
                                'Authorization': `Bearer ${config.ai.deepseekKey || config.ai.dashboardAiKey}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    });
                    return retryResp.data?.choices?.[0]?.message?.content || null;
                };
                
                const pipelineResult = await runDashboardAuditPipeline({
                    query: query,
                    initialResponse: answer,
                    contextMessages: bookContext.recentMessages || [],
                    entityAggregates: bookContext.entityAggregates || {},
                    llmCallFn: retryFn,
                    engine: 'nyan-ai',
                    maxRetries: 1
                });
                
                pipelineVerified = pipelineResult.verified;
                
                if (pipelineResult.corrected) {
                    answer = pipelineResult.text;
                    auditCorrected = true;
                    corrections = pipelineResult.corrections;
                    logger.debug({ corrections: corrections.length, method: pipelineResult.correctionMethod, latencyMs: pipelineResult.latencyMs }, 'Nyan AI: count corrections applied');
                }
                
                if (pipelineResult.needsHumanReview) {
                    needsHumanReview = true;
                    unverifiable = pipelineResult.unverifiable || [];
                    logger.warn({ unverifiableCount: unverifiable.length }, 'Nyan AI: claims need human review');
                }
            }
            
            // S4: Executive Formatter - strip conversational filler for audit brevity
            answer = formatExecutiveResponse(answer);
            
            logger.info({ processingMs: processingTime, userId: req.userId }, 'Nyan AI Audit complete');
            
            // Discord logging via Idris
            if (idrisBot && idrisBot.isReady() && tenantSchema && bookContext) {
                try {
                    const tenantInfo = await pool.query(
                        `SELECT id, ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1`, 
                        [tenantSchema]
                    );
                    if (tenantInfo.rows.length > 0) {
                        const catalogId = tenantInfo.rows[0].id;
                        let threadId = tenantInfo.rows[0]?.ai_log_thread_id;
                        
                        if (!threadId) {
                            const tenantId = parseInt(tenantSchema.replace('tenant_', ''));
                            const threadInfo = await idrisBot.createAILogThread(tenantId, tenantSchema);
                            threadId = threadInfo.threadId;
                            await pool.query(
                                `UPDATE core.tenant_catalog SET ai_log_thread_id = $1, ai_log_channel_id = $2 WHERE id = $3`, 
                                [threadInfo.threadId, threadInfo.channelId, catalogId]
                            );
                        }
                        
                        const primaryBookName = bookContext.books[0]?.name || 'Unknown';
                        const bookNames = bookContext.books.map(b => b.name).join(', ');
                        await idrisBot.postAuditResult(threadId, {
                            status: 'NYAN',
                            confidence: null,
                            answer: answer,
                            reason: `Nyan AI response (${bookContext.totalMessages} messages analyzed)`,
                            data_extracted: { 
                                engine: 'nyan-ai',
                                model: _llm.model,
                                books: bookNames, 
                                query: query.substring(0, 100),
                                processingTime: processingTime
                            },
                            bookName: primaryBookName
                        }, query, primaryBookName);
                        
                        logger.info({ threadId }, 'Nyan AI Audit logged to Discord thread');
                    }
                } catch (discordError) {
                    logger.error({ err: discordError }, 'Failed to post Nyan AI audit to Discord');
                }
            }
            
            res.json({
                success: true,
                answer: answer,
                engine: 'nyan-ai',
                model: _llm.model,
                processingTime: processingTime,
                pipelineStatus: {
                    verified: pipelineVerified,
                    corrected: auditCorrected,
                    needsHumanReview: needsHumanReview
                },
                auditCorrected: auditCorrected,
                corrections: corrections.length > 0 ? corrections : undefined,
                needsHumanReview: needsHumanReview || undefined,
                unverifiable: unverifiable.length > 0 ? unverifiable : undefined,
                bookContext: bookContext ? {
                    bookCount: bookContext.bookCount,
                    totalMessages: bookContext.totalMessages,
                    books: bookContext.books
                } : null
            });
            
        } catch (error) {
            logger.error({ err: error }, 'Nyan AI Audit error');
            res.status(500).json({ 
                error: 'Failed to process audit query',
                message: error.message
            });
        }
    });

    // Discord audit history endpoint
    app.get('/api/nyan-ai/discord-history', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { limit = 50 } = req.query;
            const horusBot = bots?.horus;
            
            if (!tenantSchema) {
                return res.status(400).json({ error: 'Tenant context required' });
            }
            
            if (!horusBot || !horusBot.isReady()) {
                return res.status(503).json({ error: 'AI audit log reader not available' });
            }
            
            const tenantInfo = await pool.query(`
                SELECT ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1
            `, [tenantSchema]);
            
            const threadId = tenantInfo.rows[0]?.ai_log_thread_id;
            
            if (!threadId) {
                return res.json({ success: true, logs: [], message: 'No AI audit log thread exists yet' });
            }
            
            const logs = await horusBot.fetchAuditLogs(threadId, parseInt(limit));
            const stats = await horusBot.getAuditStats(threadId);
            
            res.json({
                success: true,
                logs,
                stats,
                thread_id: threadId
            });
        } catch (error) {
            logger.error({ err: error }, 'Discord history error');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/playground/usage', (req, res) => {
        try {
            const stats = usageTracker.getAllUsageStats();
            res.json(stats);
        } catch (error) {
            logger.error({ err: error }, 'Usage stats error');
            res.status(500).json({ error: 'Failed to get usage stats' });
        }
    });

    app.delete('/api/playground/nuke', (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;
        try {
            const { globalPackageStore } = require('../utils/data-package');
            const { clearMemory } = require('../utils/memory-manager');
            
            const pkgResult = globalPackageStore.nukeTenant(clientIp);
            clearMemory(clientIp);
            
            logger.info({ ip: clientIp }, 'NUKE: DataPackage + Memory cleared');
            res.json({ 
                success: true, 
                ...pkgResult, 
                memoryCleared: true,
                message: 'Session nuked - fresh start, full privacy' 
            });
        } catch (error) {
            logger.error({ err: error }, 'Nuke error');
            res.status(500).json({ error: 'Failed to nuke session' });
        }
    });

    app.post('/api/playground', async (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;
        
        capacityManager.recordActivity(clientIp);
        
        try {
            let { message, photo, audio, document, documentName, photos, audios, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
            let finalPrompt = message || '';
            let extractedContent = [];
            
            const responseFileHashes = [];
            
            if (zipData) {
                try {
                    const zipBuffer = Buffer.from(zipData, 'base64');
                    const zip = await JSZip.loadAsync(zipBuffer);
                    const manifestFile = zip.file('manifest.json');
                    
                    if (manifestFile) {
                        const manifestContent = await manifestFile.async('string');
                        const manifest = JSON.parse(manifestContent);
                        
                        photos = photos || [];
                        audios = audios || [];
                        documents = documents || [];
                        
                        for (const entry of manifest) {
                            const file = zip.file(entry.path);
                            if (file) {
                                const data = await file.async('base64');
                                const item = { name: entry.name, data, type: entry.type };
                                
                                if (entry.category === 'photo') photos.push(item);
                                else if (entry.category === 'audio') audios.push(item);
                                else if (entry.category === 'document') documents.push(item);
                            }
                        }
                    }
                } catch (zipError) {
                    logger.error({ err: zipError }, '❌ ZIP extraction error');
                }
            }
            
            const docList = [];
            if (documents && documents.length > 0) {
                docList.push(...documents.map(d => ({ name: d.name, data: d.data, type: d.type })));
            }
            if (document) {
                docList.push({ name: documentName || 'document', data: document, type: 'document' });
            }
            
            for (const doc of docList) {
                const fileHash = getDocumentHash(doc.data, doc.name);
                incrementDocumentUpload(fileHash);
                
                const cached = getCachedDocumentContext(fileHash, clientIp);
                if (cached && cached.extractedText) {
                    logger.debug({ name: doc.name }, '📂 Using cached document context');
                    extractedContent.push(cached.extractedText);
                    responseFileHashes.push({ name: doc.name, hash: fileHash });
                    continue;
                }
                
                try {
                    const { processDocumentForAI } = require('../utils/attachment-cascade');
                    // HARMONIZED: Pass tenantId for shared cache scoping
                    const result = await processDocumentForAI(doc.data, doc.name, doc.type, { tenantId: clientIp });
                    if (result && result.text) {
                        extractedContent.push(result.text);
                        setCachedDocumentContext(fileHash, { extractedText: result.text }, clientIp);
                        responseFileHashes.push({ name: doc.name, hash: fileHash });
                    }
                } catch (docError) {
                    logger.error({ name: doc.name, err: docError }, '❌ Document processing error');
                }
            }
            
            if (cachedFileHashes && Array.isArray(cachedFileHashes)) {
                for (const hashEntry of cachedFileHashes) {
                    const cached = getCachedDocumentByHash(hashEntry.hash, clientIp);
                    if (cached && cached.extractedText) {
                        logger.debug({ name: hashEntry.name }, '📂 Restored cached context');
                        extractedContent.push(cached.extractedText);
                    }
                }
            }
            
            const photoList = [];
            if (photos && Array.isArray(photos)) {
                photos.forEach((p, idx) => {
                    if (typeof p === 'string') {
                        photoList.push({ name: `photo-${idx}`, data: p, type: 'photo' });
                    } else if (p && p.data) {
                        photoList.push(p);
                    }
                });
            }
            if (photo) {
                photoList.push({ name: 'image', data: photo, type: 'image' });
            }
            
            const capacityCheck = await capacityManager.consumeToken(clientIp, photoList.length > 0 ? 'vision' : 'text');
            if (!capacityCheck.allowed) {
                return res.status(429).json({
                    error: capacityCheck.reason,
                    remaining: capacityCheck.remaining,
                    resetIn: capacityCheck.resetIn
                });
            }
            
            // L1 Perception Ingestion
            const perception = await AttachmentIngestion.ingest(docList, clientIp);
            
            const pipelineInput = {
                message: finalPrompt,
                photos: photoList,
                documents: docList,
                extractedContent: extractedContent, // Use locally populated array from document processing
                history: history || [],
                clientIp,
                isVisionRequest: photoList.length > 0,
                contextAttachments
            };
            
            const pipelineResult = await orchestrator.execute(pipelineInput);
            
            if (pipelineResult.success && pipelineResult.answer) {
                recordInMemory(
                    clientIp,
                    message || '',
                    pipelineResult.answer,
                    docList.length > 0 ? {
                        name: docList[0].name,
                        type: docList[0].type || 'document',
                        processedText: extractedContent.join('\n\n').slice(0, 2000),
                        shortSummary: `${docList.length} document(s): ${docList.map(d => d.name).join(', ')}`
                    } : null
                );
            }
            
            res.json({
                success: pipelineResult.success,
                response: pipelineResult.answer,
                badge: pipelineResult.badge,
                audit: pipelineResult.audit,
                fileHashes: responseFileHashes,
                processingTime: pipelineResult.processingTime
            });
            
        } catch (error) {
            logger.error({ err: error }, '❌ Playground error');
            res.status(500).json({ error: 'An error occurred. Please try again.' });
        }
    });

    const playgroundLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 15,
        validate: { xForwardedForHeader: false },
        handler: (req, res) => {
            logger.warn({ ip: req.ip }, '⚠️ Playground rate limit exceeded');
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Too many requests. Please wait a moment before trying again.' })}\n\n`);
            res.end();
        }
    });

    app.post('/api/playground/stream', playgroundLimiter, async (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;
        
        capacityManager.recordActivity(clientIp);
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        
        const isClientDisconnected = () => {
            return res.writableEnded || res.destroyed || !res.writable;
        };
        const sseStage = (event) => {
            if (!isClientDisconnected()) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        
        try {
            let { message, photo, photos, document, documentName, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
            let extractedContent = [];
            
            const responseFileHashes = [];
            
            if (zipData) {
                try {
                    const zipBuffer = Buffer.from(zipData, 'base64');
                    const zip = await JSZip.loadAsync(zipBuffer);
                    const manifestFile = zip.file('manifest.json');
                    
                    if (manifestFile) {
                        const manifestContent = await manifestFile.async('string');
                        const manifest = JSON.parse(manifestContent);
                        
                        photos = photos || [];
                        documents = documents || [];
                        
                        for (const entry of manifest) {
                            const file = zip.file(entry.path);
                            if (file) {
                                const data = await file.async('base64');
                                const item = { name: entry.name, data, type: entry.type };
                                
                                if (entry.category === 'photo') photos.push(item);
                                else if (entry.category === 'document') documents.push(item);
                            }
                        }
                    }
                } catch (zipError) {
                    logger.error({ err: zipError }, '❌ ZIP extraction error');
                }
            }
            
            const docList = [];
            if (documents && documents.length > 0) {
                docList.push(...documents.map(d => ({ name: d.name, data: d.data, type: d.type })));
            }
            if (document) {
                docList.push({ name: documentName || 'document', data: document, type: 'document' });
            }
            
            for (const doc of docList) {
                const fileHash = getDocumentHash(doc.data, doc.name);
                incrementDocumentUpload(fileHash);
                
                const cached = getCachedDocumentContext(fileHash, clientIp);
                if (cached && cached.extractedText) {
                    logger.debug({ name: doc.name }, '📂 Using cached document context');
                    extractedContent.push(cached.extractedText);
                    responseFileHashes.push({ name: doc.name, hash: fileHash });
                    continue;
                }
                
                try {
                    const { processDocumentForAI } = require('../utils/attachment-cascade');
                    // HARMONIZED: Pass tenantId for shared cache scoping
                    const result = await processDocumentForAI(doc.data, doc.name, doc.type, { tenantId: clientIp });
                    if (result && result.text) {
                        extractedContent.push(result.text);
                        setCachedDocumentContext(fileHash, { extractedText: result.text }, clientIp);
                        responseFileHashes.push({ name: doc.name, hash: fileHash });
                    }
                } catch (docError) {
                    logger.error({ name: doc.name, err: docError }, '❌ Document processing error');
                }
            }
            
            if (cachedFileHashes && Array.isArray(cachedFileHashes)) {
                for (const hashEntry of cachedFileHashes) {
                    const cached = getCachedDocumentByHash(hashEntry.hash, clientIp);
                    if (cached && cached.extractedText) {
                        logger.debug({ name: hashEntry.name }, '📂 Restored cached context');
                        extractedContent.push(cached.extractedText);
                    }
                }
            }
            
            const photoList = [];
            if (photos && Array.isArray(photos)) {
                photos.forEach((p, idx) => {
                    if (typeof p === 'string') {
                        photoList.push({ name: `photo-${idx}`, data: p, type: 'photo' });
                    } else if (p && p.data) {
                        photoList.push(p);
                    }
                });
            }
            if (photo) {
                photoList.push({ name: 'image', data: photo, type: 'image' });
            }
            
            const capacityCheck = await capacityManager.consumeToken(clientIp, photoList.length > 0 ? 'vision' : 'text');
            if (!capacityCheck.allowed) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: capacityCheck.reason })}\n\n`);
                res.end();
                return;
            }
            
            if (responseFileHashes.length > 0) {
                res.write(`data: ${JSON.stringify({ type: 'fileHashes', hashes: responseFileHashes })}\n\n`);
            }
            
            res.write(`data: ${JSON.stringify({ type: 'status', message: 'Processing...' })}\n\n`);
            
            // L1 Perception Ingestion
            const perception = await AttachmentIngestion.ingest(docList, clientIp);
            
            // ========================================
            // COMPOUND QUERY DETECTION
            // Split multi-intent messages into separate pipeline runs
            // e.g., "$SPY price? also what does this image say?" → 2 runs
            // ========================================
            const compoundParts = detectCompoundQuery(
                message || '',
                photoList.length > 0,
                docList.length > 0
            );
            
            if (compoundParts && compoundParts.length > 1) {
                logger.debug({ parts: compoundParts.length }, '🔀 Compound query: sub-queries detected');
                res.write(`data: ${JSON.stringify({ type: 'status', message: `Analyzing ${compoundParts.length} parts...` })}\n\n`);
                
                const sectionResults = [];
                let worstBadge = 'verified';
                let totalConfidence = 0;
                let anySearchRetry = false;
                
                for (let i = 0; i < compoundParts.length; i++) {
                    const part = compoundParts[i];
                    if (isClientDisconnected()) return;
                    
                    res.write(`data: ${JSON.stringify({ type: 'status', message: `Processing part ${i + 1}/${compoundParts.length}: ${part.label}...` })}\n\n`);
                    
                    const subInput = {
                        message: part.query,
                        photos: part.includePhotos ? photoList : [],
                        documents: part.includeDocuments ? docList : [],
                        extractedContent: part.includeDocuments ? extractedContent : 
                                          part.includePhotos ? [] : [],
                        history: history || [],
                        clientIp,
                        isVisionRequest: part.includePhotos && photoList.length > 0,
                        contextAttachments: part.includePhotos || part.includeDocuments ? contextAttachments : undefined,
                        streaming: true,
                        onStageChange: sseStage
                    };
                    
                    const subResult = await orchestrator.execute(subInput);
                    
                    if (subResult.success && subResult.answer) {
                        sectionResults.push({
                            label: part.label,
                            answer: subResult.answer,
                            badge: subResult.badge || 'unverified',
                            confidence: subResult.audit?.confidence || 0,
                            didSearchRetry: subResult.didSearchRetry || false,
                            passCount: subResult.passCount || 1,
                            fastPath: subResult.fastPath || false
                        });
                        
                        if (subResult.badge === 'unverified') worstBadge = 'unverified';
                        totalConfidence += (subResult.audit?.confidence || 0);
                        if (subResult.didSearchRetry) anySearchRetry = true;
                    } else {
                        sectionResults.push({
                            label: part.label,
                            answer: `*Could not process this part. Please try asking separately.*`,
                            badge: 'unverified',
                            confidence: 0,
                            didSearchRetry: false,
                            passCount: 0,
                            fastPath: false
                        });
                        worstBadge = 'unverified';
                    }
                }
                
                if (isClientDisconnected()) return;
                
                const mergedSections = sectionResults.map((section, i) => {
                    const num = i + 1;
                    const header = `## ${num}. ${section.label}`;
                    const separator = i < sectionResults.length - 1 ? '\n\n---\n\n' : '';
                    return `${header}\n\n${section.answer}${separator}`;
                }).join('');
                
                const avgConfidence = sectionResults.length > 0 
                    ? Math.round(totalConfidence / sectionResults.length) 
                    : 0;
                
                const mergedAudit = {
                    badge: worstBadge,
                    confidence: avgConfidence,
                    reason: `Compound query: ${sectionResults.length} sections processed`,
                    didSearchRetry: anySearchRetry,
                    passCount: sectionResults.reduce((sum, s) => sum + s.passCount, 0),
                    isCompound: true,
                    sectionCount: sectionResults.length
                };
                
                await fastStreamPersonality(res, mergedSections, mergedAudit);
                
                recordInMemory(
                    clientIp,
                    message || '',
                    mergedSections || '',
                    docList.length > 0 ? {
                        name: docList[0].name,
                        type: docList[0].type || 'document',
                        processedText: extractedContent.join('\n\n').slice(0, 2000),
                        shortSummary: `${docList.length} document(s): ${docList.map(d => d.name).join(', ')}`
                    } : null
                );
                
                logger.info({ ip: clientIp, badge: worstBadge, sections: sectionResults.length }, '🌊 Compound streaming complete');
            } else {
                // ========================================
                // SINGLE QUERY PATH (original behavior)
                // ========================================
                const pipelineInput = {
                    message: message || '',
                    photos: photoList,
                    documents: docList,
                    extractedContent: extractedContent,
                    history: history || [],
                    clientIp,
                    isVisionRequest: photoList.length > 0,
                    contextAttachments,
                    streaming: true,
                    onStageChange: sseStage
                };
                
                const pipelineResult = await orchestrator.execute(pipelineInput);
                
                if (isClientDisconnected()) return;
                
                if (!pipelineResult.success || !pipelineResult.answer) {
                    const failStep = pipelineResult.step || 'unknown';
                    const failReason = pipelineResult.error || 'Processing failed';
                    logger.error({ step: failStep, reason: failReason }, '❌ Pipeline failed');
                    const userMessage = failReason.includes('Groq API')
                        ? 'The AI service is temporarily busy. Please try again in a moment.'
                        : 'Something went wrong processing your request. Please try again.';
                    res.write(`data: ${JSON.stringify({ type: 'error', message: userMessage })}\n\n`);
                    res.end();
                    return;
                }
                
                const verifiedAnswer = pipelineResult.answer;
                const badge = pipelineResult.badge || 'unverified';
                const didSearchRetry = pipelineResult.didSearchRetry || false;
                
                const auditMetadata = {
                    badge,
                    confidence: pipelineResult.audit?.confidence || 0,
                    reason: pipelineResult.audit?.reason || '',
                    didSearchRetry,
                    passCount: pipelineResult.passCount || 1
                };
                
                if (pipelineResult.fastPath) {
                    logger.debug('⚡ Fast-path: Skipping personality pass (pre-crafted message)');
                    auditMetadata.passCount = 0;
                    res.write(`data: ${JSON.stringify({ type: 'audit', audit: auditMetadata })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'token', content: verifiedAnswer })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'done', fullContent: verifiedAnswer })}\n\n`);
                    res.end();
                } else if (badge === 'verified' || badge === 'unverified') {
                    if (isClientDisconnected()) return;
                    
                    await fastStreamPersonality(res, verifiedAnswer, auditMetadata);
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'audit', audit: auditMetadata })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'token', content: verifiedAnswer })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'done', fullContent: verifiedAnswer })}\n\n`);
                    res.end();
                }
                
                if (pipelineResult.success) {
                    recordInMemory(
                        clientIp,
                        message || '',
                        verifiedAnswer || '',
                        docList.length > 0 ? {
                            name: docList[0].name,
                            type: docList[0].type || 'document',
                            processedText: extractedContent.join('\n\n').slice(0, 2000),
                            shortSummary: `${docList.length} document(s): ${docList.map(d => d.name).join(', ')}`
                        } : null
                    );
                }
                
                logger.info({ ip: clientIp, badge, searchRetry: didSearchRetry }, '🌊 Streaming complete');
            }
            
        } catch (error) {
            logger.error({ err: error }, '❌ Streaming error');
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred. Please try again.' })}\n\n`);
            res.end();
        }
    });

    // ========================================================================
    // Nyan API v1 — Internal JSON endpoint for agent-to-agent communication
    // Usage: POST /api/v1/nyan { message, mode? }
    // Auth: Bearer token (multi-key: NYAN_OUTBOUND_API, NYAN_OUTBOUND_API_DEV)
    // ========================================================================
    const AI_API_KEYS = [
        { env: 'NYAN_OUTBOUND_API', label: 'prod' },
        { env: 'NYAN_OUTBOUND_API_DEV', label: 'dev' },
        { env: 'AI_API_TOKEN', label: 'prod-legacy' },
        { env: 'AI_API_TOKEN_DEV', label: 'dev-legacy' }
    ].filter(k => process.env[k.env]).map(k => ({
        hash: crypto.createHash('sha256').update(process.env[k.env]).digest(),
        label: k.label
    }));
    if (AI_API_KEYS.length > 0) {
        logger.info({ count: AI_API_KEYS.length, keys: AI_API_KEYS.map(k => k.label) }, '🔌 Nyan API v1: keys loaded');
    }

    const nyanApiLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        message: { error: 'Rate limit exceeded. Max 60 requests/minute.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    const express = require('express');
    const nyanApiBodyParser = express.json({ limit: '50mb' });

    app.post('/api/v1/nyan', nyanApiBodyParser, nyanApiLimiter, async (req, res) => {
        if (AI_API_KEYS.length === 0) {
            return res.status(503).json({ error: 'AI API not configured. Set NYAN_OUTBOUND_API secret.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }
        const providedToken = authHeader.slice(7);
        const providedHash = crypto.createHash('sha256').update(providedToken).digest();

        let matchedLabel = null;
        for (const key of AI_API_KEYS) {
            if (crypto.timingSafeEqual(key.hash, providedHash)) {
                matchedLabel = matchedLabel || key.label;
            }
        }
        if (!matchedLabel) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }

        const { message, mode, photos, documents } = req.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Missing or empty "message" field.' });
        }

        if (message.length > 4000) {
            return res.status(400).json({ error: 'Message too long. Max 4000 characters.' });
        }

        const photoList = [];
        if (photos && Array.isArray(photos)) {
            for (let i = 0; i < Math.min(photos.length, 5); i++) {
                const p = photos[i];
                const b64Data = typeof p === 'string' ? p : (p && p.data ? p.data : null);
                if (!b64Data) continue;
                const byteSize = Math.ceil(b64Data.length * 3 / 4);
                if (byteSize > 10 * 1024 * 1024) {
                    return res.status(413).json({ error: `Photo ${typeof p === 'string' ? i : (p.name || i)} exceeds 10MB limit (${(byteSize / 1024 / 1024).toFixed(1)}MB).` });
                }
                if (typeof p === 'string') {
                    photoList.push({ name: `photo-${i}`, data: p, type: 'photo' });
                } else {
                    photoList.push({ name: p.name || `photo-${i}`, data: p.data, type: p.type || 'photo' });
                }
            }
        }

        const docList = [];
        const extractedContent = [];
        if (documents && Array.isArray(documents)) {
            for (let i = 0; i < Math.min(documents.length, 5); i++) {
                const d = documents[i];
                if (d && d.data && d.name) {
                    const byteSize = Math.ceil(d.data.length * 3 / 4);
                    if (byteSize > 20 * 1024 * 1024) {
                        return res.status(413).json({ error: `Document "${d.name}" exceeds 20MB limit (${(byteSize / 1024 / 1024).toFixed(1)}MB).` });
                    }
                    docList.push({ name: d.name, data: d.data, type: d.type || 'document' });
                }
            }
        }

        const startTime = Date.now();
        const clientIp = req.ip || '127.0.0.1';

        function extractPsiEma(preflight) {
            if (!preflight?.psiEmaAnalysis) return null;
            const daily = preflight.psiEmaAnalysis;
            const weekly = preflight.psiEmaAnalysisWeekly;
            const result = {
                daily: {
                    reading: daily.reading,
                    emoji: daily.emoji,
                    theta: daily.theta,
                    z: daily.z,
                    R: daily.R,
                    fidelity: daily.fidelity
                }
            };
            if (weekly) {
                result.weekly = {
                    reading: weekly.reading,
                    emoji: weekly.emoji,
                    theta: weekly.theta,
                    z: weekly.z,
                    R: weekly.R,
                    fidelity: weekly.fidelity
                };
            }
            return result;
        }

        try {
            const mediaInfo = [];
            if (photoList.length > 0) mediaInfo.push(`${photoList.length} photo(s)`);
            if (docList.length > 0) mediaInfo.push(`${docList.length} doc(s)`);
            const mediaTag = mediaInfo.length > 0 ? ` [media=${mediaInfo.join(', ')}]` : '';
            logger.info({ message: message.slice(0, 80), mode: mode || 'auto', key: matchedLabel, media: mediaTag || null }, '🔌 Nyan API v1: query');

            for (const doc of docList) {
                try {
                    const fileHash = getDocumentHash(doc.data, doc.name);
                    incrementDocumentUpload(fileHash);
                    const cached = getCachedDocumentContext(fileHash, clientIp);
                    if (cached && cached.extractedText) {
                        extractedContent.push(cached.extractedText);
                        continue;
                    }
                    const { processDocumentForAI } = require('../utils/attachment-cascade');
                    const result = await processDocumentForAI(doc.data, doc.name, doc.type, { tenantId: clientIp });
                    if (result && result.text) {
                        extractedContent.push(result.text);
                        setCachedDocumentContext(fileHash, { extractedText: result.text }, clientIp);
                    }
                } catch (docError) {
                    logger.error({ name: doc.name, err: docError }, '❌ Nyan API v1: Document processing error');
                }
            }

            if (docList.length > 0) {
                await AttachmentIngestion.ingest(docList, clientIp);
            }

            let compoundParts = detectCompoundQuery(message.trim(), false, false);

            if (!compoundParts || compoundParts.length <= 1) {
                const trimmedMsg = message.trim();
                const tickerMatches = trimmedMsg.match(/\$[A-Z]{1,5}\b/g);
                const isComparison = /\b(compare|vs\.?|versus|correlation|relative|against|ratio|between)\b/i.test(trimmedMsg);
                if (tickerMatches && tickerMatches.length > 1 && !isComparison) {
                    const uniqueTickers = [...new Set(tickerMatches)];
                    if (uniqueTickers.length > 1) {
                        const baseQuery = trimmedMsg
                            .replace(/\$[A-Z]{1,5}\b/g, '')
                            .replace(/\b(and|,|&|also|plus)\b/gi, '')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (baseQuery.length > 0) {
                            compoundParts = uniqueTickers.slice(0, 5).map(ticker => ({
                                query: `${ticker} ${baseQuery}`,
                                label: ticker
                            }));
                        } else {
                            const { detectPsiEMAKeys } = require('../utils/stock-fetcher');
                            const hasPsiEmaIntent = detectPsiEMAKeys(trimmedMsg).shouldTrigger;
                            const suffix = hasPsiEmaIntent ? 'psi-ema' : 'analysis';
                            compoundParts = uniqueTickers.slice(0, 5).map(ticker => ({
                                query: `${ticker} ${suffix}`,
                                label: ticker
                            }));
                        }
                        logger.debug({ tickers: uniqueTickers }, '🔌 Nyan API v1: Multi-ticker split');
                    }
                }
            }

            if (compoundParts && compoundParts.length > 1) {
                logger.debug({ parts: compoundParts.length }, '🔌 Nyan API v1: Compound query');

                const sections = [];
                let worstBadge = 'verified';
                let totalConfidence = 0;

                for (let i = 0; i < compoundParts.length; i++) {
                    const part = compoundParts[i];
                    const subInput = {
                        message: part.query,
                        photos: [],
                        documents: [],
                        extractedContent: [],
                        history: [],
                        clientIp,
                        isVisionRequest: false
                    };

                    const subResult = await orchestrator.execute(subInput);

                    if (subResult.success && subResult.answer) {
                        const section = {
                            label: part.label,
                            response: subResult.answer,
                            mode: subResult.mode || 'general',
                            badge: subResult.badge || 'unverified',
                            confidence: subResult.audit?.confidence || 0
                        };
                        if (subResult.preflight?.ticker) section.ticker = subResult.preflight.ticker;
                        const psiEma = extractPsiEma(subResult.preflight);
                        if (psiEma) section.psiEma = psiEma;
                        sections.push(section);

                        if (subResult.badge === 'unverified') worstBadge = 'unverified';
                        totalConfidence += (subResult.audit?.confidence || 0);
                    } else {
                        sections.push({
                            label: part.label,
                            response: 'Could not process this part. Please try asking separately.',
                            mode: 'error',
                            badge: 'unverified',
                            confidence: 0
                        });
                        worstBadge = 'unverified';
                    }
                }

                const mergedResponse = sections.map((s, i) => {
                    const header = `## ${i + 1}. ${s.label}`;
                    const separator = i < sections.length - 1 ? '\n\n---\n\n' : '';
                    return `${header}\n\n${s.response}${separator}`;
                }).join('');

                const avgConfidence = sections.length > 0
                    ? Math.round(totalConfidence / sections.length)
                    : 0;

                logger.info({ sections: sections.length, processingMs: Date.now() - startTime }, '🔌 Nyan API v1: Compound complete');
                return res.json({
                    success: true,
                    response: mergedResponse,
                    mode: 'compound',
                    badge: worstBadge,
                    confidence: avgConfidence,
                    processingMs: Date.now() - startTime,
                    compound: true,
                    sections
                });
            }

            const pipelineInput = {
                message: message.trim(),
                photos: photoList,
                documents: docList,
                extractedContent,
                history: [],
                clientIp,
                isVisionRequest: photoList.length > 0
            };

            const pipelineResult = await orchestrator.execute(pipelineInput);

            if (!pipelineResult.success) {
                return res.status(500).json({
                    success: false,
                    error: pipelineResult.error || 'Pipeline processing failed',
                    step: pipelineResult.step
                });
            }

            const responseMode = pipelineResult.mode || 'general';
            const response = {
                success: true,
                response: pipelineResult.answer,
                mode: responseMode,
                source: pipelineResult.source || 'llm',
                badge: pipelineResult.badge || 'unverified',
                confidence: pipelineResult.audit?.confidence || 0,
                processingMs: Date.now() - startTime,
                units: API_UNITS[responseMode] || API_UNITS.common,
                audit: {
                    confidence: pipelineResult.audit?.confidence || 0,
                    verdict: pipelineResult.auditResult?.verdict || 'unknown',
                    passCount: pipelineResult.passCount || 0,
                    didSearchRetry: pipelineResult.didSearchRetry || false
                }
            };

            if (photoList.length > 0) response.vision = true;
            if (docList.length > 0) response.documentsProcessed = docList.length;

            const psiEma = extractPsiEma(pipelineResult.preflight);
            if (psiEma) {
                response.ticker = pipelineResult.preflight.ticker;
                response.psiEma = psiEma;
            }

            if (pipelineResult.preflight?.ticker && !response.ticker) {
                response.ticker = pipelineResult.preflight.ticker;
            }

            logger.info({ mode: response.mode, source: response.source, vision: !!response.vision, docs: response.documentsProcessed || 0, processingMs: response.processingMs }, '🔌 Nyan API v1: Complete');
            res.json(response);

        } catch (error) {
            logger.error({ err: error }, '❌ Nyan API v1 error');
            res.status(500).json({
                success: false,
                error: 'Internal processing error',
                processingMs: Date.now() - startTime
            });
        }
    });

    app.get('/api/v1/nyan/health', (req, res) => {
        res.json({
            status: 'ok',
            version: 'v1',
            modes: ['general', 'psi-ema', 'seed-metric', 'chemistry', 'legal', 'code-audit', 'forex'],
            media: {
                photos: { maxCount: 5, maxSizeMB: 10, formats: ['base64 jpeg/png/webp'] },
                documents: { maxCount: 5, maxSizeMB: 20, formats: ['pdf', 'xlsx', 'docx', 'csv', 'txt'] }
            },
            endpoints: {
                'POST /api/v1/nyan': 'LLM-powered query (general, psi-ema, legal, etc.)',
                'POST /api/v1/nyan/psi-ema': 'Data-only Psi-EMA (no LLM, pure calculation)',
                'GET /api/v1/nyan/health': 'This endpoint',
                'GET /api/v1/nyan/diagnostics': 'System diagnostics (DB, Groq, Discord, uptime)'
            },
            maxMessageChars: 4000,
            maxBodyMB: 50,
            timestamp: new Date().toISOString()
        });
    });

    // ========================================================================
    // POST /api/v1/nyan/psi-ema — Structured data-only endpoint (NO LLM)
    // Pure Ψ-EMA calculation: fetch stock → analyze → return numbers
    // Compatible with OpenClaw's formatPsiEMA() (dual format: psiEma.daily + psi_ema_daily)
    // ========================================================================
    const psiEmaLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        message: { error: 'Rate limit exceeded. Max 60 psi-ema requests/minute.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.post('/api/v1/nyan/psi-ema', express.json(), psiEmaLimiter, async (req, res) => {
        if (AI_API_KEYS.length === 0) {
            return res.status(503).json({ error: 'AI API not configured. Set NYAN_OUTBOUND_API secret.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }
        const providedToken = authHeader.slice(7);
        const providedHash = crypto.createHash('sha256').update(providedToken).digest();

        let matchedLabel = null;
        for (const key of AI_API_KEYS) {
            if (crypto.timingSafeEqual(key.hash, providedHash)) {
                matchedLabel = matchedLabel || key.label;
            }
        }
        if (!matchedLabel) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }

        const { ticker, tickers } = req.body || {};
        const tickerList = tickers || (ticker ? [ticker] : []);

        if (!tickerList.length || tickerList.length === 0) {
            return res.status(400).json({ error: 'Missing "ticker" (string) or "tickers" (array) field.' });
        }
        if (tickerList.length > 5) {
            return res.status(400).json({ error: 'Max 5 tickers per request.' });
        }

        for (const t of tickerList) {
            if (typeof t !== 'string' || !sanitizeTicker(t)) {
                return res.status(400).json({ error: `Invalid ticker: "${t}". Use 1-5 uppercase letters.` });
            }
        }

        const startTime = Date.now();
        logger.info({ tickers: tickerList, key: matchedLabel }, '📊 Psi-EMA data endpoint');

        const results = {};

        for (const rawTicker of tickerList) {
            const safeTicker = sanitizeTicker(rawTicker);
            const tickerStart = Date.now();

            try {
                const stockData = await fetchStockPrices(safeTicker);

                const dailyClosesRaw = stockData?.daily?.closes || stockData?.closes || [];
                const dailyCloses = dailyClosesRaw.filter(v => v != null && !isNaN(v));

                if (dailyCloses.length < 3) {
                    results[safeTicker] = { error: 'Insufficient price data', bars: dailyCloses.length };
                    continue;
                }

                const dailyDashboard = new PsiEMADashboard();
                const dailyAnalysis = dailyDashboard.analyze({ stocks: dailyCloses });

                const dailyReading = dailyAnalysis.reading || {};
                const dailyPhase = dailyAnalysis.dimensions?.phase || {};
                const dailyAnomaly = dailyAnalysis.dimensions?.anomaly || {};
                const dailyConvergence = dailyAnalysis.dimensions?.convergence || {};
                const dailyFidelity = dailyAnalysis.fidelity || {};

                const daily = {
                    theta: dailyPhase.current ?? null,
                    z: dailyAnomaly.current ?? null,
                    R: dailyConvergence.currentDisplay ?? dailyConvergence.current ?? null,
                    reading: dailyReading.reading || dailyAnalysis.summary?.reading || null,
                    emoji: dailyReading.emoji || dailyAnalysis.summary?.readingEmoji || null,
                    description: dailyReading.description || null,
                    fidelity: dailyFidelity.breakdown || null,
                    regime: dailyAnalysis.summary?.regime || null,
                    bars: dailyCloses.length
                };

                let weekly = null;
                const weeklyClosesRaw = stockData?.weekly?.closes || [];
                const weeklyCloses = weeklyClosesRaw.filter(v => v != null && !isNaN(v));

                if (weeklyCloses.length >= 13) {
                    const weeklyDashboard = new PsiEMADashboard();
                    const weeklyAnalysis = weeklyDashboard.analyze({ stocks: weeklyCloses });

                    const weeklyReading = weeklyAnalysis.reading || {};
                    const weeklyPhase = weeklyAnalysis.dimensions?.phase || {};
                    const weeklyAnomaly = weeklyAnalysis.dimensions?.anomaly || {};
                    const weeklyConvergence = weeklyAnalysis.dimensions?.convergence || {};
                    const weeklyFidelity = weeklyAnalysis.fidelity || {};

                    weekly = {
                        theta: weeklyPhase.current ?? null,
                        z: weeklyAnomaly.current ?? null,
                        R: weeklyConvergence.currentDisplay ?? weeklyConvergence.current ?? null,
                        reading: weeklyReading.reading || weeklyAnalysis.summary?.reading || null,
                        emoji: weeklyReading.emoji || weeklyAnalysis.summary?.readingEmoji || null,
                        description: weeklyReading.description || null,
                        fidelity: weeklyFidelity.breakdown || null,
                        regime: weeklyAnalysis.summary?.regime || null,
                        bars: weeklyCloses.length
                    };
                }

                const fundamentals = stockData.fundamentals || {};
                const dataAge = calculateDataAge(stockData.daily?.endDate || stockData.endDate);

                results[safeTicker] = {
                    ticker: safeTicker,
                    name: stockData.name || safeTicker,
                    currentPrice: stockData.currentPrice || null,
                    currency: stockData.currency || 'USD',
                    sector: fundamentals.sector || null,
                    industry: fundamentals.industry || null,
                    pe: fundamentals.peRatio || null,
                    forwardPE: fundamentals.forwardPE || null,
                    marketCap: fundamentals.marketCap || null,
                    dataAge: dataAge,
                    psiEma: { daily, weekly },
                    psi_ema_daily: daily,
                    psi_ema_weekly: weekly,
                    processingMs: Date.now() - tickerStart
                };

                logger.info({ ticker: safeTicker, reading: daily.reading, emoji: daily.emoji, processingMs: Date.now() - tickerStart }, '📊 Psi-EMA result');

            } catch (fetchError) {
                logger.error({ ticker: safeTicker, err: fetchError }, '📊 Psi-EMA error');
                results[safeTicker] = {
                    ticker: safeTicker,
                    error: fetchError.message,
                    processingMs: Date.now() - tickerStart
                };
            }
        }

        const isSingle = tickerList.length === 1;
        const singleResult = isSingle ? results[tickerList[0].toUpperCase()] || results[sanitizeTicker(tickerList[0])] : null;

        res.json({
            success: true,
            mode: 'psi-ema',
            source: 'atomic:psi-ema',
            version: 'vφ⁴',
            units: API_UNITS['psi-ema'],
            ...(isSingle ? singleResult : { results }),
            processingMs: Date.now() - startTime,
            timestamp: new Date().toISOString()
        });
    });

    // ========================================================================
    // GET /api/v1/nyan/diagnostics — System health diagnostics
    // DB, Groq, Discord bots, uptime, memory, API key count
    // ========================================================================
    const hermesBot = bots?.hermes;
    const horusBot = bots?.horus;

    app.get('/api/v1/nyan/diagnostics', async (req, res) => {
        if (AI_API_KEYS.length === 0) {
            return res.status(503).json({ error: 'AI API not configured. Set NYAN_OUTBOUND_API secret.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }
        const providedToken = authHeader.slice(7);
        const providedHash = crypto.createHash('sha256').update(providedToken).digest();

        let matchedLabel = null;
        for (const key of AI_API_KEYS) {
            if (crypto.timingSafeEqual(key.hash, providedHash)) {
                matchedLabel = matchedLabel || key.label;
            }
        }
        if (!matchedLabel) {
            return res.status(401).json({ error: 'Unauthorized. Provide valid Bearer token.' });
        }

        const startTime = Date.now();
        const diagnostics = {
            status: 'ok',
            version: 'v1',
            uptime: {
                seconds: Math.floor(process.uptime()),
                human: formatUptime(process.uptime())
            },
            memory: {
                rss: formatBytes(process.memoryUsage().rss),
                heapUsed: formatBytes(process.memoryUsage().heapUsed),
                heapTotal: formatBytes(process.memoryUsage().heapTotal),
                external: formatBytes(process.memoryUsage().external)
            },
            apiKeys: {
                loaded: AI_API_KEYS.length,
                labels: AI_API_KEYS.map(k => k.label)
            },
            database: {
                healthy: false,
                latency: null,
                pool: null,
                error: null
            },
            groq: {
                configured: false,
                keys: {
                    dashboard: !!config.ai.dashboardAiKey,
                    playground: !!config.ai.groqToken,
                    vision: !!config.ai.groqVisionToken
                }
            },
            discord: {
                hermes: { role: 'Thread Creator (φ)', status: 'not_initialized', healthy: false },
                thoth: { role: 'Message Reader (0)', status: 'not_initialized', healthy: false },
                idris: { role: 'AI Audit Scribe (ι)', status: 'not_initialized', healthy: false },
                horus: { role: 'AI Audit Watcher (Ω)', status: 'not_initialized', healthy: false }
            },
            twilio: {
                configured: !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_ACCOUNT_SID
            },
            playground: {
                capacity: capacityManager ? {
                    currentSlots: capacityManager.getCurrentSlotCount?.() ?? null,
                    maxSlots: capacityManager.maxSlots ?? null
                } : null
            }
        };

        try {
            const dbStart = Date.now();
            await pool.query('SELECT 1 as health');
            diagnostics.database.healthy = true;
            diagnostics.database.latency = `${Date.now() - dbStart}ms`;
            diagnostics.database.pool = {
                total: pool.totalCount || 0,
                idle: pool.idleCount || 0,
                waiting: pool.waitingCount || 0
            };
        } catch (dbErr) {
            diagnostics.database.error = dbErr.message;
        }

        diagnostics.groq.configured = !!(config.ai.dashboardAiKey || config.ai.groqToken);

        if (hermesBot) {
            diagnostics.discord.hermes.healthy = hermesBot.isReady?.() || false;
            diagnostics.discord.hermes.status = diagnostics.discord.hermes.healthy ? 'ready' : 'disconnected';
        }
        if (thothBot) {
            diagnostics.discord.thoth.healthy = thothBot.ready || false;
            diagnostics.discord.thoth.status = diagnostics.discord.thoth.healthy ? 'ready' : 'disconnected';
        }
        if (idrisBot) {
            diagnostics.discord.idris.healthy = idrisBot.isReady?.() || false;
            diagnostics.discord.idris.status = diagnostics.discord.idris.healthy ? 'ready' : 'disconnected';
        }
        if (horusBot) {
            diagnostics.discord.horus.healthy = horusBot.isReady?.() || false;
            diagnostics.discord.horus.status = diagnostics.discord.horus.healthy ? 'ready' : 'disconnected';
        }

        const allDiscordHealthy = ['hermes', 'thoth', 'idris', 'horus'].every(
            b => diagnostics.discord[b].healthy || diagnostics.discord[b].status === 'not_initialized'
        );

        diagnostics.status = diagnostics.database.healthy && diagnostics.groq.configured
            ? (allDiscordHealthy ? 'healthy' : 'degraded')
            : 'unhealthy';

        diagnostics.processingMs = Date.now() - startTime;
        diagnostics.timestamp = new Date().toISOString();

        const statusCode = diagnostics.status === 'healthy' ? 200 : (diagnostics.status === 'degraded' ? 200 : 503);
        res.status(statusCode).json(diagnostics);
    });

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
    registerNyanAIRoutes,
    capacityManager,
    usageTracker,
    isIdentityQuery,
    containsNotFoundClaim,
    searchDuckDuckGo,
    searchBrave,
    extractCoreQuestion,
    groqWithRetry
};
