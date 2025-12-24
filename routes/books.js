const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

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

    app.get('/api/books', requireAuth, async (req, res) => {
        logger.info({ userId: req.userId }, '/api/books called');
        
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
                logger.error({ userId: req.userId, tenantSchema }, 'User not found');
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userResult.rows[0];
            const tenantId = user.tenant_id;
            
            logger.info({ email: user.email, tenantSchema }, 'Loading books');
            
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
                        logger.warn({ schemaName, err: error }, 'Could not query schema');
                    }
                }
                
                logger.info({ count: books.length, schemas: allSchemas.length }, 'Found books across schemas');
            } else {
                const result = await pool.query(`
                    SELECT b.*
                    FROM ${tenantSchema}.books b
                    WHERE b.archived = false
                    ${limboFilter}
                    ORDER BY b.created_at DESC
                `);
                books = result.rows;
                
                logger.info({ count: books.length, tenantSchema, email: user.email }, 'Found owned books');
                
                const userPhonesResult = await pool.query(`
                    SELECT DISTINCT ep.phone
                    FROM core.book_engaged_phones ep
                    JOIN core.book_registry br ON br.id = ep.book_registry_id
                    WHERE br.tenant_email = $1 AND ep.is_creator = true
                `, [user.email]);
                
                const userPhones = userPhonesResult.rows.map(r => r.phone);
                
                if (userPhones.length > 0) {
                    logger.info({ email: user.email, phones: userPhones }, 'User has verified phones');
                    
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
                    
                    logger.info({ count: books.length, email: user.email }, 'Total books (owned + contributed)');
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

    app.post('/api/books', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const userRole = req.tenantContext?.userRole || 'read-only';
            const tenantId = req.tenantContext?.tenantId;
            const isGenesisAdmin = req.tenantContext?.isGenesisAdmin || false;
            const { name, inputPlatform, userOutputUrl, contactInfo, tags, outputCredentials: userOutputCredentials } = req.body;
            
            if (!tenantId) {
                return res.status(400).json({ error: 'Tenant context required' });
            }
            
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ error: 'Book name is required and cannot be blank' });
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
                output01Url,
                JSON.stringify(outpipesUser)
            ]);
            
            logger.info({ fractalId: generatedFractalId, tenantEmail }, 'Registered book in global registry');
            
            if (hermesBot && hermesBot.isReady()) {
                try {
                    const dualThreads = await hermesBot.createDualThreadsForBook(
                        output01Url, output0nUrl, name, tenantId, book.id
                    );
                    
                    const outputDestinations = {};
                    if (dualThreads.output_01) outputDestinations.output_01 = dualThreads.output_01;
                    if (dualThreads.output_0n) outputDestinations.output_0n = dualThreads.output_0n;
                    
                    if (dualThreads.errors.length > 0) {
                        logger.warn({ errors: dualThreads.errors }, 'Output creation errors');
                    }
                    
                    await client.query(
                        `UPDATE ${tenantSchema}.books 
                         SET output_credentials = output_credentials || $1::jsonb
                         WHERE id = $2`,
                        [JSON.stringify(outputDestinations), book.id]
                    );
                    
                    book.output_credentials = { ...book.output_credentials, ...outputDestinations };
                    
                    if (dualThreads.output_01?.type === 'thread') {
                        await hermesBot.sendInitialMessage(dualThreads.output_01.thread_id, name, output01Url);
                    }
                    if (dualThreads.output_0n?.type === 'thread') {
                        await hermesBot.sendInitialMessage(dualThreads.output_0n.thread_id, name, output0nUrl);
                    }
                    
                    logger.info({ fractalId: generatedFractalId }, 'Dual-thread setup complete');
                } catch (error) {
                    logger.error({ err: error, fractalId: generatedFractalId }, 'Failed to create dual threads');
                }
            }
            
            const sanitized = sanitizeForRole ? sanitizeForRole(book, userRole) : book;
            logger.info({ fractalId: generatedFractalId }, 'Created book');
            res.json(sanitized);
        } catch (error) {
            logger.error({ err: error }, 'Error in POST /api/books');
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/books/:id', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
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
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/books/:id', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
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
            logger.info({ bookId: id, tenantSchema }, 'Archiving book (soft delete)');
            
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
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/books/:id/relink', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
        res.json({ 
            success: true, 
            message: 'With Twilio, no relink needed - just show the join code to your user again' 
        });
    });

    logger.info('Books routes registered (factory pattern)');
    
    return {};
}

module.exports = { registerBooksRoutes };
