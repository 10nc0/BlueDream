const axios = require('axios');

const PINATA_JWT = process.env.PINATA_JWT;

if (!PINATA_JWT) {
    console.warn('⚠️  PINATA_JWT not set — IPFS pinning disabled. Message ledger rows will have ipfs_cid=NULL.');
    console.warn('   Create a free account at pinata.cloud, generate an API key JWT, and set PINATA_JWT to enable IPFS backup.');
}

const PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

/**
 * Pin a JSON-serializable object to IPFS via Pinata.
 * @param {object} data - Object to serialize and pin
 * @returns {Promise<{cid: string}|null>} CID on success, null on error or missing token
 */
async function pinJson(data) {
    if (!PINATA_JWT) return null;
    try {
        const res = await axios.post(PIN_JSON_URL, {
            pinataContent: data,
            pinataMetadata: { name: `nyanbook-capsule-${Date.now()}` }
        }, {
            headers: {
                'Authorization': `Bearer ${PINATA_JWT}`,
                'Content-Type': 'application/json'
            }
        });
        return { cid: res.data?.IpfsHash };
    } catch (err) {
        console.warn('⚠️  IPFS pinJson failed (non-fatal):', err?.response?.data || err.message);
        return null;
    }
}

/**
 * Pin a raw binary buffer to IPFS via Pinata.
 * Used for attachment binaries when disclosed:true.
 * @param {Buffer} buffer - Binary data to pin
 * @param {string} mimeType - MIME type of the content
 * @returns {Promise<{cid: string}|null>} CID on success, null on error or missing token
 */
async function pinBuffer(buffer, mimeType) {
    if (!PINATA_JWT) return null;
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', buffer, {
            filename: `nyanbook-attachment-${Date.now()}`,
            contentType: mimeType || 'application/octet-stream'
        });
        form.append('pinataMetadata', JSON.stringify({ name: `nyanbook-attachment-${Date.now()}` }));

        const res = await axios.post(PIN_FILE_URL, form, {
            headers: {
                'Authorization': `Bearer ${PINATA_JWT}`,
                ...form.getHeaders()
            },
            maxBodyLength: Infinity
        });
        return { cid: res.data?.IpfsHash };
    } catch (err) {
        console.warn('⚠️  IPFS pinBuffer failed (non-fatal):', err?.response?.data || err.message);
        return null;
    }
}

module.exports = { pinJson, pinBuffer };
