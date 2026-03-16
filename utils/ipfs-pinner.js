const axios = require('axios');

const WEB3_STORAGE_TOKEN = process.env.WEB3_STORAGE_TOKEN;

if (!WEB3_STORAGE_TOKEN) {
    console.warn('⚠️  WEB3_STORAGE_TOKEN not set — IPFS pinning disabled. Message ledger rows will have ipfs_cid=NULL.');
    console.warn('   Create a free account at web3.storage and set WEB3_STORAGE_TOKEN to enable IPFS backup.');
}

const UPLOAD_URL = 'https://api.web3.storage/upload';

/**
 * Pin a JSON-serializable object to IPFS via web3.storage.
 * @param {object} data - Object to serialize and pin
 * @returns {Promise<{cid: string}|null>} CID on success, null on error or missing token
 */
async function pinJson(data) {
    if (!WEB3_STORAGE_TOKEN) return null;
    try {
        const buffer = Buffer.from(JSON.stringify(data));
        const res = await axios.post(UPLOAD_URL, buffer, {
            headers: {
                'Authorization': `Bearer ${WEB3_STORAGE_TOKEN}`,
                'Content-Type': 'application/json',
                'X-NAME': `nyanbook-capsule-${Date.now()}`
            },
            maxBodyLength: Infinity
        });
        return { cid: res.data?.cid };
    } catch (err) {
        console.warn('⚠️  IPFS pinJson failed (non-fatal):', err?.response?.data || err.message);
        return null;
    }
}

/**
 * Pin a raw binary buffer to IPFS via web3.storage.
 * Used for attachment binaries when disclosed:true.
 * @param {Buffer} buffer - Binary data to pin
 * @param {string} mimeType - MIME type of the content
 * @returns {Promise<{cid: string}|null>} CID on success, null on error or missing token
 */
async function pinBuffer(buffer, mimeType) {
    if (!WEB3_STORAGE_TOKEN) return null;
    try {
        const res = await axios.post(UPLOAD_URL, buffer, {
            headers: {
                'Authorization': `Bearer ${WEB3_STORAGE_TOKEN}`,
                'Content-Type': mimeType || 'application/octet-stream',
                'X-NAME': `nyanbook-attachment-${Date.now()}`
            },
            maxBodyLength: Infinity
        });
        return { cid: res.data?.cid };
    } catch (err) {
        console.warn('⚠️  IPFS pinBuffer failed (non-fatal):', err?.response?.data || err.message);
        return null;
    }
}

module.exports = { pinJson, pinBuffer };
