const logger = require('../../lib/logger');
const { AUDIO_MIME_EXT_MAP } = require('../../utils/file-types');
const { fetchUrl, extractUrls } = require('../../lib/url-fetcher');

// ── List normalisation helpers ────────────────────────────────────────────────
// Canonical definitions live in lib/attachment-packet.js.
// Re-exported here so all existing callers (routes/pipe.js, nyan-ai handlers,
// tests) continue to import from this path without any changes.
const {
    normalizePhotoList,
    normalizeDocList,
    extractZipAttachments,
    collectAudioList,
} = require('../../lib/attachment-packet');

async function transcribeAudioList(audioItems, clientIp, opts = {}) {
    if (audioItems.length === 0) return [];
    const { sseStage, isClientDisconnected } = opts;
    const { processDocumentForAI } = require('../../utils/attachment-cascade');
    const transcripts = [];
    for (const aud of audioItems) {
        if (isClientDisconnected?.()) break;
        if (sseStage) sseStage({ type: 'thinking', stage: '🎙️ Transcribing audio...' });
        try {
            let audName = aud.name || '';
            if (!audName || !audName.includes('.')) {
                const mimeM = typeof aud.data === 'string' && aud.data.match(/^data:([^;]+);base64,/);
                const ext = mimeM ? (AUDIO_MIME_EXT_MAP[mimeM[1]] || 'webm') : 'webm';
                audName = `audio.${ext}`;
            }
            const result = await processDocumentForAI(aud.data, audName, aud.type || 'audio', { tenantId: clientIp });
            if (result && result.text) {
                transcripts.push(result.text);
                logger.info({ name: aud.name, chars: result.text.length }, '🎙️ Audio transcribed');
            }
        } catch (audErr) {
            logger.warn({ name: aud.name, err: audErr.message }, '🎙️ Audio transcription failed');
        }
    }
    return transcripts;
}

async function fetchUrlsFromMessage(message, extractedContent, opts = {}) {
    const { sseStage, isClientDisconnected } = opts;
    const detectedUrls = extractUrls(message || '');
    for (const rawUrl of detectedUrls.slice(0, 3)) {
        if (isClientDisconnected?.()) break;
        if (sseStage) {
            const shortUrl = rawUrl.length > 60 ? rawUrl.slice(0, 57) + '...' : rawUrl;
            sseStage({ type: 'thinking', stage: `🔗 Reading ${shortUrl}` });
        }
        try {
            const fetched = await fetchUrl(rawUrl);
            const block = `[URL Context — ${fetched.title}]\nSource: ${fetched.sourceLabel}\n\n${fetched.text}`;
            extractedContent.push(block);
            logger.info({ url: rawUrl, chars: fetched.text.length }, '🔗 URL fetched');
        } catch (urlErr) {
            logger.warn({ url: rawUrl, err: urlErr.message }, '🔗 URL fetch failed');
            if (sseStage) {
                extractedContent.push(`[URL Context — fetch failed]\nSource: ${rawUrl}\nReason: ${urlErr.message}`);
            }
        }
    }
}

function buildDocAttachmentMeta(docList, extractedContent) {
    if (docList.length === 0) return null;
    return {
        name: docList[0].name,
        type: docList[0].type || 'document',
        processedText: extractedContent.join('\n\n').slice(0, 2000),
        shortSummary: `${docList.length} document(s): ${docList.map(d => d.name).join(', ')}`
    };
}

module.exports = {
    normalizePhotoList,
    normalizeDocList,
    extractZipAttachments,
    collectAudioList,
    transcribeAudioList,
    fetchUrlsFromMessage,
    buildDocAttachmentMeta
};
