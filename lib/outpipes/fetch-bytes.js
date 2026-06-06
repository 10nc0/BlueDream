'use strict';

const axios = require('axios');
const logger = require('../logger');

// Fetch raw bytes from a URL with safety validation.
// Returns { buffer, contentType, byteLength } or null on any failure.
//
// Safety checks:
//   1. HTTP status must be 2xx (axios validateStatus enforces this).
//   2. Content-Type must not be text/html or xhtml — a Twilio 403 for an
//      auth-gated media URL returns an HTML error page; forwarding that body
//      as a "file" would be silent data corruption.
//
// On any failure (network error, non-2xx, HTML body) logs a warning and
// returns null so callers fall back to URL-pointer behaviour.
async function fetchMediaBytes(url) {
    if (!url) return null;
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10_000,
            validateStatus: s => s >= 200 && s < 300
        });
        const rawContentType = response.headers['content-type'] || '';
        const contentType = rawContentType.split(';')[0].trim().toLowerCase();
        if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
            logger.warn({ url, contentType }, '⚠️ fetchMediaBytes: HTML response — falling back to URL pointer');
            return null;
        }
        const buffer = Buffer.from(response.data);
        return { buffer, contentType: contentType || 'application/octet-stream', byteLength: buffer.length };
    } catch (err) {
        logger.warn({ url, err: err.message }, '⚠️ fetchMediaBytes: GET failed — falling back to URL pointer');
        return null;
    }
}

module.exports = { fetchMediaBytes };
