const archiver = require('archiver');
const axios = require('axios');

function registerExportRoutes(app, deps) {
    const { pool, bots, middleware, tenantMiddleware, logger } = deps;
    const { requireAuth } = middleware || {};
    const { setTenantContext } = tenantMiddleware || {};
    const thothBot = bots?.thoth;

    logger.info('Registering export routes: GET/POST /api/books/:book_id/export');

    const exportBookHandler = async (req, res) => {
        console.log('🔔 EXPORT HANDLER CALLED');
        console.log('🔔 URL:', req.originalUrl);
        console.log('🔔 Params:', req.params);
        console.log('🔔 Query:', req.query);
        console.log('🔔 User ID:', req.userId);
        console.log('🔔 Tenant Context:', req.tenantContext?.tenantSchema);
        
        const { book_id } = req.params;
        const selectedMessageIds = req.body?.messageIds || null;
        
        console.log('📦 ===== EXPORT HANDLER START =====');
        console.log('📦 Method:', req.method);
        console.log('📦 Book ID:', book_id);
        console.log('📦 Selected Message IDs:', selectedMessageIds);
        console.log('📦 Selected Count:', selectedMessageIds ? selectedMessageIds.length : 0);
        
        try {
            const client = req.dbClient || pool;
            
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const bookResult = await client.query(
                `SELECT id, name, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [book_id]
            );
            
            if (bookResult.rows.length === 0) {
                console.log('📦 ERROR: Book not found');
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }
            
            const book = bookResult.rows[0];
            const outputCreds = book.output_credentials;
            console.log('📦 Book found:', book.name);
            console.log('📦 Output thread:', outputCreds?.output_01?.thread_id);
            
            let messages = [];
            
            if (!thothBot || !thothBot.client || !thothBot.ready) {
                console.log('📦 ERROR: Discord bot not ready');
                messages = [];
            } else {
                try {
                    const threadId = outputCreds?.output_01?.thread_id;
                    if (threadId) {
                        const channel = await thothBot.client.channels.fetch(threadId);
                        const fetchedMessages = await channel.messages.fetch({ limit: 100 });
                        console.log('📦 Fetched', fetchedMessages.size, 'messages from Discord');
                        
                        let allMessages = fetchedMessages.map(m => ({
                            id: m.id,
                            content: m.content,
                            author: m.author.username,
                            timestamp: m.createdAt.toISOString(),
                            embeds: m.embeds.map(e => ({
                                title: e.title,
                                description: e.description,
                                fields: e.fields
                            })),
                            attachments: m.attachments.map(a => ({
                                url: a.url,
                                filename: a.name,
                                size: a.size
                            }))
                        }));
                        
                        console.log('📦 Sample message:', {
                            id: allMessages[0]?.id,
                            content: allMessages[0]?.content?.substring(0, 50),
                            attachments: allMessages[0]?.attachments?.length
                        });
                        
                        if (selectedMessageIds && selectedMessageIds.length > 0) {
                            const selectedSet = new Set(selectedMessageIds);
                            messages = allMessages.filter(m => selectedSet.has(m.id));
                            console.log('📦 Filtered to', messages.length, 'selected messages out of', allMessages.length);
                        } else {
                            messages = allMessages;
                            console.log('📦 Using all', messages.length, 'messages (no selection)');
                        }
                    }
                } catch (err) {
                    console.log('📦 ERROR fetching Discord messages:', err.message);
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
            
            const enrichedMessages = messages.map(msg => ({
                ...msg,
                metadata: dropsMap.get(msg.id) || null
            }));
            
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
            
            for (const msg of enrichedMessages) {
                if (msg.attachments && msg.attachments.length > 0) {
                    const timestamp = new Date(msg.timestamp);
                    const dateFolder = timestamp.toISOString().split('T')[0];
                    const isoTime = timestamp.toISOString().split('T')[1].substring(0, 8);
                    const timeFolder = isoTime.replace(/:/g, '').replace(/(\d{2})(\d{2})(\d{2})/, '$1h$2m$3s');
                    
                    const offset = -timestamp.getTimezoneOffset();
                    const sign = offset >= 0 ? '+' : '-';
                    const absOffset = Math.abs(offset);
                    const tzHours = Math.floor(absOffset / 60);
                    const tzMinutes = absOffset % 60;
                    const tzString = `GMT${sign}${tzHours.toString().padStart(2, '0')}${tzMinutes > 0 ? ':' + tzMinutes.toString().padStart(2, '0') : ''}`;
                    
                    for (const attachment of msg.attachments) {
                        attachmentStats.total++;
                        try {
                            console.log(`📦 Downloading attachment: ${attachment.filename}`);
                            const response = await axios.get(attachment.url, { 
                                responseType: 'arraybuffer',
                                timeout: 30000 
                            });
                            
                            const folderPath = `attachments/${dateFolder}/${timeFolder}_${tzString}/${attachment.filename}`;
                            archive.append(response.data, { name: folderPath });
                            attachmentStats.downloaded++;
                            console.log(`📦 Added to ZIP: ${folderPath}`);
                        } catch (err) {
                            attachmentStats.failed++;
                            console.log(`📦 Failed to download ${attachment.filename}: ${err.message}`);
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

- attachments/: Media files organized by timestamp
  - ${attachmentStats.downloaded} files downloaded
  - ${attachmentStats.failed} files failed to download
  - Total attempted: ${attachmentStats.total}

Folder Structure:
attachments/YYYY-MM-DD/HhMMmSSs_GMTxx/{filename}

Example:
  attachments/2025-12-07/7h38m07s_GMT+08/phi12.xlsx
  attachments/2025-12-07/6h46m03s_GMT+08/3x3+1.xlsx

Each attachment is organized by:
- Date (YYYY-MM-DD)
- Time (HhMMmSSs) with timezone (GMT+XX)
- Filename
`;
            archive.append(readme, { name: 'README.txt' });
            
            await archive.finalize();
            
            console.log(`📦 Export created for book ${book_id}: ${messages.length} messages, ${dropsResult.rows.length} drops`);
            
        } catch (error) {
            console.error('❌ Error creating export:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    };

    app.get('/api/books/:book_id/export', requireAuth, setTenantContext, exportBookHandler);
    app.post('/api/books/:book_id/export', requireAuth, setTenantContext, exportBookHandler);

    logger.info('Export routes registered successfully');

    return {};
}

module.exports = { registerExportRoutes };
