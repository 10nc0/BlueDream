const crypto = require('crypto');

const FRACTAL_SALT = process.env.FRACTAL_SALT || 'nyan-bridge-default-salt-2025-change-in-production';

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
        .update(`${tenantId}:${type}:${dbId}:${FRACTAL_SALT}`)
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
