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
const { getTemporalContext, DEFAULT_TZ } = require('../../utils/temporal-resolver');
const capacity = require('../../utils/ai-capacity');
const visual = require('../../utils/multimodal-book-audit');
const originals = require('../../utils/book-evidence');

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
        const { query, bookIds = [], language, includeImages = false, sourceLimit = 100 } = req.body;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userRole = req.userRole;
        const startTime = Date.now();

        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return res.status(400).json({ error: 'Query is required' });
        }
        if (typeof includeImages !== 'boolean') return res.status(400).json({ error: 'includeImages must be a boolean.' });
        if (!Number.isInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > 100)
            return res.status(400).json({ error: 'sourceLimit must be between 1 and 100.' });
        if (query.length > 4000 || !Array.isArray(bookIds) || bookIds.length > 20 ||
            bookIds.some(id => !['string', 'number'].includes(typeof id))) {
            return res.status(400).json({ error: 'Use a query under 4000 characters and at most 20 selected books.' });
        }
        if (!tenantSchema) return res.status(403).json({ error: 'Tenant context required.' });

        // Double-run guard — same user + same bookIds already in flight
        const flightKey = `${tenantSchema}:${req.userId}:${includeImages}:${[...bookIds].sort().join(',')}`;
        if (auditInFlight.has(flightKey)) {
            logger.warn({ userId: req.userId, flightKey }, '⚠️ Audit already in progress, rejecting duplicate');
            return res.status(409).json({ error: 'Audit already in progress for these books. Please wait for it to complete.' });
        }
        auditInFlight.add(flightKey);

        logger.info({ userId: req.userId, bookCount: bookIds?.length || 0 }, 'Nyan AI Audit query');

        // Temporal anchor for this request. One `now` is captured at the top
        // and reused by the audit context builder, the verifier, and the LLM
        // prompt — so all three resolve "kemarin / bulan lalu / YTD / …"
        // against the same wall-clock + timezone. Future per-tenant TZ
        // overrides should populate `auditTz` from the tenant catalog.
        const auditTz = DEFAULT_TZ;
        const auditNow = new Date();
        const temporalContext = getTemporalContext({ now: auditNow, tz: auditTz });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const closed = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', closed);
        const requestContext = capacity.context.getStore();
        if (requestContext) Object.assign(requestContext, { audit: true, deadline: Date.now() + 60000, signal: controller.signal });
        let imageAudit = visual.textOnly();
        let prepared;
        let resultKey;
        const globalAccess = req.userRole === 'dev' && req.tenantContext?.globalAccess === true;

        try {
            // Revalidate even before returning a cached response.
            const authorizedBooks = [];
            for (const bookId of bookIds) authorizedBooks.push(await originals.authorizedBook(pool, tenantSchema, bookId, { globalAccess }));
            if (includeImages) visual.settings(); // Explicit unavailable error, no silent text-only substitution.
            resultKey = capacity.hash(JSON.stringify([tenantSchema, req.userId, [...bookIds].map(String).sort(), query.trim(), language || '', includeImages, sourceLimit]));
            const cached = await capacity.auditKey(resultKey);
            if (cached) return res.json({ ...cached, reused: true });
            await capacity.admission(includeImages ? 'vision' : 'text');
            if (includeImages) await capacity.reserveAuditEnvelope(visual.settings().pricing);
            let bookContext = null;
            let contextPrompt = '';

            if (bookIds && Array.isArray(bookIds) && bookIds.length > 0) {
                bookContext = await buildAuditContext(bookIds, tenantSchema, query, {
                    pool,
                    thothBot,
                    userRole,
                    maxMessages: AUDIT.MAX_MESSAGES,
                    now: auditNow,
                    tz: auditTz,
                    includeImages,
                    maxScanMessages: sourceLimit,
                    authorizedSchemas: authorizedBooks.map(book => book.tenantSchema)
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

            if (bookContext?.discoveryLimited) contextPrompt += '\nCOVERAGE LIMIT: Only a bounded recent/search-selected sample was read. Do not claim complete-book counts or totals.';
            if (includeImages) {
                if (!bookIds.length) throw Object.assign(new Error('Select a book before enabling images.'), { status: 400 });
                prepared = await visual.prepare({ pool, tenant: tenantSchema, bookIds,
                    contextMessages: bookContext?.allMessages || [], query, now: auditNow, tz: auditTz,
                    thothBot, signal: controller.signal, globalAccess, sourceLimit: Math.min(sourceLimit, 50) });
                if (!prepared.images.length) {
                    return res.status(422).json({ error: 'No readable original images were found. Turn off images for a text-only audit.',
                        includeImages: true, imageAudit: { ...visual.textOnly(), requested: true, coverage: 'original_unavailable',
                            available: prepared.available, limitations: prepared.limitations } });
                }
            }
            const systemPrompt = buildExecutiveAuditPrompt(language, bookContext?.langComposition, temporalContext);
            const response = includeImages ? null : await groqWithRetry({
                url: _llm.url,
                data: {
                    model: _llm.model,
                    messages: [
                        { role: 'system', content: `${systemPrompt}\nThis is TEXT-ONLY evidence. Do not claim original images were checked.` },
                        { role: 'user', content: contextPrompt }
                    ],
                    temperature: AI_MODELS.TEMPERATURE_AUDIT,
                    max_tokens: 3000
                },
                config: {
                    signal: controller.signal, timeout: 25000,
                    headers: {
                        'Authorization': `Bearer ${resolveAIToken('audit')}`,
                        'Content-Type': 'application/json'
                    }
                }
            }, 0);

            let answer = includeImages
                ? await visual.draft(prepared, contextPrompt, systemPrompt, { signal: controller.signal })
                : response.data?.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

            let auditCorrected = false;
            let corrections = [];
            let needsHumanReview = false;
            let unverifiable = [];
            let pipelineVerified = null;
            if (bookContext && bookContext.totalMessages > 0) {
                const retryFn = async (retryPrompt, options) => {
                    if (includeImages) return visual.draft(prepared, `${contextPrompt}\n${retryPrompt}`, buildRetryPrompt(), { signal: controller.signal });
                    const retryResp = await groqWithRetry({
                        url: _llm.url,
                        data: {
                            model: _llm.model,
                            messages: [
                                { role: 'system', content: buildRetryPrompt() },
                                { role: 'user', content: retryPrompt }
                            ],
                            temperature: options.temperature || AI_MODELS.TEMPERATURE_PRECISE,
                            max_tokens: 1000
                        },
                        config: {
                            signal: controller.signal, timeout: 15000,
                            headers: {
                                'Authorization': `Bearer ${resolveAIToken('audit')}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    }, 0);
                    return retryResp.data?.choices?.[0]?.message?.content || null;
                };

                const pipelineResult = await runDashboardAuditPipeline({
                    query: query,
                    initialResponse: answer,
                    contextMessages: bookContext.recentMessages || [],
                    entityAggregates: bookContext.entityAggregates || {},
                    llmCallFn: retryFn,
                    engine: 'nyan-ai',
                    maxRetries: 1,
                    now: auditNow,
                    tz: auditTz
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

            if (includeImages) {
                imageAudit = await visual.verify(prepared, query, answer, { signal: controller.signal });
                if (imageAudit.needsHumanReview) {
                    needsHumanReview = true;
                    pipelineVerified = false;
                }
                if (imageAudit.findings?.some(f => f.status === 'contradicted')) {
                    const issues = imageAudit.findings.filter(f => f.status === 'contradicted')
                        .map(f => `[${f.evidenceId}] ${f.claim} — source observation: ${f.observed}`).join('\n');
                    answer += `\n\nSOURCE DISCREPANCY — human review required:\n${issues}`;
                }
            }
            if (bookContext?.discoveryLimited) {
                pipelineVerified = false;
                needsHumanReview = true;
                imageAudit.limitations.push('Text discovery was bounded; complete-book coverage is not verified.');
            }
            answer = formatExecutiveResponse(answer);
            const processingTime = Date.now() - startTime;
            const usedModel = includeImages ? visual.MODEL : _llm.model;

            logger.info({ processingMs: processingTime, userId: req.userId }, 'Nyan AI Audit complete');

            if (idrisBot && idrisBot.isReady() && tenantSchema && bookContext && bookContext.books.length > 0) {
                // Write to the first (primary) book's per-book audit thread only.
                // Multi-book queries: one entry, first book is the canonical log coordinate.
                // Time is the in-thread index (Discord snowflake); no duplicate noise.
                try {
                    const primaryBook = bookContext.books[0];
                    let primaryBookName = primaryBook.name || 'Unknown';
                    let primaryFractalId = primaryBook.fractalId || primaryBook.fractal_id;

                    // Dev/admin drain: reroute to oldest book in tenant so dev testing
                    // noise does not contaminate tenant-owned queried-book audit threads.
                    // Tenant thread (ai_log_thread_id) remains as legacy read archive.
                    const isDevQuerier = userRole === 'dev' || userRole === 'admin';
                    if (isDevQuerier) {
                        const drainRow = await pool.query(
                            `SELECT fractal_id, book_name FROM core.book_registry
                             WHERE tenant_schema = $1 AND status IN ('active', 'inactive')
                             ORDER BY created_at ASC LIMIT 1`,
                            [tenantSchema]
                        );
                        if (!drainRow.rows.length) {
                            // No books in tenant — skip Discord write entirely
                            logger.debug({ userRole, tenantSchema }, 'Dev audit drain: no books in tenant, skipping Discord write');
                            primaryFractalId = null;
                        } else {
                            primaryFractalId = drainRow.rows[0].fractal_id;
                            primaryBookName  = drainRow.rows[0].book_name;
                            logger.debug({ userRole, drainFractalId: primaryFractalId }, 'Dev audit drain: rerouted to oldest book');
                        }
                    }

                    let threadId = null;

                    if (primaryFractalId) {
                        const bookRow = await pool.query(
                            `SELECT id, audit_thread_id FROM core.book_registry WHERE fractal_id = $1 AND tenant_schema = $2`,
                            [primaryFractalId, tenantSchema]
                        );

                        if (bookRow.rows.length > 0) {
                            const registryId = bookRow.rows[0].id;
                            threadId = bookRow.rows[0].audit_thread_id;

                            if (!threadId) {
                                // Atomic test-and-set: only one process wins
                                const threadInfo = await idrisBot.createBookAuditThread(primaryFractalId, primaryBookName);
                                const writeResult = await pool.query(
                                    `UPDATE core.book_registry SET audit_thread_id = $1 WHERE id = $2 AND audit_thread_id IS NULL RETURNING audit_thread_id`,
                                    [threadInfo.threadId, registryId]
                                );
                                if (writeResult.rows.length > 0) {
                                    threadId = writeResult.rows[0].audit_thread_id;
                                } else {
                                    // Another process provisioned first — re-read
                                    const reread = await pool.query(
                                        `SELECT audit_thread_id FROM core.book_registry WHERE id = $1`,
                                        [registryId]
                                    );
                                    threadId = reread.rows[0]?.audit_thread_id || null;
                                }
                            }
                        }
                    }

                    if (threadId) {
                        const bookNames = bookContext.books.map(b => b.name).join(', ');
                        const auditPayload = {
                            status: 'NYAN',
                            confidence: null,
                            answer: answer,
                            reason: `Nyan AI response (${bookContext.totalMessages} messages analyzed)`,
                            data_extracted: {
                                engine: 'nyan-ai',
                                model: usedModel,
                                includeImages,
                                imageAudit,
                                books: bookNames,
                                query: query.substring(0, 100),
                                processingTime: processingTime
                            },
                            bookName: primaryBookName
                        };
                        await idrisBot.postAuditResult(threadId, auditPayload, query, primaryBookName);
                        logger.info({ threadId, fractalId: primaryFractalId }, 'Nyan AI Audit logged to per-book thread');

                        // Mirror outpipe — tenant-level, unchanged
                        try {
                            const mirrorInfo = await pool.query(
                                `SELECT audit_mirror_thread_id, audit_mirror_webhook_url FROM core.tenant_catalog WHERE tenant_schema = $1`,
                                [tenantSchema]
                            );
                            const mirrorThreadId = mirrorInfo.rows[0]?.audit_mirror_thread_id;
                            const mirrorWebhookUrl = mirrorInfo.rows[0]?.audit_mirror_webhook_url;

                            if (mirrorWebhookUrl) {
                                const isDiscordMirror = /discord\.com\/api\/webhooks\//.test(mirrorWebhookUrl);
                                if (isDiscordMirror) {
                                    const mirrorUrl = mirrorThreadId ? `${mirrorWebhookUrl}${mirrorWebhookUrl.includes('?') ? '&' : '?'}thread_id=${mirrorThreadId}` : mirrorWebhookUrl;
                                    const mirrorEmoji  = AUDIT.STATUS_EMOJI[auditPayload.status] || '❓';
                                    const mirrorAnswer = (auditPayload.answer || '').substring(0, 4096);
                                    const mirrorEmbed  = {
                                        title:       `${mirrorEmoji} ${auditPayload.status || 'UNKNOWN'}`,
                                        color:       idrisBot.getStatusColor(auditPayload.status),
                                        description: mirrorAnswer || undefined,
                                        fields: [
                                            { name: '📝 Query', value: query.length > 300 ? query.substring(0, 300) + '\u2026' : query, inline: false }
                                        ],
                                        timestamp: new Date().toISOString()
                                    };
                                    if (primaryBookName) mirrorEmbed.fields.push({ name: '📚 Book', value: primaryBookName, inline: false });
                                    await axios.post(mirrorUrl, { embeds: [mirrorEmbed] }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
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
                                logger.info({ mirrorUrl: mirrorWebhookUrl.substring(0, 60) }, 'Nyan AI Audit mirrored');
                            } else if (mirrorThreadId) {
                                await idrisBot.postAuditResult(mirrorThreadId, auditPayload, query, primaryBookName);
                                logger.info({ mirrorThreadId }, 'Nyan AI Audit mirrored to legacy thread');
                            }
                        } catch (mirrorErr) {
                            logger.warn({ err: mirrorErr.message }, 'Audit mirror post failed (non-blocking)');
                        }
                    }
                } catch (discordError) {
                    logger.error({ err: discordError }, 'Failed to post Nyan AI audit to per-book thread (non-blocking)');
                }
            }

            const resultPayload = {
                success: true,
                answer: answer,
                engine: 'nyan-ai',
                model: usedModel,
                includeImages,
                imageAudit,
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
                    books: bookContext.books,
                    discoveryLimited: !!bookContext.discoveryLimited
                } : null
            };
            await capacity.auditKey(resultKey, resultPayload);
            await capacity.recordAudit({ inspected: imageAudit.inspected }).catch(() => {});
            res.json(resultPayload);

        } catch (error) {
            await capacity.recordAudit({ rejected: true }).catch(() => {});
            logger.error({ code: error.code, status: error.status }, 'Nyan AI Audit error');
            const status = error.status || (controller.signal.aborted ? 504 : 500);
            if (status === 429) res.set('Retry-After', String(error.retryAfter || 60));
            res.status(status).json({
                error: status < 500 || error.code === 'AI_CAPACITY' ? error.message : 'Audit could not finish within its limits. Narrow the scope or retry later.',
                includeImages
            });
        } finally {
            auditInFlight.delete(flightKey);
            clearTimeout(timer);
            res.off('close', closed);
            if (prepared) prepared.images.length = 0;
            await capacity.finishAuditEnvelope().catch(() => {});
            await capacity.auditFailed(resultKey).catch(() => {});
        }
    });

    app.get('/api/nyan-ai/ai-budget', requireAuth, async (req, res) => {
        if (req.userRole !== 'dev') return res.status(403).json({ error: 'Operator access required.' });
        try { res.set('Cache-Control', 'no-store').json(await capacity.status()); }
        catch { res.status(503).json({ error: 'Shared AI capacity unavailable.' }); }
    });

    app.get('/api/nyan-ai/evidence', requireAuth, async (req, res) => {
        try {
            const { bookId, messageId, attachmentId = '0', source, page = '1' } = req.query;
            if (![bookId, messageId, attachmentId].every(x => typeof x === 'string' && x.length <= 150) ||
                !['db', 'discord'].includes(source) || typeof page !== 'string' || !/^[1-9]\d{0,4}$/.test(page) || Number(page) > 10000) {
                return res.status(400).json({ error: 'Invalid source citation.' });
            }
            const tenant = req.tenantContext?.tenantSchema || req.tenantSchema;
            const original = await originals.resolveSource({ pool, tenant,
                ref: { bookId, messageId, attachmentId, source }, thothBot,
                globalAccess: req.userRole === 'dev' && req.tenantContext?.globalAccess === true });
            const buffer = await originals.download(original.url);
            const pdf = buffer.subarray(0, 5).toString() === '%PDF-';
            const image = pdf ? (await originals.render(buffer, Number(page))).images[0] : await originals.decodeImage(buffer);
            if (!image) return res.status(404).json({ error: 'Source page unavailable.' });
            res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox" }).type('png').send(image.data);
        } catch (err) { res.status(err.status || 503).json({ error: 'Original source unavailable or not authorized.' }); }
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
            const { limit = 25, book_fractal_id } = req.query;
            const horusBot = bots?.horus;

            if (!tenantSchema) {
                return res.status(400).json({ error: 'Tenant context required' });
            }

            if (!horusBot || !horusBot.isReady()) {
                return res.status(503).json({ error: 'AI audit log reader not available' });
            }

            // --- Per-book mode: ?book_fractal_id=xxx ---
            if (book_fractal_id) {
                const bookRow = await pool.query(
                    `SELECT book_name, audit_thread_id FROM core.book_registry WHERE fractal_id = $1 AND tenant_schema = $2`,
                    [book_fractal_id, tenantSchema]
                );
                if (!bookRow.rows.length) {
                    return res.status(404).json({ error: 'Book not found' });
                }
                const { audit_thread_id, book_name } = bookRow.rows[0];
                if (!audit_thread_id) {
                    return res.json({ success: true, logs: [], message: `No audit history yet for ${book_name}`, thread_id: null });
                }
                const safeLimit = Math.max(1, Math.min(Number.isNaN(parseInt(limit, 10)) ? 25 : parseInt(limit, 10), 100));
                const logs = await horusBot.fetchAuditLogs(audit_thread_id, safeLimit);
                const stats = await horusBot.getAuditStats(audit_thread_id);
                return res.json({ success: true, logs, stats, thread_id: audit_thread_id });
            }

            // --- Universal mode: all books for this tenant, grouped ---
            const booksResult = await pool.query(
                `SELECT fractal_id, book_name, audit_thread_id FROM core.book_registry
                 WHERE tenant_schema = $1 AND status IN ('active', 'inactive')
                 ORDER BY created_at ASC`,
                [tenantSchema]
            );

            const parsedLimit = parseInt(limit, 10);
            const perLimit = Math.max(5, Math.min(Number.isNaN(parsedLimit) ? 25 : parsedLimit, 25));

            const bookGroups = await Promise.all(
                booksResult.rows.map(async (row) => {
                    const bookMeta = { fractal_id: row.fractal_id, name: row.book_name, audit_thread_id: row.audit_thread_id };
                    if (!row.audit_thread_id) {
                        return { book: bookMeta, audits: [] };
                    }
                    try {
                        const audits = await horusBot.fetchAuditLogs(row.audit_thread_id, perLimit);
                        return { book: bookMeta, audits };
                    } catch (fetchErr) {
                        logger.warn({ fractalId: row.fractal_id, err: fetchErr.message }, 'Horus fetch failed for book audit thread');
                        return { book: bookMeta, audits: [] };
                    }
                })
            );

            // Legacy: fetch from tenant-level ai_log_thread_id (pre-#97 history).
            // These logs predate per-book threads; shown as a distinct group at the bottom.
            let allGroups = bookGroups;
            try {
                const tenantRow = await pool.query(
                    `SELECT ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1`,
                    [tenantSchema]
                );
                const legacyThreadId = tenantRow.rows[0]?.ai_log_thread_id;
                if (legacyThreadId) {
                    const legacyAudits = await horusBot.fetchAuditLogs(legacyThreadId, perLimit);
                    // fetchAuditLogs returns {id, timestamp, content, embeds, parsed?} — no `type`.
                    // Filter to entries with embeds = real audit results; skip plain-text init messages.
                    const auditOnly = legacyAudits.filter(l => l.embeds && l.embeds.length > 0);
                    if (auditOnly.length > 0) {
                        allGroups = [
                            ...bookGroups,
                            {
                                book: { fractal_id: null, name: 'Legacy Audit Log', audit_thread_id: legacyThreadId, is_legacy: true },
                                audits: auditOnly
                            }
                        ];
                    }
                }
            } catch (legacyErr) {
                logger.warn({ err: legacyErr.message }, 'Legacy audit thread fetch failed (non-blocking)');
            }

            res.json({ success: true, books: allGroups });
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
    const { getLastBackupStatus } = require('../../lib/backup');

    app.get('/api/admin/backup/status', requireAuth, (req, res) => {
        res.json(getLastBackupStatus());
    });
}

module.exports = { registerAuditRoutes };
