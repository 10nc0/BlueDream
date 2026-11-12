'use strict';

const axios = require('axios');
const { isPublicAddress } = require('../public-reader/policy');
const net = require('node:net');
const { resolveAddresses } = require('../public-reader/transport');
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

function validateMediaUrl(raw) {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const appHosts = ['nyanbook.io', process.env.APP_DOMAIN, process.env.REPLIT_DEV_DOMAIN,
        ...(process.env.REPLIT_DOMAINS || '').split(',')].filter(Boolean);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
        url.href.length > 8192 || (!host.includes('.') && !net.isIP(host)) ||
        (net.isIP(host) && !isPublicAddress(host)) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host) ||
        appHosts.some(h => host === h || host.endsWith(`.${h}`))) {
        throw new Error('Media destination is not public');
    }
    url.hash = '';
    return url;
}

// Validate every redirect and pin the actual socket lookup to vetted DNS answers.
// No proxy, ambient credentials or automatic redirect can bypass the boundary.
async function fetchMediaBytes(raw, { lookup = resolveAddresses, get = axios.get } = {}) {
    if (!raw) return null;
    let url = validateMediaUrl(raw);
    const signal = AbortSignal.timeout(10000);
    for (let redirects = 0; redirects <= 5; redirects++) {
        const records = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { signal });
        if (!records.length || records.some(r => !isPublicAddress(r.address))) {
            throw new Error('Media destination is not public');
        }
        const pinned = records[0];
        const response = await get(url.href, {
            responseType: 'arraybuffer', timeout: 10000, signal,
            maxContentLength: MAX_MEDIA_BYTES, maxBodyLength: MAX_MEDIA_BYTES,
            maxRedirects: 0, proxy: false,
            lookup: (_host, opts, cb) => opts.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
            validateStatus: status => status >= 200 && status < 400
        });
        if (response.status >= 300) {
            if (!response.headers.location) throw new Error('Media redirect has no destination');
            url = validateMediaUrl(new URL(response.headers.location, url).href);
            continue;
        }
        const contentType = (response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        if (['text/html', 'application/xhtml+xml'].includes(contentType)) throw new Error('Media response is HTML');
        const buffer = Buffer.from(response.data);
        if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw new Error('Media size is invalid');
        return { buffer, contentType, byteLength: buffer.length };
    }
    throw new Error('Media redirect limit exceeded');
}

module.exports = { fetchMediaBytes, validateMediaUrl, MAX_MEDIA_BYTES };
