'use strict';

const logger = require('../logger');
const { isDeliveryAuthority } = require('../delivery-environment');
const { DeliveryCoordinator } = require('../ordered-inpipe');

// Compatibility adapter only. All new delivery work is admitted to message_queue
// and executed by its shared fenced processor. Never send from this adapter.
class OutboxWorker {
    constructor() { this.pool = null; this._timer = null; this._running = false; }
    setPool(pool) { this.pool = pool; }
    start(intervalMs = 3000) {
        if (!isDeliveryAuthority() || this._timer) return;
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }
    stop() { clearInterval(this._timer); this._timer = null; }
    async _tick() {
        if (!isDeliveryAuthority() || !this.pool || this._running) return;
        this._running = true;
        try { await this._processJobs(); }
        catch (error) { logger.error({ code: error.code }, 'Legacy outbox reconciliation failed'); }
        finally { this._running = false; }
    }
    async _processJobs() {
        if (!isDeliveryAuthority() || !this.pool) return;
        const held = await new DeliveryCoordinator(this.pool).quarantineLegacyOutbox();
        if (held.rowCount) logger.warn({ count: held.rowCount }, 'Legacy outbox held; reconcile receipts before requeue');
    }
    async _deliverJob() { return this._processJobs(); }
    async _prune() { /* Held legacy evidence is never automatically deleted. */ }
}

module.exports = { worker: new OutboxWorker(), OutboxWorker };
