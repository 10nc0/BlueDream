'use strict';

const { fetchUrl, extractUrls } = require('../url-fetcher');
const { urlCache } = require('../fetch-cache');
const logger = require('../logger');

module.exports = {
    name: 'url-fetcher',
    description: 'Fetch and extract readable content from any web URL. Strips HTML, returns clean text.',
    parameters: {
        url: { type: 'string', required: true, description: 'The URL to fetch content from' }
    },

    async execute(url) {
        if (!url) return null;
        const cacheKey = `url:${url}`;
        const cached = urlCache.get(cacheKey);
        if (cached !== undefined) {
            logger.debug({ url: url.substring(0, 60) }, '🌐 URL fetcher: cache hit');
            return cached;
        }
        const result = await fetchUrl(url);
        if (result) urlCache.set(cacheKey, result);
        return result;
    },

    extractUrls
};
