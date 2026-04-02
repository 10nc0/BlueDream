'use strict';

const logger = require('../lib/logger');

// Lazy-loaded client — only instantiated when FIRECRAWL_API_KEY is present
let _client = null;

function _getClient() {
    if (_client) return _client;
    const { FirecrawlClient } = require('@mendable/firecrawl-js');
    _client = new FirecrawlClient({ apiKey: process.env.FIRECRAWL_API_KEY });
    return _client;
}

/**
 * Enrich a list of URLs with clean markdown via Firecrawl (single-page scrape, no crawling).
 * Fetches all URLs in parallel; each has an independent per-URL timeout.
 * Failed or timed-out URLs are silently dropped — they do not prevent other URLs from enriching.
 *
 * @param {string[]} urls            - URLs to enrich (duplicates are deduped)
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=8000] - Per-URL timeout in milliseconds
 * @param {number}  [opts.maxUrls=3]      - Maximum number of URLs to enrich (first N taken)
 * @param {number}  [opts.maxCharsPerUrl=2000] - Truncate each page markdown to this length
 * @returns {Promise<Map<string, string>>} - Map of url → markdown (only successfully enriched URLs)
 */
async function enrichUrls(urls, { timeoutMs = 8000, maxUrls = 3, maxCharsPerUrl = 2000 } = {}) {
    if (!Array.isArray(urls) || urls.length === 0) return new Map();

    const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
    if (!FIRECRAWL_API_KEY) return new Map();

    // Deduplicate and cap
    const deduped = [...new Set(urls.filter(u => typeof u === 'string' && u.startsWith('http')))].slice(0, maxUrls);
    if (deduped.length === 0) return new Map();

    const client = _getClient();
    const results = new Map();

    await Promise.all(deduped.map(async (url) => {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
        );
        try {
            const doc = await Promise.race([
                client.scrape(url, { formats: ['markdown'], onlyMainContent: true }),
                timeoutPromise
            ]);
            const md = (doc?.markdown || '').trim();
            if (md.length > 100) {
                results.set(url, md.substring(0, maxCharsPerUrl));
            }
        } catch (err) {
            logger.debug({ url: url.substring(0, 60), err: err.message }, '🕷️ Firecrawl: URL enrichment failed, skipping');
        }
    }));

    if (results.size > 0) {
        logger.info({ total: deduped.length, enriched: results.size }, '🕷️ Firecrawl: source enrichment complete');
    } else {
        logger.debug({ total: deduped.length }, '🕷️ Firecrawl: no URLs enriched (all failed or timed out)');
    }

    return results;
}

module.exports = { enrichUrls };
