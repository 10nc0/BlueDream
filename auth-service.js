const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// SECURITY: Require SESSION_SECRET to be set in production
const JWT_SECRET = process.env.SESSION_SECRET;

if (!JWT_SECRET) {
    console.warn('⚠️  WARNING: SESSION_SECRET not set! Using weak default.');
    console.warn('   Set SESSION_SECRET environment variable for production security.');
    console.warn('   Generate a strong secret: openssl rand -hex 64');
}

// Fallback for development only - NEVER use this in production
const SECRET = JWT_SECRET || 'dev-only-weak-jwt-secret-DO-NOT-USE-IN-PRODUCTION';

const ACCESS_TOKEN_EXPIRY = '15m';  // 15 minutes
const REFRESH_TOKEN_EXPIRY = '7d';  // 7 days

const JWT_ISSUER = 'nyanbook';
const JWT_AUDIENCE = 'nyanbook-app';
const ALLOWED_ALGORITHMS = ['HS256'];

function signAccessToken(userId, email, role, tenantId = null, adminId = null, isGenesisAdmin = false) {
    return jwt.sign(
        {
            userId,
            email,
            role,
            tenantId,        // Required for multi-tenant isolation
            adminId,         // '01' for dev admin, null otherwise
            isGenesisAdmin,  // Boolean flag for genesis admin status
            type: 'access'
        },
        SECRET,
        { 
            expiresIn: ACCESS_TOKEN_EXPIRY,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            algorithm: 'HS256'
        }
    );
}

function signRefreshToken(userId, email, role, tenantId = null, adminId = null, isGenesisAdmin = false) {
    const tokenId = crypto.randomBytes(32).toString('hex');
    const token = jwt.sign(
        {
            userId,
            email,
            role,
            tenantId,        // Include tenant context in refresh token
            adminId,         // Include admin_id for dev admin tracking
            isGenesisAdmin,  // Include genesis admin status
            tokenId,
            type: 'refresh'
        },
        SECRET,
        { 
            expiresIn: REFRESH_TOKEN_EXPIRY,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            algorithm: 'HS256'
        }
    );
    
    return { token, tokenId };
}

function verifyToken(token) {
    try {
        return jwt.verify(token, SECRET, {
            algorithms: ALLOWED_ALGORITHMS,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.warn('⚠️ JWT expired');
        } else if (error.name === 'JsonWebTokenError') {
            console.warn('⚠️ Invalid JWT:', error.message);
        }
        return null;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(pool, tenantSchema, userId, tokenId, deviceInfo, ipAddress) {
    const tokenHash = hashToken(tokenId);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    await pool.query(
        `INSERT INTO ${tenantSchema}.refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, deviceInfo, ipAddress, expiresAt]
    );
}

async function revokeRefreshToken(pool, tenantSchema, tokenId) {
    const tokenHash = hashToken(tokenId);
    await pool.query(
        `UPDATE ${tenantSchema}.refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
        [tokenHash]
    );
}

async function revokeAllUserTokens(pool, tenantSchema, userId) {
    await pool.query(
        `UPDATE ${tenantSchema}.refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
}

async function isRefreshTokenValid(pool, tenantSchema, tokenId, userId) {
    const tokenHash = hashToken(tokenId);
    const result = await pool.query(
        `SELECT * FROM ${tenantSchema}.refresh_tokens 
         WHERE token_hash = $1 AND user_id = $2 
         AND expires_at > NOW() AND revoked_at IS NULL`,
        [tokenHash, userId]
    );
    
    return result.rows.length > 0;
}

function cleanupExpiredTokens(pool, tenantSchema) {
    return pool.query(`DELETE FROM ${tenantSchema}.refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL`);
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyToken,
    storeRefreshToken,
    revokeRefreshToken,
    revokeAllUserTokens,
    isRefreshTokenValid,
    cleanupExpiredTokens,
    ACCESS_TOKEN_EXPIRY,
    REFRESH_TOKEN_EXPIRY
};
