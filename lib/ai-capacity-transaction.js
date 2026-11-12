'use strict';

const logger = require('./logger');

// Includes pool acquisition, lock waiting, statements and COMMIT, not 5s per SQL.
const CAPACITY_TIMEOUT_MS = 5000;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
function safeCode(error) {
    const code = String(error?.code || '');
    return /^[0-9A-Z]{5}$/.test(code) || NETWORK_CODES.has(code) ? code : 'UNKNOWN';
}
function diagnostic(operation, phase, error, ctx, started, reason) {
    // The app's compact logger omits structured fields: put ONLY this allowlist
    // in the message. Never serialize the driver error, SQL, params or identity.
    const id = /^[a-zA-Z0-9_-]{1,80}$/.test(ctx?.id || '') ? ctx.id : undefined;
    logger.error(`AI capacity ${JSON.stringify({
        operation, phase, reason, dbCode: safeCode(error),
        durationMs: Date.now() - started, requestId: id
    })}`);
}
function unavailable(operation, phase, error, reason) {
    const message = error?.code === 'CAPACITY_POOL_UNAVAILABLE'
        ? 'Shared AI capacity is unavailable. Please try later.'
        : 'Shared AI capacity could not be checked. Please try later.';
    return Object.assign(new Error(message), {
        code: 'AI_CAPACITY', status: 503, retryAfter: 60,
        capacityOperation: operation, capacityPhase: phase,
        capacityReason: reason, dbCode: safeCode(error)
    });
}

// Waiting is cancellable even when the pool/driver promise isn't. Late pool
// clients are returned unused; an in-flight transaction is destroyed, NOT put
// back into the pool for another request.
function waitFor(start, signal, lateValue = () => {}) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        let done = false;
        const abort = () => {
            if (done) return;
            done = true;
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => {
            signal.throwIfAborted();
            return start();
        }).then(value => {
            signal.removeEventListener('abort', abort);
            if (done) { lateValue(value); return; }
            done = true;
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', abort);
            if (!done) { done = true; reject(error); }
        });
        if (signal.aborted) abort();
    });
}

async function capacityTransaction({ pool, ctx, operation, fn, signal: callerSignal, deadline }) {
    const started = Date.now();
    const end = Math.min(started + CAPACITY_TIMEOUT_MS, ctx?.deadline ?? Infinity, deadline ?? Infinity);
    const controller = new AbortController();
    const signals = [controller.signal, ctx?.signal, callerSignal].filter(Boolean);
    const signal = AbortSignal.any(signals);
    const timeout = () => controller.abort(Object.assign(new Error('Capacity deadline exceeded'), { code: 'CAPACITY_TIMEOUT' }));
    const timer = setTimeout(timeout, Math.max(0, end - started));
    if (end <= started) timeout();
    let client, released = false, phase = 'pool', committed = false;
    const release = (value, destroy = false) => {
        try { value.release(destroy); }
        catch (error) { diagnostic(operation, 'release', error, ctx, started, 'cleanup_failed'); }
    };
    const releaseOnce = destroy => {
        if (!client || released) return;
        released = true;
        release(client, destroy);
    };
    const query = (stage, sql, params) => {
        phase = stage;
        return waitFor(() => client.query(sql, params), signal);
    };
    try {
        if (!pool) throw Object.assign(new Error('No capacity pool'), { code: 'CAPACITY_POOL_UNAVAILABLE' });
        client = await waitFor(() => pool.connect(), signal, value => release(value));
        await query('begin', 'BEGIN');
        await query('setup', "SET LOCAL lock_timeout = '3s'");
        await query('setup', "SET LOCAL statement_timeout = '5s'");
        // No network or inference work runs inside this lock.
        await query('lock', 'SELECT pg_advisory_xact_lock(708282)');
        const value = await waitFor(() => fn({
            query: (sql, params) => query('query', sql, params)
        }), signal);
        await query('commit', 'COMMIT');
        committed = true;
        return value;
    } catch (error) {
        const failedPhase = phase;
        const reason = controller.signal.aborted || signal.reason?.name === 'TimeoutError'
            ? 'deadline' : signal.aborted ? 'cancelled' : 'unavailable';
        if (client && !signal.aborted) {
            try { await query('rollback', 'ROLLBACK'); }
            catch (rollbackError) {
                diagnostic(operation, 'rollback', rollbackError, ctx, started, 'cleanup_failed');
                releaseOnce(true);
            }
        }
        // If COMMIT was in flight, its outcome is unknown. Keep any committed
        // reservation charged; never issue a compensating refund or inference.
        if (signal.aborted) releaseOnce(true);
        diagnostic(operation, failedPhase, error, ctx, started,
            error.code === 'AI_CAPACITY' ? 'denied' : reason);
        if (error.code === 'AI_CAPACITY') {
            error.capacityOperation ??= operation;
            error.capacityPhase ??= failedPhase;
            throw error;
        }
        throw unavailable(operation, failedPhase, error, reason);
    } finally {
        clearTimeout(timer);
        releaseOnce(!committed && signal.aborted);
    }
}

module.exports = { capacityTransaction, CAPACITY_TIMEOUT_MS };
