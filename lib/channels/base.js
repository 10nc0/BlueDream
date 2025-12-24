const logger = require('../logger');

class BaseChannel {
    constructor(name) {
        this.name = name;
    }
    
    validateSignature(req) {
        throw new Error(`${this.name}: validateSignature() not implemented`);
    }
    
    parsePayload(req) {
        throw new Error(`${this.name}: parsePayload() not implemented`);
    }
    
    normalizeMessage(rawPayload) {
        throw new Error(`${this.name}: normalizeMessage() not implemented`);
    }
    
    async sendReply(to, message) {
        throw new Error(`${this.name}: sendReply() not implemented`);
    }
    
    getEmptyResponse() {
        return { status: 200, body: '' };
    }
}

module.exports = { BaseChannel };
