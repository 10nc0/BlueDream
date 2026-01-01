const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const MetadataExtractor = require('../metadata-extractor');
const { validate, schemas } = require('../lib/validators');

function registerBooksRoutes(app, deps) {
    const { pool, bots, helpers, middleware, tenantMiddleware, logger, fractalId, constants } = deps;
    
    if (!middleware || !middleware.requireAuth) {
        logger.warn('Books routes: middleware not available, skipping registration');
        return {};
    }
    
    const { requireAuth, requireRole } = middleware;
    const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = tenantMiddleware || {};
    const { logAudit, noCacheHeaders, getTimestamp } = helpers || {};
    const hermesBot = bots?.hermes;
    const thothBot = bots?.thoth;
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const metadataExtractor = new MetadataExtractor();

    app.get('/api/books', requireAuth, async (req, res) => {
        logger.debug({ userId: req.userId }, '/api/books called');
        
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                logger.error({ userId: req.userId }, 'No tenant schema set');
                return res.status(500).json({ error: 'Tenant context not found' });
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
                            ORDER BY b.created_at DESC
                        `);
                        books.push(...schemaResult.rows);
                    } catch (error) {
                        logger.warn({ err: error }, 'Query error');
                    }
                }
                
                logger.debug({ count: books.length }, 'Books retrieved');
            } else {
                const result = await pool.query(`
                    SELECT b.*
                    FROM ${tenantSchema}.books b
                    WHERE b.archived = false
                    ${limboFilter}
                    ORDER BY b.created_at DESC
                `);
                books = result.rows;
                
                logger.debug({ count: books.length }, 'Books retrieved');
                
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
                    
                    for (const contrib of contributedBooksResult.rows) {
                        try {
                            const bookResult = await pool.query(`
                                SELECT b.*, '${contrib.tenant_schema}'::text as tenant_schema,
                                       true as is_contributed
                                FROM ${contrib.tenant_schema}.books b
                                WHERE b.fractal_id = $1 AND b.archived = false
                            `, [contrib.fractal_id]);
                            
                            if (bookResult.rows.length > 0) {
                                books.push(bookResult.rows[0]);
                            }
                        } catch (error) {
                            logger.warn({ fractalId: contrib.fractal_id, err: error }, 'Could not fetch contributed book');
                        }
                    }
                    
                    logger.debug({ count: books.length }, 'Books retrieved');
                }
            }
            
            const booksWithFractalIds = books.map(book => {
                if (!book.fractal_id && fractalId) {
                    book.fractal_id = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);
                }
                delete book.output_01_url;
                return book;
            });
            
            const sanitized = sanitizeForRole ? sanitizeForRole(booksWithFractalIds, user.role) : booksWithFractalIds;
            res.json({ books: sanitized });
        } catch (error) {
            logger.error({ err: error, userId: req.userId }, 'Error in /api/books');
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
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
            
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Error archiving book');
            res.status(500).json({ error: error.message });
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
            
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Error unarchiving book');
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
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
                const randomCode = crypto.randomBytes(3).toString('hex');
                const bookNameSlug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
                joinCode = `${bookNameSlug}-${randomCode}`;
                
                await client.query(`
                    UPDATE ${tenantSchema}.books 
                    SET contact_info = $1 
                    WHERE id = $2
                `, [`join baby-ability ${joinCode}`, book.id]);
                
                book.contact_info = `join baby-ability ${joinCode}`;
                logger.info({ fractalId: generatedFractalId, joinCode }, 'Generated join code for book');
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
            res.json(sanitized);
        } catch (error) {
            logger.error({ err: error }, 'Error in PUT /api/books/:id');
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

    // ============ DROPS API - Personal Cloud OS ============
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
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
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
            
            const searchResult = await client.query(`
                SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
                FROM ${tenantSchema}.drops
                WHERE book_id = $2 AND search_vector @@ plainto_tsquery('english', $1)
                ORDER BY rank DESC, created_at DESC
                LIMIT 100
            `, [query, bookResult.rows[0].id]);
            
            res.json({ query, results: searchResult.rows, count: searchResult.rows.length });
        } catch (error) {
            logger.error({ err: error }, 'Error searching drops');
            res.status(500).json({ error: error.message });
        }
    });

    // ============ MESSAGES API ============
    app.get('/api/messages/:id/media', requireAuth, async (req, res) => {
        res.status(404).json({ 
            error: 'Media not available via this endpoint',
            note: 'Use message.media_url (Discord CDN URL) directly from message data'
        });
    });

    app.get('/api/books/:id/messages', requireAuth, setTenantContext, async (req, res) => {
        try {
            const { id } = req.params;
            const client = req.dbClient || pool;
            let limit = parseInt(req.query.limit) || 50;
            const before = req.query.before;
            const after = req.query.after;
            const around = req.query.around;
            const context = parseInt(req.query.context) || 10;
            const source = req.query.source || 'user';
            
            if (around && isNaN(Number(around))) {
                return res.status(400).json({ error: 'Invalid message ID for around parameter' });
            }
            if (after && isNaN(Number(after))) {
                return res.status(400).json({ error: 'Invalid message ID for after parameter' });
            }
            if (context < 0 || !Number.isInteger(context) || context > 25) {
                return res.status(400).json({ error: 'Context must be 0-25' });
            }
            
            if (source === 'ledger' && req.tenantContext?.userRole !== 'dev') {
                return res.status(403).json({ error: 'Access denied: Ledger messages are dev-only' });
            }
            
            if (!['user', 'ledger'].includes(source)) {
                return res.status(400).json({ error: 'Invalid source parameter' });
            }
            
            let tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const isDev = req.tenantContext?.userRole === 'dev';
            
            if (isDev) {
                const registryLookup = await client.query(
                    `SELECT tenant_schema FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                    [id]
                );
                if (registryLookup.rows.length > 0) {
                    tenantSchema = registryLookup.rows[0].tenant_schema;
                }
            }
            
            const bookResult = await client.query(
                `SELECT id, name, output_credentials, created_at FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [id]
            );
            
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }
            
            const book = bookResult.rows[0];
            const bookCreatedAt = new Date(book.created_at);
            
            let creatorPhone = null;
            const registryResult = await client.query(
                `SELECT creator_phone, phone_number FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                [id]
            );
            if (registryResult.rows.length > 0) {
                creatorPhone = registryResult.rows[0].creator_phone || registryResult.rows[0].phone_number;
            }
            
            let outputCredentials = book.output_credentials;
            if (typeof outputCredentials === 'string') {
                outputCredentials = JSON.parse(outputCredentials);
            }
            
            const outputData = outputCredentials?.output_01;
            
            if (!outputData || !outputData.thread_id) {
                return res.json({ messages: [], total: 0, hasMore: false, note: 'No Ledger thread configured' });
            }
            
            if (!thothBot || !thothBot.client || !thothBot.ready) {
                return res.json({ messages: [], total: 0, hasMore: false, note: 'Discord bot not ready' });
            }
            
            try {
                const thread = await thothBot.client.channels.fetch(outputData.thread_id);
                
                if (!thread) {
                    return res.json({ messages: [], total: 0, hasMore: false, note: 'Thread not found' });
                }
                
                const options = { force: true };
                
                if (around) {
                    options.around = around;
                    options.limit = Math.min(context * 2 + 1, 51);
                } else if (after) {
                    options.after = after;
                    options.limit = 100;
                } else {
                    options.limit = limit;
                    if (before) options.before = before;
                }
                
                const discordMessages = await thread.messages.fetch(options);
                
                const normalizePhone = (phone) => phone ? phone.replace(/\D/g, '') : '';
                
                const messages = Array.from(discordMessages.values())
                    .filter(msg => msg.createdAt >= bookCreatedAt)
                    .map(msg => {
                        const attachment = msg.attachments.size > 0 ? msg.attachments.first() : null;
                        
                        let mediaFromEmbed = null;
                        let senderContact = null;
                        for (const embed of msg.embeds) {
                            const mediaField = embed.fields?.find(f => f.name === '📎 Media');
                            if (mediaField?.value) {
                                const match = mediaField.value.match(/\[(.*?)\]\((.*?)\)/);
                                if (match) {
                                    mediaFromEmbed = { url: match[2], contentType: match[1] };
                                }
                            }
                            const phoneField = embed.fields?.find(f => f.name === '📱 Phone');
                            if (phoneField?.value) {
                                senderContact = phoneField.value;
                            }
                        }
                        
                        const senderPhoneNorm = normalizePhone(senderContact);
                        const creatorPhoneNorm = normalizePhone(creatorPhone);
                        const isCreator = senderPhoneNorm && creatorPhoneNorm && senderPhoneNorm === creatorPhoneNorm;
                        
                        return {
                            id: msg.id,
                            sender_name: msg.author.username,
                            sender_avatar: msg.author.displayAvatarURL(),
                            sender_contact: senderContact,
                            is_creator: isCreator,
                            message_content: msg.content || '',
                            timestamp: msg.createdAt.toISOString(),
                            has_media: msg.attachments.size > 0 || !!mediaFromEmbed,
                            media_url: attachment ? attachment.url : (mediaFromEmbed ? mediaFromEmbed.url : null),
                            media_type: attachment ? attachment.contentType : (mediaFromEmbed ? mediaFromEmbed.contentType : null),
                            embeds: msg.embeds.map(e => ({
                                title: e.title === '🎉 Book Activated' ? e.title : null,
                                description: e.description,
                                color: e.color,
                                fields: e.fields ? e.fields.filter(f => f.name !== '📖 Book' && f.name !== '👤 Sender') : []
                            }))
                        };
                    });
                
                res.json({ 
                    messages,
                    total: messages.length,
                    hasMore: discordMessages.size === limit,
                    oldestMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
                });
            } catch (discordError) {
                logger.error({ err: discordError }, 'Failed to fetch from Discord');
                return res.json({ messages: [], total: 0, hasMore: false, error: discordError.message });
            }
        } catch (error) {
            logger.error({ err: error }, 'Error in /api/books/:id/messages');
            res.status(500).json({ error: error.message });
        }
    });

    // ============ SEARCH API ============
    app.get('/api/search', requireAuth, async (req, res) => {
        const { term, bookIds } = req.query;
        
        if (!term || term.trim().length === 0) {
            return res.status(400).json({ error: 'Search term is required' });
        }
        
        const searchTerm = term.toLowerCase().trim();
        
        try {
            const tenantSchema = req.tenantSchema;
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            const userResult = await pool.query(
                `SELECT id, email, tenant_id, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            
            if (!userResult.rows.length) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userResult.rows[0];
            const hasExtendedAccess = req.userRole === 'dev' && user.is_genesis_admin;
            
            let targetBookIds = null;
            if (bookIds) {
                targetBookIds = bookIds.split(',').map(id => id.trim()).filter(id => id);
            }
            
            const isTagSearch = searchTerm.startsWith('#');
            const tagQuery = isTagSearch ? searchTerm.slice(1) : searchTerm;
            
            let books = [];
            
            if (hasExtendedAccess && getAllTenantSchemas) {
                const allSchemas = await getAllTenantSchemas(pool, req.userRole);
                
                for (const schemaRow of allSchemas) {
                    try {
                        let schemaQuery = `
                            SELECT fractal_id, name as book_name, output_credentials, created_at, tags
                            FROM ${schemaRow.tenant_schema}.books
                            WHERE status = 'active' AND archived = false
                        `;
                        const schemaParams = [];
                        
                        if (targetBookIds?.length > 0) {
                            schemaQuery += ` AND fractal_id = ANY($1)`;
                            schemaParams.push(targetBookIds);
                        }
                        
                        const schemaResult = await pool.query(schemaQuery, schemaParams);
                        books.push(...schemaResult.rows);
                    } catch (error) {}
                }
            } else {
                let booksQuery = `
                    SELECT fractal_id, name as book_name, output_credentials, created_at, tags
                    FROM ${tenantSchema}.books
                    WHERE status = 'active' AND archived = false
                `;
                const queryParams = [];
                
                if (targetBookIds?.length > 0) {
                    booksQuery += ` AND fractal_id = ANY($1)`;
                    queryParams.push(targetBookIds);
                }
                
                const booksResult = await pool.query(booksQuery, queryParams);
                books = booksResult.rows;
            }
            
            const metadataMatches = new Set();
            for (const book of books) {
                if ((book.book_name || '').toLowerCase().includes(tagQuery)) {
                    metadataMatches.add(book.fractal_id);
                    continue;
                }
                if (book.tags && Array.isArray(book.tags)) {
                    if (book.tags.some(tag => (tag || '').toLowerCase().includes(tagQuery))) {
                        metadataMatches.add(book.fractal_id);
                    }
                }
            }
            
            if (books.length === 0) {
                return res.json({ matchingBooks: [] });
            }
            
            if (!thothBot || !thothBot.client || !thothBot.ready) {
                return res.json({ matchingBooks: [...metadataMatches], note: 'Discord bot not ready' });
            }
            
            const matchingBooks = [];
            let searchedCount = 0;
            const DISCORD_DELAY_MS = 150;
            const TIMEOUT_MS = 5000;
            
            for (const book of books) {
                try {
                    let outputCredentials = book.output_credentials;
                    if (typeof outputCredentials === 'string') {
                        outputCredentials = JSON.parse(outputCredentials);
                    }
                    
                    const outputData = outputCredentials?.output_01;
                    if (!outputData?.thread_id) continue;
                    
                    const bookCreatedAt = new Date(book.created_at);
                    
                    if (searchedCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, DISCORD_DELAY_MS));
                    }
                    
                    let thread;
                    try {
                        thread = await Promise.race([
                            thothBot.client.channels.fetch(outputData.thread_id),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS))
                        ]);
                    } catch (fetchError) {
                        continue;
                    }
                    if (!thread) continue;
                    
                    let allMessages = [];
                    let lastId = null;
                    let fetchCount = 0;
                    
                    try {
                        while (fetchCount < 10) {
                            const options = { limit: 100, force: true };
                            if (lastId) options.before = lastId;
                            
                            const batch = await Promise.race([
                                thread.messages.fetch(options),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS))
                            ]);
                            
                            if (batch.size === 0) break;
                            
                            for (const msg of batch.values()) {
                                allMessages.push(msg);
                                lastId = msg.id;
                            }
                            fetchCount++;
                        }
                    } catch (fetchError) {}
                    
                    searchedCount++;
                    
                    let hasMatch = false;
                    for (const msg of allMessages) {
                        if (msg.createdAt < bookCreatedAt) continue;
                        
                        let searchableText = (msg.content || '').toLowerCase();
                        
                        for (const embed of msg.embeds) {
                            if (embed.description) searchableText += ' ' + embed.description.toLowerCase();
                            if (embed.title) searchableText += ' ' + embed.title.toLowerCase();
                            if (embed.fields) {
                                for (const field of embed.fields) {
                                    searchableText += ' ' + (field.name || '').toLowerCase();
                                    searchableText += ' ' + (field.value || '').toLowerCase();
                                }
                            }
                        }
                        
                        for (const attachment of msg.attachments.values()) {
                            if (attachment.name) searchableText += ' ' + attachment.name.toLowerCase();
                            if (attachment.contentType) searchableText += ' ' + attachment.contentType.toLowerCase();
                        }
                        
                        if (searchableText.includes(searchTerm)) {
                            hasMatch = true;
                            break;
                        }
                    }
                    
                    if (hasMatch) {
                        matchingBooks.push(book.fractal_id);
                    }
                } catch (bookError) {
                    if (bookError.message?.includes('429')) {
                        const allMatches = [...new Set([...matchingBooks, ...metadataMatches])];
                        return res.json({ matchingBooks: allMatches, partial: true, reason: 'Rate limited' });
                    }
                }
            }
            
            const allMatches = [...new Set([...matchingBooks, ...metadataMatches])];
            res.json({ matchingBooks: allMatches, partial: false });
        } catch (error) {
            logger.error({ err: error }, 'Server search error');
            res.status(500).json({ error: error.message });
        }
    });

    // ============ CREATE THREAD API ============
    app.post('/api/books/:id/create-thread', requireAuth, setTenantContext, async (req, res) => {
        try {
            const { id } = req.params;
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const tenantId = req.tenantContext?.tenantId;
            
            if (!tenantId) {
                return res.status(400).json({ error: 'Tenant context required' });
            }
            
            const book = await client.query(
                `SELECT id, name, output_01_url, output_credentials, tenant_id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [id]
            );
            
            if (!book.rows.length) {
                return res.status(404).json({ error: 'Book not found' });
            }
            
            const bookData = book.rows[0];
            
            let outputCredentials = bookData.output_credentials;
            if (typeof outputCredentials === 'string') {
                outputCredentials = JSON.parse(outputCredentials);
            }
            
            if (outputCredentials?.output_01?.thread_id) {
                return res.json({ 
                    success: true, 
                    message: 'Thread already exists',
                    threadInfo: outputCredentials.output_01
                });
            }
            
            if (!hermesBot || !hermesBot.isReady()) {
                return res.status(503).json({ error: 'Discord bot not ready' });
            }
            
            logger.info({ bookId: id, bookName: bookData.name }, 'Creating output_01 thread');
            const threadInfo = await hermesBot.createThreadForBook(
                NYANBOOK_LEDGER_WEBHOOK,
                id,
                bookData.name,
                tenantId
            );
            
            const updatedCredentials = {
                ...outputCredentials,
                output_01: {
                    type: 'thread',
                    thread_id: threadInfo.threadId,
                    parent_channel_id: threadInfo.channelId
                }
            };
            
            await client.query(
                `UPDATE ${tenantSchema}.books SET output_credentials = $1 WHERE fractal_id = $2`,
                [JSON.stringify(updatedCredentials), id]
            );
            
            res.json({ 
                success: true, 
                message: 'Thread created successfully',
                threadInfo: updatedCredentials.output_01
            });
        } catch (error) {
            logger.error({ err: error }, 'Error creating thread');
            res.status(500).json({ error: error.message });
        }
    });

    const exportBookHandler = async (req, res) => {
        const { book_id } = req.params;
        const selectedMessageIds = req.body?.messageIds || null;
        
        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const bookResult = await client.query(
                `SELECT id, name, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );
            
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }
            
            const book = bookResult.rows[0];
            const outputCreds = book.output_credentials;
            
            let messages = [];
            
            if (!thothBot || !thothBot.client || !thothBot.ready) {
                messages = [];
            } else {
                try {
                    const threadId = outputCreds?.output_01?.thread_id;
                    if (threadId) {
                        const channel = await thothBot.client.channels.fetch(threadId);
                        const fetchedMessages = await channel.messages.fetch({ limit: 100 });
                        
                        let allMessages = fetchedMessages.map(m => {
                            const embed = m.embeds[0];
                            const fields = embed?.fields || [];
                            const getField = (name) => fields.find(f => f.name === name)?.value;
                            
                            const mediaField = getField('Media');
                            let media = null;
                            if (mediaField) {
                                const match = mediaField.match(/^(.+?)\s*\((.+?)\)$/);
                                if (match) {
                                    media = { type: match[1], size: match[2] };
                                } else {
                                    media = { type: mediaField };
                                }
                            }
                            
                            const formatTimestamp = (date) => {
                                const offset = -date.getTimezoneOffset();
                                const sign = offset >= 0 ? '+' : '-';
                                const absOffset = Math.abs(offset);
                                const tzHours = Math.floor(absOffset / 60);
                                const tzMinutes = absOffset % 60;
                                const tzString = `GMT${sign}${tzHours.toString().padStart(2, '0')}${tzMinutes > 0 ? ':' + tzMinutes.toString().padStart(2, '0') : ''}`;
                                
                                return date.toLocaleString('en-US', {
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: false
                                }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3/$1/$2') + ' ' + tzString;
                            };

                            return {
                                id: m.id,
                                phone: getField('Phone'),
                                time: formatTimestamp(m.createdAt),
                                text: embed?.description || '',
                                media,
                                attachments: m.attachments.size > 0 ? m.attachments.map(a => ({
                                    url: a.url,
                                    filename: a.name,
                                    size: a.size
                                })) : undefined,
                                _timestamp: m.createdAt.toISOString()
                            };
                        });
                        
                        if (selectedMessageIds && selectedMessageIds.length > 0) {
                            const selectedSet = new Set(selectedMessageIds);
                            messages = allMessages.filter(m => selectedSet.has(m.id));
                        } else {
                            messages = allMessages;
                        }
                    }
                } catch (err) {
                    logger.warn({ err }, 'Error fetching Discord messages for export');
                }
            }
            
            const dropsResult = await client.query(
                `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 ORDER BY created_at DESC`,
                [book.id]
            );
            
            const dropsMap = new Map();
            dropsResult.rows.forEach(drop => {
                dropsMap.set(drop.discord_message_id, drop);
            });
            
            const enrichedMessages = messages.map(msg => {
                const { _timestamp, ...cleanMsg } = msg;
                return {
                    ...cleanMsg,
                    metadata: dropsMap.get(msg.id) || null
                };
            });
            
            const exportData = {
                book: {
                    id: book_id,
                    name: book.name,
                    exported_at: new Date().toISOString()
                },
                messages: enrichedMessages,
                drops: dropsResult.rows,
                statistics: {
                    total_messages: messages.length,
                    total_drops: dropsResult.rows.length,
                    messages_with_metadata: enrichedMessages.filter(m => m.metadata).length
                }
            };
            
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            res.attachment(`${book.name.replace(/[^a-z0-9]/gi, '_')}_export.zip`);
            res.setHeader('Content-Type', 'application/zip');
            
            archive.pipe(res);
            archive.append(JSON.stringify(exportData, null, 2), { name: 'messages.json' });
            
            let attachmentStats = { total: 0, downloaded: 0, failed: 0 };
            
            for (const msg of messages) {
                if (msg.attachments && msg.attachments.length > 0) {
                    const timestamp = new Date(msg._timestamp);
                    const offset = -timestamp.getTimezoneOffset();
                    const sign = offset >= 0 ? '+' : '-';
                    const absOffset = Math.abs(offset);
                    const tzHours = Math.floor(absOffset / 60);
                    const tzMinutes = absOffset % 60;
                    const tzString = `GMT${sign}${tzHours.toString().padStart(2, '0')}${tzMinutes > 0 ? ':' + tzMinutes.toString().padStart(2, '0') : ''}`;

                    const formattedTime = timestamp.toLocaleString('en-US', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3/$1/$2').replace(/[/:]/g, '_').replace(/, /g, ' - ');
                    
                    for (const attachment of msg.attachments) {
                        attachmentStats.total++;
                        try {
                            const response = await axios.get(attachment.url, { 
                                responseType: 'arraybuffer',
                                timeout: 30000 
                            });
                            
                            const ext = attachment.filename.split('.').pop();
                            const renamedFile = `${formattedTime} - ${tzString} - ${msg.id}.${ext}`;
                            const folderPath = `attachments/${renamedFile}`;
                            
                            archive.append(response.data, { name: folderPath });
                            attachmentStats.downloaded++;
                        } catch (err) {
                            attachmentStats.failed++;
                            logger.warn({ filename: attachment.filename, err }, 'Failed to download attachment');
                        }
                    }
                }
            }
            
            const readme = `# Your Nyanbook Export
        
Book: ${book.name}
Exported: ${new Date().toISOString()}

This archive contains:
- messages.json: All messages with drops metadata
  - ${messages.length} messages total
  - ${dropsResult.rows.length} metadata drops
  - ${enrichedMessages.filter(m => m.metadata).length} messages with metadata

- attachments/: Media files renamed for chronological sorting
  - ${attachmentStats.downloaded} files downloaded
  - ${attachmentStats.failed} files failed to download
  - Total attempted: ${attachmentStats.total}

Naming Convention:
YYYY_MM_DD - HH_MM_SS - GMTXX - {message_id}.{extension}
`;
            archive.append(readme, { name: 'README.txt' });
            
            await archive.finalize();
            
            logger.info({ bookId: book_id, messages: messages.length, drops: dropsResult.rows.length }, 'Export created');
            
        } catch (error) {
            logger.error({ err: error }, 'Error creating export');
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    };

    const exportMiddleware = setTenantContext ? [requireAuth, setTenantContext] : [requireAuth];
    app.get('/api/books/:book_id/export', ...exportMiddleware, exportBookHandler);
    app.post('/api/books/:book_id/export', ...exportMiddleware, exportBookHandler);

    return {};
}

module.exports = { registerBooksRoutes };
