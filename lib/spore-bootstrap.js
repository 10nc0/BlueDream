'use strict';

/**
 * lib/spore-bootstrap.js
 *
 * Core validation and query logic for POST /api/agent/bootstrap (Spore Protocol).
 * Extracted so tests can exercise validation and DB stubs without spinning up Express.
 *
 * Public API:
 *   validateBootstrapEntries(raw)    → { ok, error, entries }
 *   fetchBookPayload(pool, item)     → book data object or error slot
 *   runBootstrap(raw, pool, opts)    → { bootstrapAt, totalBooks, books[] }
 */

const crypto = require('crypto');
const format = require('pg-format');
const { assertValidSchemaName, ISO8601_STRICT_RE } = require('./validators');

const MAX_BOOKS   = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT   = 200;

/**
 * Validate and normalise the raw `books` array from the request body.
 * Returns { ok: true, entries } or { ok: false, status, error }.
 *
 * Each normalised entry:
 *   { token: string, limit: number, since: string|null, tokenIndex: number }
 */
function validateBootstrapEntries(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, status: 400, error: 'books must be a non-empty array' };
    }
    if (raw.length > MAX_BOOKS) {
        return { ok: false, status: 400, error: `Too many books — max ${MAX_BOOKS} per call` };
    }

    const entries = [];
    for (let i = 0; i < raw.length; i++) {
        const e = raw[i];
        if (!e || typeof e.token !== 'string' || !e.token.trim()) {
            return { ok: false, status: 400, error: `books[${i}].token must be a non-empty string` };
        }

        let limit = DEFAULT_LIMIT;
        if (e.limit != null) {
            limit = parseInt(e.limit, 10);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
                return { ok: false, status: 400, error: `books[${i}].limit must be an integer 1–${MAX_LIMIT}` };
            }
        }

        let since = null;
        if (e.since != null) {
            if (typeof e.since !== 'string' || !ISO8601_STRICT_RE.test(e.since)) {
                return { ok: false, status: 400, error: `books[${i}].since must be a strict ISO 8601 timestamp (e.g. 2026-01-01T00:00:00.000Z)` };
            }
            const d = new Date(e.since);
            if (isNaN(d.getTime())) {
                return { ok: false, status: 400, error: `books[${i}].since date value is out of range` };
            }
            since = e.since;
        }

        entries.push({ token: e.token.trim(), limit, since, tokenIndex: i });
    }
    return { ok: true, entries };
}

/**
 * Batch-resolve token hashes against core.book_registry.
 * Returns a Map<hash → registry row>.
 */
async function resolveTokenHashes(pool, hashes) {
    if (hashes.length === 0) return new Map();
    const result = await pool.query(
        `SELECT agent_token_hash, fractal_id, tenant_schema, book_name
         FROM core.book_registry
         WHERE agent_token_hash = ANY($1::text[])`,
        [hashes]
    );
    return new Map(result.rows.map(r => [r.agent_token_hash, r]));
}

/**
 * Fetch tags, stats, and recent messages for one validated book entry.
 * Returns either a full book data object or an error slot.
 *
 * item: { tokenIndex, limit, since, registryRow: { fractal_id, tenant_schema, book_name } }
 */
async function fetchBookPayload(pool, item) {
    const { fractal_id, tenant_schema, book_name } = item.registryRow;

    try {
        assertValidSchemaName(tenant_schema);
    } catch {
        return { token_index: item.tokenIndex, error: 'invalid_token' };
    }

    // Build parameterised messages query
    const msgParams = [fractal_id, item.limit];
    let msgWhere = 'book_fractal_id = $1';
    if (item.since) {
        msgParams.push(item.since);
        msgWhere += ` AND COALESCE(sent_at, recorded_at) > $${msgParams.length}`;
    }

    try {
        const [bookResult, statsResult, msgsResult] = await Promise.all([
            // Title + tags from tenant books table (tags is TEXT[] column)
            pool.query(
                format(
                    `SELECT name, COALESCE(tags, '{}') AS tags
                     FROM %I.books WHERE fractal_id = $1 LIMIT 1`,
                    tenant_schema
                ),
                [fractal_id]
            ),
            // Stats
            pool.query(
                format(
                    `SELECT COUNT(*) AS message_count,
                            MAX(COALESCE(sent_at, recorded_at)) AS last_message_at
                     FROM %I.anatta_messages WHERE book_fractal_id = $1`,
                    tenant_schema
                ),
                [fractal_id]
            ),
            // Recent messages with optional since cursor
            pool.query(
                format(
                    `SELECT id, body, sender_name, has_attachment, media_url,
                            COALESCE(sent_at, recorded_at) AS sent_at
                     FROM %I.anatta_messages
                     WHERE ${msgWhere}
                     ORDER BY COALESCE(sent_at, recorded_at) DESC
                     LIMIT $2`,
                    tenant_schema
                ),
                msgParams
            )
        ]);

        const bookRow   = bookResult.rows[0];
        const statsRow  = statsResult.rows[0];
        const title     = bookRow?.name || book_name || null;
        const tags      = bookRow?.tags || [];

        const messages = msgsResult.rows.map(r => {
            const ts = r.sent_at;
            return {
                id:             r.id,
                body:           r.body || '',
                sender:         r.sender_name || null,
                sent_at:        ts instanceof Date ? ts.toISOString()
                                                   : (ts ? new Date(ts).toISOString() : null),
                has_attachment: !!r.has_attachment,
                media_url:      r.media_url || null
            };
        });

        return {
            token_index:  item.tokenIndex,
            fractal_id,
            title,
            tags,
            stats: {
                message_count:   parseInt(statsRow?.message_count, 10) || 0,
                last_message_at: statsRow?.last_message_at
                    ? (statsRow.last_message_at instanceof Date
                        ? statsRow.last_message_at.toISOString()
                        : new Date(statsRow.last_message_at).toISOString())
                    : null
            },
            messages
        };
    } catch (err) {
        throw err;
    }
}

/**
 * Top-level orchestrator called by the route handler and tests.
 *
 * Returns:
 *   { ok: true, bootstrap_at, total_books, books }
 *   { ok: false, status, error }     ← request-level validation failures
 */
async function runBootstrap(rawEntries, pool, { logger } = {}) {
    const validation = validateBootstrapEntries(rawEntries);
    if (!validation.ok) return validation;

    const { entries } = validation;

    // Hash all tokens for batch registry lookup
    const hashes = entries.map(e => crypto.createHash('sha256').update(e.token).digest('hex'));
    const registryMap = await resolveTokenHashes(pool, hashes);

    // Attach registry rows (or null for invalid tokens)
    const workItems = entries.map((e, i) => ({
        ...e,
        hash:        hashes[i],
        registryRow: registryMap.get(hashes[i]) || null
    }));

    // At least one token must resolve
    const validCount = workItems.filter(w => w.registryRow).length;
    if (validCount === 0) {
        return { ok: false, status: 401, error: 'No valid tokens — at least one token must resolve to an active book' };
    }

    // Parallel per-book queries (invalid tokens are short-circuited)
    const books = await Promise.all(workItems.map(async item => {
        if (!item.registryRow) {
            return { token_index: item.tokenIndex, error: 'invalid_token' };
        }
        try {
            return await fetchBookPayload(pool, item);
        } catch (err) {
            logger?.error?.({ err, fractal_id: item.registryRow.fractal_id }, 'Spore bootstrap: book query failed');
            return { token_index: item.tokenIndex, error: 'query_failed' };
        }
    }));

    const successCount = books.filter(b => !b.error).length;
    logger?.info?.({ totalRequested: entries.length, validTokens: validCount, succeeded: successCount }, 'Spore bootstrap: completed');

    return {
        ok:           true,
        bootstrap_at: new Date().toISOString(),
        total_books:  successCount,
        books
    };
}

module.exports = {
    validateBootstrapEntries,
    resolveTokenHashes,
    fetchBookPayload,
    runBootstrap,
    MAX_BOOKS,
    DEFAULT_LIMIT,
    MAX_LIMIT
};
