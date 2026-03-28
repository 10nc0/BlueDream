'use strict';

const axios = require('axios');
const logger = require('../logger');
const capacityManager = require('../../utils/playground-capacity');
const { braveCache } = require('../fetch-cache');

module.exports = {
    name: 'brave-search',
    description: 'Web search via Brave Search API. Returns real-time search results as text or structured JSON.',
    parameters: {
        query: { type: 'string', required: true, description: 'Search query (max 500 chars)' },
        clientIp: { type: 'string', required: false, description: 'Caller IP for capacity throttling' },
        format: { type: 'string', required: false, description: "'text' (default) or 'json' for structured results" }
    },

    async execute(query, clientIp = null, opts = {}) {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return null;
        }
        const sanitizedQuery = query.trim().substring(0, 500);
        const format = opts.format || 'text';

        const BRAVE_API_KEY = process.env.PLAYGROUND_BRAVE_API;
        if (!BRAVE_API_KEY) {
            logger.debug('🦁 Brave: API key not configured, skipping');
            return null;
        }

        if (clientIp) {
            const braveCapacity = await capacityManager.consumeToken(clientIp, 'brave');
            if (!braveCapacity.allowed) {
                logger.debug({ ip: clientIp, reason: braveCapacity.reason }, '🦁 Brave: capacity exhausted');
                return null;
            }
        }

        const cacheKey = `brave:${sanitizedQuery}:${format}`;
        const cached = braveCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🦁 Brave: cache hit');
            return cached;
        }

        try {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🦁 Brave: searching for real-time context');
            const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
                headers: {
                    'Accept': 'application/json',
                    'X-Subscription-Token': BRAVE_API_KEY
                },
                params: {
                    q: sanitizedQuery,
                    count: 5,
                    text_decorations: false,
                    safesearch: 'moderate'
                },
                timeout: 5000
            });

            const results = response.data?.web?.results || [];
            if (results.length === 0) {
                logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🦁 Brave: no results found');
                return null;
            }

            logger.debug({ count: results.length, format }, '🦁 Brave: injecting results into prompt');

            let result;
            if (format === 'json') {
                const structured = results.slice(0, 5).map(r => ({
                    title: r.title || '',
                    url: r.url || '',
                    description: r.description || '',
                    age: r.age || null
                }));
                result = JSON.stringify(structured);
            } else {
                const context = results.slice(0, 5).map((r, i) =>
                    `${i + 1}. ${r.title || 'Untitled'}\n   ${r.description || ''}\n   Source: ${r.url || ''}`
                ).join('\n\n');
                result = `🌐 Web search results:\n${context}`;
            }

            braveCache.set(cacheKey, result);
            return result;
        } catch (err) {
            logger.error({ err }, 'Brave search error');
            return null;
        }
    }
};
