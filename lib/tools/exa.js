'use strict';

const logger = require('../logger');
const { exaCache } = require('../fetch-cache');
const { withRetry } = require('../fetch-retry');

// exa-js exports the constructor as .default
const ExaConstructor = require('exa-js').default;

module.exports = {
    name: 'exa',
    description: 'Semantic web search via Exa. Neural-indexed, finds conceptually relevant results DDG and Brave miss.',
    parameters: {
        query: { type: 'string', required: true, description: 'Search query (max 500 chars)' }
    },

    async execute(query) {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return null;
        }

        const EXA_API_KEY = process.env.EXA_API_KEY;
        if (!EXA_API_KEY) {
            logger.debug('🔭 Exa: API key not configured, skipping');
            return null;
        }

        const sanitizedQuery = query.trim().substring(0, 500);
        const cacheKey = `exa:${sanitizedQuery}`;
        const cached = exaCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔭 Exa: cache hit');
            return cached;
        }

        try {
            logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔭 Exa: searching for semantic context');
            const exa = new ExaConstructor(EXA_API_KEY);

            const response = await withRetry(
                () => exa.searchAndContents(sanitizedQuery, {
                    numResults: 5,
                    text: { maxCharacters: 400 },
                    useAutoprompt: true
                }),
                { maxAttempts: 3, backoffMs: 500, label: 'Exa' }
            );

            const results = response?.results || [];
            if (results.length === 0) {
                logger.debug({ query: sanitizedQuery.substring(0, 40) }, '🔭 Exa: no results found');
                return null;
            }

            const context = results
                .filter(r => r.title || r.text)
                .slice(0, 5)
                .map((r, i) => {
                    const snippet = (r.text || '').trim().replace(/\s+/g, ' ').substring(0, 300);
                    const title = r.title || 'Untitled';
                    const url = r.url || '';
                    return `${i + 1}. ${title}${url ? `\n   ${url}` : ''}${snippet ? `\n   ${snippet}` : ''}`;
                })
                .join('\n\n');

            if (!context) {
                return null;
            }

            const result = `🔭 Exa semantic results:\n${context}`;
            logger.debug({ count: results.length }, '🔭 Exa: injecting results');
            exaCache.set(cacheKey, result);
            return result;
        } catch (err) {
            logger.error({ err }, '🔭 Exa search error');
            return null;
        }
    }
};
