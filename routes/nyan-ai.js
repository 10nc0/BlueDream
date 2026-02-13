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
const { AI_MODELS } = require('../config/constants');

const PLAYGROUND_GROQ_TOKEN = process.env.PLAYGROUND_GROQ_TOKEN;
const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_GROQ_TOKEN;
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
            console.log(`📂 Session Cache HIT: "${fileHash.substring(0, 16)}..." for ${clientIp}`);
            return sessionCached;
        }
        if (sessionCached) {
            sessionDocumentCache.delete(sessionKey);
        }
    }
    
    const globalCached = globalDocumentCache.get(fileHash);
    if (globalCached && now - globalCached.timestamp < GLOBAL_DOC_TTL) {
        console.log(`📂 Global Cache HIT: "${fileHash.substring(0, 16)}..." (age: ${Math.round((now - globalCached.timestamp) / 60000)}min)`);
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
        console.log(`📂 Session Cache SET: "${fileHash.substring(0, 16)}..." for ${clientIp}`);
        
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
        console.log(`📂 Global Cache SET: "${fileHash.substring(0, 16)}..." (${uploadCount} uploads)`);
        
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
        console.log(`📂 Cache cleanup: ${sessionEvicted} session + ${globalEvicted} global entries evicted`);
    }
}, 10 * 60 * 1000);

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
            console.log(`🔍 DDG: Non-JSON response for "${sanitizedQuery.substring(0, 40)}..." - skipping`);
            return null;
        }
        
        const context = [];
        if (data.AbstractText) {
            context.push(`📚 ${data.AbstractText}`);
            console.log(`🔍 DDG: Found instant answer for "${sanitizedQuery.substring(0, 40)}..."`);
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
            console.log(`🔍 DDG: Injecting ${context.length} search results into prompt`);
            return context.join('\n');
        } else {
            console.log(`🔍 DDG: No results found for "${sanitizedQuery.substring(0, 40)}..." - using base knowledge only`);
            return null;
        }
    } catch (err) {
        console.error('🔍 DDG search error:', err.message);
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
    
    const GROQ_TOKEN = process.env.PLAYGROUND_GROQ_TOKEN;
    if (!GROQ_TOKEN || trimmed.length < 100) {
        return trimmed.substring(0, 200);
    }
    
    const isNyanProtocol = /\{money|city|land price|empire|collapse|extinction|inequality|φ|cycle|breath\}/i.test(message) ||
        /price.*income|land.*afford|fertility|700.*m²|housing.*cost/i.test(message);
    
    try {
        console.log(`🧠 Extracting core question from ${message.length} char message...`);
        const systemPrompt = isNyanProtocol 
            ? 'Extract the core question about land price, housing affordability, or city cost. Include "50 years ago" or "historical" to get comparative data. Return ONLY a short search query (max 30 words). No explanation.'
            : 'Extract the core question or topic from the user message. Return ONLY a short search query (max 25 words) that captures what they want to know. No explanation, just the query.';
        
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
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
                timeout: 3000
            }
        );
        
        const extractedQuery = response.data?.choices?.[0]?.message?.content?.trim();
        if (extractedQuery && extractedQuery.length > 3) {
            console.log(`🧠 Extracted query: "${extractedQuery}"`);
            if (isNyanProtocol && !extractedQuery.toLowerCase().includes('ago') && !extractedQuery.toLowerCase().includes('historical')) {
                const enhancedQuery = extractedQuery + ' vs 50 years ago';
                console.log(`🧠 Enhanced with historical: "${enhancedQuery}"`);
                return enhancedQuery;
            }
            return extractedQuery;
        }
        return message.substring(0, 200);
    } catch (err) {
        console.error('🧠 Query extraction error:', err.message);
        return message.substring(0, 200);
    }
}

async function searchBrave(query, clientIp = null) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return null;
    }
    const sanitizedQuery = query.trim().substring(0, 500);
    
    const BRAVE_API_KEY = process.env.PLAYGROUND_BRAVE_API;
    if (!BRAVE_API_KEY) {
        console.log('🦁 Brave: API key not configured, skipping');
        return null;
    }
    
    if (clientIp) {
        const braveCapacity = await capacityManager.consumeToken(clientIp, 'brave');
        if (!braveCapacity.allowed) {
            console.log(`🦁 Brave: Capacity exhausted for ${clientIp} - ${braveCapacity.reason}`);
            return null;
        }
    }
    
    try {
        console.log(`🦁 Brave: Searching for real-time context: "${sanitizedQuery.substring(0, 40)}..."`);
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
            console.log(`🦁 Brave: No results found for "${sanitizedQuery.substring(0, 40)}..."`);
            return null;
        }
        
        const context = results.slice(0, 5).map((r, i) => 
            `${i + 1}. ${r.title || 'Untitled'}\n   ${r.description || ''}`
        ).join('\n\n');
        
        console.log(`🦁 Brave: Found ${results.length} results, injecting top 5 into prompt`);
        return `🌐 Web search results:\n${context}`;
    } catch (err) {
        console.error('🦁 Brave search error:', err.message);
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
            
            console.log(`🔴 Groq Error (attempt ${attempt + 1}/${maxRetries + 1}):`);
            console.log(`   Status: ${status}`);
            console.log(`   x-ratelimit-limit-requests: ${headers['x-ratelimit-limit-requests'] || 'N/A'}`);
            console.log(`   x-ratelimit-remaining-requests: ${headers['x-ratelimit-remaining-requests'] || 'N/A'}`);
            console.log(`   retry-after: ${headers['retry-after'] || 'N/A'}`);
            console.log(`   Error body: ${JSON.stringify(errorBody) || 'N/A'}`);
            
            const promptTokensEstimate = axiosConfig.data?.messages 
                ? JSON.stringify(axiosConfig.data.messages).length / 4 
                : 'unknown';
            console.log(`   Prompt size estimate: ~${Math.round(promptTokensEstimate)} tokens`);
            
            if (status === 429 && attempt < maxRetries) {
                const retryAfter = headers['retry-after'];
                const delayMs = retryAfter 
                    ? parseInt(retryAfter) * 1000 
                    : Math.min(1000 * Math.pow(2, attempt), 8000);
                console.log(`⏳ Groq 429: Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

const orchestrator = createPipelineOrchestrator({
    groqToken: process.env.PLAYGROUND_GROQ_TOKEN,
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

    app.post('/api/nyan-ai/audit', requireAuth, async (req, res) => {
        const { query, bookIds, language } = req.body;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userRole = req.userRole;
        const startTime = Date.now();
        
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return res.status(400).json({ error: 'Query is required' });
        }
        
        console.log(`🌈 Nyan AI Audit: User ${req.userId} querying ${bookIds?.length || 0} book(s)`);
        
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
            
            // Use GROQ_API_KEY for authenticated audit (separate from public playground)
            const response = await groqWithRetry({
                url: 'https://api.groq.com/openai/v1/chat/completions',
                data: {
                    model: 'llama-3.3-70b-versatile',
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
                        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
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
                        url: 'https://api.groq.com/openai/v1/chat/completions',
                        data: {
                            model: 'llama-3.3-70b-versatile',
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
                                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
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
                    console.log(`🔧 Nyan AI: ${corrections.length} count corrections (${pipelineResult.correctionMethod}), +${pipelineResult.latencyMs}ms`);
                }
                
                if (pipelineResult.needsHumanReview) {
                    needsHumanReview = true;
                    unverifiable = pipelineResult.unverifiable || [];
                    console.log(`⚠️ Nyan AI: ${unverifiable.length} claims need human review`);
                }
            }
            
            // S4: Executive Formatter - strip conversational filler for audit brevity
            answer = formatExecutiveResponse(answer);
            
            console.log(`✅ Nyan AI Audit complete in ${processingTime}ms for user ${req.userId}`);
            
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
                                model: 'llama-3.3-70b-versatile',
                                books: bookNames, 
                                query: query.substring(0, 100),
                                processingTime: processingTime
                            },
                            bookName: primaryBookName
                        }, query, primaryBookName);
                        
                        console.log(`📜 Nyan AI Audit logged to Discord thread ${threadId}`);
                    }
                } catch (discordError) {
                    console.error('⚠️ Failed to post Nyan AI audit to Discord:', discordError.message);
                }
            }
            
            res.json({
                success: true,
                answer: answer,
                engine: 'nyan-ai',
                model: 'llama-3.3-70b-versatile',
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
            console.error('❌ Nyan AI Audit error:', error.message);
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
            console.error('❌ Discord history error:', error);
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/playground/usage', (req, res) => {
        try {
            const stats = usageTracker.getAllUsageStats();
            res.json(stats);
        } catch (error) {
            console.error('❌ Usage stats error:', error.message);
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
            
            console.log(`🗑️ NUKE endpoint: DataPackage + Memory cleared for ${clientIp}`);
            res.json({ 
                success: true, 
                ...pkgResult, 
                memoryCleared: true,
                message: 'Session nuked - fresh start, full privacy' 
            });
        } catch (error) {
            console.error('❌ Nuke error:', error.message);
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
                    console.error('❌ ZIP extraction error:', zipError.message);
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
                    console.log(`📂 Using cached document context for ${doc.name}`);
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
                    console.error(`❌ Document processing error for ${doc.name}:`, docError.message);
                }
            }
            
            if (cachedFileHashes && Array.isArray(cachedFileHashes)) {
                for (const hashEntry of cachedFileHashes) {
                    const cached = getCachedDocumentByHash(hashEntry.hash, clientIp);
                    if (cached && cached.extractedText) {
                        console.log(`📂 Restored cached context for ${hashEntry.name}`);
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
            console.error('❌ Playground error:', error.message);
            res.status(500).json({ error: 'An error occurred. Please try again.' });
        }
    });

    const playgroundLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 15,
        validate: { xForwardedForHeader: false },
        handler: (req, res) => {
            console.warn(`⚠️ Playground rate limit exceeded - IP: ${req.ip}`);
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
                    console.error('❌ ZIP extraction error:', zipError.message);
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
                    console.log(`📂 Using cached document context for ${doc.name}`);
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
                    console.error(`❌ Document processing error for ${doc.name}:`, docError.message);
                }
            }
            
            if (cachedFileHashes && Array.isArray(cachedFileHashes)) {
                for (const hashEntry of cachedFileHashes) {
                    const cached = getCachedDocumentByHash(hashEntry.hash, clientIp);
                    if (cached && cached.extractedText) {
                        console.log(`📂 Restored cached context for ${hashEntry.name}`);
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
                console.log(`🔀 Compound query: ${compoundParts.length} sub-queries detected`);
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
                        streaming: true
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
                
                console.log(`🌊 Compound streaming complete for ${clientIp} [${worstBadge}] (${sectionResults.length} sections)`);
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
                    streaming: true
                };
                
                const pipelineResult = await orchestrator.execute(pipelineInput);
                
                if (isClientDisconnected()) return;
                
                if (!pipelineResult.success || !pipelineResult.answer) {
                    const failStep = pipelineResult.step || 'unknown';
                    const failReason = pipelineResult.error || 'Processing failed';
                    console.error(`❌ Pipeline failed at ${failStep}: ${failReason}`);
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
                    console.log(`⚡ Fast-path: Skipping personality pass (pre-crafted message)`);
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
                
                console.log(`🌊 Streaming complete for ${clientIp} [${badge}]${didSearchRetry ? ' [+search retry]' : ''}`);
            }
            
        } catch (error) {
            console.error('❌ Streaming error:', error.message);
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred. Please try again.' })}\n\n`);
            res.end();
        }
    });

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
