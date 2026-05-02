'use strict';

// LINE Profile resolver — turns opaque LINE user IDs into display names at
// render time. No storage, no DB writes. Pure A-or-B cascade:
//
//   isLineUserId(id)  → call LINE Profile API → return displayName     (A)
//                     ↘ on 403 / network / timeout → return raw id     (B)
//
// LINE returns 403 if the user has not added/blocked the OA. That's the only
// non-200 path we care about; everything else (network, parse, timeout) lands
// on the same fallback.

const logger = require('./logger');

// LINE personal userIds are 'U' + 32 lowercase hex chars (33 chars total).
// Group IDs ('C...') and room IDs ('R...') aren't queryable via /bot/profile
// (those need /bot/group/.../member/...) — we leave those as raw IDs.
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

const PROFILE_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — display names rarely change mid-month
const CACHE_MAX_ENTRIES = 1000;            // bound memory; evict oldest on overflow (Map preserves insertion order)

// Per-process cache. Keyed by userId. Value: { name, expiresAt }.
// Same userId across multiple tenants → same name → one API call per ~day.
// Insertion-order Map gives O(1) FIFO eviction when full — good enough for a
// monthly-report / dashboard-list workload where the working set is small.
const cache = new Map();

function cacheSet(id, name) {
    if (cache.has(id)) cache.delete(id); // bump to most-recent position
    cache.set(id, { name, expiresAt: Date.now() + CACHE_TTL_MS });
    while (cache.size > CACHE_MAX_ENTRIES) {
        // Map iterator yields in insertion order — first key is oldest
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function isLineUserId(id) {
    return typeof id === 'string' && LINE_USER_ID_RE.test(id);
}

async function fetchProfile(userId, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
    try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal
        });
        if (!res.ok) {
            // 403 = user blocked / not friend; 404 = unknown id. Either way, fall back.
            return null;
        }
        const json = await res.json();
        return (typeof json?.displayName === 'string' && json.displayName.trim()) || null;
    } catch (err) {
        // AbortError, network error, JSON parse — all collapse to "use raw id"
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Resolve one ID to a display name, or return the ID unchanged. Never throws.
async function resolveLineUserId(id) {
    if (!isLineUserId(id)) return id;

    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) return id;

    const cached = cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.name || id;
    }

    const name = await fetchProfile(id, accessToken);
    cacheSet(id, name);
    return name || id;
}

// Resolve a list of contributor strings in parallel. LINE IDs become display
// names where available; everything else (phone numbers, Discord IDs, emails)
// passes through unchanged.
async function resolveContributors(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return ids;

    // Dedupe: a single batch may repeat the same userId many times (e.g. a
    // chatty contributor across 50 messages). One API call per unique id.
    const uniqueLineIds = new Set();
    for (const id of ids) if (isLineUserId(id)) uniqueLineIds.add(id);

    if (uniqueLineIds.size === 0) return ids;

    const lookups = await Promise.all(
        [...uniqueLineIds].map(async id => [id, await resolveLineUserId(id)])
    );
    const nameMap = new Map(lookups);

    const resolved = ids.map(id => nameMap.get(id) || id);

    const named = [...uniqueLineIds].filter(id => nameMap.get(id) !== id).length;
    logger.info({ lineCount: uniqueLineIds.size, named, fellBack: uniqueLineIds.size - named }, '👤 LINE profile resolution');

    return resolved;
}

module.exports = {
    isLineUserId,
    resolveLineUserId,
    resolveContributors,
    _cacheForTest: cache
};
