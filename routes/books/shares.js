const { config } = require('../../config');
const { verifyBookOwnership, checkShareRateLimit } = require('./shared');
const { z } = require('../../lib/validators');

function register(app, deps) {
    const { pool, helpers, middleware, logger } = deps;
    const { requireAuth } = middleware;
    const { logAudit } = helpers || {};

    app.get('/api/books/:book_id/shares', requireAuth, async (req, res) => {
        try {
            const { book_id } = req.params;
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();

            const book = await verifyBookOwnership(pool, book_id, req.userEmail, req.tenantSchema);
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }

            const sharesResult = await pool.query(`
                SELECT shared_with_email, permission_level, invited_at
                FROM core.book_shares
                WHERE book_fractal_id = $1 AND LOWER(owner_email) = $2 AND revoked_at IS NULL
                ORDER BY invited_at DESC
            `, [book_id, normalizedOwnerEmail]);

            res.json({ shares: sharesResult.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching book shares');
            res.status(500).json({ error: 'Failed to fetch shares' });
        }
    });

    app.post('/api/books/:book_id/share', requireAuth, async (req, res) => {
        try {
            const { book_id } = req.params;
            const { email } = req.body;

            const emailResult = z.string().email().safeParse(email);
            if (!emailResult.success) {
                return res.status(400).json({ error: 'Valid email required' });
            }

            const normalizedEmail = email.toLowerCase().trim();
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();

            if (normalizedEmail === normalizedOwnerEmail) {
                return res.status(400).json({ error: 'Cannot share with yourself' });
            }

            const book = await verifyBookOwnership(pool, book_id, req.userEmail, req.tenantSchema);
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }

            if (!checkShareRateLimit(req.userId)) {
                logger.warn({ userId: req.userId }, 'Share rate limit exceeded');
                return res.status(429).json({ error: 'Too many shares. Please try again later (limit: 10/hour)' });
            }

            const existingShare = await pool.query(`
                SELECT id, revoked_at FROM core.book_shares
                WHERE book_fractal_id = $1
                  AND LOWER(owner_email) = $2
                  AND LOWER(shared_with_email) = $3
            `, [book_id, normalizedOwnerEmail, normalizedEmail]);

            let shouldSendEmail = false;

            if (existingShare.rows.length > 0) {
                const share = existingShare.rows[0];
                if (share.revoked_at) {
                    await pool.query(`
                        UPDATE core.book_shares
                        SET revoked_at = NULL, invited_at = NOW()
                        WHERE id = $1
                    `, [share.id]);
                    shouldSendEmail = true;
                } else {
                    return res.json({ success: true, message: 'Already shared with this email', alreadyShared: true });
                }
            } else {
                await pool.query(`
                    INSERT INTO core.book_shares (book_fractal_id, owner_email, shared_with_email, permission_level)
                    VALUES ($1, $2, $3, 'viewer')
                `, [book_id, normalizedOwnerEmail, normalizedEmail]);
                shouldSendEmail = true;
            }

            if (shouldSendEmail) {
                try {
                    const { Resend } = require('resend');
                    const resend = new Resend(process.env.RESEND_API_KEY);

                    const domain = config.replit.primaryDomain;
                    const dashboardLink = `https://${domain}/`;

                    await resend.emails.send({
                        from: `Nyan <nyan@${domain}>`,
                        to: normalizedEmail,
                        subject: `${normalizedOwnerEmail} shared a book with you on Nyanbook`,
                        html: `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                                <h2 style="color: #333;">You've been invited to view a book!</h2>
                                <p style="color: #666; font-size: 16px;">
                                    <strong>${normalizedOwnerEmail}</strong> has shared the book <strong>"${book.book_name}"</strong> with you on Nyanbook.
                                </p>
                                <div style="background: rgba(124, 58, 237, 0.1); border: 1px solid rgba(124, 58, 237, 0.2); border-radius: 8px; padding: 1rem; margin: 20px 0;">
                                    <p style="color: #666; margin: 0;">
                                        📚 <strong>Book:</strong> ${book.book_name}<br>
                                        👤 <strong>Shared by:</strong> ${normalizedOwnerEmail}<br>
                                        🔐 <strong>Access:</strong> View only
                                    </p>
                                </div>
                                <p style="color: #666; font-size: 16px;">
                                    To access this book, register or log in with this email address:
                                </p>
                                <div style="text-align: center; margin: 30px 0;">
                                    <a href="${dashboardLink}" style="background-color: #7c3aed; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                                        Open Nyanbook
                                    </a>
                                </div>
                                <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                                <p style="color: #999; font-size: 12px;">
                                    If you don't want to receive these emails, you can ignore this message.
                                </p>
                            </div>
                        `
                    });
                    logger.info({ email: normalizedEmail, book: book.book_name }, 'Book share invite email sent');
                } catch (emailError) {
                    logger.error({ err: emailError }, 'Failed to send share invite email');
                }
            }

            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'book_share', `Shared book ${book.book_name} with ${normalizedEmail}`);
            }

            res.json({ success: true, message: `Invited ${normalizedEmail} to view this book` });
        } catch (error) {
            logger.error({ err: error }, 'Error sharing book');
            res.status(500).json({ error: 'Failed to share book' });
        }
    });

    app.delete('/api/books/:book_id/share/:email', requireAuth, async (req, res) => {
        try {
            const { book_id, email } = req.params;
            const normalizedEmail = decodeURIComponent(email).toLowerCase().trim();
            const normalizedOwnerEmail = req.userEmail.toLowerCase().trim();

            const book = await verifyBookOwnership(pool, book_id, req.userEmail, req.tenantSchema);
            if (!book) {
                return res.status(404).json({ error: 'Book not found or access denied' });
            }

            const result = await pool.query(`
                UPDATE core.book_shares
                SET revoked_at = NOW()
                WHERE book_fractal_id = $1
                  AND LOWER(owner_email) = $2
                  AND LOWER(shared_with_email) = $3
                  AND revoked_at IS NULL
                RETURNING id
            `, [book_id, normalizedOwnerEmail, normalizedEmail]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Share not found' });
            }

            if (logAudit) {
                await logAudit(pool, req.tenantSchema, req.userId, 'book_unshare', `Revoked access for ${normalizedEmail} to book ${book.book_name}`);
            }

            res.json({ success: true, message: `Revoked access for ${normalizedEmail}` });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking book share');
            res.status(500).json({ error: 'Failed to revoke access' });
        }
    });
}

module.exports = { register };
