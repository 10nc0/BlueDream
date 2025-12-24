const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');

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

    logger.info('Books routes registered (factory pattern)');
    
    return {};
}

module.exports = { registerBooksRoutes };
