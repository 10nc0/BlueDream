const MetadataExtractor = require('../../lib/metadata-extractor');
const { validate, schemas } = require('../../lib/validators');
const { detectLanguage, getFtsConfig } = require('../../utils/language-detector');

function register(app, deps) {
    const { pool, helpers, middleware, tenantMiddleware, logger } = deps;
    const { requireAuth } = middleware;
    const { setTenantContext } = tenantMiddleware || {};

    const metadataExtractor = new MetadataExtractor();

    app.post('/api/drops', requireAuth, setTenantContext, validate(schemas.createDrop), async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, discord_message_id, metadata_text } = req.validated;
            const client = req.dbClient || pool;

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }

            const internalBookId = bookResult.rows[0].id;

            const existingDrop = await client.query(
                `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 AND discord_message_id = $2`,
                [internalBookId, discord_message_id]
            );

            let dropResult;
            let extracted;

            if (existingDrop.rows.length > 0) {
                const combinedText = existingDrop.rows[0].metadata_text + ' ' + metadata_text;
                extracted = metadataExtractor.extract(combinedText);

                dropResult = await client.query(`
                    UPDATE ${tenantSchema}.drops
                    SET metadata_text = $1,
                        extracted_tags = $2::text[],
                        extracted_dates = $3::text[],
                        updated_at = NOW()
                    WHERE book_id = $4 AND discord_message_id = $5
                    RETURNING *
                `, [combinedText, extracted.tags, extracted.dates, internalBookId, discord_message_id]);
            } else {
                extracted = metadataExtractor.extract(metadata_text);

                dropResult = await client.query(`
                    INSERT INTO ${tenantSchema}.drops (book_id, discord_message_id, metadata_text, extracted_tags, extracted_dates)
                    VALUES ($1, $2, $3, $4::text[], $5::text[])
                    RETURNING *
                `, [internalBookId, discord_message_id, metadata_text, extracted.tags, extracted.dates]);
            }

            res.json({ success: true, drop: dropResult.rows[0], extracted });
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
                `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 ORDER BY created_at DESC`,
                [bookResult.rows[0].id]
            );

            res.json({ drops: dropsResult.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching drops');
            next(error);
        }
    });

    app.delete('/api/drops/tag', requireAuth, setTenantContext, async (req, res, next) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, discord_message_id, tag } = req.body;
            const client = req.dbClient || pool;

            if (!book_id || !discord_message_id || !tag) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const escapedTag = tag.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');

            const dropResult = await client.query(`
                UPDATE ${tenantSchema}.drops
                SET extracted_tags = array_remove(extracted_tags, $1),
                    metadata_text = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(metadata_text, '(^|\\s)#?' || $2 || '(\\s|$)', ' ', 'gi'), '\\s+', ' ', 'g')),
                    updated_at = NOW()
                WHERE book_id = $3 AND discord_message_id = $4
                RETURNING *
            `, [tag, escapedTag, bookResult.rows[0].id, discord_message_id]);

            if (dropResult.rows.length === 0) {
                return res.status(404).json({ error: 'Drop not found' });
            }

            res.json({ success: true, drop: dropResult.rows[0] });
        } catch (error) {
            logger.error({ err: error }, 'Error removing tag');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.delete('/api/drops/date', requireAuth, setTenantContext, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id, discord_message_id, date } = req.body;
            const client = req.dbClient || pool;

            if (!book_id || !discord_message_id || !date) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const escapedDate = date.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');

            const dropResult = await client.query(`
                UPDATE ${tenantSchema}.drops
                SET extracted_dates = array_remove(extracted_dates, $1),
                    metadata_text = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(metadata_text, '(^|\\s)' || $2 || '(\\s|$)', ' ', 'gi'), '\\s+', ' ', 'g')),
                    updated_at = NOW()
                WHERE book_id = $3 AND discord_message_id = $4
                RETURNING *
            `, [date, escapedDate, bookResult.rows[0].id, discord_message_id]);

            if (dropResult.rows.length === 0) {
                return res.status(404).json({ error: 'Drop not found' });
            }

            res.json({ success: true, drop: dropResult.rows[0] });
        } catch (error) {
            logger.error({ err: error }, 'Error removing date');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/drops/search/:book_id', requireAuth, setTenantContext, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { book_id } = req.params;
            const { query } = req.query;
            const client = req.dbClient || pool;

            if (!query) {
                return res.status(400).json({ error: 'Query parameter required' });
            }

            const bookResult = await client.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const queryLang = detectLanguage(query);
            const ftsConfig = getFtsConfig(queryLang.lang);
            const searchResult = await client.query(`
                SELECT *, ts_rank(search_vector, plainto_tsquery($3, $1)) as rank
                FROM ${tenantSchema}.drops
                WHERE book_id = $2 AND search_vector @@ plainto_tsquery($3, $1)
                ORDER BY rank DESC, created_at DESC
                LIMIT 100
            `, [query, bookResult.rows[0].id, ftsConfig]);

            res.json({ query, results: searchResult.rows, count: searchResult.rows.length });
        } catch (error) {
            logger.error({ err: error }, 'Error searching drops');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });
}

module.exports = { register };
