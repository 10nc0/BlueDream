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
            pipelineCheckpoint: globalCheckpointStore.getStats()
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
