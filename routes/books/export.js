const archiver = require('archiver');
const axios = require('axios');
const crypto = require('crypto');
const { buildCsvFromMessages } = require('../../utils/book-csv-export');
const { BRAND } = require('../../config/brand');

function formatTimestamp(date) {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const tzHours = Math.floor(absOffset / 60);
    const tzMinutes = absOffset % 60;
    const tzString = `GMT${sign}${tzHours.toString().padStart(2, '0')}${tzMinutes > 0 ? ':' + tzMinutes.toString().padStart(2, '0') : ''}`;
    return date.toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3/$1/$2') + ' ' + tzString;
}

async function loadBookExportData({ client, thothBot, tenantSchema, book_id, selectedMessageIds, isDev, logger }) {
    let resolvedSchema = tenantSchema;
    if (isDev) {
        const reg = await client.query(
            `SELECT tenant_schema FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
            [book_id]
        );
        if (reg.rows.length > 0) resolvedSchema = reg.rows[0].tenant_schema;
    }

    const bookResult = await client.query(
        `SELECT id, name, output_credentials FROM ${resolvedSchema}.books WHERE fractal_id = $1`,
        [book_id]
    );
    if (bookResult.rows.length === 0) {
        return { notFound: true };
    }
    const book = bookResult.rows[0];
    const outputCreds = book.output_credentials;

    let messages = [];
    if (thothBot?.client && thothBot.ready) {
        try {
            const threadId = outputCreds?.output_01?.thread_id;
            if (threadId) {
                const channel = await thothBot.client.channels.fetch(threadId);

                // Paginate past Discord's 100-message per-call ceiling.
                // Use `before` cursor (oldest snowflake seen so far) until a
                // batch comes back with fewer than 100 entries — that's the end.
                const PAGE_SIZE = 100;
                const collected = new Map(); // id → message, deduplicates across pages
                let before = undefined;

                while (true) {
                    const opts = { limit: PAGE_SIZE };
                    if (before) opts.before = before;
                    const batch = await channel.messages.fetch(opts);
                    if (batch.size === 0) break;
                    batch.forEach(m => collected.set(m.id, m));
                    // Discord returns newest-first; the oldest in this batch is the
                    // smallest snowflake — use it as the cursor for the next page.
                    before = batch.last()?.id;
                    if (batch.size < PAGE_SIZE) break;
                }

                const mapMessage = m => {
                    const embed = m.embeds[0];
                    const fields = embed?.fields || [];
                    const getField = (name) => fields.find(f => f.name === name)?.value;

                    const mediaField = getField('Media');
                    let media = null;
                    if (mediaField) {
                        const match = mediaField.match(/^(.+?)\s*\((.+?)\)$/);
                        media = match ? { type: match[1], size: match[2] } : { type: mediaField };
                    }

                    return {
                        id: m.id,
                        phone: getField('Phone'),
                        time: formatTimestamp(m.createdAt),
                        text: embed?.description || '',
                        media,
                        // mediaField present but zero Discord attachments → source/unresolved
                        _sourceUnresolved: !!(mediaField && m.attachments.size === 0),
                        attachments: m.attachments.size > 0 ? m.attachments.map(a => ({
                            url: a.url,
                            filename: a.name,
                            size: a.size
                        })) : undefined,
                        _timestamp: m.createdAt.toISOString()
                    };
                };

                const allMessages = [...collected.values()].map(mapMessage);

                if (selectedMessageIds && selectedMessageIds.length > 0) {
                    const selectedSet = new Set(selectedMessageIds);
                    messages = allMessages.filter(m => selectedSet.has(m.id));
                } else {
                    messages = allMessages;
                }
                messages.sort((a, b) => new Date(a._timestamp) - new Date(b._timestamp));
            }
        } catch (err) {
            logger.warn({ err }, 'Error fetching Discord messages for export');
        }
    }

    const dropsResult = await client.query(
        `SELECT * FROM ${resolvedSchema}.drops WHERE book_id = $1 ORDER BY created_at DESC`,
        [book.id]
    );
    const dropsMap = new Map();
    dropsResult.rows.forEach(drop => dropsMap.set(drop.source_id, drop));

    const anattaCidByMsgId = new Map();
    try {
        const cidResult = await client.query(
            `SELECT message_fractal_id, attachment_cid
             FROM ${resolvedSchema}.anatta_messages
             WHERE book_fractal_id = $1 AND attachment_cid IS NOT NULL`,
            [book_id]
        );
        cidResult.rows.forEach(r => {
            if (r.message_fractal_id) anattaCidByMsgId.set(r.message_fractal_id, r.attachment_cid);
        });
    } catch (err) {
        logger.warn({ err: err.message }, 'CID lookup failed (non-fatal)');
    }

    // Authoritative message count from the DB ledger — used in the manifest to
    // reconcile against what the Discord thread returned. A gap means some messages
    // were never delivered to Discord (bot outage, thread deletion, etc.).
    let ledgerMessageCount = null;
    try {
        const countResult = await client.query(
            `SELECT COUNT(*)::int AS n FROM ${resolvedSchema}.anatta_messages WHERE book_fractal_id = $1`,
            [book_id]
        );
        ledgerMessageCount = countResult.rows[0]?.n ?? null;
    } catch (err) {
        logger.warn({ err: err.message }, 'Ledger count query failed (non-fatal)');
    }

    const enrichedMessages = messages.map(msg => {
        const { _timestamp, ...cleanMsg } = msg;
        return { ...cleanMsg, metadata: dropsMap.get(msg.id) || null };
    });

    return {
        book,
        tenantSchema: resolvedSchema,
        messages,
        dropsRows: dropsResult.rows,
        dropsMap,
        enrichedMessages,
        anattaCidByMsgId,
        ledgerMessageCount
    };
}

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
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const isDev = req.tenantContext?.userRole === 'dev';

            const loaded = await loadBookExportData({
                client, thothBot, tenantSchema, book_id, selectedMessageIds, isDev, logger
            });
            if (loaded.notFound) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }
            const { book, messages, dropsRows, enrichedMessages, tenantSchema: resolvedSchema, ledgerMessageCount } = loaded;

            const exportTimestamp = new Date().toISOString();

            const exportData = {
                book: {
                    id: book_id,
                    name: book.name,
                    exported_at: exportTimestamp
                },
                messages: enrichedMessages,
                drops: dropsRows,
                statistics: {
                    total_messages: messages.length,
                    total_drops: dropsRows.length,
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
            // Structured gap list — populated by fetch failures and source/unresolved rows.
            // Each entry: { message_id, timestamp, filename, url, reason, stub_path|null }
            const failedAttachments = [];

            const CDN_BASE_DELAY_MS = 300;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

                            const retryAfterHeader = response.headers?.['retry-after'] || response.headers?.['x-ratelimit-reset-after'];
                            const delayMs = retryAfterHeader
                                ? Math.max(parseFloat(retryAfterHeader) * 1000, CDN_BASE_DELAY_MS)
                                : CDN_BASE_DELAY_MS;
                            await sleep(delayMs);
                        } catch (err) {
                            attachmentStats.failed++;
                            const httpStatus = err?.response?.status || null;
                            const reason = httpStatus
                                ? `fetch failed — HTTP ${httpStatus}`
                                : `fetch failed — ${err.code || err.message || 'network error'}`;

                            logger.warn({ filename: attachment.filename, httpStatus, reason }, 'Failed to download attachment — writing .missing stub');

                            // Write a named .missing stub so the gap is visible in the ZIP.
                            // Include a sanitized filename stem to guarantee uniqueness when
                            // a single message has multiple failed attachments.
                            const safeStem = (attachment.filename || 'attachment')
                                .replace(/\.[^.]+$/, '')          // strip extension
                                .replace(/[^a-z0-9_\-]/gi, '_')   // fs-safe
                                .slice(0, 40);
                            const stubName = `${formattedTime} - ${msg.id} - ${safeStem}.missing`;
                            const stubPath = `attachments/${stubName}`;
                            const stubContent = JSON.stringify({
                                reason,
                                url: attachment.url,
                                http_status: httpStatus,
                                filename: attachment.filename,
                                message_id: msg.id,
                                timestamp: msg._timestamp,
                                sender: msg.phone || null
                            });
                            fileHashes.push({ path: stubPath, sha256: sha256(stubContent), size: Buffer.byteLength(stubContent) });
                            archive.append(stubContent, { name: stubPath });

                            failedAttachments.push({
                                message_id: msg.id,
                                timestamp: msg._timestamp,
                                filename: attachment.filename,
                                url: attachment.url,
                                reason,
                                stub_path: stubPath
                            });

                            const errRetryHeader = err?.response?.headers?.['retry-after'] || err?.response?.headers?.['x-ratelimit-reset-after'];
                            const errDelayMs = errRetryHeader
                                ? Math.max(parseFloat(errRetryHeader) * 1000, CDN_BASE_DELAY_MS)
                                : CDN_BASE_DELAY_MS;
                            await sleep(errDelayMs);
                        }
                    }
                }

                // source/unresolved: embed has a Media field but Twilio never fetched
                // the bytes at ingest time — no Discord attachment exists. No stub file
                // (there is nothing to write), but the gap is named in the manifest.
                if (msg._sourceUnresolved) {
                    failedAttachments.push({
                        message_id: msg.id,
                        timestamp: msg._timestamp,
                        filename: null,
                        url: null,
                        reason: 'source/unresolved — bytes were never fetched at ingest time',
                        stub_path: null
                    });
                }
            }

            const readme = `# Your ${BRAND.name} Export

Book: ${book.name}
Exported: ${exportTimestamp}

This archive contains:
- messages.json: All messages with drops metadata
  - ${messages.length} messages total
  - ${dropsRows.length} metadata drops
  - ${enrichedMessages.filter(m => m.metadata).length} messages with metadata

- attachments/: Media files renamed for chronological sorting
  - ${attachmentStats.downloaded} files downloaded successfully
  - ${attachmentStats.failed} files failed to download (see .missing stubs below)
  - Total attempted: ${attachmentStats.total}

- manifest.json: Cryptographic integrity manifest
  - SHA256 hashes for all files
  - Export provenance and timestamp
  - failed_attachments: structured list of every gap (message ID, reason, stub path)

Naming Convention:
YYYY_MM_DD - HH_MM_SS - UTC - {message_id}.{extension}

## Missing files
When a media file could not be retrieved, a .missing stub is written in its place
inside attachments/ with the same timestamp prefix. The stub is a JSON file that
records the reason, the original URL, the HTTP status (if any), and the message ID.

Reasons a file may be missing:
  - fetch failed — HTTP 403/404: the Discord CDN URL expired or was revoked.
  - fetch failed — network error: transient connectivity issue at export time.
  - source/unresolved: the platform could not download the file from the source
    (e.g. WhatsApp) at the time the message was received. No bytes exist anywhere.

All gaps are also listed in manifest.json under "failed_attachments" so you can
audit completeness without unpacking the archive.

## Verification
To verify file integrity, compare SHA256 hashes in manifest.json:
  sha256sum messages.json
  sha256sum attachments/*
`;
            fileHashes.push({ path: 'README.txt', sha256: sha256(readme), size: Buffer.byteLength(readme) });
            archive.append(readme, { name: 'README.txt' });

            const manifest = {
                version: '1.1',
                format: BRAND.exportFormatTag,
                provenance: {
                    source: process.env.REPLIT_DEV_DOMAIN || process.env.REPL_SLUG || BRAND.exportSourceFallback,
                    exported_at: exportTimestamp,
                    book_id: book_id,
                    book_name: book.name
                },
                statistics: {
                    total_files: fileHashes.length + 1,
                    total_messages: messages.length,
                    total_drops: dropsRows.length,
                    attachments_downloaded: attachmentStats.downloaded,
                    // Derived from failedAttachments so this count always equals
                    // failed_attachments.length — includes both fetch errors and
                    // source/unresolved gaps (which don't bump attachmentStats.failed).
                    attachments_failed: failedAttachments.length
                },
                // Reconcile the Discord thread export against the authoritative
                // anatta_messages row count. A non-zero gap means some messages
                // exist in the DB but were not returned by the Discord thread
                // (e.g. bot outage, thread partial deletion, pre-activation messages).
                // null means the ledger query was unavailable (non-fatal).
                ledger: {
                    messages_in_db: ledgerMessageCount,
                    messages_exported: messages.length,
                    gap: ledgerMessageCount !== null ? ledgerMessageCount - messages.length : null,
                    note: (ledgerMessageCount !== null && ledgerMessageCount !== messages.length)
                        ? 'Gap: some DB rows were not present in the Discord thread. May reflect bot outage, pre-activation messages, or thread edits.'
                        : null
                },
                failed_attachments: failedAttachments,
                files: fileHashes,
                integrity: {
                    algorithm: 'SHA256',
                    note: 'Each file hash can be verified independently using sha256sum or similar tools'
                }
            };

            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

            await archive.finalize();

            if (logAudit) {
                logAudit(pool, resolvedSchema, req.userId, 'book_export',
                    `Exported book "${book.name}" (${messages.length} messages, ${attachmentStats.downloaded} attachments)`)
                    .catch(err => logger.warn({ err }, 'Failed to log export audit'));
            }

            logger.info({ bookId: book_id, messages: messages.length, drops: dropsRows.length }, 'Export created');

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

    app.get('/api/books/:book_id/export/csv', ...exportMiddleware, async (req, res) => {
        const { book_id } = req.params;
        try {
            const client = req.dbClient || pool;
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const isDev = req.tenantContext?.userRole === 'dev';

            const loaded = await loadBookExportData({
                client, thothBot, tenantSchema, book_id, selectedMessageIds: null, isDev, logger
            });
            if (loaded.notFound) {
                return res.status(404).json({ error: 'Book not found in your tenant' });
            }
            const { book, messages, anattaCidByMsgId } = loaded;

            const csv = buildCsvFromMessages(messages, book.name, anattaCidByMsgId);
            const filename = `${book.name.replace(/[^a-z0-9]/gi, '_')}_export.csv`;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csv);
        } catch (err) {
            logger.error({ err, bookId: book_id }, 'Error creating CSV export');
            if (!res.headersSent) {
                res.status(500).json({ error: 'An internal error occurred. Please try again.' });
            }
        }
    });

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
