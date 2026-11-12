'use strict';

function isDeliveryAuthority() {
    // Keep the established production predicate; NODE_ENV=test is never authority.
    return process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
}

module.exports = { isDeliveryAuthority };
