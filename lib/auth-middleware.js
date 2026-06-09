const crypto = require('crypto');
const { VALID_SCHEMA_PATTERN } = require('./validators');

const loginAttempts = new Map();
const LOGIN_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

function checkLoginRateLimit(namespace, key) {
    const compositeKey = `${namespace}:${key}`;
    const now = Date.now();
    const entry = loginAttempts.get(compositeKey);
    if (!entry || now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        return { allowed: true };
    }
    if (entry.count >= LOGIN_RATE_LIMIT.maxAttempts) {
        return { allowed: false };
    }
    return { allowed: true };
}

function recordFailedLogin(namespace, key) {
    const compositeKey = `${namespace}:${key}`;
    const now = Date.now();
    const entry = loginAttempts.get(compositeKey);
    if (!entry || now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        loginAttempts.set(compositeKey, { count: 1, firstAttempt: now });
    } else {
        entry.count++;
    }
}

function clearLoginAttempts(namespace, key) {
    loginAttempts.delete(`${namespace}:${key}`);
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts.entries()) {
        if (now - entry.firstAttempt > LOGIN_RATE_LIMIT.windowMs) loginAttempts.delete(key);
    }
}, 60000);

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function createAuthMiddleware(pool, authService, logger) {
    async function requireAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);

            // JWT path: all JWTs have exactly 3 dot-separated segments
            if (token.split('.').length === 3) {
                const decoded = authService.verifyToken(token);
                if (decoded && decoded.type === 'access') {
                    req.userId = decoded.userId;
                    req.userEmail = decoded.email;
                    req.userRole = decoded.role;
                    req.tenantId = decoded.tenantId;
                    const candidateSchema = `tenant_${decoded.tenantId}`;
                    if (!VALID_SCHEMA_PATTERN.test(candidateSchema)) {
                        logger.warn({ tenantId: decoded.tenantId }, 'JWT tenantId failed schema validation');
                        return res.status(401).json({ error: 'Invalid token claims' });
                    }
                    req.tenantSchema = candidateSchema;
                    req.authMethod = 'jwt';
                    return next();
                }
                return res.status(401).json({ error: 'Invalid or expired token' });
            }

            // Hash-based token path: 64-char hex (crypto.randomBytes(32).toString('hex'))
            if (/^[0-9a-f]{64}$/.test(token)) {
                const tokenHash = hashToken(token);
                try {
                    // Try user_tokens (read-only cross-book access within own tenant)
                    const ut = await pool.query(
                        `SELECT tenant_schema, user_email FROM core.user_tokens WHERE token_hash = $1`,
                        [tokenHash]
                    );
                    if (ut.rows.length > 0) {
                        const row = ut.rows[0];
                        if (!VALID_SCHEMA_PATTERN.test(row.tenant_schema)) {
                            return res.status(401).json({ error: 'Invalid token claims' });
                        }
                        // GET-only: user tokens are read-only credentials
                        if (req.method !== 'GET') {
                            return res.status(403).json({ error: 'User token: GET requests only. Use session or JWT for write operations.' });
                        }
                        // Block /api/me/* account-management routes (require session/JWT)
                        if (req.path.startsWith('/api/me')) {
                            return res.status(403).json({ error: 'Account management requires session authentication.' });
                        }
                        req.userEmail = row.user_email;
                        req.tenantSchema = row.tenant_schema;
                        req.tenantId = parseInt(row.tenant_schema.replace('tenant_', ''), 10);
                        req.authMethod = 'user_token';
                        // Resolve req.userId + req.userRole so downstream routes work identically
                        // to session-auth paths (many routes query users WHERE id = $1)
                        try {
                            const ur = await pool.query(
                                `SELECT id, role FROM ${row.tenant_schema}.users WHERE email = $1 LIMIT 1`,
                                [row.user_email]
                            );
                            if (ur.rows.length) {
                                req.userId   = ur.rows[0].id;
                                req.userRole = ur.rows[0].role;
                            }
                        } catch (_) { /* non-fatal — routes that need userId will 404 naturally */ }
                        pool.query(
                            `UPDATE core.user_tokens SET last_used_at = NOW() WHERE token_hash = $1`,
                            [tokenHash]
                        ).catch(() => {});
                        return next();
                    }

                    // Try contributor_tokens (book-scoped access)
                    const ct = await pool.query(
                        `SELECT tenant_schema, granted_to_email, book_fractal_ids
                         FROM core.contributor_tokens WHERE token_hash = $1`,
                        [tokenHash]
                    );
                    if (ct.rows.length > 0) {
                        const row = ct.rows[0];
                        if (!VALID_SCHEMA_PATTERN.test(row.tenant_schema)) {
                            return res.status(401).json({ error: 'Invalid token claims' });
                        }
                        // GET-only: contributor tokens are read-only credentials
                        if (req.method !== 'GET') {
                            return res.status(403).json({ error: 'Contributor token: GET requests only.' });
                        }
                        // Block /api/me/* account-management routes
                        if (req.path.startsWith('/api/me')) {
                            return res.status(403).json({ error: 'Account management requires session authentication.' });
                        }
                        req.userEmail = row.granted_to_email;
                        req.tenantSchema = row.tenant_schema;
                        req.tenantId = parseInt(row.tenant_schema.replace('tenant_', ''), 10);
                        req.authMethod = 'contributor_token';
                        req.contributorBookFractalIds = row.book_fractal_ids;

                        // ── Contributor scope enforcement (deny-by-default) ────────────────
                        // Contributors may ONLY access routes where a granted book fractal_id
                        // appears explicitly in the URL path segment
                        //   (/api/books/:id/..., /api/webhook/:id/..., /api/agent/:id/...).
                        // Any cross-book route (mesh/tag, search, book list, etc.) that carries
                        // no book id in the URL is denied outright — even if it is a GET.
                        // Query params are checked as a secondary constraint when also present.
                        const grantedIds = new Set(row.book_fractal_ids);
                        const pathMatch = req.path.match(/\/api\/(?:books|webhook|agent)\/([^\/]+)/);
                        if (!pathMatch) {
                            // No book-scoped path segment → deny (prevents mesh/tag, search, etc.)
                            return res.status(403).json({
                                error: 'Contributor token: access requires a book-scoped URL path. Cross-book routes are not accessible.'
                            });
                        }
                        const pathBookId = pathMatch[1];
                        if (!grantedIds.has(pathBookId)) {
                            return res.status(403).json({ error: 'Contributor token not authorized for this book.' });
                        }
                        // Also enforce any query-param book identifiers present in the request
                        for (const qKey of ['bookId', 'fractal_id', 'book_id', 'fractalId']) {
                            if (req.query[qKey] && !grantedIds.has(req.query[qKey])) {
                                return res.status(403).json({ error: 'Contributor token not authorized for this book.' });
                            }
                        }

                        // Contributor tokens are valid for users who may not have a NyanBook account.
                        // req.userId is set only if the email resolves to an existing user — routes
                        // that truly need it will surface a 404; contributor token callers are expected
                        // to use book-scoped GET endpoints that filter by fractal_id, not by user id.
                        try {
                            const ur = await pool.query(
                                `SELECT id, role FROM ${row.tenant_schema}.users WHERE email = $1 LIMIT 1`,
                                [row.granted_to_email]
                            );
                            if (ur.rows.length) {
                                req.userId   = ur.rows[0].id;
                                req.userRole = ur.rows[0].role;
                            }
                        } catch (_) { /* non-fatal — contributor may not hold a NyanBook account */ }

                        pool.query(
                            `UPDATE core.contributor_tokens SET last_used_at = NOW() WHERE token_hash = $1`,
                            [tokenHash]
                        ).catch(() => {});
                        return next();
                    }
                } catch (err) {
                    logger.error({ err }, 'Hash-token lookup error in requireAuth');
                    return res.status(500).json({ error: 'Authentication error' });
                }
            }

            return res.status(401).json({ error: 'Invalid or expired token' });
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
            // Hash-based tokens (user_token, contributor_token) are read-only credentials
            // scoped to data access only — they can never satisfy a role gate regardless of
            // what role the underlying user holds.  This prevents an admin-role user from
            // leveraging their user_token to reach admin-only management endpoints.
            if (req.authMethod === 'user_token' || req.authMethod === 'contributor_token') {
                return res.status(403).json({ error: 'Token-based authentication cannot access role-restricted endpoints. Use a session or JWT.' });
            }

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

module.exports = {
    checkLoginRateLimit,
    recordFailedLogin,
    clearLoginAttempts,
    hashToken,
    createAuthMiddleware
};
