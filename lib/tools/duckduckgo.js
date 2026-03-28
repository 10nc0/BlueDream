'use strict';

const axios = require('axios');
const logger = require('../logger');
const { duckduckgoCache } = require('../fetch-cache');

module.exports = {
    name: 'duckduckgo',
    description: 'Instant answers via DuckDuckGo API. Returns quick facts and related topics.',
    parameters: {
        query: { type: 'string', required: true, description: 'Search query (max 500 chars)' }
    },

    async execute(query) {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return null;
        }
        const sanitizedQuery = query.trim().substring(0, 500);

        const cacheKey = `ddg:${sanitizedQuery}`;
        const cached = duckduckgoCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: cache hit');
            return cached;
        }

        const params = {
            q: sanitizedQuery,
            format: 'json',
            no_html: 1,
            skip_disambig: 1,
            t: 'nyanbook'
        };
        const url = `https://api.duckduckgo.com/?${new URLSearchParams(params).toString()}`;

        try {
            const response = await axios.get(url, { timeout: 5000, responseType: 'json' });
            const data = response.data;

            if (!data || typeof data !== 'object') {
                logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: non-JSON response, skipping');
                return null;
            }

            const context = [];
            if (data.AbstractText) {
                const src = data.AbstractSource ? ` [${data.AbstractSource}]` : '';
                const srcUrl = data.AbstractURL ? ` — ${data.AbstractURL}` : '';
                context.push(`📚 ${data.AbstractText}${src}${srcUrl}`);
                logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: instant answer found');
            }
            if (data.RelatedTopics && Array.isArray(data.RelatedTopics) && data.RelatedTopics.length > 0) {
                const relevantTopics = data.RelatedTopics.filter(t => t && t.Text && !t.FirstURL).slice(0, 3);
                if (relevantTopics.length > 0) {
                    context.push('Related information:');
                    relevantTopics.forEach(topic => {
                        if (topic.Text) context.push(`  • ${topic.Text}`);
                    });
                }
            }

            if (context.length > 0) {
                logger.debug({ count: context.length }, '🔍 DDG: injecting results');
                const result = context.join('\n');
                duckduckgoCache.set(cacheKey, result);
                return result;
            } else {
                logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔍 DDG: no results, using base knowledge');
                return null;
            }
        } catch (err) {
            logger.error({ err }, '🔍 DDG search error');
            return null;
        }
    }
};
