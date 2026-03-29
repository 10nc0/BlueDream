const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');

function register(app, deps) {
    const { pool, bots, helpers, middleware, tenantMiddleware, logger } = deps;
    const { requireAuth } = middleware;
    const { setTenantContext } = tenantMiddleware || {};
    const { logAudit } = helpers || {};
    const thothBot = bots?.thoth;
    const horusBot = bots?.horus;

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

    app.get('/api/books/:book_id/closings', requireAuth, setTenantContext, async (req, res) => {
        const { book_id } = req.params;
        const rawLimit = parseInt(req.query.limit) || 12;
        const fetchLimit = Math.min(Math.max(rawLimit, 1), 100);

        try {
            const horusBotLocal = horusBot;
            if (!horusBotLocal || !horusBotLocal.isReady()) {
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

            const result = await horusBotLocal.fetchAuditLogsPaginated(threadId, { limit: fetchLimit });
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
}

module.exports = { register };
