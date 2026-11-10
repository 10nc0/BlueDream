'use strict';
const { performance } = require('node:perf_hooks');
const { PHI_BREATHE } = require('../config/constants');

// Runs only the clock and fenced publisher, never application callbacks.
class HeartbeatClock {
    constructor({ lease, publish, now = () => performance.now(), wallNow = Date.now,
        schedule = setTimeout, cancel = clearTimeout, base = PHI_BREATHE.BASE_INTERVAL_MS,
        phi = PHI_BREATHE.PHI, followerMs = 10000, initialCount = 0 }) {
        Object.assign(this, { lease, publish, now, wallNow, schedule, cancel, base, phi, followerMs });
        this.count = initialCount;
        this.stopped = true;
    }
    start() {
        if (!this.stopped) return this.inFlight;
        this.stopped = false;
        this.deadline = this.now();
        return this._launch();
    }
    _launch() {
        if (this.stopped) return;
        this.inFlight = this._tick();
        return this.inFlight;
    }
    async _tick() {
        const started = this.now(), scheduled = this.deadline;
        let interval = this.base;
        try {
            const tick = this.lease ? await this.lease.tick() :
                { owned: true, fresh: true, value: ++this.count, age_ms: 0 };
            if (this.stopped) return;
            if (tick.owned && (!Number.isSafeInteger(Number(tick.value)) || Number(tick.value) <= 0))
                throw Object.assign(new Error('Invalid fenced heartbeat count'), { code: 'HEARTBEAT_INVALID_COUNT' });
            const completed = this.now(), dbMs = this.lease ? completed - started : 0;
            this.count = Number(tick.value) || this.count;
            interval = tick.owned ? (this.count % 2 ? Math.round(this.base * this.phi) : this.base) : this.followerMs;
            // Conservative local timestamp: no database/client wall-clock alignment
            // assumption and no freshening an old observation during IPC delivery.
            const ageMs = Math.max(0, Number(tick.age_ms) || 0) + dbMs;
            const observedAt = this.wallNow() - ageMs;
            const emittedAt = this.wallNow();
            this.publish({ kind: 'observation', count: this.count, owned: !!tick.owned,
                fresh: !!tick.fresh && ageMs < 20000, observedAt, emittedAt,
                durationMs: interval, scheduledAt: emittedAt - (completed - scheduled),
                latenessMs: Math.max(0, started - scheduled), dbMs,
                spacingMs: tick.owned && this.lastPublished !== undefined ? completed - this.lastPublished : null });
            if (tick.owned) this.lastPublished = completed;
        } catch (error) {
            if (!this.stopped) this.publish({ kind: 'observation', owned: false, fresh: false,
                code: error.code || 'HEARTBEAT_DB_ERROR', emittedAt: this.wallNow() });
        } finally {
            if (!this.stopped) {
                // Keep deadlines anchored, but skip overdue slots: never replay a
                // burst of counter writes after an outage or long query.
                this.deadline = scheduled + interval;
                const completed = this.now();
                if (this.deadline <= completed) {
                    const missed = Math.floor((completed - this.deadline) / interval) + 1;
                    this.deadline += missed * interval;
                    this.publish({ kind: 'overdue', missed, emittedAt: this.wallNow() });
                }
                this.timer = this.schedule(() => this._launch(), Math.max(0, this.deadline - this.now()));
            }
        }
    }
    async stop() {
        this.stopped = true;
        this.cancel(this.timer);
        await this.inFlight;
        await this.lease?.release();
    }
}
module.exports = { HeartbeatClock };
