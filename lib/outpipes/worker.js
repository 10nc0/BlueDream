'use strict';

const { createOutpipe } = require('./router');
const logger = require('../logger');

// In-memory circuit breaker per endpoint.
// Resets on restart — intentional (avoids DB complexity, fine for this scale).
const endpointFailures = new Map(); // endpoint -> { count, pausedUntil }

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_PAUSE_MS  = 5 * 60 * 1000; // 5 minutes

function isCircuitOpen(endpoint) {
    if (!endpoint) return false;
    const state = endpointFailures.get(endpoint);
    if (!state) return false;
    if (state.pausedUntil && Date.now() >= state.pausedUntil) {
        endpointFailures.delete(endpoint);
        return false;
    }
    return !!(state.pausedUntil);
}

function recordEndpointSuccess(endpoint) {
    if (endpoint) endpointFailures.delete(endpoint);
}

function recordEndpointFailure(endpoint) {
    if (!endpoint) return;
    const state = endpointFailures.get(endpoint) || { count: 0, pausedUntil: null };
    state.count += 1;
    if (state.count >= CIRCUIT_THRESHOLD && !state.pausedUntil) {
        state.pausedUntil = Date.now() + CIRCUIT_PAUSE_MS;
        logger.warn({ endpoint }, '⚡ Outpipe circuit open — pausing endpoint for 5 min');
    }
    endpointFailures.set(endpoint, state);
}

class OutboxWorker {
    constructor() {
        this.pool     = null;
        this._timer   = null;
        this._running = false;
    }

    setPool(pool) {
        this.pool = pool;
    }

    start(intervalMs = 3000) {
        if (this._timer) return;
        this._timer = setInterval(() => this._tick(), intervalMs);
        logger.info({ intervalMs }, '📬 Outbox worker started');
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _tick() {
        if (!this.pool || this._running) return;
        this._running = true;
        try {
            await this._processJobs();
            await this._prune();
        } catch (err) {
            logger.error({ err }, 'Outbox worker tick error');
        } finally {
            this._running = false;
        }
    }

    async _processJobs() {
        const { rows } = await this.pool.query(`
            SELECT id, outpipe_type, outpipe_config, endpoint, payload, attempts, max_attempts
            FROM core.outbox_jobs
            WHERE status = 'pending' AND next_attempt_at <= NOW()
            ORDER BY next_attempt_at
            LIMIT 50
        `);

        if (rows.length === 0) return;
        logger.debug({ count: rows.length }, '📬 Outbox: processing jobs');

        // Sequential — prevents Discord rate-limit spikes
        for (const job of rows) {
            await this._deliverJob(job);
        }
    }

    async _deliverJob(job) {
        if (isCircuitOpen(job.endpoint)) {
            logger.debug({ endpoint: job.endpoint }, '⚡ Circuit open — skipping job this tick');
            return;
        }

        try {
            const pipe = createOutpipe(job.outpipe_config);
            await pipe.deliver(job.payload, {});

            await this.pool.query(
                `UPDATE core.outbox_jobs SET status = 'success', updated_at = NOW() WHERE id = $1`,
                [job.id]
            );
            recordEndpointSuccess(job.endpoint);
            logger.debug({ jobId: job.id, type: job.outpipe_type }, '✅ Outbox job delivered');

        } catch (err) {
            recordEndpointFailure(job.endpoint);
            const attempts = job.attempts + 1;

            if (attempts >= job.max_attempts) {
                await this.pool.query(
                    `UPDATE core.outbox_jobs
                     SET status = 'failed', attempts = $1, last_error = $2, updated_at = NOW()
                     WHERE id = $3`,
                    [attempts, String(err.message || err).slice(0, 500), job.id]
                );
                logger.warn({ jobId: job.id, attempts, endpoint: job.endpoint }, '❌ Outbox job exhausted retries');
            } else {
                // Exponential backoff: 2s, 4s, 8s, 16s, 32s… capped at 1 hour
                const delayMs = Math.min(1000 * Math.pow(2, attempts), 3_600_000);
                await this.pool.query(
                    `UPDATE core.outbox_jobs
                     SET attempts = $1, last_error = $2,
                         next_attempt_at = NOW() + ($3 * interval '1 millisecond'),
                         updated_at = NOW()
                     WHERE id = $4`,
                    [attempts, String(err.message || err).slice(0, 500), delayMs, job.id]
                );
                logger.debug({ jobId: job.id, attempts, delayMs }, '🔁 Outbox job scheduled retry');
            }
        }
    }

    async _prune() {
        // LIMIT 500 prevents long locks on large tables
        await this.pool.query(`
            DELETE FROM core.outbox_jobs
            WHERE id IN (
                SELECT id FROM core.outbox_jobs
                WHERE status IN ('success', 'failed', 'cancelled')
                  AND updated_at < NOW() - INTERVAL '24 hours'
                LIMIT 500
            )
        `);
    }
}

const worker = new OutboxWorker();

module.exports = { worker, isCircuitOpen };
