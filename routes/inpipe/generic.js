const crypto = require('crypto');
const multer = require('multer');
const { writeDrop } = require('../../lib/drop-writer');
const { VALID_SCHEMA_PATTERN } = require('../../lib/validators');
const { AttachmentIngestion } = require('../../utils/attachment-ingestion');
const phiBreathe = require('../../lib/phi-breathe');

// Memory storage — files held in-memory as Buffer; 10 MB hard cap.
const _upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
}).single('attachment');

// Normalise the tags field across JSON and multipart requests.
// JSON: tags is already an array.
// Multipart: multer puts repeated `tags` values into an array, or the caller
// may send a single JSON-encoded string like '["foo","bar"]'.
function _parseTags(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('[')) {
            try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
        }
        return [raw];
    }
    return [];
}

function register(app, deps) {
    const { pool, logger } = deps;

    if (!pool) {
        logger.warn('Generic inpipe: pool not available, skipping registration');
        return;
    }

    app.post('/api/inpipe/generic', (req, res, next) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.toLowerCase().startsWith('multipart/form-data')) {
            return _upload(req, res, (err) => {
                if (err) {
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({ error: 'Attachment too large (max 10 MB)' });
                    }
                    return res.status(400).json({ error: `Multipart parse error: ${err.message}` });
                }
                next();
            });
        }
        next();
    }, async (req, res) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Authorization required. Use: Authorization: Bearer <agent_token>' });
            }
            const providedToken = authHeader.slice(7).trim();
            if (!providedToken) {
                return res.status(401).json({ error: 'Bearer token must not be empty' });
            }

            const providedHash = crypto.createHash('sha256').update(providedToken).digest('hex');
            const registryRow = await pool.query(
                `SELECT fractal_id, tenant_schema, status FROM core.book_registry WHERE agent_token_hash = $1`,
                [providedHash]
            );
            if (registryRow.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid agent token' });
            }
            const { fractal_id: bookFractalId, tenant_schema: tenantSchema, status } = registryRow.rows[0];
            if (status !== 'active' && status !== 'suspended') {
                return res.status(403).json({ error: 'Book is not active' });
            }
            if (!VALID_SCHEMA_PATTERN.test(tenantSchema)) {
                return res.status(400).json({ error: 'Invalid tenant schema' });
            }

            const body = req.body || {};

            // Defense in depth: if book_id is provided it must match the token's book.
            if (body.book_id && body.book_id !== bookFractalId) {
                return res.status(403).json({ error: 'book_id does not match agent token scope' });
            }

            const { metadata_text, sent_at } = body;

            if (!metadata_text || typeof metadata_text !== 'string' || metadata_text.trim().length === 0) {
                return res.status(400).json({ error: 'metadata_text is required' });
            }
            if (metadata_text.length > 10000) {
                return res.status(400).json({ error: 'metadata_text too long (max 10000 characters)' });
            }

            const callerTags = _parseTags(body.tags)
                .filter(t => typeof t === 'string' && t.length > 0 && t.length <= 500);

            const sentAtValue = (sent_at && !isNaN(new Date(sent_at).getTime()))
                ? new Date(sent_at).toISOString()
                : null;

            // Attachment handling — supports both:
            //   multipart/form-data: `attachment` file field (multer → req.file)
            //   application/json:    `attachment` base64 string in body
            let effectiveText = metadata_text.trim();
            let attachDocList = null;

            if (req.file) {
                attachDocList = [{
                    data: req.file.buffer.toString('base64'),
                    name: req.file.originalname || 'attachment',
                    type: req.file.mimetype || null
                }];
            } else if (body.attachment && typeof body.attachment === 'string') {
                attachDocList = [{
                    data: body.attachment,
                    name: body.attachment_name || 'attachment',
                    type: body.attachment_type || null
                }];
            }

            if (attachDocList) {
                try {
                    const ingested = await AttachmentIngestion.ingest(attachDocList, '127.0.0.1');
                    if (ingested.extractedText) {
                        effectiveText = effectiveText
                            ? `${effectiveText}\n\n[Attached]\n${ingested.extractedText}`
                            : `[Attached]\n${ingested.extractedText}`;
                    }
                } catch (attachErr) {
                    logger.warn({ err: attachErr.message }, 'Generic inpipe: attachment ingestion failed (non-fatal)');
                }
            }

            // source_id: gen: + first 24 hex chars of SHA-256(fractalId:timestamp:text)
            const sourceId = 'gen:' + crypto
                .createHash('sha256')
                .update(`${bookFractalId}:${Date.now()}:${effectiveText}`)
                .digest('hex')
                .slice(0, 24);

            const bookResult = await pool.query(
                `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [bookFractalId]
            );
            if (bookResult.rows.length === 0) {
                return res.status(404).json({ error: 'Book not found' });
            }
            const bookInternalId = bookResult.rows[0].id;

            const { drop, extracted, payload_id } = await writeDrop({
                pool,
                tenantSchema,
                bookInternalId,
                sourceId,
                metadataText: effectiveText,
                tags: callerTags,
                sentAt: sentAtValue,
                phiStamp: phiBreathe.phiBreatheCount
            });

            logger.info({ bookId: bookFractalId, sourceId, tags: extracted.tags }, 'Generic inpipe: drop written');

            return res.status(201).json({
                success: true,
                payload_id,
                source_id: drop.source_id,
                extracted
            });
        } catch (error) {
            logger.error({ err: error }, 'Generic inpipe: error writing drop');
            return res.status(500).json({ error: 'An internal error occurred. Please try again.' });
        }
    });
}

module.exports = { register };
