'use strict';

// One small queue shared by boot recovery and periodic housekeeping. No SQL
// locks or connections are held while a task is waiting for its turn.
class MaintenanceQueue {
    constructor({ pool, concurrency = 1, reserve = 4, onError = () => {} } = {}) {
        this.pool = pool;
        this.concurrency = concurrency;
        this.reserve = reserve;
        this.onError = onError;
        this.jobs = new Map();
        this.pending = [];
        this.active = new Set();
        this.closed = false;
    }
    enqueue(name, run, { delayMs = 0, attempts = 3 } = {}) {
        if (this.closed) return Promise.resolve({ skipped: 'shutdown' });
        if (this.jobs.has(name)) return this.jobs.get(name).promise;
        const job = { name, run, attempts, attempt: 0, at: Date.now() + delayMs };
        job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
        this.jobs.set(name, job);
        this.pending.push(job);
        this._schedule();
        return job.promise;
    }
    _schedule() {
        if (this.timer || this.closed) return;
        this.timer = setTimeout(() => { this.timer = null; this._pump(); }, 25);
        this.timer.unref?.();
    }
    _pump() {
        if (this.closed) return;
        const capacity = this.pool?.options?.max || 20;
        const occupied = (this.pool?.totalCount || 0) - (this.pool?.idleCount || 0);
        while (this.active.size < this.concurrency && !(this.pool?.waitingCount > 0) &&
            occupied < Math.max(1, capacity - this.reserve)) {
            const index = this.pending.findIndex(job => job.at <= Date.now());
            if (index < 0) break;
            const [job] = this.pending.splice(index, 1);
            this.active.add(job);
            job.attempt++;
            Promise.resolve().then(() => this.closed ? { skipped: 'shutdown' } : job.run()).then(result => {
                this.jobs.delete(job.name);
                job.resolve(result);
            }, error => {
                this.onError(job.name, error);
                if (!this.closed && job.attempt < job.attempts) {
                    job.at = Date.now() + Math.min(30000, 1000 * 2 ** (job.attempt - 1));
                    this.pending.push(job);
                } else {
                    this.jobs.delete(job.name);
                    job.reject(error);
                }
            }).finally(() => { this.active.delete(job); if (this.pending.length) this._schedule(); });
        }
        if (this.pending.length) this._schedule();
    }
    stop() {
        this.closed = true;
        clearTimeout(this.timer);
        for (const job of this.pending.splice(0)) {
            this.jobs.delete(job.name);
            job.resolve({ skipped: 'shutdown' });
        }
        return Promise.allSettled([...this.active].map(job => job.promise));
    }
}
module.exports = { MaintenanceQueue };
