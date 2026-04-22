'use strict';

const dns = require('dns').promises;
const net = require('net');
const logger = require('./logger');

const MAX_TEXT_CHARS = 10000;
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'NyanBook-AI-Reader/1.0 (compatible; research reader)';

// SSRF guard — blocks fetches to private/loopback/link-local addresses.
// Covers: loopback (127/8), RFC-1918 (10/8, 172.16/12, 192.168/16),
// link-local / AWS metadata (169.254/16), IPv6 loopback (::1), IPv6 ULA (fc00::/7),
// and IPv4-mapped IPv6 (::ffff:x.x.x.x / ::ffff:XXXX:XXXX).

// Normalise an address string to a dotted-decimal IPv4 string where possible.
// Handles three forms:
//   - pure IPv4:              "127.0.0.1"           → "127.0.0.1"
//   - mixed IPv4-mapped IPv6: "::ffff:127.0.0.1"    → "127.0.0.1"
//   - hex IPv4-mapped IPv6:   "::ffff:7f00:0001"    → "127.0.0.1"
// Returns null if the address is not IPv4 / IPv4-mapped.
function normaliseToIPv4(addr) {
    const lower = addr.toLowerCase().trim();

    // Pure IPv4
    if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return lower;

    // Mixed notation: ::ffff:a.b.c.d
    const mixedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mixedMatch) return mixedMatch[1];

    // Hex notation: ::ffff:HHHH:HHHH  (last 32 bits = IPv4)
    const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    }

    return null; // pure IPv6 — handled separately
}

function isPrivateIPv4(dotted) {
    const parts = dotted.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return (
        a === 127 ||                           // 127.0.0.0/8  loopback
        a === 10 ||                            // 10.0.0.0/8   RFC 1918
        (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 RFC 1918
        (a === 192 && b === 168) ||            // 192.168.0.0/16 RFC 1918
        (a === 169 && b === 254) ||            // 169.254.0.0/16 link-local / metadata
        a === 0                                // 0.0.0.0/8    "this" network
    );
}

function isPrivateIp(addr) {
    const ipv4 = normaliseToIPv4(addr);
    if (ipv4 !== null) return isPrivateIPv4(ipv4);

    // Pure IPv6 checks
    const lower = addr.toLowerCase().trim();
    if (lower === '::1') return true;              // loopback
    if (lower === '::') return true;               // unspecified
    if (/^fe80:/i.test(lower)) return true;        // link-local
    if (/^fc/i.test(lower)) return true;           // ULA
    if (/^fd/i.test(lower)) return true;           // ULA

    return false;
}

async function assertPublicUrl(url) {
    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }

    // Strip IPv6 brackets from literal IPv6 hostnames  (e.g. http://[::1]/)
    const bareHost = hostname.replace(/^\[|\]$/g, '');

    // Reject bare "localhost" and literal IP addresses that are private/reserved.
    // net.isIP() returns 4, 6, or 0 — only run IP range checks on actual IP literals,
    // so hostnames that happen to start with "fc" / "fd" are never falsely blocked.
    if (bareHost === 'localhost') {
        throw new Error('URL resolves to a private or reserved IP address');
    }
    if (net.isIP(bareHost) !== 0 && isPrivateIp(bareHost)) {
        throw new Error('URL resolves to a private or reserved IP address');
    }

    // Fail-closed: if DNS pre-check cannot resolve the host, block the request.
    let address;
    try {
        ({ address } = await dns.lookup(bareHost));
    } catch (err) {
        logger.warn({ hostname: bareHost, err: err.message }, 'SSRF guard: DNS lookup failed — blocking request');
        throw new Error('URL resolves to a private or reserved IP address');
    }

    if (isPrivateIp(address)) {
        throw new Error('URL resolves to a private or reserved IP address');
    }
}

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

    // SSRF guard: resolve hostname and reject private/reserved IPs before fetching.
    await assertPublicUrl(rawUrl);

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

// Exported for testing — not part of the public API surface.
module.exports = { fetchUrl, extractUrls, detectUrlType, assertPublicUrl, isPrivateIp, normaliseToIPv4, isPrivateIPv4 };
