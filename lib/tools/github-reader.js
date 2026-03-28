'use strict';

const { fetchUrl, detectUrlType } = require('../url-fetcher');

module.exports = {
    name: 'github-reader',
    description: 'Read GitHub repositories, files, trees, raw content, and Gists. Supports repos, blobs, trees, raw files, and gist URLs.',
    parameters: {
        url: { type: 'string', required: true, description: 'GitHub URL (repo, blob, tree, raw, or gist)' }
    },

    async execute(url) {
        const type = detectUrlType(url);
        if (!type.startsWith('github')) {
            return null;
        }
        return fetchUrl(url);
    },

    isGitHubUrl(url) {
        const type = detectUrlType(url);
        return type.startsWith('github');
    }
};
