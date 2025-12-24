const bcrypt = require('bcrypt');
const crypto = require('crypto');

function createAuthMiddleware(pool, authService, logger) {
    async function requireAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = authService.verifyToken(token);
            
            if (decoded && decoded.type === 'access') {
                req.userId = decoded.userId;
                req.userEmail = decoded.email;
                req.userRole = decoded.role;
                req.tenantId = decoded.tenantId;
                req.tenantSchema = `tenant_${decoded.tenantId}`;
                req.authMethod = 'jwt';
                return next();
            } else {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }
        }
        
        if (req.session && req.session.userId) {
            try {
                const mappingResult = await pool.query(
                    'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [req.session.userEmail]
                );
                
                if (mappingResult.rows.length === 0) {
                    return res.status(401).json({ error: 'User not found' });
                }
                
                const { tenant_id, tenant_schema } = mappingResult.rows[0];
                
                req.userId = req.session.userId;
                req.userEmail = req.session.userEmail;
                req.userRole = req.session.userRole;
                req.tenantId = tenant_id;
                req.tenantSchema = tenant_schema;
                req.authMethod = 'cookie';
                return next();
            } catch (error) {
                logger.error({ err: error }, 'Session auth error');
                return res.status(500).json({ error: 'Authentication failed' });
            }
        }
        
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login.html');
    }

    function requireRole(...allowedRoles) {
        return async (req, res, next) => {
            if (!req.userId || !req.tenantSchema) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const result = await pool.query(
                `SELECT role FROM ${req.tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            
            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            const userRole = result.rows[0].role;
            
            if (userRole === 'dev') {
                req.userRole = userRole;
                return next();
            }
            
            if (userRole === 'admin' && (allowedRoles.includes('admin') || allowedRoles.includes('user'))) {
                req.userRole = userRole;
                return next();
            }
            
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            
            req.userRole = userRole;
            next();
        };
    }

    return { requireAuth, requireRole };
}

function registerAuthAdminRoutes(app, deps) {
    const { pool, authService, tenantManager, helpers, logger } = deps;
    const { logAudit, noCacheHeaders, getTimestamp, createSessionRecord } = helpers;
    
    const { requireAuth, requireRole } = createAuthMiddleware(pool, authService, logger);

    app.get('/api/auth/status', async (req, res) => {
        noCacheHeaders(res);
        
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                const decoded = authService.verifyToken(token);
                
                if (decoded && decoded.type === 'access') {
                    const mappingResult = await pool.query(
                        'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                        [decoded.email]
                    );
                    
                    if (mappingResult.rows.length > 0) {
                        const { tenant_schema } = mappingResult.rows[0];
                        const result = await pool.query(
                            `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                            [decoded.userId]
                        );
                        
                        if (result.rows.length > 0) {
                            return res.json({ authenticated: true, user: result.rows[0], authMethod: 'jwt' });
                        }
                    }
                }
            }
            
            if (req.session && req.session.userId && req.session.userEmail) {
                const mappingResult = await pool.query(
                    'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [req.session.userEmail]
                );
                
                if (mappingResult.rows.length > 0) {
                    const { tenant_schema } = mappingResult.rows[0];
                    const result = await pool.query(
                        `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                        [req.session.userId]
                    );
                    
                    if (result.rows.length > 0) {
                        return res.json({ authenticated: true, user: result.rows[0], authMethod: 'cookie' });
                    }
                }
            }
            
            res.json({ authenticated: false });
        } catch (error) {
            logger.error({ err: error }, 'Auth status error');
            res.json({ authenticated: false });
        }
    });

    app.post('/api/auth/login', async (req, res) => {
        noCacheHeaders(res);
        
        const { email, password } = req.body;
        
        logger.info({ email, ip: req.ip }, 'Login attempt');
        
        try {
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }
            
            const normalizedEmail = email.toLowerCase().trim();
            
            const mappingResult = await pool.query(
                'SELECT tenant_id, tenant_schema, user_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
                [normalizedEmail]
            );
            
            if (mappingResult.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            const { tenant_schema, user_id } = mappingResult.rows[0];
            
            const result = await pool.query(
                `SELECT * FROM ${tenant_schema}.users WHERE id = $1 AND LOWER(email) = $2`,
                [user_id, normalizedEmail]
            );
            
            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            const user = result.rows[0];
            const validPassword = await bcrypt.compare(password, user.password_hash);
            
            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            req.session.userId = user.id;
            req.session.userEmail = user.email;
            req.session.userRole = user.role;
            req.session.tenantId = user.tenant_id;
            
            const adminId = user.is_genesis_admin ? '01' : null;
            const accessToken = authService.signAccessToken(
                user.id, 
                user.email, 
                user.role,
                user.tenant_id,
                adminId,
                user.is_genesis_admin
            );
            const { token: refreshToken, tokenId } = authService.signRefreshToken(
                user.id, 
                user.email, 
                user.role,
                user.tenant_id,
                adminId,
                user.is_genesis_admin
            );
            
            const deviceInfo = req.get('user-agent') || 'unknown';
            await authService.storeRefreshToken(pool, tenant_schema, user.id, tokenId, deviceInfo, req.ip);
            
            req.session.save(async (err) => {
                if (err) {
                    logger.error({ err }, 'Session save error');
                    return res.status(500).json({ error: 'Session save failed' });
                }
                
                await createSessionRecord(user.id, req.sessionID, req, tenant_schema);
                
                logAudit(pool, req, 'LOGIN', 'USER', user.id.toString(), user.email, {
                    method: 'email_password',
                    role: user.role,
                    authType: 'jwt+cookie'
                }, tenant_schema);
                
                logger.info({ email: user.email, sessionId: req.sessionID }, 'Login successful');
                
                res.json({ 
                    success: true,
                    user: { 
                        id: user.id, 
                        email: user.email, 
                        role: user.role 
                    },
                    accessToken,
                    refreshToken,
                    tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
                });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/auth/check-genesis', async (req, res) => {
        noCacheHeaders(res);
        
        try {
            const tenantCount = await pool.query('SELECT COUNT(*) FROM core.tenant_catalog');
            const isFirstUser = parseInt(tenantCount.rows[0].count) === 0;
            res.json({ isFirstUser });
        } catch (error) {
            res.status(500).json({ error: 'Failed to check status' });
        }
    });

    app.post('/api/auth/signup', async (req, res) => {
        const { email, password, inviteToken } = req.body;
        
        logger.info({ email, ip: req.ip, hasInvite: !!inviteToken }, 'Signup attempt');
        
        try {
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }
            
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            
            const normalizedEmail = email.toLowerCase().trim();
            
            const emailCheck = await pool.query(
                'SELECT tenant_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
                [normalizedEmail]
            );
            if (emailCheck.rows.length > 0) {
                logger.info({ email }, 'Signup blocked - email exists');
                return res.status(409).json({ error: 'Email already registered' });
            }
            
            let newUser;
            let isGenesisAdmin = false;
            let tenantId = null;
            let tenantUserId = null;
            
            if (inviteToken) {
                const validation = await tenantManager.validateInviteToken(inviteToken);
                if (!validation.valid) {
                    return res.status(400).json({ error: validation.reason });
                }
                
                const invite = validation.invite;
                const passwordHash = await bcrypt.hash(password, 10);
                
                const schemaName = `tenant_${invite.tenant_id}`;
                const result = await pool.query(`
                    INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
                    VALUES ($1, $2, $3, $4, false)
                    RETURNING id, email, role, tenant_id, is_genesis_admin
                `, [normalizedEmail, passwordHash, invite.target_role, invite.tenant_id]);
                
                newUser = result.rows[0];
                tenantUserId = newUser.id;
                tenantId = invite.tenant_id;
                
                await pool.query(`
                    INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (email) DO NOTHING
                `, [normalizedEmail, tenantId, schemaName, tenantUserId]);
                
                await tenantManager.consumeInviteToken(inviteToken);
                
                logger.info({ email, tenantId, role: invite.target_role }, 'User joined tenant via invite');
            } else {
                const tenantCountResult = await pool.query('SELECT COUNT(*) as count FROM core.tenant_catalog');
                const isFirstUser = parseInt(tenantCountResult.rows[0].count) === 0;
                
                if (!isFirstUser) {
                    const fastCheck = tenantManager.checkSignupRateLimit(req.ip, email);
                    if (!fastCheck.allowed) {
                        logger.info({ email, reason: fastCheck.reason }, 'Rate limit blocked');
                        return res.status(429).json({ error: fastCheck.reason });
                    }
                    
                    const sybilCheck = await tenantManager.checkSybilRisk(email, req.ip);
                    if (!sybilCheck.allowed) {
                        logger.info({ email, reason: sybilCheck.reason }, 'Sybil protection blocked');
                        return res.status(429).json({ error: sybilCheck.reason });
                    }
                    
                    const rateLimitEmail = await tenantManager.checkRateLimit('tenant_creation', 'email', email);
                    if (!rateLimitEmail.allowed) {
                        return res.status(429).json({ error: rateLimitEmail.reason });
                    }
                    
                    const rateLimitIP = await tenantManager.checkRateLimit('tenant_creation', 'ip', req.ip);
                    if (!rateLimitIP.allowed) {
                        return res.status(429).json({ error: rateLimitIP.reason });
                    }
                } else {
                    logger.info('Genesis admin signup - skipping rate limits');
                }
                
                const passwordHash = await bcrypt.hash(password, 10);
                
                const userRole = isFirstUser ? 'dev' : 'admin';
                const isGenesis = isFirstUser;
                
                const tenant = await tenantManager.createTenant(0);
                tenantId = tenant.tenantId;
                const schemaName = `tenant_${tenantId}`;
                
                const tenantUserResult = await pool.query(`
                    INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id, email, role, tenant_id, is_genesis_admin
                `, [normalizedEmail, passwordHash, userRole, tenantId, isGenesis]);
                
                newUser = tenantUserResult.rows[0];
                tenantUserId = newUser.id;
                
                await pool.query(`
                    INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (email) DO NOTHING
                `, [normalizedEmail, tenantId, schemaName, tenantUserId]);
                
                try {
                    await tenantManager.recordTenantCreation(email, req.ip);
                    tenantManager.recordSuccessfulSignup(req.ip, email);
                } catch (analyticsError) {
                    logger.warn({ err: analyticsError }, 'Analytics recording failed');
                }
                
                isGenesisAdmin = isGenesis;
                
                if (isGenesis) {
                    logger.info({ email, tenantId, tenantUserId }, 'Genesis admin created');
                } else {
                    logger.info({ email, tenantId, tenantUserId }, 'Admin created (fractalized)');
                }
            }
            
            req.session.userId = newUser.id;
            req.session.userEmail = newUser.email;
            req.session.userRole = newUser.role;
            req.session.tenantId = tenantId;
            
            const adminId = isGenesisAdmin ? '01' : null;
            const accessToken = authService.signAccessToken(
                newUser.id, 
                newUser.email, 
                newUser.role,
                tenantId,
                adminId,
                isGenesisAdmin
            );
            const { token: refreshToken, tokenId } = authService.signRefreshToken(
                newUser.id, 
                newUser.email, 
                newUser.role,
                tenantId,
                adminId,
                isGenesisAdmin
            );
            
            const deviceInfo = req.get('user-agent') || 'unknown';
            const tenantUserIdForToken = tenantUserId || newUser.id;
            await authService.storeRefreshToken(pool, `tenant_${tenantId}`, tenantUserIdForToken, tokenId, deviceInfo, req.ip);
            
            req.session.save(async (err) => {
                if (err) {
                    logger.error({ err }, 'Session save error');
                    return res.status(500).json({ error: 'Session save failed' });
                }
                
                await createSessionRecord(newUser.id, req.sessionID, req);
                
                logAudit(pool, req, 'SIGNUP', 'USER', newUser.id.toString(), newUser.email, {
                    role: newUser.role,
                    is_genesis_admin: isGenesisAdmin,
                    tenant_id: tenantId,
                    via_invite: !!inviteToken
                });
                
                res.json({
                    success: true,
                    user: {
                        id: newUser.id,
                        email: newUser.email,
                        role: newUser.role,
                        tenantId: tenantId,
                        isGenesisAdmin
                    },
                    accessToken,
                    refreshToken,
                    message: isGenesisAdmin 
                        ? 'Welcome! You are a Genesis Admin with your own isolated database.' 
                        : 'Account created successfully. Welcome to the team!'
                });
            });
        } catch (error) {
            logger.error({ err: error }, 'Signup error');
            res.status(500).json({ error: 'Signup failed: ' + error.message });
        }
    });

    app.post('/api/auth/forgot-password', async (req, res) => {
        const { email, phone } = req.body;
        
        logger.info({ email, ip: req.ip }, 'Password reset request');
        
        try {
            if (!email || !phone) {
                return res.status(400).json({ error: 'Email and phone number are required' });
            }
            
            const normalizedEmail = email.toLowerCase().trim();
            
            let standardizedPhone = phone.replace(/[\s\-\(\)\.]/g, '');
            if (standardizedPhone.startsWith('0')) {
                standardizedPhone = '+62' + standardizedPhone.substring(1);
            }
            if (!standardizedPhone.startsWith('+') && /^\d/.test(standardizedPhone)) {
                standardizedPhone = '+' + standardizedPhone;
            }
            
            const mappingResult = await pool.query(
                'SELECT tenant_id, tenant_schema, user_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
                [normalizedEmail]
            );
            
            if (mappingResult.rows.length === 0) {
                logger.info({ email }, 'Password reset: email not found');
                return res.json({ success: true, message: 'If your details match, you will receive a reset link via email.' });
            }
            
            const { tenant_schema } = mappingResult.rows[0];
            
            const phoneCheck = await pool.query(`
                SELECT ep.phone, br.tenant_email
                FROM core.book_engaged_phones ep
                JOIN core.book_registry br ON br.id = ep.book_registry_id
                WHERE LOWER(br.tenant_email) = $1 AND ep.is_creator = TRUE AND ep.phone = $2
                LIMIT 1
            `, [normalizedEmail, standardizedPhone]);
            
            if (phoneCheck.rows.length === 0) {
                logger.info({ email, phone: standardizedPhone }, 'Password reset: phone mismatch');
                return res.json({ success: true, message: 'If your details match, you will receive a reset link via email.' });
            }
            
            const resetToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            
            await pool.query(`
                UPDATE core.password_reset_tokens SET used = TRUE WHERE user_email = $1 AND used = FALSE
            `, [normalizedEmail]);
            
            await pool.query(`
                INSERT INTO core.password_reset_tokens (token, user_email, tenant_schema, phone, expires_at)
                VALUES ($1, $2, $3, $4, $5)
            `, [resetToken, normalizedEmail, tenant_schema, standardizedPhone, expiresAt]);
            
            const domain = process.env.REPLIT_DOMAINS?.split(',')[0] || 'nyanbook.io';
            const resetLink = `https://${domain}/reset-password.html?token=${resetToken}`;
            
            try {
                const { Resend } = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);
                
                await resend.emails.send({
                    from: 'Nyan <nyan@nyanbook.io>',
                    to: normalizedEmail,
                    subject: 'Reset Your Nyanbook Password',
                    html: `
                        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                            <h2 style="color: #333;">Reset Your Password</h2>
                            <p style="color: #666; font-size: 16px;">
                                You requested a password reset for your Nyanbook account. Click the button below to set a new password:
                            </p>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${resetLink}" style="background-color: #7c3aed; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                                    Reset Password
                                </a>
                            </div>
                            <p style="color: #999; font-size: 14px;">
                                This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.
                            </p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                            <p style="color: #999; font-size: 12px;">
                                If the button doesn't work, copy and paste this link:<br>
                                <a href="${resetLink}" style="color: #7c3aed;">${resetLink}</a>
                            </p>
                        </div>
                    `
                });
                
                logger.info({ email: normalizedEmail }, 'Password reset email sent');
            } catch (emailError) {
                logger.error({ err: emailError }, 'Failed to send reset email');
                return res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
            }
            
            res.json({ success: true, message: 'Reset link sent to your email!' });
            
        } catch (error) {
            logger.error({ err: error }, 'Password reset error');
            res.status(500).json({ error: 'Password reset failed. Please try again.' });
        }
    });

    app.post('/api/auth/reset-password', async (req, res) => {
        const { token, password } = req.body;
        
        logger.info({ tokenPrefix: token?.substring(0, 8) }, 'Password reset attempt');
        
        try {
            if (!token || !password) {
                return res.status(400).json({ error: 'Token and password are required' });
            }
            
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            
            const tokenResult = await pool.query(`
                SELECT id, user_email, tenant_schema, expires_at, used
                FROM core.password_reset_tokens
                WHERE token = $1
            `, [token]);
            
            if (tokenResult.rows.length === 0) {
                logger.info('Password reset: invalid token');
                return res.status(400).json({ error: 'Invalid or expired reset link' });
            }
            
            const tokenData = tokenResult.rows[0];
            
            if (tokenData.used) {
                logger.info({ email: tokenData.user_email }, 'Password reset: token already used');
                return res.status(400).json({ error: 'This reset link has already been used' });
            }
            
            if (new Date() > new Date(tokenData.expires_at)) {
                logger.info({ email: tokenData.user_email }, 'Password reset: token expired');
                return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
            }
            
            const hashedPassword = await bcrypt.hash(password, 10);
            const normalizedEmail = tokenData.user_email.toLowerCase();
            
            await pool.query(`
                UPDATE ${tokenData.tenant_schema}.users 
                SET password_hash = $1, updated_at = NOW()
                WHERE LOWER(email) = $2
            `, [hashedPassword, normalizedEmail]);
            
            await pool.query(`
                UPDATE core.password_reset_tokens SET used = TRUE WHERE user_email = $1
            `, [normalizedEmail]);
            
            try {
                await pool.query(`
                    DELETE FROM ${tokenData.tenant_schema}.refresh_tokens 
                    WHERE user_id = (SELECT id FROM ${tokenData.tenant_schema}.users WHERE LOWER(email) = $1)
                `, [normalizedEmail]);
                logger.info({ email: tokenData.user_email }, 'Revoked all sessions');
            } catch (revokeError) {
                logger.warn({ err: revokeError }, 'Could not revoke sessions');
            }
            
            logger.info({ email: tokenData.user_email }, 'Password reset successful');
            
            res.json({ success: true, message: 'Password updated successfully!' });
            
        } catch (error) {
            logger.error({ err: error }, 'Password reset error');
            res.status(500).json({ error: 'Password reset failed. Please try again.' });
        }
    });

    app.post('/api/auth/refresh', async (req, res) => {
        try {
            const { refreshToken } = req.body;
            
            if (!refreshToken) {
                return res.status(401).json({ error: 'Refresh token required' });
            }
            
            const decoded = authService.verifyToken(refreshToken);
            if (!decoded || decoded.type !== 'refresh') {
                return res.status(401).json({ error: 'Invalid refresh token' });
            }
            
            const tenantSchema = `tenant_${decoded.tenantId}`;
            
            const isValid = await authService.isRefreshTokenValid(pool, tenantSchema, decoded.tokenId, decoded.userId);
            if (!isValid) {
                return res.status(401).json({ error: 'Refresh token revoked or expired' });
            }
            
            const accessToken = authService.signAccessToken(
                decoded.userId, 
                decoded.email, 
                decoded.role,
                decoded.tenantId,
                decoded.adminId,
                decoded.isGenesisAdmin
            );
            
            res.json({ 
                success: true,
                accessToken,
                tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/auth/logout', requireAuth, async (req, res) => {
        const userId = req.userId;
        const sessionId = req.sessionID;
        const tenantSchema = req.tenantSchema || `tenant_${req.tenantId}`;
        
        logger.info({ userId, sessionId, tenantSchema }, 'Logout request');
        
        try {
            if (userId && tenantSchema) {
                try {
                    await authService.revokeAllUserTokens(pool, tenantSchema, userId);
                    logger.info('Tokens revoked');
                } catch (tokenError) {
                    logger.warn({ err: tokenError }, 'Token revocation failed');
                }
                
                if (sessionId) {
                    try {
                        await pool.query(`
                            UPDATE ${tenantSchema}.active_sessions 
                            SET is_active = FALSE
                            WHERE user_id = $1 AND session_id = $2
                        `, [userId, sessionId]);
                        logger.info('Session marked inactive');
                    } catch (sessionError) {
                        logger.warn({ err: sessionError }, 'Session marking failed');
                    }
                }
            }
            
            try {
                await Promise.race([
                    new Promise((resolve, reject) => {
                        if (!req.session) {
                            return resolve();
                        }
                        
                        req.session.destroy((err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Session destroy timeout')), 5000)
                    )
                ]);
            } catch (destroyError) {
                logger.warn({ err: destroyError }, 'Session destroy failed');
            }
            
            res.clearCookie('book.sid', {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'none',
                partitioned: true
            });
            
            try {
                await logAudit(pool, req, 'LOGOUT', 'USER', userId?.toString() || 'unknown', null, {});
            } catch (auditError) {
                logger.warn({ err: auditError }, 'Audit logging failed');
            }
            
            logger.info('User logged out successfully');
            
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Logout error');
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/invites', requireAuth, async (req, res) => {
        try {
            if (req.userRole !== 'admin' && req.userRole !== 'dev') {
                return res.status(403).json({ error: 'Only admins can create invites' });
            }
            
            const { targetRole = 'read-only', expiresInDays = 7, maxUses = 1 } = req.body;
            
            if (!['admin', 'read-only', 'write-only'].includes(targetRole)) {
                return res.status(400).json({ error: 'Invalid target role' });
            }
            
            if (!req.tenantId) {
                return res.status(400).json({ error: 'User not associated with a tenant' });
            }
            
            const token = await tenantManager.generateInviteToken(
                req.tenantId,
                req.userId,
                targetRole,
                expiresInDays,
                maxUses
            );
            
            logAudit(pool, req, 'CREATE_INVITE', 'INVITE', token, req.userEmail, {
                tenant_id: req.tenantId,
                target_role: targetRole,
                expires_in_days: expiresInDays,
                max_uses: maxUses
            }, req.tenantSchema);
            
            const baseUrl = `https://${req.get('host')}`;
            const inviteUrl = `${baseUrl}/signup.html?invite=${token}`;
            
            res.json({ 
                success: true, 
                token,
                inviteUrl,
                expiresInDays,
                maxUses,
                targetRole
            });
        } catch (error) {
            logger.error({ err: error }, 'Create invite error');
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/invites/validate/:token', async (req, res) => {
        try {
            const { token } = req.params;
            const validation = await tenantManager.validateInviteToken(token);
            
            if (validation.valid) {
                res.json({
                    valid: true,
                    targetRole: validation.invite.target_role,
                    remainingUses: validation.invite.max_uses - validation.invite.current_uses,
                    expiresAt: validation.invite.expires_at
                });
            } else {
                res.json({
                    valid: false,
                    reason: validation.reason
                });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/invites', requireAuth, async (req, res) => {
        try {
            if (req.userRole !== 'admin' && req.userRole !== 'dev') {
                return res.status(403).json({ error: 'Only admins can list invites' });
            }
            
            if (!req.tenantId) {
                return res.status(400).json({ error: 'User not associated with a tenant' });
            }
            
            const result = await pool.query(`
                SELECT id, token, created_by_user_id, expires_at, max_uses, current_uses, 
                       target_role, status, created_at
                FROM core.invites
                WHERE tenant_id = $1
                ORDER BY created_at DESC
            `, [req.tenantId]);
            
            res.json({ invites: result.rows });
        } catch (error) {
            logger.error({ err: error }, 'List invites error');
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/invites/:id', requireAuth, async (req, res) => {
        try {
            if (req.userRole !== 'admin' && req.userRole !== 'dev') {
                return res.status(403).json({ error: 'Only admins can revoke invites' });
            }
            
            const { id } = req.params;
            
            await pool.query(`
                UPDATE core.invites
                SET status = 'revoked'
                WHERE id = $1 AND tenant_id = $2
            `, [id, req.tenantId]);
            
            logAudit(pool, req, 'REVOKE_INVITE', 'INVITE', id, req.userEmail, {
                tenant_id: req.tenantId
            }, req.tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Revoke invite error');
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            const { userId, sortBy = 'login_time', sortOrder = 'desc', filterDevice, filterBrowser, filterLocation } = req.query;
            
            let query = `
                SELECT 
                    s.id, s.user_id, s.session_id, s.ip_address, s.user_agent,
                    s.device_type, s.browser, s.os, s.location, s.login_time, s.last_activity,
                    s.is_active,
                    u.email, u.phone
                FROM ${tenantSchema}.active_sessions s
                LEFT JOIN ${tenantSchema}.users u ON s.user_id = u.id
                WHERE 1=1
            `;
            const params = [];
            let paramCount = 1;
            
            if (userId) {
                query += ` AND s.user_id = $${paramCount}`;
                params.push(userId);
                paramCount++;
            }
            
            if (filterDevice) {
                query += ` AND s.device_type = $${paramCount}`;
                params.push(filterDevice);
                paramCount++;
            }
            
            if (filterBrowser) {
                query += ` AND s.browser = $${paramCount}`;
                params.push(filterBrowser);
                paramCount++;
            }
            
            if (filterLocation) {
                query += ` AND s.location ILIKE $${paramCount}`;
                params.push(`%${filterLocation}%`);
                paramCount++;
            }
            
            const validColumns = ['login_time', 'last_activity', 'device_type', 'browser', 'ip_address', 'location'];
            const sortColumn = validColumns.includes(sortBy) ? sortBy : 'login_time';
            const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
            query += ` ORDER BY s.${sortColumn} ${order}`;
            
            const result = await pool.query(query, params);
            
            res.json({ sessions: result.rows });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching sessions');
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/sessions/:id', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { id } = req.params;
            const tenantSchema = req.tenantSchema;
            
            const sessionResult = await pool.query(`
                SELECT user_id, session_id FROM ${tenantSchema}.active_sessions WHERE id = $1
            `, [id]);
            
            if (sessionResult.rows.length === 0) {
                return res.status(404).json({ error: 'Session not found' });
            }
            
            const session = sessionResult.rows[0];
            
            await pool.query(`
                UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE id = $1
            `, [id]);
            
            await pool.query(`
                DELETE FROM sessions WHERE sid = $1
            `, [session.session_id]);
            
            await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', id.toString(), null, {
                target_user_id: session.user_id,
                session_id: session.session_id
            });
            
            res.json({ success: true, message: 'Session revoked' });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking session');
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/sessions/revoke-all', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { userId } = req.body;
            const tenantSchema = req.tenantSchema;
            
            let sessionQuery;
            let params = [];
            
            if (userId) {
                sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE user_id = $1`;
                params = [userId];
            } else {
                sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE session_id != $1`;
                params = [req.sessionID];
            }
            
            const sessionsResult = await pool.query(sessionQuery, params);
            const sessionIds = sessionsResult.rows.map(row => row.session_id);
            
            if (sessionIds.length === 0) {
                return res.json({ success: true, message: 'No sessions to revoke', count: 0 });
            }
            
            if (userId) {
                await pool.query(`
                    UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE user_id = $1
                `, [userId]);
            } else {
                await pool.query(`
                    UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE session_id != $1
                `, [req.sessionID]);
            }
            
            for (const sessionId of sessionIds) {
                await pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]);
            }
            
            await logAudit(pool, req, 'REVOKE_ALL_SESSIONS', 'SESSION', userId || 'all', null, {
                count: sessionIds.length,
                target_user_id: userId || 'all'
            });
            
            res.json({ 
                success: true, 
                message: `${sessionIds.length} session(s) revoked`,
                count: sessionIds.length
            });
        } catch (error) {
            logger.error({ err: error }, 'Error revoking all sessions');
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/users', requireAuth, requireRole('admin', 'dev'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            const userResult = await pool.query(
                `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
                [req.userId]
            );
            
            if (!userResult.rows.length) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userResult.rows[0];
            
            if (user.role === 'dev' && user.is_genesis_admin) {
                const result = await pool.query(
                    `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
                );
                res.json(result.rows);
            } else if (user.role === 'admin') {
                const result = await pool.query(
                    `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
                );
                res.json(result.rows);
            } else {
                return res.status(403).json({ error: 'Access denied' });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            const oldData = await pool.query(`SELECT role, email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            const oldRole = oldData.rows[0]?.role;
            
            const result = await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET role = $1, updated_at = NOW()
                WHERE id = $2
                RETURNING id, email, role, tenant_id, is_genesis_admin
            `, [role, id]);
            
            const updatedUser = result.rows[0];
            
            await logAudit(pool, req, 'UPDATE_ROLE', 'USER', id, updatedUser.email, {
                old_role: oldRole,
                new_role: role
            }, tenantSchema);
            
            res.json(updatedUser);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
        const { id } = req.params;
        const client = await pool.connect();
        
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (parseInt(id) === req.userId) {
                return res.status(400).json({ error: 'Cannot delete your own account' });
            }
            
            const userData = await client.query(`SELECT email, role FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const deletedUser = userData.rows[0];
            
            await client.query('BEGIN');
            
            try {
                await client.query(`DELETE FROM ${tenantSchema}.users WHERE id = $1`, [id]);
                await client.query(`DELETE FROM core.user_email_to_tenant WHERE email = $1`, [deletedUser.email]);
                await client.query('COMMIT');
                
                await logAudit(pool, req, 'DELETE_USER', 'USER', id, deletedUser.email, {
                    role: deletedUser.role
                }, tenantSchema);
                
                res.json({ success: true });
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        } finally {
            client.release();
        }
    });

    app.put('/api/users/:id/email', requireAuth, requireRole('admin'), async (req, res) => {
        const { id } = req.params;
        const { email } = req.body;
        
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (!email || !email.trim()) {
                return res.status(400).json({ error: 'Email is required' });
            }
            
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Invalid email format' });
            }
            
            const existingUser = await pool.query(`SELECT id FROM ${tenantSchema}.users WHERE email = $1 AND id != $2`, [email, id]);
            if (existingUser.rows.length > 0) {
                return res.status(400).json({ error: 'Email already exists' });
            }
            
            const oldData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            const oldEmail = oldData.rows[0]?.email;
            
            const result = await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET email = $1, updated_at = NOW()
                WHERE id = $2
                RETURNING id, email, role
            `, [email, id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const updatedUser = result.rows[0];
            
            await pool.query(`
                UPDATE core.user_email_to_tenant 
                SET email = $1, updated_at = NOW()
                WHERE email = $2
            `, [email, oldEmail]);
            
            await logAudit(pool, req, 'UPDATE_EMAIL', 'USER', id, updatedUser.email, {
                old_email: oldEmail,
                new_email: email
            }, tenantSchema);
            
            res.json(updatedUser);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
        const { id } = req.params;
        const { password } = req.body;
        
        try {
            const tenantSchema = req.tenantSchema;
            
            if (!tenantSchema) {
                return res.status(500).json({ error: 'Tenant context not found' });
            }
            
            if (!password || !password.trim()) {
                return res.status(400).json({ error: 'Password is required' });
            }
            
            if (password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters long' });
            }
            
            const userData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            if (userData.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const user = userData.rows[0];
            const hashedPassword = await bcrypt.hash(password, 10);
            
            await pool.query(`
                UPDATE ${tenantSchema}.users 
                SET password_hash = $1, updated_at = NOW()
                WHERE id = $2
            `, [hashedPassword, id]);
            
            await logAudit(pool, req, 'UPDATE_PASSWORD', 'USER', id, user.email, {
                updated_by_admin: true
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const tenantSchema = req.tenantSchema;
            const { limit = 100, offset = 0, action_type, target_type } = req.query;
            
            let query = `
                SELECT 
                    id, timestamp, actor_email, action_type, target_type, 
                    target_id, target_email, details, ip_address
                FROM ${tenantSchema}.audit_logs
            `;
            
            const conditions = [];
            const params = [];
            let paramIndex = 1;
            
            if (action_type) {
                conditions.push(`action_type = $${paramIndex++}`);
                params.push(action_type);
            }
            
            if (target_type) {
                conditions.push(`target_type = $${paramIndex++}`);
                params.push(target_type);
            }
            
            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }
            
            query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    logger.info('Auth-Admin routes registered (factory pattern)');
    
    return { requireAuth, requireRole };
}

module.exports = { registerAuthAdminRoutes, createAuthMiddleware };
