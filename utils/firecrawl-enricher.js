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
 * @param {string[]} urls                 - URLs to enrich (duplicates are deduped)
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=8000] - Per-URL timeout in milliseconds
 * @param {number}  [opts.maxCharsPerUrl=2000] - Truncate each page markdown to this length
 * @returns {Promise<Map<string, string>>} - Map of url → markdown (only successfully enriched URLs)
 */
async function enrichUrls(urls, { timeoutMs = 8000, maxCharsPerUrl = 2000 } = {}) {
    if (!Array.isArray(urls) || urls.length === 0) return new Map();

    const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
    if (!FIRECRAWL_API_KEY) return new Map();

    // Deduplicate, filter valid http(s) URLs (no hard cap — all cited URLs are eligible)
    const deduped = [...new Set(urls.filter(u => typeof u === 'string' && u.startsWith('http')))];
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
