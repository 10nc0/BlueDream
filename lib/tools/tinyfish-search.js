'use strict';

const axios = require('axios');
const logger = require('../logger');
const { tinyfishCache } = require('../fetch-cache');
const { withRetry } = require('../fetch-retry');

const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai';
const DOMAIN_TYPES = new Set(['web', 'news', 'research_paper']);

function buildSearchParams(query, opts) {
    const params = {
        query,
        purpose: opts.purpose || 'Find current, credible sources for a grounded NyanBook answer',
        domain_type: DOMAIN_TYPES.has(opts.domainType) ? opts.domainType : 'web'
    };

    if (params.domain_type !== 'research_paper') {
        if (Number.isInteger(opts.recencyMinutes) && opts.recencyMinutes >= 1 && opts.recencyMinutes <= 5256000) {
            params.recency_minutes = opts.recencyMinutes;
        } else {
            if (/^\d{4}-\d{2}-\d{2}$/.test(opts.afterDate || '')) params.after_date = opts.afterDate;
            if (/^\d{4}-\d{2}-\d{2}$/.test(opts.beforeDate || '')) params.before_date = opts.beforeDate;
        }
    }
    if (/^[A-Za-z]{2}$/.test(opts.location || '')) params.location = opts.location.toUpperCase();
    if (/^[A-Za-z]{2,3}$/.test(opts.language || '')) params.language = opts.language.toLowerCase();
    if (params.domain_type === 'research_paper') {
        if (Number.isInteger(opts.pubYearMin) && opts.pubYearMin >= 0 && opts.pubYearMin <= 9999) {
            params.pub_year_min = opts.pubYearMin;
        }
        if (Number.isInteger(opts.pubYearMax) && opts.pubYearMax >= 0 && opts.pubYearMax <= 9999) {
            params.pub_year_max = opts.pubYearMax;
        }
    }

    return params;
}

module.exports = {
    name: 'tinyfish-search',
    description: 'Direct live web search via TinyFish. Used as the first generic-search provider, with Brave and DDG fallbacks.',
    parameters: {
        query: { type: 'string', required: true, description: 'Search query (max 500 chars)' },
        format: { type: 'string', required: false, description: "'text' (default) or 'json' for structured results" },
        domainType: { type: 'string', required: false, description: "'web' (default), 'news', or 'research_paper'" },
        recencyMinutes: { type: 'number', required: false, description: 'Only return results from this many minutes ago' },
        afterDate: { type: 'string', required: false, description: 'Earliest result date in YYYY-MM-DD format' },
        beforeDate: { type: 'string', required: false, description: 'Latest result date in YYYY-MM-DD format' },
        pubYearMin: { type: 'number', required: false, description: 'Earliest publication year for research_paper searches' },
        pubYearMax: { type: 'number', required: false, description: 'Latest publication year for research_paper searches' },
        location: { type: 'string', required: false, description: 'Two-letter country code' },
        language: { type: 'string', required: false, description: 'Result language code' }
    },

    async execute(query, opts = {}) {
        // Registry calls multi-parameter tools with one args object, while the
        // SearchKernel calls providers positionally.
        if (query && typeof query === 'object') {
            opts = { ...query, format: query.format || 'text' };
            query = query.query;
        }

        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return null;
        }

        const apiKey = process.env.TINYFISH_API_KEY;
        if (!apiKey) {
            logger.debug('🐟 TinyFish: API key not configured, skipping');
            return null;
        }

        const sanitizedQuery = query.trim().substring(0, 500);
        const format = opts.format || 'text';
        const searchParams = buildSearchParams(sanitizedQuery, opts);
        const cacheKey = `tinyfish:${JSON.stringify(searchParams)}:${format}`;
        const cached = tinyfishCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🐟 TinyFish: cache hit');
            return cached;
        }

        try {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🐟 TinyFish: searching directly');
            const response = await withRetry(
                () => axios.get(TINYFISH_SEARCH_URL, {
                    headers: {
                        'Accept': 'application/json',
                        'X-API-Key': apiKey
                    },
                    params: searchParams,
                    timeout: 8000
                }),
                { maxAttempts: 3, backoffMs: 500, label: 'TinyFish' }
            );

            const results = response.data?.results || [];
            if (results.length === 0) {
                logger.debug('🐟 TinyFish: no usable results, falling back');
                return null;
            }

            const structured = results.slice(0, 10).map(result => ({
                title: result.title || '',
                url: result.url || '',
                description: result.snippet || '',
                age: result.date || null,
                siteName: result.site_name || null
            }));

            const output = format === 'json'
                ? JSON.stringify(structured)
                : `🐟 TinyFish live web results:\n${structured.map((result, index) =>
                    `${index + 1}. ${result.title || 'Untitled'}\n   ${result.description || ''}\n   Source: ${result.url || ''}${result.age ? `\n   Date: ${result.age}` : ''}`
                ).join('\n\n')}`;

            tinyfishCache.set(cacheKey, output);
            logger.info({ count: structured.length }, '🐟 TinyFish: live results injected');
            return output;
        } catch (err) {
            // Do not log the Axios error object: request headers contain the API key.
            logger.warn({
                status: err.response?.status || null,
                code: err.code || null
            }, '🐟 TinyFish search unavailable, falling back');
            return null;
        }
    }
};