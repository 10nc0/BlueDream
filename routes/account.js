'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Resend } = require('resend');
const { config } = require('../config');
const { EMAIL } = require('../config/constants');
const { BRAND } = require('../config/brand');
const { assertValidSchemaName } = require('../lib/validators');

function hashToken(t) {
    return crypto.createHash('sha256').update(t).digest('hex');
}

const TOKEN_GEN_COOLDOWN_MS = 60_000;
const tokenGenTimestamps = new Map();

function register(app, deps) {
    const { pool, middleware, logger } = deps;
    const { requireAuth } = middleware;

    function getResend() {
        return new Resend(process.env.RESEND_API_KEY);
    }

    function getDomain() {
        return config.replit?.primaryDomain || process.env.REPLIT_DEV_DOMAIN || 'localhost';
    }

    // GET /api/me — identity
    app.get('/api/me', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, email, role, created_at, preferences FROM ${req.tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
            const u = result.rows[0];
            res.json({
                id: u.id,
                email: u.email,
                role: u.role,
                member_since: u.created_at,
                tenant_schema: req.tenantSchema,
                preferences: u.preferences || {}
            });
        } catch (err) {
            logger.error({ err }, 'GET /api/me error');
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/me/password-reset — send reset email for authenticated user (no phone needed)
    app.post('/api/me/password-reset', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const email = (req.userEmail || '').toLowerCase().trim();
            if (!email) return res.status(400).json({ error: 'No email on account' });

            const resetToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashToken(resetToken);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

            await pool.query(
                `UPDATE core.password_reset_tokens SET used = TRUE WHERE LOWER(user_email) = $1 AND used = FALSE`,
                [email]
            );
            await pool.query(
                `INSERT INTO core.password_reset_tokens (token, user_email, tenant_schema, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [tokenHash, email, req.tenantSchema, expiresAt]
            );

            const domain = getDomain();
            const resetLink = `https://${domain}/reset-password.html?token=${resetToken}`;

            await getResend().emails.send({
                from: `${EMAIL.FROM_NAME} <${EMAIL.FROM_ADDRESS}>`,
                to: email,
                subject: `Reset Your ${BRAND.name} Password`,
                html: `
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <h2 style="color:#333;">Reset Your Password</h2>
                        <p style="color:#666;font-size:16px;">
                            You requested a password reset for your ${BRAND.name} account.
                            Click the button below to set a new password:
                        </p>
                        <div style="text-align:center;margin:30px 0;">
                            <a href="${resetLink}" style="background-color:#7c3aed;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">
                                Reset Password
                            </a>
                        </div>
                        <p style="color:#999;font-size:14px;">
                            This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.
                        </p>
                        <p style="color:#999;font-size:12px;">
                            If the button doesn't work, copy this link:<br>
                            <a href="${resetLink}" style="color:#7c3aed;">${resetLink}</a>
                        </p>
                    </div>
                `
            });

            res.json({ success: true, message: 'Password reset email sent. Check your inbox.' });
        } catch (err) {
            logger.error({ err }, 'POST /api/me/password-reset error');
            res.status(500).json({ error: 'Failed to send reset email' });
        }
    });

    // POST /api/me/email/request — initiate email address change
    app.post('/api/me/email/request', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const { newEmail } = req.body;
            if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
                return res.status(400).json({ error: 'Invalid email address' });
            }
            const normalizedNew = newEmail.toLowerCase().trim();
            const currentEmail = (req.userEmail || '').toLowerCase().trim();

            if (normalizedNew === currentEmail) {
                return res.status(400).json({ error: 'New email is the same as your current email' });
            }

            const existing = await pool.query(
                `SELECT user_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1`,
                [normalizedNew]
            );
            if (existing.rows.length > 0) {
                return res.status(409).json({ error: 'That email address is already in use' });
            }

            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashToken(token);
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await pool.query(
                `UPDATE core.email_change_tokens SET used = TRUE WHERE LOWER(user_email) = $1 AND used = FALSE`,
                [currentEmail]
            );
            await pool.query(
                `INSERT INTO core.email_change_tokens (tenant_schema, user_email, new_email, token_hash, expires_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [req.tenantSchema, currentEmail, normalizedNew, tokenHash, expiresAt]
            );

            const domain = getDomain();
            const verifyLink = `https://${domain}/api/me/email/verify?token=${token}`;
            const resend = getResend();

            await resend.emails.send({
                from: `${EMAIL.FROM_NAME} <${EMAIL.FROM_ADDRESS}>`,
                to: normalizedNew,
                subject: `Verify Your New Email — ${BRAND.name}`,
                html: `
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <h2 style="color:#333;">Verify Your New Email</h2>
                        <p style="color:#666;font-size:16px;">
                            A request was made to change your ${BRAND.name} account email to this address.
                            Click below to confirm:
                        </p>
                        <div style="text-align:center;margin:30px 0;">
                            <a href="${verifyLink}" style="background-color:#7c3aed;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">
                                Verify New Email
                            </a>
                        </div>
                        <p style="color:#999;font-size:14px;">
                            This link expires in 24 hours. If you didn't request this, ignore this email.
                        </p>
                    </div>
                `
            });

            await resend.emails.send({
                from: `${EMAIL.FROM_NAME} <${EMAIL.FROM_ADDRESS}>`,
                to: currentEmail,
                subject: `Security Alert: Email Change Requested — ${BRAND.name}`,
                html: `
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <h2 style="color:#e53e3e;">Security Alert</h2>
                        <p style="color:#666;font-size:16px;">
                            A request was made to change the email on your ${BRAND.name} account to
                            <strong>${normalizedNew}</strong>.
                        </p>
                        <p style="color:#666;font-size:16px;">
                            If you did not request this, your account may be compromised.
                            Please contact support immediately.
                        </p>
                    </div>
                `
            });

            res.json({ success: true, message: 'Verification email sent to your new address.' });
        } catch (err) {
            logger.error({ err }, 'POST /api/me/email/request error');
            res.status(500).json({ error: 'Failed to send verification email' });
        }
    });

    // GET /api/me/email/verify — confirm email change from link in email
    app.get('/api/me/email/verify', async (req, res) => {
        const { token } = req.query;
        if (!token) return res.redirect('/index.html?email_change=error&reason=missing_token');

        const tokenHash = hashToken(token);
        let client;
        try {
            const lookup = await pool.query(
                `SELECT * FROM core.email_change_tokens WHERE token_hash = $1`,
                [tokenHash]
            );
            if (!lookup.rows.length) {
                return res.redirect('/index.html?email_change=error&reason=invalid');
            }
            const row = lookup.rows[0];
            if (row.used) return res.redirect('/index.html?email_change=error&reason=used');
            if (new Date(row.expires_at) < new Date()) {
                return res.redirect('/index.html?email_change=error&reason=expired');
            }

            const safeSchema = assertValidSchemaName(row.tenant_schema);
            client = await pool.connect();
            await client.query('BEGIN');
            await client.query(
                `UPDATE ${safeSchema}.users SET email = $1, updated_at = NOW() WHERE LOWER(email) = $2`,
                [row.new_email, row.user_email.toLowerCase()]
            );
            await client.query(
                `UPDATE core.user_email_to_tenant SET email = $1 WHERE LOWER(email) = $2`,
                [row.new_email, row.user_email.toLowerCase()]
            );
            await client.query(
                `UPDATE core.email_change_tokens SET used = TRUE WHERE token_hash = $1`,
                [tokenHash]
            );
            await client.query('COMMIT');
            return res.redirect('/index.html?email_change=success');
        } catch (err) {
            if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
            logger.error({ err }, 'GET /api/me/email/verify error');
            return res.redirect('/index.html?email_change=error&reason=internal');
        } finally {
            if (client) client.release();
        }
    });

    // GET /api/me/sessions — own active sessions
    app.get('/api/me/sessions', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.json({ sessions: [] });
            const result = await pool.query(
                `SELECT id, session_id, ip_address, user_agent, device_type, browser, os, location,
                        login_time, last_activity, is_active
                 FROM ${req.tenantSchema}.active_sessions
                 WHERE user_id = $1 AND is_active = TRUE
                 ORDER BY last_activity DESC LIMIT 20`,
                [req.userId]
            );
            const currentSid = req.session?.id || req.sessionID || null;
            const sessions = result.rows.map(s => ({
                ...s,
                is_current: currentSid ? s.session_id === currentSid : false
            }));
            res.json({ sessions });
        } catch (err) {
            logger.error({ err }, 'GET /api/me/sessions error');
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/me/sessions/:id — revoke a specific session
    app.delete('/api/me/sessions/:id', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const { id } = req.params;
            const sessionRow = await pool.query(
                `SELECT session_id FROM ${req.tenantSchema}.active_sessions
                 WHERE id = $1 AND user_id = $2`,
                [id, req.userId]
            );
            if (!sessionRow.rows.length) return res.status(404).json({ error: 'Session not found' });
            const sid = sessionRow.rows[0].session_id;
            const currentSid = req.session?.id || req.sessionID || null;
            if (currentSid && sid === currentSid) {
                return res.status(403).json({ error: 'Cannot revoke your current session' });
            }
            await pool.query(
                `UPDATE ${req.tenantSchema}.active_sessions SET is_active = FALSE WHERE id = $1`,
                [id]
            );
            try { await pool.query('DELETE FROM sessions WHERE sid = $1', [sid]); } catch (_) {}
            res.json({ success: true });
        } catch (err) {
            logger.error({ err }, 'DELETE /api/me/sessions/:id error');
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/me/sessions/revoke-all — revoke all except current
    app.post('/api/me/sessions/revoke-all', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const currentSid = req.session?.id || req.sessionID || '';
            const others = await pool.query(
                `SELECT session_id FROM ${req.tenantSchema}.active_sessions
                 WHERE user_id = $1 AND is_active = TRUE AND session_id != $2`,
                [req.userId, currentSid]
            );
            await pool.query(
                `UPDATE ${req.tenantSchema}.active_sessions
                 SET is_active = FALSE WHERE user_id = $1 AND session_id != $2`,
                [req.userId, currentSid]
            );
            for (const row of others.rows) {
                try { await pool.query('DELETE FROM sessions WHERE sid = $1', [row.session_id]); } catch (_) {}
            }
            res.json({ success: true, count: others.rows.length });
        } catch (err) {
            logger.error({ err }, 'POST /api/me/sessions/revoke-all error');
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/me/token — current user token status
    app.get('/api/me/token', requireAuth, async (req, res) => {
        try {
            const email = (req.userEmail || '').toLowerCase();
            const result = await pool.query(
                `SELECT id, created_at, last_used_at FROM core.user_tokens
                 WHERE tenant_schema = $1 AND LOWER(user_email) = $2`,
                [req.tenantSchema, email]
            );
            if (!result.rows.length) return res.json({ exists: false });
            const t = result.rows[0];
            res.json({ exists: true, created_at: t.created_at, last_used_at: t.last_used_at });
        } catch (err) {
            logger.error({ err }, 'GET /api/me/token error');
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/me/token — generate user token (requires password, rate-limited)
    app.post('/api/me/token', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const { currentPassword } = req.body;
            if (!currentPassword) return res.status(400).json({ error: 'Current password required' });

            const userResult = await pool.query(
                `SELECT password_hash FROM ${req.tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            if (!userResult.rows.length) return res.status(401).json({ error: 'User not found' });
            const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
            if (!valid) return res.status(401).json({ error: 'Incorrect password' });

            const email = (req.userEmail || '').toLowerCase();
            const lastGen = tokenGenTimestamps.get(email);
            if (lastGen && Date.now() - lastGen < TOKEN_GEN_COOLDOWN_MS) {
                const retryAfter = Math.ceil((TOKEN_GEN_COOLDOWN_MS - (Date.now() - lastGen)) / 1000);
                res.set('Retry-After', String(retryAfter));
                return res.status(429).json({ error: `Rate limited — try again in ${retryAfter}s` });
            }

            await pool.query(
                `DELETE FROM core.user_tokens WHERE tenant_schema = $1 AND LOWER(user_email) = $2`,
                [req.tenantSchema, email]
            );

            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashToken(rawToken);
            await pool.query(
                `INSERT INTO core.user_tokens (tenant_schema, user_email, token_hash)
                 VALUES ($1, $2, $3)`,
                [req.tenantSchema, email, tokenHash]
            );
            tokenGenTimestamps.set(email, Date.now());

            res.json({ success: true, token: rawToken });
        } catch (err) {
            logger.error({ err }, 'POST /api/me/token error');
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/me/token — revoke user token
    app.delete('/api/me/token', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const email = (req.userEmail || '').toLowerCase();
            await pool.query(
                `DELETE FROM core.user_tokens WHERE tenant_schema = $1 AND LOWER(user_email) = $2`,
                [req.tenantSchema, email]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error({ err }, 'DELETE /api/me/token error');
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/me/contributors — list contributor grants by current user
    app.get('/api/me/contributors', requireAuth, async (req, res) => {
        try {
            const email = (req.userEmail || '').toLowerCase();
            const result = await pool.query(
                `SELECT id, granted_to_email, book_fractal_ids, created_at, last_used_at
                 FROM core.contributor_tokens
                 WHERE tenant_schema = $1 AND LOWER(granted_by_email) = $2
                 ORDER BY created_at DESC`,
                [req.tenantSchema, email]
            );
            res.json({ contributors: result.rows });
        } catch (err) {
            logger.error({ err }, 'GET /api/me/contributors error');
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/me/contributors — grant contributor access
    app.post('/api/me/contributors', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const { grantedToEmail, bookFractalIds, currentPassword } = req.body;
            if (!grantedToEmail || !Array.isArray(bookFractalIds) || !bookFractalIds.length) {
                return res.status(400).json({ error: 'grantedToEmail and bookFractalIds[] required' });
            }
            if (!currentPassword) return res.status(400).json({ error: 'Current password required' });

            const normalizedGrantee = grantedToEmail.toLowerCase().trim();
            const ownerEmail = (req.userEmail || '').toLowerCase();
            if (normalizedGrantee === ownerEmail) {
                return res.status(400).json({ error: 'Cannot grant access to yourself' });
            }

            const userResult = await pool.query(
                `SELECT password_hash FROM ${req.tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            if (!userResult.rows.length) return res.status(401).json({ error: 'User not found' });
            const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
            if (!valid) return res.status(401).json({ error: 'Incorrect password' });

            // Ownership check: only books whose created_by_admin_id matches the
            // requesting user's email may be granted — prevents cross-user privilege escalation
            const bookCheck = await pool.query(
                `SELECT fractal_id FROM ${req.tenantSchema}.books
                 WHERE fractal_id = ANY($1::text[])
                   AND LOWER(created_by_admin_id) = $2`,
                [bookFractalIds, ownerEmail]
            );
            if (bookCheck.rows.length !== bookFractalIds.length) {
                return res.status(400).json({ error: 'One or more books not found in your account or not owned by you' });
            }

            for (const fid of bookFractalIds) {
                const cnt = await pool.query(
                    `SELECT COUNT(*) FROM core.contributor_tokens
                     WHERE tenant_schema = $1 AND $2 = ANY(book_fractal_ids)`,
                    [req.tenantSchema, fid]
                );
                if (parseInt(cnt.rows[0].count, 10) >= 10) {
                    return res.status(400).json({ error: `Max 10 contributors reached for book ${fid}` });
                }
            }

            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashToken(rawToken);
            await pool.query(
                `INSERT INTO core.contributor_tokens
                     (granted_by_email, granted_to_email, tenant_schema, book_fractal_ids, token_hash)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT ON CONSTRAINT uq_contributor_per_pair
                 DO UPDATE SET book_fractal_ids = $4, token_hash = $5, last_used_at = NULL`,
                [ownerEmail, normalizedGrantee, req.tenantSchema, bookFractalIds, tokenHash]
            );

            res.json({ success: true, token: rawToken });
        } catch (err) {
            logger.error({ err }, 'POST /api/me/contributors error');
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/me/contributors/:id — revoke contributor access
    app.delete('/api/me/contributors/:id', requireAuth, async (req, res) => {
        try {
            const email = (req.userEmail || '').toLowerCase();
            const { id } = req.params;
            const result = await pool.query(
                `DELETE FROM core.contributor_tokens
                 WHERE id = $1 AND tenant_schema = $2 AND LOWER(granted_by_email) = $3
                 RETURNING id`,
                [id, req.tenantSchema, email]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Contributor not found' });
            res.json({ success: true });
        } catch (err) {
            logger.error({ err }, 'DELETE /api/me/contributors/:id error');
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/me/tags — drop-tag frequencies from PITA mesh (not book-level tags)
    app.get('/api/me/tags', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT LOWER(unnest(extracted_tags)) AS tag, COUNT(*) AS count
                 FROM ${req.tenantSchema}.drops
                 WHERE extracted_tags IS NOT NULL AND cardinality(extracted_tags) > 0
                 GROUP BY 1
                 ORDER BY count DESC
                 LIMIT 200`
            );
            res.json({ tags: result.rows });
        } catch (err) {
            logger.error({ err }, 'GET /api/me/tags error');
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/me/security-log — last 10 security-relevant events for current user
    app.get('/api/me/security-log', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.json({ events: [] });
            const result = await pool.query(
                `SELECT id, timestamp, action_type, ip_address, details
                 FROM ${req.tenantSchema}.audit_logs
                 WHERE actor_user_id = $1
                   AND action_type IN ('LOGIN','LOGOUT','REVOKE_SESSION','REVOKE_ALL_SESSIONS',
                                       'UPDATE_EMAIL','UPDATE_PASSWORD','SIGNUP')
                 ORDER BY timestamp DESC NULLS LAST
                 LIMIT 10`,
                [req.userId]
            );
            res.json({ events: result.rows });
        } catch (err) {
            logger.error({ err }, 'GET /api/me/security-log error');
            res.status(500).json({ error: err.message });
        }
    });

    // PATCH /api/me/preferences — update locale / monthly email backup default
    app.patch('/api/me/preferences', requireAuth, async (req, res) => {
        try {
            if (!req.userId) return res.status(403).json({ error: 'Session auth required' });
            const ALLOWED = ['locale', 'monthlyEmailBackupDefault'];
            const updates = {};
            for (const k of ALLOWED) {
                if (req.body[k] !== undefined) updates[k] = req.body[k];
            }
            if (!Object.keys(updates).length) {
                return res.status(400).json({ error: 'No valid preference fields provided' });
            }
            await pool.query(
                `UPDATE ${req.tenantSchema}.users
                 SET preferences = preferences || $1::jsonb, updated_at = NOW()
                 WHERE id = $2`,
                [JSON.stringify(updates), req.userId]
            );
            res.json({ success: true, preferences: updates });
        } catch (err) {
            logger.error({ err }, 'PATCH /api/me/preferences error');
            res.status(500).json({ error: err.message });
        }
    });

    return {
        endpoints: [
            'GET    /api/me',
            'POST   /api/me/password-reset',
            'POST   /api/me/email/request',
            'GET    /api/me/email/verify',
            'GET    /api/me/sessions',
            'DELETE /api/me/sessions/:id',
            'POST   /api/me/sessions/revoke-all',
            'GET    /api/me/token',
            'POST   /api/me/token',
            'DELETE /api/me/token',
            'GET    /api/me/contributors',
            'POST   /api/me/contributors',
            'DELETE /api/me/contributors/:id',
            'GET    /api/me/tags',
            'PATCH  /api/me/preferences',
        ]
    };
}

module.exports = { register: register };
