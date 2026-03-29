const { assertValidSchemaName } = require('../../lib/validators');
const { normalizeForSearch } = require('../../utils/language-detector');

function register(app, deps) {
    const { pool, bots, middleware, tenantMiddleware, logger, constants } = deps;
    const { requireAuth } = middleware;
    const { setTenantContext, getAllTenantSchemas } = tenantMiddleware || {};
    const thothBot = bots?.thoth;
    const hermesBot = bots?.hermes;
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;

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

    app.post('/api/books/:id/create-thread', requireAuth, setTenantContext, async (req, res) => {
        const { id } = req.params;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const tenantId = req.tenantContext?.tenantId;

        if (!tenantId) {
            return res.status(400).json({ error: 'Tenant context required' });
        }

        if (!hermesBot || !hermesBot.isReady()) {
            return res.status(503).json({ error: 'Discord bot not ready' });
        }

        const txClient = await pool.connect();
        try {
            await txClient.query('BEGIN');

            const book = await txClient.query(
                `SELECT id, name, output_01_url, output_credentials, tenant_id
                 FROM ${tenantSchema}.books WHERE fractal_id = $1 FOR UPDATE`,
                [id]
            );

            if (!book.rows.length) {
                await txClient.query('ROLLBACK');
                return res.status(404).json({ error: 'Book not found' });
            }

            const bookData = book.rows[0];
            let outputCredentials = bookData.output_credentials;
            if (typeof outputCredentials === 'string') {
                outputCredentials = JSON.parse(outputCredentials);
            }

            if (outputCredentials?.output_01?.thread_id) {
                await txClient.query('COMMIT');
                return res.json({
                    success: true,
                    message: 'Thread already exists',
                    threadInfo: outputCredentials.output_01
                });
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

            await txClient.query(
                `UPDATE ${tenantSchema}.books SET output_credentials = $1 WHERE fractal_id = $2`,
                [JSON.stringify(updatedCredentials), id]
            );

            await txClient.query('COMMIT');

            res.json({
                success: true,
                message: 'Thread created successfully',
                threadInfo: updatedCredentials.output_01
            });
        } catch (error) {
            await txClient.query('ROLLBACK').catch(() => {});
            logger.error({ err: error }, 'Error creating thread');
            res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        } finally {
            txClient.release();
        }
    });
}

module.exports = { register };
