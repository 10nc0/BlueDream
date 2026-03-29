const logger = require('../../lib/logger');
const { AUDIO_MIME_EXT_MAP } = require('../../utils/file-types');
const { fetchUrl, extractUrls } = require('../../lib/url-fetcher');

function normalizePhotoList(photos, photo) {
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
    return photoList;
}

function normalizeDocList(documents, document, documentName) {
    const docList = [];
    if (documents && documents.length > 0) {
        docList.push(...documents.map(d => ({ name: d.name, data: d.data, type: d.type })));
    }
    if (document) {
        docList.push({ name: documentName || 'document', data: document, type: 'document' });
    }
    return docList;
}

async function extractZipAttachments(zipData) {
    const extracted = { photos: [], audios: [], documents: [] };
    if (!zipData) return extracted;
    try {
        const JSZip = require('jszip');
        const zipBuffer = Buffer.from(zipData, 'base64');
        const zip = await JSZip.loadAsync(zipBuffer);
        const manifestFile = zip.file('manifest.json');
        if (manifestFile) {
            const manifestContent = await manifestFile.async('string');
            const manifest = JSON.parse(manifestContent);
            for (const entry of manifest) {
                const file = zip.file(entry.filename || entry.path);
                if (file) {
                    const data = await file.async('base64');
                    const itemName = entry.originalName || entry.name || 'file';
                    const itemCat  = entry.type || entry.category || '';
                    const item = { name: itemName, data, type: itemCat };
                    if (itemCat === 'photo') extracted.photos.push(item);
                    else if (itemCat === 'audio') extracted.audios.push(item);
                    else if (itemCat === 'document') extracted.documents.push(item);
                }
            }
        }
    } catch (zipError) {
        logger.error({ err: zipError }, '❌ ZIP extraction error');
    }
    return extracted;
}

function collectAudioList(audios, audio) {
    const audioList = [];
    if (audios && Array.isArray(audios)) audioList.push(...audios);
    if (audio) audioList.push({ name: 'voice-recording', data: audio, type: 'audio' });
    return audioList;
}

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
