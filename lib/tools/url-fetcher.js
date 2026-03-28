'use strict';

const { fetchUrl, extractUrls } = require('../url-fetcher');

module.exports = {
    name: 'url-fetcher',
    description: 'Fetch and extract readable content from any web URL. Strips HTML, returns clean text.',
    parameters: {
        url: { type: 'string', required: true, description: 'The URL to fetch content from' }
    },

    async execute(url) {
        return fetchUrl(url);
    },

    extractUrls
};
