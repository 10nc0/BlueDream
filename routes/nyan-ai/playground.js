const rateLimit = require('express-rate-limit');
const { logger, orchestrator, executeCompoundQuery, setupSSE, fastStreamPersonality } = require('./shared');
const { normalizePhotoList, normalizeDocList, collectAudioList, buildDocAttachmentMeta,
        extractZipAttachments, transcribeAudioList, fetchUrlsFromMessage } = require('./media');
const { processAndCacheDocList } = require('../../utils/doc-cache');
const { AttachmentIngestion } = require('../../utils/attachment-ingestion');
const { recordInMemory } = require('../../utils/context-extractor');
const { detectCompoundQuery } = require('../../utils/preflight-router');
const { fetchUrl } = require('../../lib/url-fetcher');
const capacityManager = require('../../utils/playground-capacity');
const usageTracker = require('../../utils/playground-usage');

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

function registerPlaygroundRoutes(app, deps) {
    app.get('/api/playground/usage', (req, res) => {
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

            await fetchUrlsFromMessage(message, extractedContent);

            const photoList = normalizePhotoList(photos, photo);

            const capacityCheck = await capacityManager.consumeToken(clientIp, photoList.length > 0 ? 'vision' : 'text');
            if (!capacityCheck.allowed) {
                return res.status(429).json({
                    error: capacityCheck.reason,
                    remaining: capacityCheck.remaining,
                    resetIn: capacityCheck.resetIn
                });
            }

            const perception = await AttachmentIngestion.ingest(docList, clientIp);

            const pipelineInput = {
                message: finalPrompt,
                photos: photoList,
                documents: docList,
                extractedContent: extractedContent,
                history: history || [],
                clientIp,
                isVisionRequest: photoList.length > 0,
                contextAttachments
            };

            const pipelineResult = await orchestrator.execute(pipelineInput);

            if (pipelineResult.success && pipelineResult.answer) {
                recordInMemory(clientIp, message || '', pipelineResult.answer, buildDocAttachmentMeta(docList, extractedContent));
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

    app.post('/api/playground/fetch-url', playgroundLimiter, async (req, res) => {
        const { url } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url is required' });
        }
        try {
            const result = await fetchUrl(url.trim());
            return res.json({ ok: true, title: result.title, sourceLabel: result.sourceLabel, text: result.text });
        } catch (err) {
            logger.warn({ url, err: err.message }, '🔗 Explicit fetch-url failed');
            return res.status(422).json({ error: err.message });
        }
    });

    app.post('/api/playground/stream', playgroundLimiter, async (req, res) => {
        const clientIp = req.ip || req.connection.remoteAddress;

        capacityManager.recordActivity(clientIp);

        const { isClientDisconnected, sseStage, cleanup } = setupSSE(res);

        try {
            let { message, photo, audio, document, documentName, photos, audios, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
            let extractedContent = [];
            const responseFileHashes = [];

            const zipExtracted = await extractZipAttachments(zipData);
            photos = (photos || []).concat(zipExtracted.photos);
            audios = (audios || []).concat(zipExtracted.audios);
            documents = (documents || []).concat(zipExtracted.documents);

            const docList = normalizeDocList(documents, document, documentName);
            await processAndCacheDocList(docList, cachedFileHashes, clientIp, extractedContent, responseFileHashes);

            const audioList = collectAudioList(audios, audio);
            const transcripts = await transcribeAudioList(audioList, clientIp, { sseStage, isClientDisconnected });
            if (transcripts.length > 0) {
                const spoken = transcripts.join(' ');
                message = message ? `${message} ${spoken}` : spoken;
            }

            await fetchUrlsFromMessage(message, extractedContent, { sseStage, isClientDisconnected });

            if (isClientDisconnected()) return;

            const photoList = normalizePhotoList(photos, photo);

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
                    extractedContent, photoList, docList, history, clientIp, contextAttachments, sseStage, isClientDisconnected
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

                logger.info({ ip: clientIp, badge: compound.worstBadge, sections: compound.sections.length }, '🌊 Compound streaming complete');
            } else {
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
                    sseStage({ type: 'error', message: userMessage });
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

                if (pipelineResult.fastPath) {
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

                logger.info({ ip: clientIp, badge, searchRetry: didSearchRetry }, '🌊 Streaming complete');
            }

        } catch (error) {
            logger.error({ err: error }, '❌ Streaming error');
            sseStage({ type: 'error', message: 'An error occurred. Please try again.' });
            cleanup();
        }
    });
}

module.exports = { registerPlaygroundRoutes };
