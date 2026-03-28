const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const MetadataExtractor = require('../lib/metadata-extractor');
const { validate, schemas, assertValidSchemaName } = require('../lib/validators');
const { validateOutpipeConfig } = require('../lib/outpipes/router');
const { detectLanguage, getFtsConfig, normalizeForSearch } = require('../utils/language-detector');

const BOOK_LIST_COLS = `b.id, b.name, b.input_platform, b.output_platform, b.output_credentials,
    b.output_0n_url, b.outpipes_user, b.status, b.contact_info, b.tags, b.archived, b.fractal_id,
    b.created_by_admin_id, b.created_at, b.updated_at, b.sort_order`;

const BOOKS_CACHE = new Map();
const BOOKS_CACHE_TTL_MS = 5000;

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

// In-memory rate limiter for book sharing (10 shares/hour per user)
const shareRateLimiter = new Map();
const SHARE_RATE_LIMIT = 10;
const SHARE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkShareRateLimit(userId) {
    const now = Date.now();
    const userShares = shareRateLimiter.get(userId) || [];
    
    // Filter to only shares within the window
    const recentShares = userShares.filter(ts => now - ts < SHARE_RATE_WINDOW_MS);
    shareRateLimiter.set(userId, recentShares);
    
    if (recentShares.length >= SHARE_RATE_LIMIT) {
        return false; // Rate limited
    }
    
    // Record this share
    recentShares.push(now);
    shareRateLimiter.set(userId, recentShares);
    return true;
}

// Cleanup stale entries every 10 minutes
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

function registerBooksRoutes(app, deps) {
    const { pool, bots, helpers, middleware, tenantMiddleware, logger, fractalId, constants } = deps;
    
    if (!middleware || !middleware.requireAuth) {
        logger.warn('Books routes: middleware not available, skipping registration');
        return {};
    }
    
    const { requireAuth, requireRole } = middleware;
    const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = tenantMiddleware || {};
    const { logAudit, noCacheHeaders } = helpers || {};
    const hermesBot = bots?.hermes;
    const thothBot = bots?.thoth;
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const metadataExtractor = new MetadataExtractor();

    // PATCH /api/books/reorder — persist drag-and-drop sort order
    app.patch('/api/books/reorder', requireAuth, setTenantContext, async (req, res) => {
        try {
            const { order } = req.body; // [{ fractal_id, sort_order }, ...]
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
        const { config } = require('../config');
        res.json({
            lineOaId:            config.line?.lineOaId || null,
            telegramConfigured:  !!process.env.TELEGRAM_BOT_TOKEN,
            telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || null
        });
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
                
                logger.debug({ count: books.length }, 'Books retrieved');
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
                    
                    logger.debug({ count: books.length }, 'Books retrieved');
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
            
            // Fetch book_channels for tenant's own books to attach channels array
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

            // Build new plain objects to avoid mutating pg Row objects (which breaks JSON serialization)
            const booksWithFractalIds = books.map(book => {
                // Create a plain object copy
                const plainBook = { ...book };
                
                if (!plainBook.fractal_id && fractalId) {
                    plainBook.fractal_id = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);
                }
                delete plainBook.output_01_url;
                
                // Determine ownership: owner = book from user's own tenant without shared/contributed flags
                // For devs viewing other tenants: they are NOT owners
                const isFromOwnTenant = !plainBook.tenant_schema || plainBook.tenant_schema === tenantSchema;
                const isSharedOrContributed = plainBook.is_shared || plainBook.is_contributed;
                
                // isOwner = from own tenant AND not marked as shared/contributed
                plainBook.isOwner = isFromOwnTenant && !isSharedOrContributed;
                
                // canEdit = strictly owner only (no dev exception)
                plainBook.canEdit = plainBook.isOwner;
                
                // canView = always true if they can see the book
                plainBook.canView = true;

                // Attach channels array from book_channels (empty for WhatsApp/LINE — legacy path)
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
                // Raw join code — no "join baby-ability" prefix (that is Twilio-sandbox-specific)
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
                // Same slug-hex format as LINE — user sends /start JOINCODE to the bot
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

                // Create book_channels inpipe row — status 'pending' until /start JOINCODE is sent
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

    // PATCH /api/books/:id/outpipes — replace the outpipes_user array for a book
    // Validates each typed outpipe config. Password required for any discord/webhook URL entry.
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

            // Validate each outpipe config entry
            for (const cfg of outpipes) {
                const result = validateOutpipeConfig(cfg);
                if (!result.valid) {
                    return res.status(400).json({ error: `Invalid outpipe config: ${result.error}` });
                }
            }

            // Password required when any discord or webhook URL outpipe is added/changed
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

            // Security: ensure no outpipe points at the system ledger webhook
            if (NYANBOOK_LEDGER_WEBHOOK) {
                const ledgerCollision = outpipes.find(p => p.url === NYANBOOK_LEDGER_WEBHOOK);
                if (ledgerCollision) {
                    return res.status(400).json({
                        error: 'Security violation: outpipe URL cannot match the system ledger webhook.'
                    });
                }
            }

            // Atomic dual-write: tenant schema + core registry must stay in sync.
            // A partial failure (books updated, registry stale) causes wrong Hermes
            // thread layout on first book activation. Explicit transaction guarantees both
            // rows commit together or neither does.
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

    // ============ MESSAGES API ============
    app.get('/api/messages/:id/media', requireAuth, async (req, res) => {
        res.status(404).json({ 
            error: 'Media not available via this endpoint',
            note: 'Use message.media_url (Discord CDN URL) directly from message data'
        });
    });

    app.get('/api/messages/:id/context', requireAuth, setTenantContext, async (req, res) => {
        try {
            const messageId = req.params.id;
            const bookId = req.query.bookId;
            const contextWindow = parseInt(req.query.context) || 10;
            
            if (!messageId || isNaN(Number(messageId))) {
                return res.status(400).json({ error: 'Invalid message ID' });
            }
            
            if (!bookId) {
                return res.status(400).json({ error: 'bookId is required' });
            }
            
            if (contextWindow < 0 || !Number.isInteger(contextWindow) || contextWindow > 50) {
                return res.status(400).json({ error: 'Context must be 0-50' });
            }
            
            const client = req.dbClient || pool;
            let tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const isDev = req.tenantContext?.userRole === 'dev';
            
            if (isDev) {
                const registryLookup = await client.query(
                    `SELECT tenant_schema FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                    [bookId]
                );
                if (registryLookup.rows.length > 0) {
                    tenantSchema = registryLookup.rows[0].tenant_schema;
                }
            }
            
            assertValidSchemaName(tenantSchema);
            
            const bookResult = await client.query(
                `SELECT id, name, output_credentials, created_at FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [bookId]
            );
            
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }
            
            const book = bookResult.rows[0];
            const bookCreatedAt = new Date(book.created_at);
            
            let creatorPhone = null;
            const registryResult = await client.query(
                `SELECT creator_phone, phone_number FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                [bookId]
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
                
                const discordMessages = await thread.messages.fetch({
                    force: true,
                    around: messageId,
                    limit: Math.min(contextWindow * 2 + 1, 100)
                });
                
                const normalizePhone = (phone) => phone ? phone.replace(/\D/g, '') : '';
                
                const messages = Array.from(discordMessages.values())
                    .filter(msg => msg.createdAt >= bookCreatedAt)
                    .sort((a, b) => b.createdAt - a.createdAt)
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
                            const phoneField = embed.fields?.find(f => 
                                f.name && (
                                    /[📞📱]/.test(f.name) || 
                                    f.name.toLowerCase().includes('phone')
                                )
                            );
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
                            message_content: msg.content || (msg.embeds[0]?.description !== '_(No text content)_' ? msg.embeds[0]?.description : '') || '',
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
                    targetId: messageId
                });
            } catch (discordError) {
                logger.error({ err: discordError }, 'Failed to fetch context from Discord');
                return res.json({ messages: [], total: 0, error: discordError.message });
            }
        } catch (error) {
            logger.error({ err: error }, 'Error in /api/messages/:id/context');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
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
            
            assertValidSchemaName(tenantSchema);
            
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
                            const phoneField = embed.fields?.find(f => 
                                f.name && (
                                    /[📞📱]/.test(f.name) || 
                                    f.name.toLowerCase().includes('phone')
                                )
                            );
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
                            message_content: msg.content || (msg.embeds[0]?.description !== '_(No text content)_' ? msg.embeds[0]?.description : '') || '',
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
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    // ============ SEARCH API ============
    app.get('/api/search', requireAuth, async (req, res) => {
        const { term, bookIds } = req.query;
        
        if (!term || term.trim().length === 0) {
            return res.status(400).json({ error: 'Search term is required' });
        }
        
        const searchTerm = normalizeForSearch(term);
        
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
                        
                        let searchableText = normalizeForSearch(msg.content || '');
                        
                        for (const embed of msg.embeds) {
                            if (embed.description) searchableText += ' ' + normalizeForSearch(embed.description);
                            if (embed.title) searchableText += ' ' + normalizeForSearch(embed.title);
                            if (embed.fields) {
                                for (const field of embed.fields) {
                                    searchableText += ' ' + normalizeForSearch(field.name || '');
                                    searchableText += ' ' + normalizeForSearch(field.value || '');
                                }
                            }
                        }
                        
                        for (const attachment of msg.attachments.values()) {
                            if (attachment.name) searchableText += ' ' + normalizeForSearch(attachment.name);
                            if (attachment.contentType) searchableText += ' ' + normalizeForSearch(attachment.contentType);
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
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
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
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    const exportBookHandler = async (req, res) => {
        const { book_id } = req.params;
        const selectedMessageIds = req.body?.messageIds || null;
        
        try {
            const client = req.dbClient || pool;
            let tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const isDev = req.tenantContext?.userRole === 'dev';
            
            if (isDev) {
                const registryLookup = await client.query(
                    `SELECT tenant_schema FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                    [book_id]
                );
                if (registryLookup.rows.length > 0) {
                    tenantSchema = registryLookup.rows[0].tenant_schema;
                }
            }
            
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
            
            const exportTimestamp = new Date().toISOString();
            
            const exportData = {
                book: {
                    id: book_id,
                    name: book.name,
                    exported_at: exportTimestamp
                },
                messages: enrichedMessages,
                drops: dropsResult.rows,
                statistics: {
                    total_messages: messages.length,
                    total_drops: dropsResult.rows.length,
                    messages_with_metadata: enrichedMessages.filter(m => m.metadata).length
                }
            };
            
            const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
            const fileHashes = [];
            
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            res.attachment(`${book.name.replace(/[^a-z0-9]/gi, '_')}_export.zip`);
            res.setHeader('Content-Type', 'application/zip');
            
            archive.pipe(res);
            
            const messagesJson = JSON.stringify(exportData, null, 2);
            fileHashes.push({ path: 'messages.json', sha256: sha256(messagesJson), size: Buffer.byteLength(messagesJson) });
            archive.append(messagesJson, { name: 'messages.json' });
            
            let attachmentStats = { total: 0, downloaded: 0, failed: 0 };
            
            for (const msg of messages) {
                if (msg.attachments && msg.attachments.length > 0) {
                    const timestamp = new Date(msg._timestamp);
                    // Use UTC consistently for cross-user portability
                    const utcYear = timestamp.getUTCFullYear();
                    const utcMonth = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
                    const utcDay = String(timestamp.getUTCDate()).padStart(2, '0');
                    const utcHour = String(timestamp.getUTCHours()).padStart(2, '0');
                    const utcMinute = String(timestamp.getUTCMinutes()).padStart(2, '0');
                    const utcSecond = String(timestamp.getUTCSeconds()).padStart(2, '0');
                    const formattedTime = `${utcYear}_${utcMonth}_${utcDay} - ${utcHour}_${utcMinute}_${utcSecond} - UTC`;
                    
                    for (const attachment of msg.attachments) {
                        attachmentStats.total++;
                        try {
                            const response = await axios.get(attachment.url, { 
                                responseType: 'arraybuffer',
                                timeout: 30000 
                            });
                            
                            const ext = attachment.filename.split('.').pop();
                            const renamedFile = `${formattedTime} - ${msg.id}.${ext}`;
                            const folderPath = `attachments/${renamedFile}`;
                            
                            const attachmentBuffer = Buffer.from(response.data);
                            fileHashes.push({ path: folderPath, sha256: sha256(attachmentBuffer), size: attachmentBuffer.length });
                            archive.append(attachmentBuffer, { name: folderPath });
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
Exported: ${exportTimestamp}

This archive contains:
- messages.json: All messages with drops metadata
  - ${messages.length} messages total
  - ${dropsResult.rows.length} metadata drops
  - ${enrichedMessages.filter(m => m.metadata).length} messages with metadata

- attachments/: Media files renamed for chronological sorting
  - ${attachmentStats.downloaded} files downloaded
  - ${attachmentStats.failed} files failed to download
  - Total attempted: ${attachmentStats.total}

- manifest.json: Cryptographic integrity manifest
  - SHA256 hashes for all files
  - Export provenance and timestamp

Naming Convention:
YYYY_MM_DD - HH_MM_SS - UTC - {message_id}.{extension}

## Verification
To verify file integrity, compare SHA256 hashes in manifest.json:
  sha256sum messages.json
  sha256sum attachments/*
`;
            fileHashes.push({ path: 'README.txt', sha256: sha256(readme), size: Buffer.byteLength(readme) });
            archive.append(readme, { name: 'README.txt' });
            
            const manifest = {
                version: '1.0',
                format: 'nyanbook-export',
                provenance: {
                    source: process.env.REPLIT_DEV_DOMAIN || process.env.REPL_SLUG || 'nyanbook',
                    exported_at: exportTimestamp,
                    book_id: book_id,
                    book_name: book.name
                },
                statistics: {
                    total_files: fileHashes.length + 1,
                    total_messages: messages.length,
                    total_drops: dropsResult.rows.length,
                    attachments_downloaded: attachmentStats.downloaded,
                    attachments_failed: attachmentStats.failed
                },
                files: fileHashes,
                integrity: {
                    algorithm: 'SHA256',
                    note: 'Each file hash can be verified independently using sha256sum or similar tools'
                }
            };
            
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
            
            await archive.finalize();
            
            // Audit log for export (data egress tracking) - don't block on failure
            if (logAudit) {
                logAudit(pool, tenantSchema, req.userId, 'book_export', 
                    `Exported book "${book.name}" (${messages.length} messages, ${attachmentStats.downloaded} attachments)`)
                    .catch(err => logger.warn({ err }, 'Failed to log export audit'));
            }
            
            logger.info({ bookId: book_id, messages: messages.length, drops: dropsResult.rows.length }, 'Export created');
            
        } catch (error) {
            logger.error({ err: error }, 'Error creating export');
            if (!res.headersSent) {
                res.status(500).json({ error: 'An internal error occurred. Please try again.' });
            }
        }
    };

    const exportMiddleware = setTenantContext ? [requireAuth, setTenantContext] : [requireAuth];
    app.get('/api/books/:book_id/export', ...exportMiddleware, exportBookHandler);
    app.post('/api/books/:book_id/export', ...exportMiddleware, exportBookHandler);

    // ==================== MONTHLY CLOSING ENDPOINTS ====================

    app.get('/api/books/:book_id/closings', requireAuth, setTenantContext, async (req, res) => {
        const { book_id } = req.params;
        const rawLimit = parseInt(req.query.limit) || 12;
        const fetchLimit = Math.min(Math.max(rawLimit, 1), 100);

        try {
            const horusBot = bots?.horus;
            if (!horusBot || !horusBot.isReady()) {
                return res.status(503).json({ error: 'Audit log reader not available' });
            }

            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            if (!tenantSchema) {
                return res.status(400).json({ error: 'Tenant context required' });
            }

            const bookCheck = await pool.query(
                `SELECT 1 FROM ${tenantSchema}.books WHERE fractal_id = $1 LIMIT 1`,
                [book_id]
            );
            if (bookCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const tenantInfo = await pool.query(
                `SELECT ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1`,
                [tenantSchema]
            );
            const threadId = tenantInfo.rows[0]?.ai_log_thread_id;
            if (!threadId) {
                return res.json({ success: true, closings: [], message: 'No audit log thread exists yet' });
            }

            const result = await horusBot.fetchAuditLogsPaginated(threadId, { limit: fetchLimit });
            const closings = result.logs
                .filter(log => log.type === 'closing')
                .filter(log => {
                    if (!log.parsed?.bookInfo) return false;
                    const idMatch = log.parsed.bookInfo.match(/\(([^)]+)\)$/);
                    return idMatch && idMatch[1] === book_id;
                });

            res.json({ success: true, closings });
        } catch (err) {
            logger.error({ bookId: book_id, err }, 'Closings fetch error');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });

    // ==================== BOOK SHARING ENDPOINTS ====================
    
    // Helper: Verify book ownership via book_registry (cross-tenant secure)
    const verifyBookOwnership = async (bookFractalId, userEmail, tenantSchema) => {
        const normalizedOwnerEmail = userEmail.toLowerCase().trim();
        
        // Join book_registry to verify the book belongs to this tenant AND user
        const result = await pool.query(`
            SELECT br.fractal_id, br.book_name, br.tenant_schema
            FROM core.book_registry br
            WHERE br.fractal_id = $1 
              AND br.tenant_schema = $2
              AND br.status = 'active'
              AND LOWER(br.tenant_email) = $3
        `, [bookFractalId, tenantSchema, normalizedOwnerEmail]);
        
        if (result.rows.length === 0) {
            return null;
        }
        return result.rows[0];
    };
    
    // Get shares for a book
    app.get('/api/books/:book_id/shares', requireAuth, async (req, res) => {
        try {
            const { book_id } = req.params;
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();
            
            // Verify user owns this book via book_registry (cross-tenant secure)
            const book = await verifyBookOwnership(book_id, req.userEmail, req.tenantSchema);
            
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }
            
            // Get active shares (not revoked) - filter by normalized owner email
            const sharesResult = await pool.query(`
                SELECT shared_with_email, permission_level, invited_at
                FROM core.book_shares
                WHERE book_fractal_id = $1 AND LOWER(owner_email) = $2 AND revoked_at IS NULL
                ORDER BY invited_at DESC
            `, [book_id, normalizedOwnerEmail]);
            
            res.json({ shares: sharesResult.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching book shares');
            res.status(500).json({ error: 'Failed to fetch shares' });
        }
    });
    
    // Share a book with an email
    app.post('/api/books/:book_id/share', requireAuth, async (req, res) => {
        try {
            const { book_id } = req.params;
            const { email } = req.body;
            
            if (!email || !email.includes('@')) {
                return res.status(400).json({ error: 'Valid email required' });
            }
            
            const normalizedEmail = email.toLowerCase().trim();
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();
            
            // Can't share with self
            if (normalizedEmail === normalizedOwnerEmail) {
                return res.status(400).json({ error: 'Cannot share with yourself' });
            }
            
            // Verify user owns this book via book_registry (cross-tenant secure)
            const book = await verifyBookOwnership(book_id, req.userEmail, req.tenantSchema);
            
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }
            
            // Rate limit AFTER ownership verification (10 shares/hour per user)
            // This prevents attackers from triggering rate limits on others
            if (!checkShareRateLimit(req.userId)) {
                logger.warn({ userId: req.userId }, 'Share rate limit exceeded');
                return res.status(429).json({ error: 'Too many shares. Please try again later (limit: 10/hour)' });
            }
            
            // Idempotent upsert: check for any existing share (active or revoked) by this owner
            const existingShare = await pool.query(`
                SELECT id, revoked_at FROM core.book_shares
                WHERE book_fractal_id = $1 
                  AND LOWER(owner_email) = $2 
                  AND LOWER(shared_with_email) = $3
            `, [book_id, normalizedOwnerEmail, normalizedEmail]);
            
            let shouldSendEmail = false;
            
            if (existingShare.rows.length > 0) {
                const share = existingShare.rows[0];
                if (share.revoked_at) {
                    // Re-share after revoke - reactivate, resend email
                    await pool.query(`
                        UPDATE core.book_shares 
                        SET revoked_at = NULL, invited_at = NOW()
                        WHERE id = $1
                    `, [share.id]);
                    shouldSendEmail = true;
                } else {
                    // Already shared and active - don't resend
                    return res.json({ success: true, message: 'Already shared with this email', alreadyShared: true });
                }
            } else {
                // New share - store normalized emails
                await pool.query(`
                    INSERT INTO core.book_shares (book_fractal_id, owner_email, shared_with_email, permission_level)
                    VALUES ($1, $2, $3, 'viewer')
                `, [book_id, normalizedOwnerEmail, normalizedEmail]);
                shouldSendEmail = true;
            }
            
            // Send invite email via Resend
            if (shouldSendEmail) {
                try {
                    const { Resend } = require('resend');
                    const resend = new Resend(process.env.RESEND_API_KEY);
                    
                    const domain = config.replit.primaryDomain;
                    const dashboardLink = `https://${domain}/`;
                    
                    await resend.emails.send({
                        from: `Nyan <nyan@${domain}>`,
                        to: normalizedEmail,
                        subject: `${normalizedOwnerEmail} shared a book with you on Nyanbook`,
                        html: `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                                <h2 style="color: #333;">You've been invited to view a book!</h2>
                                <p style="color: #666; font-size: 16px;">
                                    <strong>${normalizedOwnerEmail}</strong> has shared the book <strong>"${book.book_name}"</strong> with you on Nyanbook.
                                </p>
                                <div style="background: rgba(124, 58, 237, 0.1); border: 1px solid rgba(124, 58, 237, 0.2); border-radius: 8px; padding: 1rem; margin: 20px 0;">
                                    <p style="color: #666; margin: 0;">
                                        📚 <strong>Book:</strong> ${book.book_name}<br>
                                        👤 <strong>Shared by:</strong> ${normalizedOwnerEmail}<br>
                                        🔐 <strong>Access:</strong> View only
                                    </p>
                                </div>
                                <p style="color: #666; font-size: 16px;">
                                    To access this book, register or log in with this email address:
                                </p>
                                <div style="text-align: center; margin: 30px 0;">
                                    <a href="${dashboardLink}" style="background-color: #7c3aed; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                                        Open Nyanbook
                                    </a>
                                </div>
                                <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                                <p style="color: #999; font-size: 12px;">
                                    If you don't want to receive these emails, you can ignore this message.
                                </p>
                            </div>
                        `
                    });
                    logger.info({ email: normalizedEmail, book: book.book_name }, 'Book share invite email sent');
                } catch (emailError) {
                    logger.error({ err: emailError }, 'Failed to send share invite email');
                    // Don't fail the share if email fails
                }
            }
            
            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'book_share', `Shared book ${book.book_name} with ${normalizedEmail}`);
            }
            
            res.json({ success: true, message: `Invited ${normalizedEmail} to view this book` });
        } catch (error) {
            logger.error({ err: error }, 'Error sharing book');
            res.status(500).json({ error: 'Failed to share book' });
        }
    });
    
    // Revoke share access
    app.delete('/api/books/:book_id/share/:email', requireAuth, async (req, res) => {
        try {
            const { book_id, email } = req.params;
            const normalizedEmail = decodeURIComponent(email).toLowerCase().trim();
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();
            
            // Verify user owns this book via book_registry (cross-tenant secure)
            const book = await verifyBookOwnership(book_id, req.userEmail, req.tenantSchema);
            
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }
            
            // Revoke by setting revoked_at - must match owner email
            const result = await pool.query(`
                UPDATE core.book_shares 
                SET revoked_at = NOW()
                WHERE book_fractal_id = $1 
                  AND LOWER(owner_email) = $2 
                  AND LOWER(shared_with_email) = $3 
                  AND revoked_at IS NULL
                RETURNING id
            `, [book_id, normalizedOwnerEmail, normalizedEmail]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Share not found' });
            }
            
            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'book_unshare', `Revoked access for ${normalizedEmail} to book ${book.book_name}`);
            }
            
            res.json({ success: true, message: `Revoked access for ${normalizedEmail}` });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking book share');
            res.status(500).json({ error: 'Failed to revoke access' });
        }
    });

    return { endpoints: 30 };
}

module.exports = { registerBooksRoutes };
