const crypto = require('crypto');
const { assertValidSchemaName } = require('../../lib/validators');
const { verifyBookOwnership } = require('./shared');

function register(app, deps) {
    const { pool, helpers, middleware, logger } = deps;
    const { requireAuth } = middleware;
    const { logAudit } = helpers || {};

    // Check whether an agent token exists for this book.
    // Reads from core.book_registry — single source of truth (Task #211).
    // The tenant-schema column (tenantSchema.books.agent_token_hash) is dormant.
    app.get('/api/books/:book_id/agent-token', requireAuth, async (req, res) => {
        try {
            const book = await verifyBookOwnership(pool, req.params.book_id, req.userEmail, req.tenantSchema);
            if (!book) return res.status(404).json({ error: 'Book not found or access denied' });
            const result = await pool.query(
                `SELECT agent_token_hash FROM core.book_registry WHERE fractal_id = $1`,
                [req.params.book_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'Book not found' });
            res.json({ has_token: !!result.rows[0].agent_token_hash });
        } catch (error) {
            logger.error({ err: error }, 'Agent token check failed');
            res.status(500).json({ error: 'Failed to check agent token' });
        }
    });

    // Generate a new agent token for this book.
    // Only writes to core.book_registry (Task #211 — tenant silo retired).
    app.post('/api/books/:book_id/agent-token', requireAuth, async (req, res) => {
        try {
            const book = await verifyBookOwnership(pool, req.params.book_id, req.userEmail, req.tenantSchema);
            if (!book) return res.status(404).json({ error: 'Book not found or access denied' });
            assertValidSchemaName(req.tenantSchema);
            // Token generation requires an active book. Activation creates the Discord
            // thread; a token without a thread has nowhere to route messages.
            const statusRow = await pool.query(
                `SELECT status FROM ${req.tenantSchema}.books WHERE fractal_id = $1`,
                [req.params.book_id]
            );
            // 'active' = live; 'suspended' = deactivated but was live (thread + messages exist).
            // 'pending' / 'inactive' = never activated — no thread, no messages — block these.
            const { status } = statusRow.rows[0] || {};
            if (!['active', 'suspended'].includes(status)) {
                return res.status(403).json({ error: 'Book must be activated via WhatsApp before generating an agent token.' });
            }
            const rawToken = crypto.randomBytes(32).toString('base64url');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            // Single write — core.book_registry is the sole token store.
            await pool.query(
                `UPDATE core.book_registry SET agent_token_hash = $1 WHERE fractal_id = $2`,
                [tokenHash, req.params.book_id]
            );
            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'agent_token_create', `Agent token generated for book ${req.params.book_id}`);
            }
            logger.info({ tenantSchema: req.tenantSchema, bookId: req.params.book_id }, 'Agent token generated');
            res.json({ success: true, token: rawToken });
        } catch (error) {
            logger.error({ err: error }, 'Agent token generation failed');
            res.status(500).json({ error: 'Failed to generate agent token' });
        }
    });

    // Revoke the agent token for this book.
    // Only clears core.book_registry (Task #211 — tenant silo retired).
    app.delete('/api/books/:book_id/agent-token', requireAuth, async (req, res) => {
        try {
            const book = await verifyBookOwnership(pool, req.params.book_id, req.userEmail, req.tenantSchema);
            if (!book) return res.status(404).json({ error: 'Book not found or access denied' });
            // Clear the core registry so the token stops routing immediately.
            await pool.query(
                `UPDATE core.book_registry SET agent_token_hash = NULL WHERE fractal_id = $1`,
                [req.params.book_id]
            );
            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'agent_token_delete', `Agent token revoked for book ${req.params.book_id}`);
            }
            logger.info({ tenantSchema: req.tenantSchema, bookId: req.params.book_id }, 'Agent token revoked');
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Agent token revocation failed');
            res.status(500).json({ error: 'Failed to revoke agent token' });
        }
    });
}

module.exports = { register };
