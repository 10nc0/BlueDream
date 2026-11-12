'use strict';

/**
 * Universal retry / exponential-backoff helpers for third-party API calls.
 *
 * Design principle: every outbound handshake gets up to 3 attempts with
 * exponential backoff (500 ms → 1 000 ms) before failing. Retries are
 * triggered only for transient conditions:
 *
 *   • Network-level errors (DNS failure, connection refused, timeout thrown)
 *   • HTTP 429 Too Many Requests   (honors Retry-After header if present)
 *   • HTTP 5xx Server Errors       (500, 502, 503, 504)
 *
 * Permanent 4xx errors (400 Bad Request, 401 Unauthorised, 403 Forbidden,
 * 404 Not Found, 410 Gone, …) are returned / rethrown immediately — retrying
 * them would waste time and burn rate-limit budget without any benefit.
 *
 * Two helpers cover the two HTTP client patterns used in this codebase:
 *
 *   fetchWithRetry  — wraps native fetch(); used by BIS, World Bank, FRED,
 *                     UK Land Registry, MLIT, SGP HDB, and any other file
 *                     that calls fetch() directly.
 *
 *   withRetry       — wraps any async function; used by axios callers
 *                     (Brave, DuckDuckGo) and SDK callers (Exa) where we
 *                     cannot intercept the raw Response object.
 *
 * Both helpers rethrow / return the last result after exhaustion so that
 * callers' existing try/catch + null-return logic stays intact.
 */

const logger = require('./logger');

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

const { setTimeout: sleep } = require('node:timers/promises');

function retryAfterMs(value, now = Date.now()) {
    if (value == null || String(value).trim() === '') return null;
    const text = String(value).trim();
    let ms;
    if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
    else if (/^[+-]?\d/.test(text)) return null;
    else ms = Date.parse(text) - now; // HTTP-date, not just delta-seconds.
    return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : null;
}

function policy(options) {
    const result = { maxAttempts: 3, backoffMs: 500, label: '', ...options };
    if (!Number.isSafeInteger(result.maxAttempts) || result.maxAttempts < 1 ||
        !Number.isFinite(result.backoffMs) || result.backoffMs < 0)
        throw new RangeError('Retry attempts must be positive and backoff must be finite and nonnegative.');
    return result;
}

function cancelled(error) {
    return error?.name === 'AbortError' || error?.code === 'ERR_CANCELED' || error?.code === 'ABORT_ERR';
}

// Cancellation stops waiting; it cannot cancel an arbitrary SDK operation.
// Pass this same signal to the underlying transport when that API supports it.
// Both fulfillment and rejection handlers remain attached after an abort so a
// late SDK rejection is handled, but can never trigger a retry.
function awaitWithSignal(operation, signal) {
    if (!signal) return Promise.resolve(operation);
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(operation).then(
            value => { cleanup(); signal.aborted ? reject(signal.reason) : resolve(value); },
            error => { cleanup(); reject(signal.aborted ? signal.reason : error); }
        );
        if (signal.aborted) abort();
    });
}

function getHeader(headers, name) {
    return headers?.get?.(name) ?? headers?.[name.toLowerCase()] ?? headers?.['Retry-After'];
}

async function backoff(options, attempt, status, headers, signal) {
    const headerMs = Number(status) === 429 ? retryAfterMs(getHeader(headers, 'retry-after')) : null;
    const waitMs = headerMs ?? Math.min(MAX_RETRY_AFTER_MS, options.backoffMs * 2 ** (attempt - 1));
    logger.warn({ attempt, maxAttempts: options.maxAttempts, status, waitMs, label: options.label },
        'Outbound transient failure; bounded retry');
    signal?.throwIfAborted();
    try { await sleep(waitMs, undefined, { signal }); }
    catch (error) { signal?.throwIfAborted(); throw error; }
}

async function dispose(response, signal) {
    try { await awaitWithSignal(response.body?.cancel(), signal); }
    catch (error) {
        signal?.throwIfAborted();
        // Some adapters already closed the body. Cleanup failure must not
        // become a second, independently retried request.
        logger.debug({ code: error?.code }, 'Abandoned response body already closed');
    }
}

/**
 * Native fetch: both fetchOptions.signal and retryOptions.signal are WHOLE
 * operation deadlines, covering attempts, backoff and subsequent body reads.
 * Never manufacture a fresh timeout for a retry. The final Response (even 5xx)
 * remains untouched so callers retain their existing response/null contracts.
 */
async function fetchWithRetry(url, fetchOptions = {}, retryOptions = {}) {
    const options = policy(retryOptions);
    const signals = [...new Set([fetchOptions.signal, options.signal].filter(Boolean))];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const request = signal ? { ...fetchOptions, signal } : fetchOptions;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        signal?.throwIfAborted();
        let response;
        try { response = await fetch(url, request); }
        catch (error) {
            signal?.throwIfAborted();
            if (error.code === 'AI_CAPACITY' || error.providerCompleted ||
                cancelled(error) || attempt === options.maxAttempts) throw error;
            await backoff(options, attempt, undefined, undefined, signal);
            continue;
        }
        if (signal?.aborted) {
            void dispose(response); // cleanup must not delay an already-cancelled caller
            signal.throwIfAborted();
        }
        if (!RETRYABLE_HTTP_STATUSES.has(Number(response.status)) || attempt === options.maxAttempts)
            return response;
        await dispose(response, signal);
        await backoff(options, attempt, response.status, response.headers, signal);
    }
}

/**
 * SDK/axios calls may accept optional { signal, attempt }; zero-argument
 * callbacks remain compatible. The supplied signal is a total deadline.
 * An SDK's own request timeout remains per-attempt and is not a total deadline.
 */
async function withRetry(fn, retryOptions = {}) {
    const options = policy(retryOptions);
    const { signal } = options;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        signal?.throwIfAborted();
        try { return await awaitWithSignal(fn({ signal, attempt }), signal); }
        catch (error) {
            signal?.throwIfAborted();
            const status = error?.response?.status ?? error?.statusCode ?? error?.status;
            if (error.code === 'AI_CAPACITY' || error.providerCompleted ||
                cancelled(error) || retryOptions.shouldRetry?.(error) === false ||
                (Number(status) > 0 && !RETRYABLE_HTTP_STATUSES.has(Number(status))) ||
                attempt === options.maxAttempts) throw error;
            await backoff(options, attempt, status, error?.response?.headers ?? error?.headers, signal);
        }
    }
}

module.exports = { fetchWithRetry, withRetry, RETRYABLE_HTTP_STATUSES, retryAfterMs, awaitWithSignal };
