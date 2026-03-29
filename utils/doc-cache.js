const crypto = require('crypto');
const logger = require('../lib/logger');

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
            const { processDocumentForAI } = require('./attachment-cascade');
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

module.exports = {
    getDocumentHash,
    getSessionCacheKey,
    incrementDocumentUpload,
    getCachedDocumentContext,
    setCachedDocumentContext,
    getCachedDocumentByHash,
    processAndCacheDocList
};
