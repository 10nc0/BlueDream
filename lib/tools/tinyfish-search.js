'use strict';

const axios = require('axios');
const logger = require('../logger');
const { tinyfishCache } = require('../fetch-cache');

const MONID_RUN_URL = 'https://api.monid.ai/v1/run';

module.exports = {
    name: 'tinyfish-search',
    description: 'Live web search via TinyFish through Monid. Used as the first generic-search provider, with Brave and DDG fallbacks.',
    parameters: {
        query: { type: 'string', required: true, description: 'Search query (max 500 chars)' },
        format: { type: 'string', required: false, description: "'text' (default) or 'json' for structured results" }
    },

    async execute(query, opts = {}) {
        // Registry calls multi-parameter tools with one args object, while the
        // SearchKernel calls providers positionally.
        if (query && typeof query === 'object') {
            opts = { format: query.format || 'text' };
            query = query.query;
        }

        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return null;
        }

        const apiKey = process.env.MONID_API;
        if (!apiKey) {
            logger.debug('🐟 TinyFish: MONID_API not configured, skipping');
            return null;
        }

        const sanitizedQuery = query.trim().substring(0, 500);
        const format = opts.format || 'text';
        const cacheKey = `tinyfish:${sanitizedQuery}:${format}`;
        const cached = tinyfishCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🐟 TinyFish: cache hit');
            return cached;
        }

        try {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🐟 TinyFish: searching through Monid');
            const response = await axios.post(
                MONID_RUN_URL,
                {
                    provider: 'tinyfish',
                    endpoint: '/search',
                    input: {
                        queryParams: {
                            query: sanitizedQuery,
                            purpose: 'Find current, credible sources for a grounded NyanBook answer',
                            domain_type: 'web'
                        }
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 8000
                }
            );

            const results = response.data?.output?.results || [];
            if (response.data?.status !== 'COMPLETED' || results.length === 0) {
                logger.debug({
                    status: response.data?.status || null,
                    providerStatus: response.data?.providerResponse?.httpStatus || null
                }, '🐟 TinyFish: no usable results, falling back');
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
            // Do not log the Axios error object: request headers contain MONID_API.
            logger.warn({
                status: err.response?.status || null,
                providerStatus: err.response?.data?.providerResponse?.httpStatus || null,
                code: err.response?.data?.providerResponse?.error?.error?.code || err.code || null
            }, '🐟 TinyFish search unavailable, falling back');
            return null;
        }
    }
};