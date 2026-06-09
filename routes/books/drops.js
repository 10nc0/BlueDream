const { writeDrop } = require('../../lib/drop-writer');
const { validate, schemas, BOOK_ID_PATTERN } = require('../../lib/validators');
const { detectLanguage, getFtsConfig } = require('../../utils/language-detector');
const phiBreathe = require('../../lib/phi-breathe');

function register(app, deps) {
    const { pool, helpers, middleware, tenantMiddleware, logger } = deps;
    const { requireAuth } = middleware;
    const { setTenantContext } = tenantMiddleware || {};

    app.post('/api/drops', requireAuth, setTenantContext, validate(schemas.createDrop), async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, source_id, metadata_text, sent_at } = req.validated;
            const client = req.dbClient || pool;

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }

            const internalBookId = bookResult.rows[0].id;
            // sent_at is pre-validated by schema (ISO datetime); guard against
            // out-of-range dates before passing to the DB.
            const sentAtValue = (sent_at && !isNaN(new Date(sent_at).getTime()))
                ? new Date(sent_at).toISOString()
                : null;

            const { drop, extracted } = await writeDrop({
                pool: client,
                tenantSchema,
                bookInternalId: internalBookId,
                sourceId: source_id,
                metadataText: metadata_text,
                tags: [],
                sentAt: sentAtValue,
                phiStamp: phiBreathe.phiBreatheCount
            });

            res.json({ success: true, drop, extracted });
        } catch (error) {
            logger.error({ err: error }, 'Error creating drop');
            next(error);
        }
    });

    app.get('/api/drops/:book_id', requireAuth, setTenantContext, async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id } = req.params;
            const client = req.dbClient || pool;

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }

            const dropsResult = await client.query(
                `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 ORDER BY COALESCE(sent_at, created_at) DESC`,
                [bookResult.rows[0].id]
            );

            res.json({ drops: dropsResult.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching drops');
            next(error);
        }
    });

    app.delete('/api/drops/tag', requireAuth, setTenantContext, validate(schemas.deleteDropTag), async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, source_id, tag } = req.validated;
            const client = req.dbClient || pool;

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const escapedTag = tag.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');
            const internalBookId = bookResult.rows[0].id;
            const stamp = phiBreathe.phiBreatheCount;
            const performedBy = req.user?.email || null;

            await client.query(`
                INSERT INTO ${tenantSchema}.drop_events
                    (book_id, source_id, event_type, event_data, performed_by)
                VALUES ($1, $2, 'tag_removed', $3::jsonb, $4)
            `, [internalBookId, source_id, JSON.stringify({ tag, phi_breathe_stamp: stamp }), performedBy]);

            const dropResult = await client.query(`
                UPDATE ${tenantSchema}.drops
                SET extracted_tags = array_remove(extracted_tags, $1),
                    metadata_text = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(metadata_text, '(^|\\s)#?' || $2 || '(\\s|$)', ' ', 'gi'), '\\s+', ' ', 'g')),
                    updated_at = NOW()
                WHERE book_id = $3 AND source_id = $4
                RETURNING *
            `, [tag, escapedTag, internalBookId, source_id]);

            if (dropResult.rows.length === 0) {
                return res.status(404).json({ error: 'Drop not found' });
            }

            res.json({ success: true, drop: dropResult.rows[0] });
        } catch (error) {
            logger.error({ err: error }, 'Error removing tag');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.delete('/api/drops/date', requireAuth, setTenantContext, validate(schemas.deleteDropDate), async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, source_id, date } = req.validated;
            const client = req.dbClient || pool;

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const escapedDate = date.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');
            const internalBookId = bookResult.rows[0].id;
            const stamp = phiBreathe.phiBreatheCount;
            const performedBy = req.user?.email || null;

            await client.query(`
                INSERT INTO ${tenantSchema}.drop_events
                    (book_id, source_id, event_type, event_data, performed_by)
                VALUES ($1, $2, 'date_removed', $3::jsonb, $4)
            `, [internalBookId, source_id, JSON.stringify({ date, phi_breathe_stamp: stamp }), performedBy]);

            const dropResult = await client.query(`
                UPDATE ${tenantSchema}.drops
                SET extracted_dates = array_remove(extracted_dates, $1),
                    metadata_text = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(metadata_text, '(^|\\s)' || $2 || '(\\s|$)', ' ', 'gi'), '\\s+', ' ', 'g')),
                    updated_at = NOW()
                WHERE book_id = $3 AND source_id = $4
                RETURNING *
            `, [date, escapedDate, internalBookId, source_id]);

            if (dropResult.rows.length === 0) {
                return res.status(404).json({ error: 'Drop not found' });
            }

            res.json({ success: true, drop: dropResult.rows[0] });
        } catch (error) {
            logger.error({ err: error }, 'Error removing date');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/drops/:book_id/:source_id/events', requireAuth, setTenantContext, async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, source_id } = req.params;
            const client = req.dbClient || pool;

            if (!BOOK_ID_PATTERN.test(book_id)) {
                return res.status(400).json({ error: 'Invalid book ID format' });
            }
            if (!source_id || source_id.length > 200) {
                return res.status(400).json({ error: 'Invalid source ID' });
            }

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const eventsResult = await client.query(`
                SELECT id, event_type, event_data, performed_by, created_at
                FROM ${tenantSchema}.drop_events
                WHERE book_id = $1 AND source_id = $2
                ORDER BY created_at ASC
            `, [bookResult.rows[0].id, source_id]);

            res.json({ events: eventsResult.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching drop events');
            next(error);
        }
    });

    app.get('/api/drops/search/:book_id', requireAuth, setTenantContext, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id } = req.params;
            const query = req.query.q || req.query.query;
            const client = req.dbClient || pool;

            if (!query) {
                return res.status(400).json({ error: 'Query parameter required' });
            }
            if (query.length > 500) {
                return res.status(400).json({ error: 'Query too long (max 500 characters)' });
            }

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const bookInternalId = bookResult.rows[0].id;
            const isTagSearch = query.startsWith('#');
            const tagTerm = isTagSearch ? query.slice(1).toLowerCase() : null;

            let searchResult;
            if (isTagSearch && tagTerm) {
                // Exact-tag path: uses GIN containment operator — O(log n) via the
                // idx_drops_extracted_tags_gin index (added in migration 012).
                // Tags are stored lowercase at write time so lower($2) is consistent.
                searchResult = await client.query(`
                    SELECT *, 1.0 as rank
                    FROM ${tenantSchema}.drops
                    WHERE book_id = $1
                      AND extracted_tags @> ARRAY[$2]
                    ORDER BY COALESCE(sent_at, created_at) DESC
                    LIMIT 100
                `, [bookInternalId, tagTerm]);
            } else {
                const queryLang = detectLanguage(query);
                const ftsConfig = getFtsConfig(queryLang.lang);
                searchResult = await client.query(`
                    SELECT *, ts_rank(search_vector, plainto_tsquery($3, $1)) as rank
                    FROM ${tenantSchema}.drops
                    WHERE book_id = $2 AND (
                        search_vector @@ plainto_tsquery($3, $1)
                        -- Prefix search can't use GIN containment; sequential scan is
                        -- acceptable here because prefix queries are rare and
                        -- short-circuited by the FTS path above.
                        OR EXISTS (
                            SELECT 1 FROM unnest(extracted_tags) t
                            WHERE lower(t) LIKE $4
                        )
                    )
                    ORDER BY rank DESC, COALESCE(sent_at, created_at) DESC
                    LIMIT 100
                `, [query, bookInternalId, ftsConfig, `%${query.toLowerCase()}%`]);
            }

            res.json(searchResult.rows);
        } catch (error) {
            logger.error({ err: error }, 'Error searching drops');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });
}

module.exports = { register };
