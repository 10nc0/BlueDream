'use strict';

const logger = require('./logger');

const MAX_TEXT_CHARS = 10000;
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'NyanBook-AI-Reader/1.0 (compatible; research reader)';

const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)\/?(?:#.*)?$/;
const GITHUB_BLOB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+?)(?:\?.*)?$/;
const GITHUB_TREE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?(?:\?.*)?$/;
const GITHUB_RAW_RE = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;
const GITHUB_GIST_RE = /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)\/?(?:raw\/.*)?$/;

function detectUrlType(url) {
    if (GITHUB_RAW_RE.test(url)) return 'github-raw';
    if (GITHUB_BLOB_RE.test(url)) return 'github-blob';
    if (GITHUB_TREE_RE.test(url)) return 'github-tree';
    if (GITHUB_REPO_RE.test(url)) return 'github-repo';
    if (GITHUB_GIST_RE.test(url)) return 'github-gist';
    return 'web';
}

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function extractTitle(html) {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
}

function decodeBase64Content(encoded) {
    const clean = encoded.replace(/\n/g, '');
    return Buffer.from(clean, 'base64').toString('utf8');
}

async function timedFetch(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...opts, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchGitHubRepo(owner, repo) {
    const readmeUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
    const infoUrl = `https://api.github.com/repos/${owner}/${repo}`;

    const [readmeRes, infoRes] = await Promise.allSettled([
        timedFetch(readmeUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' } }),
        timedFetch(infoUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' } })
    ]);

    let repoMeta = '';
    if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
        const info = await infoRes.value.json();
        const parts = [];
        if (info.full_name) parts.push(`Repository: ${info.full_name}`);
        if (info.description) parts.push(`Description: ${info.description}`);
        if (info.language) parts.push(`Primary language: ${info.language}`);
        if (info.stargazers_count != null) parts.push(`Stars: ${info.stargazers_count}`);
        if (info.topics && info.topics.length) parts.push(`Topics: ${info.topics.join(', ')}`);
        if (info.license && info.license.name) parts.push(`License: ${info.license.name}`);
        repoMeta = parts.join('\n');
    }

    let readmeText = '';
    if (readmeRes.status === 'fulfilled' && readmeRes.value.ok) {
        const data = await readmeRes.value.json();
        if (data.encoding === 'base64' && data.content) {
            readmeText = decodeBase64Content(data.content);
        }
    }

    const combined = [repoMeta, readmeText ? `\n--- README ---\n${readmeText}` : ''].join('\n').trim();
    if (!combined) throw new Error('No content retrieved from GitHub repository');

    return {
        text: combined.slice(0, MAX_TEXT_CHARS),
        title: `GitHub: ${owner}/${repo}`,
        sourceLabel: `github.com/${owner}/${repo}`
    };
}

async function fetchGitHubFile(owner, repo, branch, path) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const res = await timedFetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' }
    });

    if (!res.ok) {
        if (res.status === 404) throw new Error(`File not found: ${path}`);
        throw new Error(`GitHub API error ${res.status}`);
    }

    const data = await res.json();

    if (Array.isArray(data)) {
        const listing = data.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`).join('\n');
        return {
            text: `Directory listing for ${path || '/'} in ${owner}/${repo}@${branch}:\n\n${listing}`,
            title: `GitHub: ${owner}/${repo}/${path || ''}`,
            sourceLabel: `github.com/${owner}/${repo}/tree/${branch}/${path || ''}`
        };
    }

    if (data.encoding === 'base64' && data.content) {
        const content = decodeBase64Content(data.content);
        return {
            text: content.slice(0, MAX_TEXT_CHARS),
            title: `${path} — ${owner}/${repo}`,
            sourceLabel: `github.com/${owner}/${repo}/blob/${branch}/${path}`
        };
    }

    if (data.download_url) {
        const raw = await timedFetch(data.download_url, { headers: { 'User-Agent': USER_AGENT } });
        const text = await raw.text();
        return {
            text: text.slice(0, MAX_TEXT_CHARS),
            title: `${path} — ${owner}/${repo}`,
            sourceLabel: `github.com/${owner}/${repo}/blob/${branch}/${path}`
        };
    }

    throw new Error('Unable to retrieve file content');
}

async function fetchGitHubRaw(url) {
    const res = await timedFetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Raw fetch error ${res.status}`);
    const text = await res.text();
    const m = GITHUB_RAW_RE.exec(url);
    const label = m ? `raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : url;
    return {
        text: text.slice(0, MAX_TEXT_CHARS),
        title: `Raw file — ${label}`,
        sourceLabel: label
    };
}

async function fetchGitHubGist(owner, gistId) {
    const apiUrl = `https://api.github.com/gists/${gistId}`;
    const res = await timedFetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) throw new Error(`Gist API error ${res.status}`);
    const data = await res.json();

    const parts = [];
    if (data.description) parts.push(`Gist: ${data.description}`);
    for (const [filename, file] of Object.entries(data.files || {})) {
        parts.push(`\n--- ${filename} ---`);
        parts.push(file.content || '(binary)');
    }

    return {
        text: parts.join('\n').slice(0, MAX_TEXT_CHARS),
        title: `Gist by ${owner}: ${data.description || gistId}`,
        sourceLabel: `gist.github.com/${owner}/${gistId}`
    };
}

async function fetchWebContent(url) {
    const res = await timedFetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NyanBook-Reader/1.0)',
            'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9'
        },
        redirect: 'follow'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

    const contentType = res.headers.get('content-type') || '';
    let text;

    if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
        text = await res.text();
        return {
            text: text.slice(0, MAX_TEXT_CHARS),
            title: new URL(url).hostname,
            sourceLabel: url
        };
    }

    const html = await res.text();
    const title = extractTitle(html) || new URL(url).hostname;
    const stripped = stripHtml(html);

    return {
        text: stripped.slice(0, MAX_TEXT_CHARS),
        title,
        sourceLabel: url
    };
}

async function fetchUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only HTTP/HTTPS URLs are supported');
    }

    const type = detectUrlType(rawUrl);
    logger.info({ url: rawUrl, type }, '🔗 URL fetcher: retrieving');

    switch (type) {
        case 'github-repo': {
            const m = GITHUB_REPO_RE.exec(rawUrl);
            return fetchGitHubRepo(m[1], m[2]);
        }
        case 'github-blob': {
            const m = GITHUB_BLOB_RE.exec(rawUrl);
            return fetchGitHubFile(m[1], m[2], m[3], m[4]);
        }
        case 'github-tree': {
            const m = GITHUB_TREE_RE.exec(rawUrl);
            return fetchGitHubFile(m[1], m[2], m[3], m[4] || '');
        }
        case 'github-raw': {
            return fetchGitHubRaw(rawUrl);
        }
        case 'github-gist': {
            const m = GITHUB_GIST_RE.exec(rawUrl);
            return fetchGitHubGist(m[1], m[2]);
        }
        default:
            return fetchWebContent(rawUrl);
    }
}

function extractUrls(text) {
    if (!text) return [];
    const URL_RE = /https?:\/\/[^\s<>"']+/g;
    const found = text.match(URL_RE) || [];
    return [...new Set(found)].filter(u => {
        try { new URL(u); return true; } catch { return false; }
    });
}

module.exports = { fetchUrl, extractUrls, detectUrlType };
