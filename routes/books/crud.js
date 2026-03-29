const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { validate, schemas } = require('../../lib/validators');
const { validateOutpipeConfig } = require('../../lib/outpipes/router');
const {
    BOOK_LIST_COLS,
    _getCachedBooks,
    _setCachedBooks,
    _invalidateBooksCache
} = require('./shared');

function register(app, deps) {
    const { pool, helpers, middleware, tenantMiddleware, logger, fractalId, constants } = deps;
    const { requireAuth, requireRole } = middleware;
    const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = tenantMiddleware || {};
    const { logAudit } = helpers || {};
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;

    app.patch('/api/books/reorder', requireAuth, setTenantContext, async (req, res) => {
        try {
            const { order } = req.body;
            if (!Array.isArray(order) || order.length === 0) {
                return res.status(400).json({ error: 'order array required' });
            }
            const tenantSchema = req.tenantSchema;
            await Promise.all(order.map(({ fractal_id, sort_order }) =>
                pool.query(
                    `UPDATE ${tenantSchema}.books SET sort_order = $1 WHERE fractal_id = $2`,
                    [sort_order, fractal_id]
                )
            ));
            _invalidateBooksCache(tenantSchema, req.userId);
            res.json({ ok: true });
        } catch (err) {
            logger.error({ err }, 'Error in PATCH /api/books/reorder');
            res.status(500).json({ error: 'Failed to save order' });
        }
    });

    app.get('/api/books/channel-config', requireAuth, (req, res) => {
        const { config } = require('../../config');
        res.json({
            lineOaId:            config.line?.lineOaId || null,
            telegramConfigured:  !!process.env.TELEGRAM_BOT_TOKEN,
            telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || null
        });
    });

    app.get('/api/books/top', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            if (!tenantSchema) return res.status(500).json({ error: 'Tenant context not found' });

            const cachedFid = req.query.fid;
            let query, params;
            if (cachedFid) {
                query = `SELECT ${BOOK_LIST_COLS} FROM ${tenantSchema}.books b
                         WHERE b.fractal_id = $1 AND b.archived = false AND b.status != 'expired' LIMIT 1`;
                params = [cachedFid];
            } else {
                query = `SELECT ${BOOK_LIST_COLS} FROM ${tenantSchema}.books b
                         WHERE b.archived = false AND b.status != 'expired' AND b.fractal_id IS NOT NULL
                         ORDER BY b.sort_order ASC NULLS LAST, b.created_at DESC LIMIT 1`;
                params = [];
            }
            const result = await pool.query(query, params);
            if (result.rows.length === 0) return res.json({ book: null });

            const book = { ...result.rows[0], isOwner: true, canEdit: true, canView: true };
            delete book.output_01_url;
            res.json({ book });
        } catch (error) {
            logger.error({ err: error }, 'Error in /api/books/top');
            res.status(500).json({ error: 'Failed to load book' });
        }
    });

    app.get('/api/books', requireAuth, async (req, res) => {
        logger.debug({ userId: req.userId }, '/api/books called');

        try {
            const tenantSchema = req.tenantSchema;

            if (!tenantSchema) {
                logger.error({ userId: req.userId }, 'No tenant schema set');
                return res.status(500).json({ error: 'Tenant context not found' });
            }

            const cached = _getCachedBooks(tenantSchema, req.userId);
            if (cached) {
                return res.json(cached);
            }

            const userResult = await pool.query(
                `SELECT id, email, tenant_id, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );

            if (!userResult.rows.length) {
                logger.error({ userId: req.userId }, 'User not found');
                return res.status(404).json({ error: 'User not found' });
            }

            const user = userResult.rows[0];
            const tenantId = user.tenant_id;

            logger.debug({ userId: req.userId }, 'Loading books');

            let books = [];
            const hasExtendedAccess = req.userRole === 'dev' && user.is_genesis_admin;
            const limboFilter = hasExtendedAccess ? '' : `AND b.name NOT LIKE '%(t%-b1)'`;

            if (hasExtendedAccess && getAllTenantSchemas) {
                const allSchemas = await getAllTenantSchemas(pool, req.userRole);

                for (const schemaRow of allSchemas) {
                    const schemaName = schemaRow.tenant_schema;
                    try {
                        const schemaResult = await pool.query(`
                            SELECT b.*, '${schemaName}'::text as tenant_schema
                            FROM ${schemaName}.books b
                            WHERE b.archived = false
                              AND b.status != 'expired'
                              AND b.fractal_id IS NOT NULL
                            ORDER BY b.created_at DESC
                        `);
                        books.push(...schemaResult.rows);
                    } catch (error) {
                        logger.warn({ err: error, schema: schemaName }, 'Query error');
                    }
                }

                logger.debug({ count: books.length }, '📚 Books retrieved');
            } else {
                const result = await pool.query(`
                    SELECT ${BOOK_LIST_COLS}
                    FROM ${tenantSchema}.books b
                    WHERE b.archived = false
                      AND b.status != 'expired'
                      AND b.fractal_id IS NOT NULL
                    ${limboFilter}
                    ORDER BY b.sort_order ASC NULLS LAST, b.created_at DESC
                `);
                books = result.rows;

                logger.debug({ count: books.length }, '📚 Books retrieved');

                const userPhonesResult = await pool.query(`
                    SELECT DISTINCT ep.phone
                    FROM core.book_engaged_phones ep
                    JOIN core.book_registry br ON br.id = ep.book_registry_id
                    WHERE br.tenant_email = $1 AND ep.is_creator = true
                `, [user.email]);

                const userPhones = userPhonesResult.rows.map(r => r.phone);

                if (userPhones.length > 0) {
                    logger.debug({ count: userPhones.length }, 'Phones retrieved');

                    const contributedBooksResult = await pool.query(`
                        SELECT DISTINCT
                            br.fractal_id, br.book_name, br.tenant_schema, br.tenant_email,
                            ep.is_creator, ep.first_engaged_at, ep.last_engaged_at
                        FROM core.book_engaged_phones ep
                        JOIN core.book_registry br ON br.id = ep.book_registry_id
                        WHERE ep.phone = ANY($1::text[])
                          AND ep.is_creator = false
                          AND ep.last_engaged_at IS NOT NULL
                          AND br.status = 'active'
                          AND br.tenant_email != $2
                        ORDER BY ep.last_engaged_at DESC
                    `, [userPhones, user.email]);

                    const contribBySchema = {};
                    for (const c of contributedBooksResult.rows) {
                        (contribBySchema[c.tenant_schema] ||= []).push(c.fractal_id);
                    }
                    for (const [schema, fids] of Object.entries(contribBySchema)) {
                        try {
                            const batchResult = await pool.query(`
                                SELECT b.*, '${schema}'::text as tenant_schema,
                                       true as is_contributed
                                FROM ${schema}.books b
                                WHERE b.fractal_id = ANY($1::text[]) AND b.archived = false
                            `, [fids]);
                            books.push(...batchResult.rows);
                        } catch (error) {
                            logger.warn({ schema, err: error }, 'Could not fetch contributed books batch');
                        }
                    }

                    logger.debug({ count: books.length }, '📚 Books retrieved');
                }

                const existingFids = new Set(books.map(b => b.fractal_id));

                const sharedBooksResult = await pool.query(`
                    SELECT DISTINCT bs.book_fractal_id, br.tenant_schema
                    FROM core.book_shares bs
                    JOIN core.book_registry br ON br.fractal_id = bs.book_fractal_id AND br.status = 'active'
                    WHERE bs.shared_with_email = $1 AND bs.revoked_at IS NULL
                `, [user.email.toLowerCase()]);

                const sharedBySchema = {};
                for (const s of sharedBooksResult.rows) {
                    if (existingFids.has(s.book_fractal_id)) continue;
                    (sharedBySchema[s.tenant_schema] ||= []).push(s.book_fractal_id);
                }
                for (const [schema, fids] of Object.entries(sharedBySchema)) {
                    try {
                        const batchResult = await pool.query(`
                            SELECT b.*, '${schema}'::text as tenant_schema,
                                   true as is_shared
                            FROM ${schema}.books b
                            WHERE b.fractal_id = ANY($1::text[]) AND b.archived = false
                        `, [fids]);
                        books.push(...batchResult.rows);
                    } catch (error) {
                        logger.warn({ schema, err: error }, 'Could not fetch shared books batch');
                    }
                }
            }

            let channelsMap = {};
            try {
                const fractalIds = books
                    .filter(b => !b.is_shared && !b.is_contributed && b.fractal_id)
                    .map(b => b.fractal_id);
                if (fractalIds.length > 0) {
                    const chResult = await pool.query(`
                        SELECT book_fractal_id, direction, channel, status
                        FROM ${tenantSchema}.book_channels
                        WHERE book_fractal_id = ANY($1::text[])
                        ORDER BY direction, channel
                    `, [fractalIds]);
                    for (const row of chResult.rows) {
                        if (!channelsMap[row.book_fractal_id]) channelsMap[row.book_fractal_id] = [];
                        channelsMap[row.book_fractal_id].push({
                            direction: row.direction,
                            channel: row.channel,
                            status: row.status
                        });
                    }
                }
            } catch (e) {
                logger.warn({ err: e }, 'book_channels fetch skipped (table may not exist yet)');
            }

            const booksWithFractalIds = books.map(book => {
                const plainBook = { ...book };

                if (!plainBook.fractal_id && fractalId) {
                    plainBook.fractal_id = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);
                }
                delete plainBook.output_01_url;

                const isFromOwnTenant = !plainBook.tenant_schema || plainBook.tenant_schema === tenantSchema;
                const isSharedOrContributed = plainBook.is_shared || plainBook.is_contributed;

                plainBook.isOwner = isFromOwnTenant && !isSharedOrContributed;
                plainBook.canEdit = plainBook.isOwner;
                plainBook.canView = true;

                const bookChannels = channelsMap[plainBook.fractal_id] || [];
                plainBook.channels    = bookChannels;
                plainBook.has_inpipe  = bookChannels.some(c => c.direction === 'inpipe'  && c.status === 'active');
                plainBook.has_outpipe = bookChannels.some(c => c.direction === 'outpipe' && c.status === 'active');

                return plainBook;
            });

            const sanitized = sanitizeForRole ? sanitizeForRole(booksWithFractalIds, user.role) : booksWithFractalIds;
            const response = { books: sanitized };
            _setCachedBooks(tenantSchema, req.userId, response);
            res.json(response);
        } catch (error) {
            logger.error({ err: error, userId: req.userId }, 'Error in /api/books');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/books/archived', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;

            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }

            const result = await pool.query(`
                SELECT * FROM ${tenantSchema}.books
                WHERE archived = true
                ORDER BY updated_at DESC
            `);

            res.json({ books: result.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching archived books');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/books/:id/stats', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;

            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }

            const bookResult = await pool.query(
                `SELECT * FROM ${tenantSchema}.books WHERE id = $1`,
                [id]
            );

            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            res.json({
                book: bookResult.rows[0],
                messageCount: 0,
                note: 'Message statistics are managed by Discord'
            });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching book stats');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.post('/api/books/:id/archive', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;

            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }

            await pool.query(`
                UPDATE ${tenantSchema}.books
                SET archived = true, status = 'archived', updated_at = NOW()
                WHERE id = $1
            `, [id]);

            _invalidateBooksCache(req.tenantSchema, req.userId);
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Error archiving book');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.post('/api/books/:id/unarchive', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;

            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }

            await pool.query(`
                UPDATE ${tenantSchema}.books
                SET archived = false, status = 'active', updated_at = NOW()
                WHERE id = $1
            `, [id]);

            _invalidateBooksCache(req.tenantSchema, req.userId);
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Error unarchiving book');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/messages', requireAuth, async (req, res) => {
        try {
            res.json({
                messages: [],
                note: 'Messages are stored in Discord threads. Use the Discord interface to view full history.'
            });
        } catch (error) {
            logger.error({ err: error }, 'Error in /api/messages');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.get('/api/stats', requireAuth, async (req, res) => {
        try {
            res.json({
                total: 0,
                success: 0,
                failed: 0,
                pending: 0,
                note: 'Message statistics are not tracked in PostgreSQL. View full history in Discord threads.'
            });
        } catch (error) {
            logger.error({ err: error }, 'Error in /api/stats');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    app.post('/api/books', requireAuth, setTenantContext, requireRole('admin', 'write-only'), validate(schemas.createBook), async (req, res, next) => {
        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const userRole = req.tenantContext?.userRole || 'read-only';
            const tenantId = req.tenantContext?.tenantId;
            const isGenesisAdmin = req.tenantContext?.isGenesisAdmin || false;
            const { name, inputPlatform, userOutputUrl, contactInfo, tags, outputCredentials: userOutputCredentials } = { ...req.body, ...req.validated };

            if (!tenantId) {
                return res.status(400).json({ error: 'Tenant context required' });
            }

            if (!NYANBOOK_LEDGER_WEBHOOK) {
                logger.error('NYANBOOK_WEBHOOK_URL environment variable not configured');
                return res.status(500).json({ error: 'System configuration error: Ledger not available. Please contact administrator.' });
            }

            const output01Url = NYANBOOK_LEDGER_WEBHOOK;
            const output0nUrl = userOutputUrl || null;

            if (output0nUrl && output0nUrl === NYANBOOK_LEDGER_WEBHOOK) {
                return res.status(400).json({
                    error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook.'
                });
            }

            const createdByAdminId = (userRole === 'dev' && isGenesisAdmin) ? '01' : null;
            const threadName = `book-t${tenantId}-${Date.now()}`;
            const outputCredentials = {
                thread_name: threadName,
                webhooks: userOutputCredentials?.webhooks || []
            };

            const finalContactInfo = contactInfo || (inputPlatform === 'whatsapp' ? 'join baby-ability' : null);

            if (!isGenesisAdmin) {
                const unlinkCount = await client.query(
                    `SELECT COUNT(*) FROM ${tenantSchema}.books WHERE status IN ('inactive', 'pending') AND archived = false`,
                );
                if (parseInt(unlinkCount.rows[0].count, 10) >= 3) {
                    return res.status(400).json({
                        error: 'Max 3 unconnected books allowed. Connect or delete an existing book first.'
                    });
                }
            }

            logger.info({ name, inputPlatform, contactInfo }, 'Book creation request');

            const result = await client.query(
                `INSERT INTO ${tenantSchema}.books (name, input_platform, output_platform, input_credentials, output_credentials, output_01_url, output_0n_url, contact_info, tags, status, archived, created_by_admin_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                [name, inputPlatform, 'discord', {}, outputCredentials, output01Url, output0nUrl, finalContactInfo, tags || [], 'inactive', false, createdByAdminId]
            );

            const book = result.rows[0];
            const generatedFractalId = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);

            await client.query(
                `UPDATE ${tenantSchema}.books SET fractal_id = $1 WHERE id = $2`,
                [generatedFractalId, book.id]
            );

            book.fractal_id = generatedFractalId;

            let joinCode = null;
            if (inputPlatform === 'whatsapp') {
                const randomCode = crypto.randomBytes(4).toString('hex');
                const bookNameSlug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
                joinCode = `${bookNameSlug}-${randomCode}`;

                await client.query(`
                    UPDATE ${tenantSchema}.books
                    SET contact_info = $1
                    WHERE id = $2
                `, [`join baby-ability ${joinCode}`, book.id]);

                book.contact_info = `join baby-ability ${joinCode}`;
                logger.info({ fractalId: generatedFractalId, joinCode }, 'Generated join code for book');
            } else if (inputPlatform === 'line') {
                const randomCode = crypto.randomBytes(4).toString('hex');
                const bookNameSlug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
                joinCode = `${bookNameSlug}-${randomCode}`;

                await client.query(`
                    UPDATE ${tenantSchema}.books
                    SET contact_info = $1
                    WHERE id = $2
                `, [joinCode, book.id]);

                book.contact_info = joinCode;
                logger.info({ fractalId: generatedFractalId, joinCode }, 'Generated LINE join code for book');
            } else if (inputPlatform === 'telegram') {
                const randomCode = crypto.randomBytes(4).toString('hex');
                const bookNameSlug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
                joinCode = `${bookNameSlug}-${randomCode}`;

                await client.query(`
                    UPDATE ${tenantSchema}.books
                    SET contact_info = $1
                    WHERE id = $2
                `, [joinCode, book.id]);

                book.contact_info = joinCode;
                logger.info({ fractalId: generatedFractalId, joinCode }, 'Generated Telegram join code for book');

                await client.query(`
                    INSERT INTO ${tenantSchema}.book_channels
                        (book_fractal_id, direction, channel, status)
                    VALUES ($1, 'inpipe', 'telegram', 'pending')
                    ON CONFLICT (book_fractal_id, direction, channel) DO NOTHING
                `, [generatedFractalId]);
            }

            const tenantEmail = req.tenantContext.userEmail;
            const outpipesUser = outputCredentials?.webhooks?.map(w => ({
                type: 'webhook',
                url: w.url,
                name: w.name || 'User Webhook'
            })) || [];

            if (output0nUrl && !outpipesUser.find(w => w.url === output0nUrl)) {
                outpipesUser.push({
                    type: 'webhook',
                    url: output0nUrl,
                    name: 'Primary Webhook'
                });
            }

            await pool.query(`
                INSERT INTO core.book_registry (
                    book_name, join_code, fractal_id, tenant_schema, tenant_email,
                    phone_number, status, inpipe_type, outpipe_ledger, outpipes_user
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                name,
                joinCode || `no-code-${generatedFractalId}`,
                generatedFractalId,
                tenantSchema,
                tenantEmail,
                null,
                'pending',
                inputPlatform,
                output01Url || 'https://nyanbook-ledger.local',
                JSON.stringify(outpipesUser)
            ]);

            logger.debug({ fractalId: generatedFractalId }, 'Book registered with status=pending (thread creation deferred to Twilio activation)');

            const sanitized = sanitizeForRole ? sanitizeForRole(book, userRole) : book;
            logger.info({ fractalId: generatedFractalId }, 'Created book');
            _invalidateBooksCache(tenantSchema, req.userId);
            res.json(sanitized);
        } catch (error) {
            logger.error({ err: error }, 'Error in POST /api/books');
            next(error);
        }
    });

    app.put('/api/books/:id', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res, next) => {
        try {
            const client = req.dbClient || pool;
            const userRole = req.tenantContext?.userRole || 'read-only';
            const tenantSchema = req.tenantContext.tenantSchema;
            const userId = req.userId;
            const { id } = req.params;
            const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags, status, userOutputUrl, password } = req.body;

            if (userOutputUrl && userOutputUrl === NYANBOOK_LEDGER_WEBHOOK) {
                return res.status(400).json({
                    error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook.'
                });
            }

            if (userOutputUrl !== undefined || (outputCredentials && outputCredentials.webhooks)) {
                const currentBook = await client.query(
                    `SELECT output_0n_url, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                    [id]
                );

                if (currentBook.rows.length > 0) {
                    const existingWebhookUrl = currentBook.rows[0].output_0n_url;
                    const newWebhookUrl = userOutputUrl || (outputCredentials?.webhooks?.[0]?.url);

                    if (newWebhookUrl && newWebhookUrl !== existingWebhookUrl) {
                        if (!password) {
                            return res.status(403).json({
                                error: 'Password required to change webhook URL',
                                requiresPassword: true
                            });
                        }

                        const userResult = await client.query(
                            `SELECT password_hash FROM ${tenantSchema}.users WHERE id = $1`,
                            [userId]
                        );

                        if (userResult.rows.length === 0) {
                            return res.status(401).json({ error: 'User not found' });
                        }

                        const isPasswordValid = await bcrypt.compare(password, userResult.rows[0].password_hash);
                        if (!isPasswordValid) {
                            return res.status(401).json({
                                error: 'Invalid password. Webhook URL not changed.',
                                invalidPassword: true
                            });
                        }

                        logger.info({ bookId: id, userId }, 'Password verified for webhook change');
                    }
                }
            }

            const updates = [];
            const values = [];
            let paramCount = 1;

            if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
            if (inputPlatform !== undefined) { updates.push(`input_platform = $${paramCount++}`); values.push(inputPlatform); }
            if (outputPlatform !== undefined) { updates.push(`output_platform = $${paramCount++}`); values.push(outputPlatform); }
            if (inputCredentials !== undefined) { updates.push(`input_credentials = $${paramCount++}`); values.push(inputCredentials); }
            if (outputCredentials !== undefined) {
                updates.push(`output_credentials = output_credentials || $${paramCount++}::jsonb`);
                values.push(JSON.stringify({ webhooks: outputCredentials.webhooks || [] }));
            }
            if (contactInfo !== undefined) { updates.push(`contact_info = $${paramCount++}`); values.push(contactInfo || null); }
            if (tags !== undefined) { updates.push(`tags = $${paramCount++}`); values.push(tags || []); }
            if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }
            if (userOutputUrl !== undefined) { updates.push(`output_0n_url = $${paramCount++}`); values.push(userOutputUrl); }

            updates.push(`updated_at = NOW()`);
            values.push(id);

            const result = await client.query(
                `UPDATE ${tenantSchema}.books
                 SET ${updates.join(', ')}
                 WHERE fractal_id = $${paramCount} RETURNING *`,
                values
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const sanitized = sanitizeForRole ? sanitizeForRole(result.rows[0], userRole) : result.rows[0];
            _invalidateBooksCache(tenantSchema, req.userId);
            res.json(sanitized);
        } catch (error) {
            logger.error({ err: error }, 'Error in PUT /api/books/:id');
            next(error);
        }
    });

    app.patch('/api/books/:id/outpipes', requireAuth, setTenantContext, requireRole('admin'), async (req, res, next) => {
        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext.tenantSchema;
            const userId = req.userId;
            const { id } = req.params;
            const { outpipes, password } = req.body;

            if (!Array.isArray(outpipes)) {
                return res.status(400).json({ error: 'outpipes must be an array' });
            }

            for (const cfg of outpipes) {
                const result = validateOutpipeConfig(cfg);
                if (!result.valid) {
                    return res.status(400).json({ error: `Invalid outpipe config: ${result.error}` });
                }
            }

            const hasUrlOutpipe = outpipes.some(p => p.type === 'discord' || p.type === 'webhook');
            if (hasUrlOutpipe) {
                if (!password) {
                    return res.status(403).json({
                        error: 'Password required to configure discord or webhook outpipes',
                        requiresPassword: true
                    });
                }
                const userResult = await client.query(
                    `SELECT password_hash FROM ${tenantSchema}.users WHERE id = $1`,
                    [userId]
                );
                if (!userResult.rows.length) {
                    return res.status(401).json({ error: 'User not found' });
                }
                const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
                if (!valid) {
                    return res.status(401).json({
                        error: 'Invalid password. Outpipes not updated.',
                        invalidPassword: true
                    });
                }
            }

            if (NYANBOOK_LEDGER_WEBHOOK) {
                const ledgerCollision = outpipes.find(p => p.url === NYANBOOK_LEDGER_WEBHOOK);
                if (ledgerCollision) {
                    return res.status(400).json({
                        error: 'Security violation: outpipe URL cannot match the system ledger webhook.'
                    });
                }
            }

            const txClient = await pool.connect();
            let updateResult;
            try {
                await txClient.query('BEGIN');
                updateResult = await txClient.query(
                    `UPDATE ${tenantSchema}.books SET outpipes_user = $1, updated_at = NOW()
                     WHERE fractal_id = $2 RETURNING fractal_id, name, outpipes_user`,
                    [JSON.stringify(outpipes), id]
                );
                if (updateResult.rows.length === 0) {
                    await txClient.query('ROLLBACK');
                    return res.status(404).json({ error: 'Book not found' });
                }
                await txClient.query(
                    `UPDATE core.book_registry SET outpipes_user = $1, updated_at = NOW()
                     WHERE fractal_id = $2`,
                    [JSON.stringify(outpipes), updateResult.rows[0].fractal_id]
                );
                await txClient.query('COMMIT');
            } catch (txError) {
                await txClient.query('ROLLBACK').catch(() => {});
                throw txError;
            } finally {
                txClient.release();
            }

            pool.query(
                `UPDATE core.outbox_jobs SET status = 'cancelled', updated_at = NOW()
                 WHERE book_fractal_id = $1 AND status = 'pending'`,
                [updateResult.rows[0].fractal_id]
            ).catch(err => logger.warn({ err }, 'Failed to cancel outbox jobs on outpipe update'));

            logger.info({ bookId: id, count: outpipes.length }, 'Outpipes updated');
            _invalidateBooksCache(tenantSchema, req.userId);
            res.json({ success: true, outpipes_user: updateResult.rows[0].outpipes_user });
        } catch (error) {
            logger.error({ err: error }, 'Error in PATCH /api/books/:id/outpipes');
            next(error);
        }
    });

    app.delete('/api/books/:id', requireAuth, setTenantContext, requireRole('admin'), async (req, res, next) => {
        const { id } = req.params;

        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext.tenantSchema;

            const bookResult = await client.query(
                `SELECT id, fractal_id, output_01_url, output_0n_url FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [id]
            );

            if (!bookResult.rows.length) {
                logger.warn({ userId: req.userId, bookId: id }, 'Attempted to delete book outside tenant');
                return res.status(404).json({ error: 'Book not found' });
            }

            const book = bookResult.rows[0];
            logger.debug({ bookId: id }, 'Archiving book');

            if (book.output_0n_url) {
                try {
                    await axios.delete(book.output_0n_url);
                    logger.info({ bookId: id }, 'Discord webhook deleted');
                } catch (err) {
                    logger.warn({ err, bookId: id }, 'Failed to delete webhook (maybe already gone)');
                }
            }

            const result = await client.query(`
                UPDATE ${tenantSchema}.books
                SET archived = true, status = 'archived', updated_at = NOW()
                WHERE fractal_id = $1
                RETURNING *
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            logger.info({ bookId: id, userId: req.userId }, 'Book archived successfully');

            pool.query(
                `UPDATE core.outbox_jobs SET status = 'cancelled', updated_at = NOW()
                 WHERE book_fractal_id = $1 AND status = 'pending'`,
                [id]
            ).catch(err => logger.warn({ err }, 'Failed to cancel outbox jobs on book archive'));

            _invalidateBooksCache(tenantSchema, req.userId);
            res.json({ success: true, message: 'Book deleted successfully' });

            if (logAudit) {
                setImmediate(() => {
                    logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
                        message: 'Book archived (soft delete)',
                        tenant_schema: tenantSchema
                    }).catch(err => logger.error({ err }, 'Audit log failed'));
                });
            }
        } catch (error) {
            logger.error({ err: error, bookId: id }, 'Error archiving book');
            next(error);
        }
    });

    app.post('/api/books/:id/relink', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
        res.json({
            success: true,
            message: 'With Twilio, no relink needed - just show the join code to your user again'
        });
    });
}

module.exports = { register };
