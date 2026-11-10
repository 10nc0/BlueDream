'use strict';

const logger = require('../lib/logger');
const { awaitWithSignal } = require('../lib/fetch-retry');

// Lazy-loaded client — only instantiated when FIRECRAWL_API_KEY is present
let _client = null;
let _clientTimeoutMs;

function _getClient(timeoutMs) {
    if (_client && _clientTimeoutMs === timeoutMs) return _client;
    const { FirecrawlClient } = require('@mendable/firecrawl-js');
    // In this SDK maxRetries counts total HTTP attempts (zero sends nothing).
    _client = new FirecrawlClient({ apiKey: process.env.FIRECRAWL_API_KEY, timeoutMs, maxRetries: 1 });
    _clientTimeoutMs = timeoutMs;
    return _client;
}

/**
 * Enrich a list of URLs with clean markdown via Firecrawl (single-page scrape, no crawling).
 * Fetches all URLs in parallel; each has an independent per-URL timeout.
 * Failed or timed-out URLs are silently dropped — they do not prevent other URLs from enriching.
 *
 * @param {string[]} urls                 - URLs to enrich (duplicates are deduped)
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=8000] - Per-URL timeout in milliseconds
 * @param {number}  [opts.maxCharsPerUrl=2000] - Truncate each page markdown to this length
 * @param {AbortSignal} [opts.signal] - Caller cancellation; stops waiting/starting work.
 * @returns {Promise<Map<string, string>>} - Map of url → markdown (only successfully enriched URLs)
 */
async function enrichUrls(urls, { timeoutMs = 8000, maxCharsPerUrl = 2000, signal } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(urls) || urls.length === 0) return new Map();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('Enrichment timeout must be positive.');

    const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
    if (!FIRECRAWL_API_KEY) return new Map();

    // Deduplicate, filter valid http(s) URLs (no hard cap — all cited URLs are eligible)
    const deduped = [...new Set(urls.filter(u => typeof u === 'string' && u.startsWith('http')))];
    if (deduped.length === 0) return new Map();

    const client = _getClient(timeoutMs);
    const results = new Map();

    await Promise.all(deduped.map(async (url) => {
        signal?.throwIfAborted();
        try {
            // Native transport timeout closes the local HTTP request; no
            // uncancellable Promise.race timer. autoResume otherwise permits
            // minutes of SDK retries after a processing_continues response.
            // The public scrape API has no AbortSignal: caller abort only stops
            // waiting here; remote processing may continue until its own limits.
            // Do not set scrape.timeout: this SDK overrides transport timeout
            // with that server timeout + 5 seconds.
            const doc = await awaitWithSignal(client.scrape(url, {
                formats: ['markdown'], onlyMainContent: true, autoResume: false
            }), signal);
            const md = (doc?.markdown || '').trim();
            if (md.length > 100) {
                results.set(url, md.substring(0, maxCharsPerUrl));
            }
        } catch (err) {
            signal?.throwIfAborted();
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

/**
 * Replace raw description snippets in Brave-format search result text with Firecrawl markdown.
 * Pattern matched: "N. Title\n   Description\n   Source: https://url"
 * - Where enrichedMap has a match for the URL, the description is replaced with Firecrawl markdown.
 * - Where no match exists, the original description is preserved (graceful fallback).
 * DDG results (no "Source:" URL lines) pass through unchanged.
 *
 * @param {string} searchResultText - Raw search result text (from cascade())
 * @param {Map<string, string>} enrichedMap - url → markdown from enrichUrls()
 * @returns {string} Search result text with enriched snippets substituted in-place
 */
function substituteEnrichedSnippets(searchResultText, enrichedMap) {
    if (!enrichedMap || enrichedMap.size === 0) return searchResultText;
    if (!searchResultText || !searchResultText.includes('Source:')) return searchResultText;

    // Match each Brave result block: "N. Title\n   description\n   Source: url"
    // Group 1: result header + prefix spaces for description line start
    // Group 2: original description text
    // Group 3: source line including URL
    // Group 4: the URL itself
    return searchResultText.replace(
        /(\d+\.\s+[^\n]+\n   )([^\n]+)(\n   Source:\s*(https?:\/\/\S+))/g,
        (match, prefix, _description, sourceLine, url) => {
            const md = enrichedMap.get(url);
            if (!md) return match; // fallback: keep original description
            // Collapse multi-line markdown to a single-line snippet for readability in the cascade block
            const snippet = md.substring(0, 400).replace(/\n+/g, ' ').trim();
            return `${prefix}${snippet}${sourceLine}`;
        }
    );
}

module.exports = { enrichUrls, substituteEnrichedSnippets };
