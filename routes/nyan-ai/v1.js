const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger, orchestrator, executeCompoundQuery, API_UNITS, formatUptime, formatBytes } = require('./shared');
const { extractPsiEma, extractPsiEmaFromAnalysis, splitMultiTicker } = require('../../utils/psi-ema-extract');
const { processAndCacheDocList } = require('../../utils/doc-cache');
const { AttachmentIngestion } = require('../../utils/attachment-ingestion');
const { PsiEMADashboard } = require('../../utils/psi-EMA');
const { fetchStockPrices, calculateDataAge, sanitizeTicker } = require('../../utils/stock-fetcher');
const { detectCompoundQuery } = require('../../utils/preflight-router');
const { globalCheckpointStore } = require('../../utils/pipeline-checkpoint');
const { getLastBackupStatus } = require('../../lib/backup');
const { config } = require('../../config');
const capacityManager = require('../../utils/playground-capacity');

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

function authenticateApiKey(req) {
    if (AI_API_KEYS.length === 0) return { error: 503, message: 'AI API not configured. Set NYAN_OUTBOUND_API secret.' };
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { error: 401, message: 'Unauthorized. Provide valid Bearer token.' };
    const providedToken = authHeader.slice(7);
    const providedHash = crypto.createHash('sha256').update(providedToken).digest();
    let matchedLabel = null;
    for (const key of AI_API_KEYS) {
        if (crypto.timingSafeEqual(key.hash, providedHash)) {
            matchedLabel = matchedLabel || key.label;
        }
    }
    if (!matchedLabel) return { error: 401, message: 'Unauthorized. Provide valid Bearer token.' };
    return { label: matchedLabel };
}

const nyanApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Rate limit exceeded. Max 60 requests/minute.' },
    standardHeaders: true,
    legacyHeaders: false
});

const psiEmaLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Rate limit exceeded. Max 60 psi-ema requests/minute.' },
    standardHeaders: true,
    legacyHeaders: false
});

const nyanApiBodyParser = express.json({ limit: '50mb' });

function registerV1Routes(app, deps) {
    const { pool, bots } = deps;
    const thothBot = bots?.thoth;
    const idrisBot = bots?.idris;
    const hermesBot = bots?.hermes;
    const horusBot = bots?.horus;

    app.post('/api/v1/nyan', nyanApiBodyParser, nyanApiLimiter, async (req, res) => {
        const auth = authenticateApiKey(req);
        if (auth.error) return res.status(auth.error).json({ error: auth.message });
        const matchedLabel = auth.label;

        const { message, mode, photos, documents, byok } = req.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Missing or empty "message" field.' });
        }

        if (message.length > 4000) {
            return res.status(400).json({ error: 'Message too long. Max 4000 characters.' });
        }

        // BYOK Watchtower: optional caller-supplied model credentials.
        // Their key drives S2 (reasoning); NyanBook's auditToken drives S3 (verify).
        // base_url must be https — no local/private-network SSRF risk.
        let byokToken = null, byokModel = null, byokUrl = null;
        if (byok && typeof byok === 'object') {
            if (!byok.api_key || typeof byok.api_key !== 'string' || !byok.api_key.trim()) {
                return res.status(400).json({ error: 'byok.api_key must be a non-empty string.' });
            }
            if (!byok.model || typeof byok.model !== 'string' || !byok.model.trim()) {
                return res.status(400).json({ error: 'byok.model must be a non-empty string.' });
            }
            if (byok.base_url && !/^https:\/\//i.test(byok.base_url.trim())) {
                return res.status(400).json({ error: 'byok.base_url must start with https://.' });
            }
            byokToken = byok.api_key.trim();
            byokModel = byok.model.trim();
            byokUrl   = byok.base_url ? byok.base_url.trim() : null;
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

        try {
            const mediaInfo = [];
            if (photoList.length > 0) mediaInfo.push(`${photoList.length} photo(s)`);
            if (docList.length > 0) mediaInfo.push(`${docList.length} doc(s)`);
            const mediaTag = mediaInfo.length > 0 ? ` [media=${mediaInfo.join(', ')}]` : '';
            logger.info({ message: message.slice(0, 80), mode: mode || 'auto', key: matchedLabel, media: mediaTag || null }, '🔌 Nyan API v1: query');

            await processAndCacheDocList(docList, null, clientIp, extractedContent, []);

            if (docList.length > 0) {
                await AttachmentIngestion.ingest(docList, clientIp);
            }

            let compoundParts = detectCompoundQuery(message.trim(), false, false);

            if (!compoundParts || compoundParts.length <= 1) {
                const tickerParts = splitMultiTicker(message);
                if (tickerParts) {
                    compoundParts = tickerParts;
                    logger.debug({ tickers: tickerParts.map(p => p.label) }, '🔌 Nyan API v1: Multi-ticker split');
                }
            }

            if (compoundParts && compoundParts.length > 1) {
                logger.debug({ parts: compoundParts.length }, '🔌 Nyan API v1: Compound query');

                const compound = await executeCompoundQuery(compoundParts, {
                    extractedContent: [], photoList: [], docList: [], history: [], clientIp
                });

                logger.info({ sections: compound.sections.length, processingMs: Date.now() - startTime }, '🔌 Nyan API v1: Compound complete');
                return res.json({
                    success: true,
                    response: compound.mergedAnswer,
                    mode: 'compound',
                    badge: compound.worstBadge,
                    confidence: compound.avgConfidence,
                    processingMs: Date.now() - startTime,
                    compound: true,
                    sections: compound.sections
                });
            }

            const pipelineInput = {
                message: message.trim(),
                photos: photoList,
                documents: docList,
                extractedContent,
                history: [],
                clientIp,
                isVisionRequest: photoList.length > 0,
                // BYOK Watchtower — present only when caller supplied byok block
                ...(byokToken ? { byokToken, byokModel, byokUrl } : {})
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
            const confidence = pipelineResult.audit?.confidence ?? null;
            const response = {
                success: true,
                response: pipelineResult.answer,
                mode: responseMode,
                source: pipelineResult.source || 'llm',
                badge: pipelineResult.badge || 'unverified',
                confidence,
                processingMs: Date.now() - startTime,
                units: API_UNITS[responseMode] || API_UNITS.common,
                audit: {
                    confidence,
                    verdict: pipelineResult.auditResult?.verdict || 'unknown',
                    passCount: pipelineResult.passCount || 0,
                    didSearchRetry: pipelineResult.didSearchRetry || false
                }
            };

            if (photoList.length > 0) response.vision = true;
            if (docList.length > 0) response.documentsProcessed = docList.length;

            // BYOK Watchtower: flag that caller's key was used for reasoning.
            // When audit didn't fully approve, expose the raw draft so the agent
            // can see exactly what NyanBook caught and corrected.
            if (byokToken) {
                response.byok_used = true;
                if (response.badge !== 'verified') {
                    response.draft = pipelineResult.draftAnswer || null;
                }
            }

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

    app.get('/api/v1/nyan/guide', (req, res) => {
        res.json({
            name: 'Nyan AI API',
            version: 'v1',
            description: 'LLM-powered query API with built-in web search, audit verification, and optional BYOK (Bring Your Own Key) watchtower mode.',
            base_url: `https://${process.env.APP_DOMAIN || req.hostname}`,

            auth: {
                type: 'Bearer token',
                header: 'Authorization: Bearer <token>',
                note: 'Token must match NYAN_OUTBOUND_API or NYAN_OUTBOUND_API_DEV configured on the server. No token required for /health or /guide.'
            },

            rate_limits: {
                default: '60 requests/minute per IP',
                psi_ema: '60 requests/minute per IP'
            },

            endpoints: [
                {
                    method: 'POST',
                    path: '/api/v1/nyan',
                    auth_required: true,
                    description: 'Submit a query to the full AI pipeline. Runs preflight routing, optional web search, LLM reasoning, and a two-pass audit. Returns a single JSON response.',
                    request: {
                        content_type: 'application/json',
                        max_body_mb: 50,
                        fields: {
                            message: { type: 'string', required: true, max_chars: 4000, description: 'Your query or instruction.' },
                            photos: { type: 'array<base64_string|{name,data}>', required: false, max_count: 5, max_size_mb_each: 10, formats: ['jpeg', 'png', 'webp'], description: 'Images for vision analysis.' },
                            documents: { type: 'array<{name,data,type}>', required: false, max_count: 5, max_size_mb_each: 20, formats: ['pdf', 'xlsx', 'docx', 'csv', 'txt'], description: 'Documents to parse and include in context.' },
                            byok: {
                                type: 'object', required: false,
                                description: 'BYOK Watchtower — your model key handles S2 reasoning, NyanBook\'s key always handles S3 audit verification.',
                                fields: {
                                    api_key:  { type: 'string', required: true,  description: 'Your LLM provider API key.' },
                                    model:    { type: 'string', required: true,  description: 'Model ID (e.g. "llama-3.3-70b-versatile").' },
                                    base_url: { type: 'string', required: false, description: 'Provider base URL. Must start with https://. Defaults to Groq endpoint.' }
                                }
                            }
                        }
                    },
                    response: {
                        success: {
                            success: true,
                            response: 'string — final verified answer',
                            mode: 'string — detected query mode (see modes below)',
                            source: 'string — "llm" | "search" | "atomic:*"',
                            badge: 'string — "verified" | "fixable" | "unverified" | "rejected"',
                            confidence: 'number|null — audit confidence 0–1',
                            processingMs: 'number',
                            audit: { confidence: 'number|null', verdict: 'string', passCount: 'number', didSearchRetry: 'boolean' },
                            byok_used: 'boolean — present only when byok block was supplied',
                            draft: 'string|null — original answer before correction; present only when byok_used=true and badge≠verified',
                            ticker: 'string — present for psi-ema / forex queries',
                            psiEma: 'object — Psi-EMA analysis; present for psi-ema queries',
                            vision: 'boolean — present when photos were submitted',
                            documentsProcessed: 'number — present when documents were submitted'
                        },
                        error: { success: false, error: 'string', step: 'string|undefined' }
                    },
                    examples: [
                        {
                            label: 'General query',
                            request: { message: 'What is the current inflation rate in Singapore?' },
                            response_shape: { success: true, response: '...', mode: 'general', badge: 'verified' }
                        },
                        {
                            label: 'Seed metric (property affordability)',
                            request: { message: 'seed metric london singapore tokyo' },
                            response_shape: { success: true, response: '...', mode: 'seed-metric', badge: 'verified' }
                        },
                        {
                            label: 'BYOK Watchtower',
                            request: {
                                message: 'What is the seed metric for Singapore?',
                                byok: { api_key: 'gsk_...', model: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1' }
                            },
                            response_shape: { success: true, response: '...', byok_used: true, badge: 'verified' }
                        }
                    ]
                },
                {
                    method: 'POST',
                    path: '/api/v1/nyan/psi-ema',
                    auth_required: true,
                    description: 'Pure Psi-EMA calculation — no LLM, no web search. Returns technical analysis (θ, z-score, R-ratio) for one or more stock tickers.',
                    request: {
                        fields: {
                            ticker:  { type: 'string',          required: false, description: 'Single ticker (e.g. "AAPL").' },
                            tickers: { type: 'array<string>',   required: false, max_count: 5, description: 'Multiple tickers. Use ticker OR tickers, not both.' }
                        }
                    },
                    response: {
                        success: { success: true, mode: 'psi-ema', ticker: 'string', currentPrice: 'number', psiEma: { daily: 'object', weekly: 'object|null' }, processingMs: 'number' }
                    },
                    examples: [
                        { label: 'Single ticker', request: { ticker: 'AAPL' } },
                        { label: 'Multiple tickers', request: { tickers: ['AAPL', 'MSFT', 'NVDA'] } }
                    ]
                },
                {
                    method: 'POST',
                    path: '/api/webhook/:fractalId',
                    auth_required: true,
                    auth_note: 'Bearer token scoped to a specific book (agent_token from book settings). Token must match the book referenced in the URL.',
                    description: 'Write a message into a specific book. Accepts text, an HTTPS media URL, or base64 documents/photos. All fields except text are optional. Enqueues durably; returns immediately.',
                    request: {
                        content_type: 'application/json',
                        max_body_mb: 50,
                        fields: {
                            text:       { type: 'string', required: false, max_chars: 10000, description: 'Message body.' },
                            username:   { type: 'string', required: false, max: 100, description: 'Display name for the sender. Defaults to "External".' },
                            media_url:  { type: 'string', required: false, description: 'HTTPS URL of an existing hosted file. Cannot be a data: URI — use documents[] or photos[] for base64 instead.' },
                            media_type: { type: 'string', required: false, description: 'MIME type of the media_url attachment (e.g. "application/pdf"). Optional — server derives from URL extension if omitted.' },
                            photos:     { type: 'array<base64_string|{name,data}>', required: false, max_count: 5, max_size_mb_each: 10, description: 'Base64-encoded images. No external hosting needed.' },
                            documents:  { type: 'array<{name,data,type}>', required: false, max_count: 5, max_size_mb_each: 20, formats: ['pdf', 'xlsx', 'docx', 'csv', 'txt'], description: 'Base64-encoded documents. Text is extracted and appended to the message body. No external hosting needed.' },
                            phone:      { type: 'string', required: false, description: 'E.164 phone number (display only, not used for routing).' },
                            email:      { type: 'string', required: false, description: 'Email address (display only).' }
                        }
                    },
                    response: { success: true, message: 'Message accepted' },
                    examples: [
                        {
                            label: 'Text only',
                            request: { text: 'Session checkpoint — context saved.' }
                        },
                        {
                            label: 'PDF document (base64, no external hosting needed)',
                            request: {
                                text: 'Attaching build report',
                                documents: [{ name: 'report.pdf', data: '<base64>', type: 'pdf' }]
                            }
                        },
                        {
                            label: 'Photo snapshot',
                            request: {
                                text: 'Screenshot of current state',
                                photos: [{ name: 'screenshot.png', data: '<base64>' }]
                            }
                        }
                    ]
                },
                {
                    method: 'POST',
                    path: '/api/agent/message',
                    auth_required: true,
                    auth_note: 'Bearer token resolves the target book automatically — no fractal_id in URL. One token = one book.',
                    description: 'Token-only write endpoint. Same payload contract as POST /api/webhook/:fractalId but the book is resolved from the token, not the URL. Preferred for agents that hold a single token.',
                    request: { description: 'Identical to POST /api/webhook/:fractalId — see above.' },
                    response: { success: true, message: 'Message accepted', book_id: 'string — resolved book fractal_id' }
                },
                {
                    method: 'GET',
                    path: '/api/webhook/:fractalId/messages',
                    auth_required: true,
                    auth_note: 'Same bearer token scoped to the book. Token must match the book in the URL.',
                    description: 'Read messages from a book. Returns newest-first with pagination cursors.',
                    request: {
                        query_params: {
                            limit:  { type: 'integer', default: 50, max: 100, description: 'Number of messages to return.' },
                            after:  { type: 'ISO8601 timestamp', description: 'Return messages after this time (exclusive). Cannot combine with before.' },
                            before: { type: 'ISO8601 timestamp', description: 'Return messages before this time (exclusive). Cannot combine with after.' }
                        }
                    },
                    response: {
                        book: 'string', book_id: 'string',
                        messages: 'array<{id, sender, text, timestamp, has_media, media_ipfs_cid, media_ipfs_gateway_url, media_url}>',
                        total: 'number', hasMore: 'boolean',
                        cursor: { newest: 'ISO8601|null', oldest: 'ISO8601|null' }
                    }
                },
                {
                    method: 'GET',
                    path: '/api/agent/messages',
                    auth_required: true,
                    auth_note: 'Bearer token resolves the book automatically.',
                    description: 'Token-only read endpoint. Same response shape as GET /api/webhook/:fractalId/messages but the book is resolved from the token.',
                    request: { description: 'Same query params as GET /api/webhook/:fractalId/messages.' }
                },
                {
                    method: 'POST',
                    path: '/api/agent/bootstrap',
                    auth_required: false,
                    auth_note: 'Each entry in books[] carries its own bearer token. No shared Authorization header needed.',
                    description: 'Spore Protocol — multi-book cold-start bootstrap. Agent supplies up to 20 bearer tokens and receives a structured memory export per book in one round-trip. Designed for agent cold-start, scheduled re-sync, and context hand-offs between agent instances.',
                    rate_limit: '20 requests/minute per IP (dedicated limiter, independent of other pipe endpoints)',
                    request: {
                        content_type: 'application/json',
                        fields: {
                            books: {
                                type: 'array',
                                required: true,
                                max_items: 20,
                                description: 'List of book fetch specs. Order is preserved in the response.',
                                item_fields: {
                                    token:  { type: 'string', required: true,  description: 'Agent bearer token for this book.' },
                                    limit:  { type: 'integer', required: false, default: 50, max: 200, description: 'Max messages to return for this book.' },
                                    since:  { type: 'ISO8601 timestamp', required: false, description: 'Return only messages after this time (exclusive cursor for pagination).' }
                                }
                            }
                        }
                    },
                    response: {
                        bootstrap_at: 'ISO8601 — server timestamp when the response was assembled',
                        total_books:  'integer — number of books successfully resolved (excludes error slots)',
                        books: 'array — one entry per input token, in request order. Valid book slots contain:',
                        book_slot_valid: {
                            token_index:  'integer — position in the request books[] array',
                            fractal_id:   'string — unique book identifier',
                            title:        'string|null — book display name',
                            tags:         'string[] — tenant-assigned tags',
                            stats: {
                                message_count:   'integer',
                                last_message_at: 'ISO8601|null'
                            },
                            messages: 'array<{ id, body, sender, sent_at, has_attachment, media_url }> — newest-first, up to limit'
                        },
                        book_slot_error: {
                            token_index: 'integer',
                            error:       '"invalid_token" | "query_failed"'
                        }
                    },
                    errors: {
                        400: 'books is not a non-empty array, too many entries (>20), invalid limit, or invalid since format.',
                        401: 'No token in any books[] entry resolved to an active book.',
                        429: 'Rate limit exceeded (20 bootstrap req/min per IP).'
                    },
                    examples: [
                        {
                            label: 'Cold-start re-hydration across two books',
                            curl: [
                                'curl -X POST https://YOUR_DOMAIN/api/agent/bootstrap \\',
                                '  -H "Content-Type: application/json" \\',
                                '  -d \'{"books":[',
                                '    {"token":"<token_A>","limit":50},',
                                '    {"token":"<token_B>","limit":20,"since":"2026-01-01T00:00:00.000Z"}',
                                '  ]}\''
                            ].join('\n'),
                            response_shape: {
                                bootstrap_at: '2026-05-24T09:00:00.000Z',
                                total_books: 2,
                                books: [
                                    { token_index: 0, fractal_id: 'book_t1_...', title: 'Alpha Book', tags: ['vehicle'], stats: { message_count: 42, last_message_at: '...' }, messages: ['...'] },
                                    { token_index: 1, fractal_id: 'book_t2_...', title: 'Beta Book',  tags: [],          stats: { message_count: 7,  last_message_at: null }, messages: [] }
                                ]
                            }
                        },
                        {
                            label: 'Mixed valid + invalid tokens — invalid slot does not fail others',
                            response_shape: {
                                bootstrap_at: '2026-05-24T09:00:01.000Z',
                                total_books: 1,
                                books: [
                                    { token_index: 0, error: 'invalid_token' },
                                    { token_index: 1, fractal_id: 'book_t2_...', title: 'My Book', tags: [], stats: { message_count: 3, last_message_at: '...' }, messages: ['...'] }
                                ]
                            }
                        }
                    ]
                },
                {
                    method: 'GET',
                    path: '/api/v1/nyan/health',
                    auth_required: false,
                    description: 'Quick liveness check. Returns server status, supported modes, and endpoint list.'
                },
                {
                    method: 'GET',
                    path: '/api/v1/nyan/guide',
                    auth_required: false,
                    description: 'This document. Full API reference for agents and integrators.'
                },
                {
                    method: 'GET',
                    path: '/api/v1/nyan/diagnostics',
                    auth_required: true,
                    description: 'System diagnostics — DB health, LLM provider status, Discord bots, memory, uptime.'
                }
            ],

            modes: {
                general:      'Open-ended questions, news, science, history, current events. Triggers real-time web search when needed.',
                'seed-metric': 'Property affordability index — price/sqm, income, years-to-own for one or more cities. Include city names in query.',
                'psi-ema':    'Stock technical analysis (Psi-EMA θ/z/R). Include a ticker symbol in query or use the dedicated /psi-ema endpoint for raw data.',
                forex:        'Currency conversion and exchange rate queries.',
                legal:        'Legal analysis and contract interpretation. Activates legal reasoning guardrails.',
                chemistry:    'Chemistry, pharmacology, and molecular analysis.',
                'code-audit': 'Code review, security analysis, and debugging.'
            },

            badges: {
                verified:   'Audit passed — answer confirmed against sources or logic.',
                fixable:    'Audit found issues and applied corrections. Final answer is the corrected version.',
                unverified: 'Audit could not confirm or deny — answer delivered as-is.',
                rejected:   'Answer was rejected after max retries. Response may be a refusal or best-effort fallback.'
            },

            errors: {
                400: 'Invalid request — missing required field, field too long, or bad byok block.',
                401: 'Missing or invalid Bearer token.',
                429: 'Rate limit exceeded (60 req/min). Retry after 60 seconds.',
                500: 'Internal pipeline error — retry safe.',
                503: 'Server busy (message queue full). Retry after a short delay.'
            },

            byok_watchtower: {
                summary: 'Supply your own LLM key for the reasoning pass. NyanBook always runs the audit pass on its own key.',
                flow: ['S2 Reasoning → your key + your model', 'S3 Audit → NyanBook key (always)', 'Response includes byok_used:true', 'If badge≠verified, response includes draft (your model\'s original answer before correction)'],
                supported_providers: ['Groq (https://api.groq.com/openai/v1)', 'OpenRouter (https://openrouter.ai/api/v1)', 'OpenAI (https://api.openai.com/v1)', 'Any OpenAI-compatible endpoint over https://']
            },

            changelog: [
                { version: 'v1.3', date: '2026-05', change: 'Spore Protocol — POST /api/agent/bootstrap for multi-book cold-start re-hydration' },
                { version: 'v1.2', date: '2026-05', change: 'BYOK Watchtower — optional byok block on POST /api/v1/nyan' },
                { version: 'v1.1', date: '2026-04', change: 'Psi-EMA dedicated endpoint, compound query support' },
                { version: 'v1.0', date: '2026-01', change: 'Initial API release' }
            ],

            generated_at: new Date().toISOString()
        });
    });

    app.post('/api/v1/nyan/psi-ema', express.json(), psiEmaLimiter, async (req, res) => {
        const auth = authenticateApiKey(req);
        if (auth.error) return res.status(auth.error).json({ error: auth.message });
        const matchedLabel = auth.label;

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
                const daily = { ...extractPsiEmaFromAnalysis(dailyAnalysis), bars: dailyCloses.length };

                let weekly = null;
                const weeklyClosesRaw = stockData?.weekly?.closes || [];
                const weeklyCloses = weeklyClosesRaw.filter(v => v != null && !isNaN(v));

                if (weeklyCloses.length >= 13) {
                    const weeklyDashboard = new PsiEMADashboard();
                    const weeklyAnalysis = weeklyDashboard.analyze({ stocks: weeklyCloses });
                    weekly = { ...extractPsiEmaFromAnalysis(weeklyAnalysis), bars: weeklyCloses.length };
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

    app.get('/api/v1/nyan/diagnostics', async (req, res) => {
        const auth = authenticateApiKey(req);
        if (auth.error) return res.status(auth.error).json({ error: auth.message });

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
            database: { healthy: false, latency: null, pool: null, error: null },
            groq: {
                configured: false,
                keys: {
                    dashboard: !!config.ai.dashboardAiKey,
                    playground: !!config.ai.groqToken,
                    vision: !!config.ai.groqVisionToken
                },
                fallback: {
                    openrouter: !!process.env.OPENROUTER_API_KEY,
                    ollama: !!process.env.OLLAMA_BASE_URL,
                    // ollamaBase is intentionally omitted — exposes internal host/IP
                    ollamaModel: process.env.OLLAMA_MODEL || null,
                }
            },
            discord: {
                hermes: { role: 'Thread Creator (φ)', status: 'not_initialized', healthy: false },
                thoth: { role: 'Message Reader (0)', status: 'not_initialized', healthy: false },
                idris: { role: 'AI Audit Scribe (ι)', status: 'not_initialized', healthy: false },
                horus: { role: 'AI Audit Watcher (Ω)', status: 'not_initialized', healthy: false }
            },
            twilio: { configured: !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_ACCOUNT_SID },
            playground: {
                capacity: capacityManager ? {
                    currentSlots: capacityManager.getCurrentSlotCount?.() ?? null,
                    maxSlots: capacityManager.maxSlots ?? null
                } : null
            },
            pipelineCheckpoint: globalCheckpointStore.getStats(),
            backup: getLastBackupStatus()
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

        // Any configured AI provider (Groq, OpenRouter, or Ollama) marks the system as healthy
        diagnostics.groq.configured = !!(
            config.ai.dashboardAiKey ||
            config.ai.groqToken ||
            process.env.OPENROUTER_API_KEY ||
            process.env.OLLAMA_BASE_URL
        );

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

module.exports = { registerV1Routes };
