const crypto = require('crypto');
const { computePayloadId } = require('../../lib/drop-writer');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_SCHEMA = /^tenant_[a-z0-9_]+$/;

// AES-256-GCM cursor sealing — the cursor is opaque to callers and non-forgeable.
// source_id never leaves the server; only the integer row id (SERIAL PK) is
// inside the sealed envelope, giving a globally-unique cross-book tiebreaker.
const CURSOR_SEAL_KEY = (() => {
    const secret = process.env.SESSION_SECRET || 'dev-fallback-cursor-key-change-in-prod';
    return crypto.createHash('sha256').update('cursor-seal:' + secret).digest();
})();

function sealCursor(ts, rowId) {
    const plain = JSON.stringify({ ts, id: rowId });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CURSOR_SEAL_KEY, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function unsealCursor(token) {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 29) throw new Error('cursor too short');
    const iv       = buf.slice(0, 12);
    const authTag  = buf.slice(12, 28);
    const enc      = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', CURSOR_SEAL_KEY, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    const decoded = JSON.parse(plain);
    if (!decoded.ts || typeof decoded.ts !== 'string' ||
        decoded.id == null || typeof decoded.id !== 'number') {
        throw new Error('malformed cursor fields');
    }
    return decoded;
}

function register(app, deps) {
    const { pool, middleware, tenantMiddleware, logger } = deps;
    const { requireAuth } = middleware;
    const { setTenantContext } = tenantMiddleware || {};

    app.get('/api/mesh/tag/:tagValue', requireAuth, setTenantContext, async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;

            // Defense-in-depth: tenantSchema must be server-derived and well-formed.
            if (!tenantSchema || !VALID_SCHEMA.test(tenantSchema)) {
                logger.error({ tenantSchema }, 'mesh: invalid tenantSchema — rejecting');
                return res.status(500).json({ error: 'Internal error' });
            }

            const client = req.dbClient || pool;
            const { tagValue } = req.params;

            if (!tagValue || tagValue.trim().length === 0) {
                return res.status(400).json({ error: 'Tag value is required' });
            }
            if (tagValue.length > 500) {
                return res.status(400).json({ error: 'Tag value too long (max 500 characters)' });
            }

            const rawLimit = parseInt(req.query.limit, 10);
            const limit = (!isNaN(rawLimit) && rawLimit > 0 && rawLimit <= MAX_LIMIT)
                ? rawLimit
                : DEFAULT_LIMIT;

            // Parse sealed cursor.  Cursor format: AES-256-GCM({ ts, id: drops.id }).
            // drops.id is a SERIAL PRIMARY KEY — globally unique within the tenant,
            // so it is a sound cross-book tiebreaker.  source_id never appears in
            // the cursor; callers receive only the opaque sealed token.
            let beforeTs = null;
            let beforeId = null;
            if (req.query.before_cursor) {
                try {
                    const decoded = unsealCursor(req.query.before_cursor);
                    beforeTs = decoded.ts;
                    beforeId = decoded.id;
                } catch (_) {
                    return res.status(400).json({ error: 'Invalid cursor' });
                }
            }

            let rows;

            if (beforeTs && beforeId != null) {
                // Keyset page: rows strictly before the cursor position in
                // (COALESCE(sent_at, created_at) DESC, id DESC) order.
                const result = await client.query(`
                    SELECT d.id,
                           d.source_id,
                           d.metadata_text,
                           d.extracted_tags,
                           COALESCE(d.sent_at, d.created_at) AS sent_at,
                           b.fractal_id AS book_fractal_id,
                           b.name       AS book_name
                    FROM   ${tenantSchema}.books b
                    JOIN   ${tenantSchema}.drops  d ON d.book_id = b.id
                    WHERE  d.extracted_tags @> ARRAY[lower($1)]
                      AND  (COALESCE(d.sent_at, d.created_at), d.id)
                                < ($2::timestamptz, $3::integer)
                    ORDER  BY COALESCE(d.sent_at, d.created_at) DESC,
                              d.id DESC
                    LIMIT  $4
                `, [tagValue, beforeTs, beforeId, limit + 1]);
                rows = result.rows;
            } else {
                // First page — no cursor condition.
                const result = await client.query(`
                    SELECT d.id,
                           d.source_id,
                           d.metadata_text,
                           d.extracted_tags,
                           COALESCE(d.sent_at, d.created_at) AS sent_at,
                           b.fractal_id AS book_fractal_id,
                           b.name       AS book_name
                    FROM   ${tenantSchema}.books b
                    JOIN   ${tenantSchema}.drops  d ON d.book_id = b.id
                    WHERE  d.extracted_tags @> ARRAY[lower($1)]
                    ORDER  BY COALESCE(d.sent_at, d.created_at) DESC,
                              d.id DESC
                    LIMIT  $2
                `, [tagValue, limit + 1]);
                rows = result.rows;
            }

            // Detect whether there is a next page by over-fetching limit+1.
            const hasMore = rows.length > limit;
            if (hasMore) rows = rows.slice(0, limit);

            // Seal cursor from the last row's (ts, id) pair.
            // d.id (SERIAL PK) is the tiebreaker; source_id stays server-only.
            let nextCursor = null;
            if (hasMore && rows.length > 0) {
                const last = rows[rows.length - 1];
                const lastTs = last.sent_at instanceof Date
                    ? last.sent_at.toISOString()
                    : String(last.sent_at);
                nextCursor = sealCursor(lastTs, last.id);
            }

            const results = rows.map(row => ({
                payload_id:      computePayloadId(row.source_id),
                book_fractal_id: row.book_fractal_id,
                book_name:       row.book_name,
                sent_at:         row.sent_at instanceof Date
                                    ? row.sent_at.toISOString()
                                    : row.sent_at,
                metadata_text:   row.metadata_text,
                extracted_tags:  row.extracted_tags
            }));

            res.set('X-Auth-Scope', req.authMethod === 'user_token' ? 'user_token' : 'session');
            return res.json({ results, next_cursor: nextCursor });

        } catch (error) {
            logger.error({ err: error }, 'Mesh tag query error');
            next(error);
        }
    });
}

module.exports = { register };
