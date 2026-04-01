const axios = require('axios');
const rateLimit = require('express-rate-limit');
const logger = require('../../lib/logger');
const { resolveAIToken, groqWithRetry } = require('../../utils/groq-client');
const { AI_MODELS, getLLMBackend, AUDIT } = require('../../config/constants');
const { buildAuditContext } = require('../../utils/audit-context');
const { runDashboardAuditPipeline } = require('../../utils/dashboard-audit-pipeline');
const { formatExecutiveResponse } = require('../../utils/executive-formatter');
const { buildExecutiveAuditPrompt, buildRetryPrompt } = require('../../prompts/executive-audit');
const { runMonthlyClosing } = require('../../lib/monthly-closing');

// In-flight guard — prevents the same user from firing two identical audit
// calls simultaneously (double-click, retry while pending, etc.).
// Keyed by userId + sorted bookIds. Cleared when the request completes.
const auditInFlight = new Set();

const _llm = getLLMBackend();

function registerAuditRoutes(app, deps) {
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

        // Double-run guard — same user + same bookIds already in flight
        const flightKey = `${req.userId}:${(Array.isArray(bookIds) ? [...bookIds].sort() : []).join(',')}`;
        if (auditInFlight.has(flightKey)) {
            logger.warn({ userId: req.userId, flightKey }, '⚠️ Audit already in progress, rejecting duplicate');
            return res.status(409).json({ error: 'Audit already in progress for these books. Please wait for it to complete.' });
        }
        auditInFlight.add(flightKey);

        logger.info({ userId: req.userId, bookCount: bookIds?.length || 0 }, 'Nyan AI Audit query');

        try {
            let bookContext = null;
            let contextPrompt = '';

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
                    const langLine = bookContext.langComposition
                        ? `\nLanguage distribution: ${bookContext.langComposition.summary}`
                        : '';

                    const messagesText = bookContext.recentMessages
                        .map(m => {
                            const date = m.timestamp.split('T')[0];
                            const langTag = m.lang ? ` [${m.lang}]` : '';
                            return `[${m.bookName}] ${date}${langTag}: ${m.content}`;
                        })
                        .join('\n');

                    contextPrompt = `
You have access to the user's book data from their Nyanbook ledger.

BOOKS IN CONTEXT (${bookContext.bookCount} book(s), ${bookContext.totalMessages} total messages):
${bookSummary}${langLine}
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

            const response = await groqWithRetry({
                url: _llm.url,
                data: {
                    model: _llm.model,
                    messages: [
                        { role: 'system', content: buildExecutiveAuditPrompt(language, bookContext?.langComposition) },
                        { role: 'user', content: contextPrompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 4096
                },
                config: {
                    headers: {
                        'Authorization': `Bearer ${resolveAIToken('audit')}`,
                        'Content-Type': 'application/json'
                    }
                }
            });

            let answer = response.data?.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
            const processingTime = Date.now() - startTime;

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
                                { role: 'system', content: buildRetryPrompt() },
                                { role: 'user', content: retryPrompt }
                            ],
                            temperature: options.temperature || 0.1,
                            max_tokens: 4096
                        },
                        config: {
                            headers: {
                                'Authorization': `Bearer ${resolveAIToken('audit')}`,
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

            answer = formatExecutiveResponse(answer);

            logger.info({ processingMs: processingTime, userId: req.userId }, 'Nyan AI Audit complete');

            if (idrisBot && idrisBot.isReady() && tenantSchema && bookContext) {
                try {
                    const tenantInfo = await pool.query(
                        `SELECT id, ai_log_thread_id, audit_mirror_thread_id, audit_mirror_webhook_url FROM core.tenant_catalog WHERE tenant_schema = $1`,
                        [tenantSchema]
                    );
                    if (tenantInfo.rows.length > 0) {
                        const catalogId = tenantInfo.rows[0].id;
                        let threadId = tenantInfo.rows[0]?.ai_log_thread_id;
                        const mirrorThreadId = tenantInfo.rows[0]?.audit_mirror_thread_id;
                        const mirrorWebhookUrl = tenantInfo.rows[0]?.audit_mirror_webhook_url;

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
                        const auditPayload = {
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
                        };
                        await idrisBot.postAuditResult(threadId, auditPayload, query, primaryBookName);
                        logger.info({ threadId }, 'Nyan AI Audit logged to Discord thread');

                        if (mirrorWebhookUrl) {
                            try {
                                const isDiscordMirror = /discord\.com\/api\/webhooks\//.test(mirrorWebhookUrl);
                                if (isDiscordMirror) {
                                    const mirrorUrl = mirrorThreadId ? `${mirrorWebhookUrl}${mirrorWebhookUrl.includes('?') ? '&' : '?'}thread_id=${mirrorThreadId}` : mirrorWebhookUrl;
                                    await axios.post(mirrorUrl, {
                                        embeds: [{
                                            title: `${auditPayload.status === 'NYAN' ? '🐱' : '📝'} Audit Mirror`,
                                            color: idrisBot.getStatusColor(auditPayload.status),
                                            fields: [
                                                { name: '📝 Query', value: query.length > 200 ? query.substring(0, 200) + '...' : query, inline: false },
                                                { name: '💬 Answer', value: (auditPayload.answer || '').length > 500 ? auditPayload.answer.substring(0, 500) + '...' : (auditPayload.answer || 'No answer'), inline: false },
                                                { name: '📚 Book', value: primaryBookName, inline: true }
                                            ],
                                            timestamp: new Date().toISOString()
                                        }]
                                    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
                                } else {
                                    const webhookHost = new URL(mirrorWebhookUrl).hostname;
                                    const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd|fe80)/i;
                                    if (blockedPatterns.test(webhookHost)) {
                                        logger.warn({ host: webhookHost }, 'Audit mirror blocked: private/reserved address');
                                    } else {
                                        await axios.post(mirrorWebhookUrl, {
                                            event: 'audit_result',
                                            timestamp: new Date().toISOString(),
                                            query: query,
                                            answer: auditPayload.answer,
                                            status: auditPayload.status,
                                            confidence: auditPayload.confidence,
                                            book: primaryBookName,
                                            engine: auditPayload.data_extracted?.engine,
                                            model: auditPayload.data_extracted?.model
                                        }, {
                                            headers: { 'Content-Type': 'application/json' },
                                            timeout: 10000,
                                            maxRedirects: 0
                                        });
                                    }
                                }
                                logger.info({ mirrorUrl: mirrorWebhookUrl.substring(0, 60), isDiscord: isDiscordMirror }, 'Nyan AI Audit mirrored');
                            } catch (mirrorErr) {
                                logger.warn({ mirrorUrl: mirrorWebhookUrl.substring(0, 60), err: mirrorErr.message }, 'Audit mirror post failed');
                            }
                        } else if (mirrorThreadId) {
                            try {
                                await idrisBot.postAuditResult(mirrorThreadId, auditPayload, query, primaryBookName);
                                logger.info({ mirrorThreadId }, 'Nyan AI Audit mirrored to legacy thread');
                            } catch (mirrorErr) {
                                logger.warn({ mirrorThreadId, err: mirrorErr.message }, 'Legacy audit mirror post failed');
                            }
                        }
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
        } finally {
            auditInFlight.delete(flightKey);
        }
    });

    // Manual monthly closing trigger — admin only.
    // POST /api/nyan-ai/monthly-closing?month=YYYY-MM&force=true
    app.post('/api/nyan-ai/monthly-closing', requireAuth, async (req, res) => {
        if (req.userRole !== 'admin' && req.userRole !== 'dev') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const overrideMonth = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
            ? req.query.month
            : null;
        const force = req.query.force === 'true';

        logger.info({ userId: req.userId, overrideMonth, force }, '📊 Manual monthly closing trigger');

        try {
            const result = await runMonthlyClosing(pool, bots, { overrideMonth, force });
            res.json({ success: true, result });
        } catch (err) {
            logger.error({ err }, '📊 Manual monthly closing failed');
            res.status(500).json({ error: 'Monthly closing failed', message: err.message });
        }
    });

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

            res.json({ success: true, logs, stats, thread_id: threadId });
        } catch (error) {
            logger.error({ err: error }, 'Discord history error');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/nyan-ai/audit-mirror', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            if (!tenantSchema) return res.status(400).json({ error: 'Tenant context required' });
            const result = await pool.query(
                `SELECT audit_mirror_thread_id, audit_mirror_webhook_url FROM core.tenant_catalog WHERE tenant_schema = $1`,
                [tenantSchema]
            );
            const row = result.rows[0] || {};
            res.json({
                audit_mirror_thread_id: row.audit_mirror_thread_id || null,
                audit_mirror_webhook_url: row.audit_mirror_webhook_url || null,
                legacy_thread_only: !row.audit_mirror_webhook_url && !!row.audit_mirror_thread_id
            });
        } catch (error) {
            logger.error({ err: error }, 'Audit mirror config fetch error');
            res.status(500).json({ error: 'Failed to fetch audit mirror config' });
        }
    });

    app.post('/api/nyan-ai/audit-mirror', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            if (!tenantSchema) return res.status(400).json({ error: 'Tenant context required' });
            const { webhook_url } = req.body;
            if (!webhook_url || !/^https?:\/\/.+/.test(webhook_url)) {
                return res.status(400).json({ error: 'Valid webhook URL required (https://...)' });
            }
            const isDiscordWebhook = /discord\.com\/api\/webhooks\//.test(webhook_url);
            let threadId = null;
            if (isDiscordWebhook) {
                const threadMatch = webhook_url.match(/thread_id=(\d+)/);
                threadId = threadMatch ? threadMatch[1] : null;
            }
            await pool.query(
                `UPDATE core.tenant_catalog SET audit_mirror_webhook_url = $1, audit_mirror_thread_id = $2 WHERE tenant_schema = $3`,
                [webhook_url, threadId, tenantSchema]
            );
            logger.info({ tenantSchema, webhookUrl: webhook_url.substring(0, 60), isDiscord: isDiscordWebhook }, 'Audit mirror configured');
            res.json({ success: true, audit_mirror_webhook_url: webhook_url });
        } catch (error) {
            logger.error({ err: error }, 'Audit mirror config save error');
            res.status(500).json({ error: 'Failed to save audit mirror config' });
        }
    });

    app.delete('/api/nyan-ai/audit-mirror', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            if (!tenantSchema) return res.status(400).json({ error: 'Tenant context required' });
            await pool.query(
                `UPDATE core.tenant_catalog SET audit_mirror_webhook_url = NULL, audit_mirror_thread_id = NULL, audit_mirror_channel_id = NULL WHERE tenant_schema = $1`,
                [tenantSchema]
            );
            logger.info({ tenantSchema }, 'Audit mirror removed');
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Audit mirror config delete error');
            res.status(500).json({ error: 'Failed to remove audit mirror config' });
        }
    });
}

module.exports = { registerAuditRoutes };
