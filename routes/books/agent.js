const crypto = require('crypto');
const { assertValidSchemaName } = require('../../lib/validators');
const { verifyBookOwnership } = require('./shared');

function register(app, deps) {
    const { pool, helpers, middleware, logger } = deps;
    const { requireAuth } = middleware;
    const { logAudit } = helpers || {};

    app.get('/api/books/:book_id/agent-token', requireAuth, async (req, res) => {
        try {
            const book = await verifyBookOwnership(pool, req.params.book_id, req.userEmail, req.tenantSchema);
            if (!book) return res.status(404).json({ error: 'Book not found or access denied' });
            assertValidSchemaName(req.tenantSchema);
            const result = await pool.query(
                `SELECT agent_token_hash FROM ${req.tenantSchema}.books WHERE fractal_id = $1`,
                [req.params.book_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'Book not found' });
            res.json({ has_token: !!result.rows[0].agent_token_hash });
        } catch (error) {
            logger.error({ err: error }, 'Agent token check failed');
            res.status(500).json({ error: 'Failed to check agent token' });
        }
    });

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
            await pool.query(
                `UPDATE ${req.tenantSchema}.books SET agent_token_hash = $1 WHERE fractal_id = $2`,
                [tokenHash, req.params.book_id]
            );
            // Mirror to core.book_registry so POST /api/agent/message can do an
            // O(1) cross-tenant lookup without scanning every tenant schema.
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

    app.delete('/api/books/:book_id/agent-token', requireAuth, async (req, res) => {
        try {
            const book = await verifyBookOwnership(pool, req.params.book_id, req.userEmail, req.tenantSchema);
            if (!book) return res.status(404).json({ error: 'Book not found or access denied' });
            assertValidSchemaName(req.tenantSchema);
            await pool.query(
                `UPDATE ${req.tenantSchema}.books SET agent_token_hash = NULL WHERE fractal_id = $1`,
                [req.params.book_id]
            );
            // Clear the core mirror so the token stops routing immediately.
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
