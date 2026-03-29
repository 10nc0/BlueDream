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
            const rawToken = crypto.randomBytes(32).toString('base64url');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            await pool.query(
                `UPDATE ${req.tenantSchema}.books SET agent_token_hash = $1 WHERE fractal_id = $2`,
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
