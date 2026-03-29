const BOOK_LIST_COLS = `b.id, b.name, b.input_platform, b.output_platform, b.output_credentials,
    b.output_0n_url, b.outpipes_user, b.status, b.contact_info, b.tags, b.archived, b.fractal_id,
    b.created_by_admin_id, b.created_at, b.updated_at, b.sort_order`;

const BOOKS_CACHE = new Map();
const BOOKS_CACHE_TTL_MS = 30000;

function _cacheKey(tenantSchema, userId) {
    return `${tenantSchema}:${userId}`;
}

function _getCachedBooks(tenantSchema, userId) {
    const key = _cacheKey(tenantSchema, userId);
    const entry = BOOKS_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > BOOKS_CACHE_TTL_MS) {
        BOOKS_CACHE.delete(key);
        return null;
    }
    return entry.data;
}

function _setCachedBooks(tenantSchema, userId, data) {
    const key = _cacheKey(tenantSchema, userId);
    BOOKS_CACHE.set(key, { data, ts: Date.now() });
    setTimeout(() => BOOKS_CACHE.delete(key), BOOKS_CACHE_TTL_MS);
}

function _invalidateBooksCache(tenantSchema, userId) {
    BOOKS_CACHE.delete(_cacheKey(tenantSchema, userId));
}

setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of BOOKS_CACHE.entries()) {
        if (now - entry.ts > BOOKS_CACHE_TTL_MS) BOOKS_CACHE.delete(uid);
    }
}, 60000);

const shareRateLimiter = new Map();
const SHARE_RATE_LIMIT = 10;
const SHARE_RATE_WINDOW_MS = 60 * 60 * 1000;

function checkShareRateLimit(userId) {
    const now = Date.now();
    const userShares = shareRateLimiter.get(userId) || [];
    const recentShares = userShares.filter(ts => now - ts < SHARE_RATE_WINDOW_MS);
    shareRateLimiter.set(userId, recentShares);
    if (recentShares.length >= SHARE_RATE_LIMIT) return false;
    recentShares.push(now);
    shareRateLimiter.set(userId, recentShares);
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [userId, shares] of shareRateLimiter.entries()) {
        const recent = shares.filter(ts => now - ts < SHARE_RATE_WINDOW_MS);
        if (recent.length === 0) {
            shareRateLimiter.delete(userId);
        } else {
            shareRateLimiter.set(userId, recent);
        }
    }
}, 10 * 60 * 1000);

async function verifyBookOwnership(pool, bookFractalId, userEmail, tenantSchema) {
    const normalizedOwnerEmail = userEmail.toLowerCase().trim();
    const result = await pool.query(`
        SELECT br.fractal_id, br.book_name, br.tenant_schema
        FROM core.book_registry br
        WHERE br.fractal_id = $1
          AND br.tenant_schema = $2
          AND br.status = 'active'
          AND LOWER(br.tenant_email) = $3
    `, [bookFractalId, tenantSchema, normalizedOwnerEmail]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
}

module.exports = {
    BOOK_LIST_COLS,
    _getCachedBooks,
    _setCachedBooks,
    _invalidateBooksCache,
    checkShareRateLimit,
    verifyBookOwnership
};
