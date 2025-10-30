const crypto = require('crypto');

// SECURITY: Require FRACTAL_SALT to be set in production
const FRACTAL_SALT = process.env.FRACTAL_SALT;

if (!FRACTAL_SALT) {
    console.warn('⚠️  WARNING: FRACTAL_SALT not set! Using weak default salt.');
    console.warn('   Set FRACTAL_SALT environment variable for production security.');
    console.warn('   Generate a strong salt: openssl rand -hex 32');
}

// Fallback for development only - NEVER use this in production
const SALT = FRACTAL_SALT || 'dev-only-weak-salt-DO-NOT-USE-IN-PRODUCTION';

/**
 * Generate a fractalized ID for a resource
 * Format: {type}_t{tenantId}_{hash}
 * Example: bridge_t3_a1b2c3d4e5
 * 
 * @param {string} type - Resource type ('bridge', 'msg')
 * @param {number} tenantId - Tenant ID
 * @param {number} dbId - Database internal ID
 * @returns {string} Opaque fractalized ID
 */
function generate(type, tenantId, dbId) {
    const prefix = `${type}_t${tenantId}_`;
    const hash = crypto.createHash('sha256')
        .update(`${tenantId}:${type}:${dbId}:${SALT}`)
        .digest('hex')
        .slice(0, 12); // 12 hex chars = 48 bits of entropy
    return `${prefix}${hash}`;
}

/**
 * Parse a fractalized ID back to its components
 * 
 * @param {string} fractalId - Fractalized ID to parse
 * @returns {object|null} Parsed components or null if invalid
 */
function parse(fractalId) {
    if (!fractalId || typeof fractalId !== 'string') {
        return null;
    }
    
    const match = fractalId.match(/^(bridge|msg)_t(\d+)_([a-f0-9]+)$/);
    if (!match) {
        return null;
    }
    
    return {
        type: match[1],
        tenantId: parseInt(match[2]),
        hash: match[3]
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
 * @returns {boolean} True if fractalized ID is valid for this DB ID
 */
function verify(fractalId, type, tenantId, dbId) {
    const expected = generate(type, tenantId, dbId);
    return fractalId === expected;
}

module.exports = {
    generate,
    parse,
    validateTenant,
    verify
};
