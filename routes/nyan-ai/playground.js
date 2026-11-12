const rateLimit = require('express-rate-limit');
const { logger, orchestrator, executeCompoundQuery, setupSSE, fastStreamPersonality } = require('./shared');
const { normalizePhotoList, normalizeDocList, collectAudioList, buildDocAttachmentMeta,
        extractZipAttachments, transcribeAudioList, fetchUrlsFromMessage } = require('./media');
const { processAndCacheDocList } = require('../../utils/doc-cache');
const { AttachmentIngestion } = require('../../utils/attachment-ingestion');
const { recordInMemory } = require('../../utils/context-extractor');
const { detectCompoundQuery } = require('../../utils/preflight-router');
const { extractUrls } = require('../../lib/url-fetcher');
const { addAnchor, tickAnchors, clearAnchors } = require('../../utils/url-anchor-store');
const capacityManager = require('../../utils/playground-capacity');
const usageTracker = require('../../utils/playground-usage');
const { PublicReader } = require('../../lib/public-reader');
const { publicAIError } = require('../../lib/ai-errors');
const { validatePlaygroundInput } = require('../../lib/playground-input');

function requestReader(res, onProgress) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    const reader = new PublicReader({ signal: controller.signal, onProgress });
    return {
        reader,
        signal: controller.signal,
        async close() {
            res.removeListener('close', abort);
            await reader.dispose();
        }
    };
}

const playgroundLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
        logger.warn({ ip: req.ip }, '⚠️ Playground rate limit exceeded');
        res.status(429);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Too many requests. Please wait a moment before trying again.' })}\n\n`);
        res.end();
    }
});

function registerPlaygroundRoutes(app, deps) {
    const requireAuth = deps?.middleware?.requireAuth;

    app.get('/api/playground/usage', requireAuth, (req, res) => {
        try {
            const stats = usageTracker.getAllUsageStats();
            res.json(stats);
        } catch (error) {
            logger.error({ err: error }, 'Usage stats error');
            res.status(500).json({ error: 'Failed to get usage stats' });
        }
    });

    app.get('/api/playground/test-seed-metric', async (req, res) => {
        if (process.env.NODE_ENV === 'production' || process.env.REPL_SLUG === 'production') {
            return res.status(404).json({ error: 'Not available in production' });
        }
        const rawCities = Array.isArray(req.query.cities) ? req.query.cities.join(',') : (req.query.cities || 'singapore,seoul');
        const cities = rawCities.split(',').map(c => c.trim().toLowerCase().replace(/[^a-z\s-]/g, '')).filter(Boolean).slice(0, 6);
        const message = `${cities.join(' ')} seed metric`;
        const clientIp = req.ip || req.connection.remoteAddress;
        try {
            const result = await orchestrator.run({
                message,
                conversationHistory: [],
                clientIp,
                extractedContent: [],
            });
            res.json({
                query: message,
                cities,
                mode: result.mode,
                answer: result.answer,
                processingTime: result.processingTime,
                sourceUrls: result.sourceUrls || [],
            });
        } catch (error) {
            logger.error({ err: error, cities }, 'Test seed metric error');
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/playground/nuke', (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;
        try {
            const { globalPackageStore } = require('../../utils/data-package');
            const { clearMemory } = require('../../utils/memory-manager');

            const pkgResult = globalPackageStore.nukeTenant(clientIp);
            clearMemory(clientIp);
            clearAnchors(clientIp);

            logger.info({ ip: clientIp }, 'NUKE: DataPackage + Memory + Anchors cleared');
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

    app.post('/api/playground', playgroundLimiter, async (req, res) => {
        const inputError = validatePlaygroundInput(req.body);
        if (inputError) return res.status(400).json({ error: inputError, code: 'PLAYGROUND_INPUT_REQUIRED' });
        const clientIp = req.ip || req.connection.remoteAddress;
        const research = requestReader(res);

        capacityManager.recordActivity(clientIp);

        try {
            let { message, photo, audio, document, documentName, photos, audios, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
            let finalPrompt = message || '';
            let extractedContent = [];
            const responseFileHashes = [];

            const zipExtracted = await extractZipAttachments(zipData);
            photos = (photos || []).concat(zipExtracted.photos);
            audios = (audios || []).concat(zipExtracted.audios);
            documents = (documents || []).concat(zipExtracted.documents);

            const docList = normalizeDocList(documents, document, documentName);
            await processAndCacheDocList(docList, cachedFileHashes, clientIp, extractedContent, responseFileHashes);

            const audioList = collectAudioList(audios, audio);
            const transcripts = await transcribeAudioList(audioList, clientIp);
            if (transcripts.length > 0) {
                const spoken = transcripts.join(' ');
                finalPrompt = finalPrompt ? `${finalPrompt} ${spoken}` : spoken;
            }

            await fetchUrlsFromMessage(message, extractedContent, { publicReader: research.reader });
            for (const u of extractUrls(message || '').slice(0, 3)) addAnchor(clientIp, u);

            const photoList = normalizePhotoList(photos, photo);

            const capacityCheck = await capacityManager.consumeToken(clientIp, photoList.length > 0 ? 'vision' : 'text');
            if (!capacityCheck.allowed) {
                res.set('Retry-After', String(capacityCheck.retryAfter || 60));
                return res.status(capacityCheck.status || 429).json({
                    error: capacityCheck.reason,
                    code: capacityCheck.code || 'AI_CAPACITY',
                    remaining: capacityCheck.remaining,
                    resetIn: capacityCheck.resetIn
                });
            }

            const perception = await AttachmentIngestion.ingest(docList, clientIp);

            const pipelineInput = {
                sessionId: clientIp,
                message: finalPrompt,
                photos: photoList,
                documents: docList,
                extractedContent: extractedContent,
                history: history || [],
                clientIp,
                isVisionRequest: photoList.length > 0,
                contextAttachments,
                publicReader: research.reader,
                signal: research.signal,
                surface: 'playground'
            };

            const pipelineResult = await orchestrator.execute(pipelineInput);

            if (!pipelineResult.success || !pipelineResult.answer) {
                const failure = publicAIError(pipelineResult);
                if (failure.retryAfter) res.set('Retry-After', String(failure.retryAfter));
                return res.status(failure.status).json({ success: false, error: failure.message,
                    code: failure.code, retryAfter: failure.retryAfter });
            }
            if (pipelineResult.success && pipelineResult.answer) {
                recordInMemory(clientIp, message || '', pipelineResult.answer, buildDocAttachmentMeta(docList, extractedContent));
            }
            tickAnchors(clientIp);

            res.json({
                success: pipelineResult.success,
                response: pipelineResult.answer,
                badge: pipelineResult.badge,
                audit: pipelineResult.audit,
                fileHashes: responseFileHashes,
                processingTime: pipelineResult.processingTime
            });

        } catch (error) {
            if (research.signal.aborted) return;
            logger.error({ err: error }, '❌ Playground error');
            const failure = publicAIError(error);
            if (failure.retryAfter) res.set('Retry-After', String(failure.retryAfter));
            res.status(failure.status).json({ error: failure.message, code: failure.code, retryAfter: failure.retryAfter });
        } finally {
            await research.close();
        }
    });

    app.post('/api/playground/fetch-url', playgroundLimiter, async (req, res) => {
        const { url } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url is required' });
        }
        const research = requestReader(res);
        try {
            research.reader.admitSources([url.trim()]);
            const result = await research.reader.read({ url: url.trim() });
            if (!result.ok) return res.status(422).json({ ...result, error: result.limitation });
            return res.json({ ...result, sourceLabel: result.finalUrl, text: result.evidence.text });
        } catch (err) {
            logger.warn({ url, err: err.message }, '🔗 Explicit fetch-url failed');
            return res.status(422).json({ error: err.message });
        } finally {
            await research.close();
        }
    });

    app.post('/api/playground/stream', playgroundLimiter, async (req, res) => {
        const inputError = validatePlaygroundInput(req.body);
        if (inputError) return res.status(400).json({ error: inputError, code: 'PLAYGROUND_INPUT_REQUIRED' });
        const requestStartedAt = Date.now();
        const clientIp = req.ip || req.connection.remoteAddress;

        capacityManager.recordActivity(clientIp);

        const { isClientDisconnected, sseStage, cleanup } = setupSSE(res);
        const research = requestReader(res, sseStage);

        try {
            let { message, photo, audio, document, documentName, photos, audios, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
            let extractedContent = [];
            const responseFileHashes = [];

            const zipExtracted = await extractZipAttachments(zipData);
            photos = (photos || []).concat(zipExtracted.photos);
            audios = (audios || []).concat(zipExtracted.audios);
            documents = (documents || []).concat(zipExtracted.documents);

            const docList = normalizeDocList(documents, document, documentName);
            if (docList.length > 0 && sseStage) {
                const docLabel = docList.length === 1
                    ? `📄 Reading ${docList[0].name || 'document'}...`
                    : `📄 Reading ${docList.length} documents...`;
                sseStage({ type: 'thinking', stage: docLabel });
            }
            await processAndCacheDocList(docList, cachedFileHashes, clientIp, extractedContent, responseFileHashes);

            const audioList = collectAudioList(audios, audio);
            const transcripts = await transcribeAudioList(audioList, clientIp, { sseStage, isClientDisconnected });
            if (transcripts.length > 0) {
                const spoken = transcripts.join(' ');
                message = message ? `${message} ${spoken}` : spoken;
            }

            await fetchUrlsFromMessage(message, extractedContent, { sseStage, isClientDisconnected, publicReader: research.reader });
            for (const u of extractUrls(message || '').slice(0, 3)) addAnchor(clientIp, u);

            if (isClientDisconnected()) return;

            const photoList = normalizePhotoList(photos, photo);
            if (photoList.length > 0 && sseStage) {
                const imgLabel = photoList.length === 1
                    ? `🖼️ Looking at ${photoList[0].name || 'image'}...`
                    : `🖼️ Looking at ${photoList.length} images...`;
                sseStage({ type: 'thinking', stage: imgLabel });
            }

            const capacityCheck = await capacityManager.consumeToken(clientIp, photoList.length > 0 ? 'vision' : 'text');
            if (!capacityCheck.allowed) {
                sseStage({ type: 'error', message: capacityCheck.reason,
                    code: capacityCheck.code || 'AI_CAPACITY', status: capacityCheck.status || 429,
                    retryAfter: capacityCheck.retryAfter || 60 });
                cleanup();
                return;
            }

            if (responseFileHashes.length > 0) {
                res.write(`data: ${JSON.stringify({ type: 'fileHashes', hashes: responseFileHashes })}\n\n`);
            }

            res.write(`data: ${JSON.stringify({ type: 'status', message: 'Processing...' })}\n\n`);

            const perception = await AttachmentIngestion.ingest(docList, clientIp);

            const compoundParts = detectCompoundQuery(
                message || '',
                photoList.length > 0,
                docList.length > 0
            );

            if (compoundParts && compoundParts.length > 1) {
                logger.debug({ parts: compoundParts.length }, '🔀 Compound query: sub-queries detected');
                sseStage({ type: 'status', message: `Analyzing ${compoundParts.length} parts...` });

                const compound = await executeCompoundQuery(compoundParts, {
                    extractedContent, photoList, docList, history, clientIp, contextAttachments, sseStage, isClientDisconnected,
                    publicReader: research.reader, signal: research.signal,
                    surface: 'playground'
                });

                if (isClientDisconnected()) return;

                const mergedAudit = {
                    badge: compound.worstBadge,
                    confidence: compound.avgConfidence,
                    reason: `Compound query: ${compound.sections.length} sections processed`,
                    didSearchRetry: compound.anySearchRetry,
                    passCount: compound.totalPassCount,
                    isCompound: true,
                    sectionCount: compound.sections.length
                };

                await fastStreamPersonality(res, compound.mergedAnswer, mergedAudit);
                recordInMemory(clientIp, message || '', compound.mergedAnswer || '', buildDocAttachmentMeta(docList, extractedContent));
                tickAnchors(clientIp);

                logger.info({ ip: clientIp, badge: compound.worstBadge, sections: compound.sections.length }, '🌊 Compound streaming complete');
            } else {
                const answerId = require('node:crypto').randomUUID();
                let draftShown = false;
                const pipelineInput = {
                    requestStartedAt,
                    sessionId: clientIp,
                    message: message || '',
                    photos: photoList,
                    documents: docList,
                    extractedContent: extractedContent,
                    history: history || [],
                    clientIp,
                    isVisionRequest: photoList.length > 0,
                    contextAttachments,
                    streaming: true,
                    onStageChange: sseStage,
                    publicReader: research.reader,
                    signal: research.signal,
                    surface: 'playground',
                    onDraftDelta: content => {
                        if (!draftShown) {
                            draftShown = true;
                            sseStage({ type: 'draft', answerId, status: 'unverified', message: 'Unverified draft — checking sources and auditing…' });
                        }
                        sseStage({ type: 'draft-token', answerId, content });
                    }
                };

                const pipelineResult = await orchestrator.execute(pipelineInput);

                if (isClientDisconnected()) return;

                if (!pipelineResult.success || !pipelineResult.answer) {
                    const failStep = pipelineResult.step || 'unknown';
                    const failReason = pipelineResult.error || 'Processing failed';
                    logger.error({ step: failStep, reason: failReason }, '❌ Pipeline failed');
                    sseStage({ type: 'error', ...publicAIError(pipelineResult) });
                    cleanup();
                    return;
                }

                const verifiedAnswer = pipelineResult.answer;
                const badge = pipelineResult.badge || 'unverified';
                const didSearchRetry = pipelineResult.didSearchRetry || false;

                const auditMetadata = {
                    badge,
                    confidence: pipelineResult.audit?.confidence ?? null,
                    reason: pipelineResult.audit?.reason || '',
                    didSearchRetry,
                    passCount: pipelineResult.passCount || 1
                };

                if (draftShown) {
                    sseStage({ type: 'audit', answerId, audit: auditMetadata });
                    sseStage({ type: 'done', answerId, fullContent: verifiedAnswer, replacesDraft: true,
                        corrected: !!pipelineResult.retryCount || badge === 'corrected' || badge === 'refused' });
                    cleanup();
                } else if (pipelineResult.fastPath) {
                    logger.debug('⚡ Fast-path: Skipping personality pass (pre-crafted message)');
                    auditMetadata.passCount = 0;
                    sseStage({ type: 'audit', audit: auditMetadata });
                    sseStage({ type: 'token', content: verifiedAnswer });
                    sseStage({ type: 'done', fullContent: verifiedAnswer });
                    cleanup();
                } else if (badge === 'verified' || badge === 'unverified') {
                    if (isClientDisconnected()) return;
                    await fastStreamPersonality(res, verifiedAnswer, auditMetadata);
                } else {
                    sseStage({ type: 'audit', audit: auditMetadata });
                    sseStage({ type: 'token', content: verifiedAnswer });
                    sseStage({ type: 'done', fullContent: verifiedAnswer });
                    cleanup();
                }

                if (pipelineResult.success) {
                    recordInMemory(clientIp, message || '', verifiedAnswer || '', buildDocAttachmentMeta(docList, extractedContent));
                }
                tickAnchors(clientIp);

                logger.info({ ip: clientIp, badge, searchRetry: didSearchRetry }, '🌊 Streaming complete');
            }

        } catch (error) {
            if (research.signal.aborted) return;
            logger.error({ err: error }, '❌ Streaming error');
            sseStage({ type: 'error', ...publicAIError(error) });
            cleanup();
        } finally {
            await research.close();
        }
    });
}

module.exports = { registerPlaygroundRoutes };
