const axios = require('axios');

const PINATA_JWT = process.env.PINATA_JWT;

if (!PINATA_JWT) {
    console.warn('⚠️  PINATA_JWT not set — IPFS pinning disabled. Message ledger rows will have ipfs_cid=NULL.');
    console.warn('   Create a free account at pinata.cloud, generate an API key JWT, and set PINATA_JWT to enable IPFS backup.');
}

const PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

/**
 * Pin a JSON-serializable object to IPFS via Pinata.
 * Retries up to maxRetries times with exponential backoff on transient failures.
 * Returns null (non-fatal) on permanent failure — Discord is the canonical ledger.
 * @param {object} data - Object to serialize and pin
 * @param {number} maxRetries - Number of retry attempts after the first try (default 2)
 * @returns {Promise<{cid: string}|null>} CID on success, null on error or missing token
 */
async function pinJson(data, maxRetries = 2) {
    if (!PINATA_JWT) return null;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
            lastErr = err;
            if (attempt < maxRetries) {
                const delayMs = 500 * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    console.warn('⚠️  IPFS pinJson failed after retries (non-fatal):', lastErr?.response?.data || lastErr?.message);
    return null;
}

module.exports = { pinJson };
