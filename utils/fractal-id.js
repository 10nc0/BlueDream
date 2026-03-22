const crypto = require('crypto');

// SECURITY: FRACTAL_SALT must be set. vegapunk.js fails-closed at startup if missing.
// Fallback generates a per-process ephemeral random salt — unpredictable, no known string
// in the codebase. Dev sessions won't survive restarts (acceptable). Prod never reaches this.
const SALT = process.env.FRACTAL_SALT || (() => {
    const ephemeral = require('crypto').randomBytes(32).toString('hex');
    console.warn('⚠️  FRACTAL_SALT not set — ephemeral salt active (dev only).');
    console.warn('   Generate a prod salt: openssl rand -hex 32');
    return ephemeral;
})();

/**
 * Generate a fractalized ID for a resource
 * Format: {type}_t{tenantId}_{hash} or dev_{type}_t{tenantId}_{hash} for dev admins
 * Examples: 
 *   - book_t3_a1b2c3d4e5 (regular admin)
 *   - dev_book_t1_a1b2c3d4e5 (dev admin with admin_id='01')
 *   - bridge_t3_a1b2c3d4e5 (legacy bridge type, backward compatible)
 * 
 * @param {string} type - Resource type ('book', 'bridge', 'msg')
 * @param {number} tenantId - Tenant ID
 * @param {number} dbId - Database internal ID
 * @param {string|null} createdByAdminId - Admin ID ('01' for dev, null for regular)
 * @returns {string} Opaque fractalized ID
 */
function generate(type, tenantId, dbId, createdByAdminId = null) {
    // Dev admin (admin_id='01') gets special prefix for visibility
    const devPrefix = (createdByAdminId === '01') ? 'dev_' : '';
    const prefix = `${devPrefix}${type}_t${tenantId}_`;
    const hash = crypto.createHash('sha256')
        .update(`${tenantId}:${type}:${dbId}:${SALT}`)
        .digest('hex')
        .slice(0, 12); // 12 hex chars = 48 bits of entropy
    return `${prefix}${hash}`;
}

/**
 * Parse a fractalized ID back to its components
 * Handles both regular and dev-prefixed IDs
 * 
 * @param {string} fractalId - Fractalized ID to parse
 * @returns {object|null} Parsed components or null if invalid
 */
function parse(fractalId) {
    if (!fractalId || typeof fractalId !== 'string') {
        return null;
    }
    
    // Match both regular and dev-prefixed IDs
    // Examples: bridge_t1_abc123, book_t1_abc123, or dev_book_t1_abc123
    const match = fractalId.match(/^(?:(dev)_)?(bridge|book|msg)_t(\d+)_([a-f0-9]+)$/);
    if (!match) {
        return null;
    }
    
    return {
        isDevBridge: match[1] === 'dev',  // Legacy compatibility
        envPrefix: match[1],  // 'dev' or undefined
        type: match[2],
        tenantId: parseInt(match[3]),
        hash: match[4]
    };
}

/**
 * Validate that a fractalized ID belongs to a specific tenant
 * 
 * @param {string} fractalId - Fractalized ID to validate
 * @param {number} expectedTenantId - Expected tenant ID
 * @returns {boolean} True if valid and belongs to tenant
 */
function validateTenant(fractalId, expectedTenantId) {
    const parsed = parse(fractalId);
    if (!parsed) {
        return false;
    }
    return parsed.tenantId === expectedTenantId;
}

/**
 * Verify a fractalized ID matches a database ID
 * (Prevents hash collision attacks)
 * 
 * @param {string} fractalId - Fractalized ID to verify
 * @param {string} type - Resource type
 * @param {number} tenantId - Tenant ID
 * @param {number} dbId - Database ID to verify against
 * @param {string|null} createdByAdminId - Admin ID ('01' for dev, null for regular)
 * @returns {boolean} True if fractalized ID is valid for this DB ID
 */
function verify(fractalId, type, tenantId, dbId, createdByAdminId = null) {
    const expected = generate(type, tenantId, dbId, createdByAdminId);
    return fractalId === expected;
}

/**
 * Generate a deterministic fractal ID for a message record
 * Derived from content fingerprint — no DB ID needed
 * Format: msg_t{tenantId}_{hash}
 *
 * @param {string} bookFractalId - Parent book's fractal ID
 * @param {number} tenantId - Tenant ID
 * @param {string} timestamp - ISO timestamp of the message
 * @param {string} contentHash - SHA256 of message body
 * @returns {string} Stable, unique message fractal ID
 */
function generateMsg(bookFractalId, tenantId, timestamp, contentHash) {
    const hash = crypto.createHmac('sha256', SALT)
        .update(`${bookFractalId}:${timestamp}:${contentHash}`)
        .digest('hex')
        .slice(0, 12);
    return `msg_t${tenantId}_${hash}`;
}

module.exports = {
    generate,
    generateMsg,
    parse,
    validateTenant,
    verify
};
