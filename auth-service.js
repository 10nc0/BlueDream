const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-in-production';
const ACCESS_TOKEN_EXPIRY = '15m';  // 15 minutes
const REFRESH_TOKEN_EXPIRY = '7d';  // 7 days

function signAccessToken(userId, email, role) {
    return jwt.sign(
        {
            userId,
            email,
            role,
            type: 'access'
        },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
}

function signRefreshToken(userId, email, role) {
    const tokenId = crypto.randomBytes(32).toString('hex');
    const token = jwt.sign(
        {
            userId,
            email,
            role,
            tokenId,
            type: 'refresh'
        },
        JWT_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );
    
    return { token, tokenId };
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(pool, userId, tokenId, deviceInfo, ipAddress) {
    const tokenHash = hashToken(tokenId);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, deviceInfo, ipAddress, expiresAt]
    );
}

async function revokeRefreshToken(pool, tokenId) {
    const tokenHash = hashToken(tokenId);
    await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
        [tokenHash]
    );
}

async function revokeAllUserTokens(pool, userId) {
    await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
    );
}

async function isRefreshTokenValid(pool, tokenId, userId) {
    const tokenHash = hashToken(tokenId);
    const result = await pool.query(
        `SELECT * FROM refresh_tokens 
         WHERE token_hash = $1 AND user_id = $2 
         AND expires_at > NOW() AND revoked_at IS NULL`,
        [tokenHash, userId]
    );
    
    return result.rows.length > 0;
}

function cleanupExpiredTokens(pool) {
    return pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL');
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
