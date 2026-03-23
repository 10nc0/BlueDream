'use strict';

class BaseOutpipe {
    constructor(config) {
        this.config = config;
        this.type = config.type;
        this.displayName = config.name || config.type;
    }

    async deliver(capsule, options = {}) {
        throw new Error(`${this.type}: deliver() not implemented`);
    }

    static validateConfig(config) {
        if (!config || !config.type) return { valid: false, error: 'type required' };
        return { valid: true };
    }
}

module.exports = { BaseOutpipe };
