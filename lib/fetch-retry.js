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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function _isRetryableStatus(status) {
    return RETRYABLE_HTTP_STATUSES.has(status);
}

// ── fetchWithRetry ─────────────────────────────────────────────────────────

/**
 * Drop-in replacement for fetch() with automatic retry and exponential backoff.
 *
 * Returns the Response so callers continue to use `res.ok`, `res.json()`,
 * and `res.text()` exactly as before. Throws only when a network-level error
 * persists after all retries are exhausted.
 *
 * Usage:
 *   const res = await fetchWithRetry(url, fetchOptions, { label: 'BIS' });
 *   if (!res.ok) { ... return null; }
 *   const json = await res.json();
 *
 * @param {string}  url
 * @param {object}  [fetchOptions]               - Standard fetch() options
 * @param {object}  [retryOptions]
 * @param {number}  [retryOptions.maxAttempts=3] - Total attempts (1 = no retry)
 * @param {number}  [retryOptions.backoffMs=500] - Initial wait; doubles each retry
 * @param {string}  [retryOptions.label='']      - Short label for log messages
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, fetchOptions = {}, retryOptions = {}) {
    const { maxAttempts = 3, backoffMs = 500, label = '' } = retryOptions;
    const tag = label ? `[${label}] ` : '';
    const shortUrl = String(url).slice(0, 80);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(url, fetchOptions);

            // Permanent 4xx (not 429) — caller handles, no retry
            if (!_isRetryableStatus(res.status)) {
                return res;
            }

            // Retryable HTTP status
            if (attempt === maxAttempts) {
                logger.warn({ status: res.status, attempt, url: shortUrl },
                    `🔄 ${tag}fetchWithRetry: retries exhausted`);
                return res;   // caller will see !res.ok and return null
            }

            let waitMs = backoffMs * Math.pow(2, attempt - 1);
            if (res.status === 429) {
                const ra = res.headers.get('Retry-After');
                if (ra) {
                    const sec = parseInt(ra, 10);
                    if (isFinite(sec)) waitMs = Math.min(sec * 1000, MAX_RETRY_AFTER_MS);
                }
            }
            logger.warn({ status: res.status, attempt, maxAttempts, waitMs, url: shortUrl },
                `🔄 ${tag}fetchWithRetry: transient HTTP error, retrying`);
            await sleep(waitMs);

        } catch (err) {
            // Network-level error (DNS, timeout, connection refused)
            if (attempt === maxAttempts) {
                logger.warn({ err: err.message, attempt, url: shortUrl },
                    `🔄 ${tag}fetchWithRetry: network error, retries exhausted`);
                throw err;
            }
            const waitMs = backoffMs * Math.pow(2, attempt - 1);
            logger.warn({ err: err.message, attempt, maxAttempts, waitMs, url: shortUrl },
                `🔄 ${tag}fetchWithRetry: network error, retrying`);
            await sleep(waitMs);
        }
    }
}

// ── withRetry ─────────────────────────────────────────────────────────────

/**
 * Wrap any async function with retry and exponential backoff.
 *
 * Designed for axios callers (where axios throws on HTTP errors and exposes
 * the status via err.response?.status) and SDK callers (Exa, etc.) where
 * the raw Response object is not accessible.
 *
 * Permanent HTTP 4xx errors detected via err.response?.status are rethrown
 * immediately — no retry budget wasted.
 *
 * Rethrows the final error after exhaustion so callers' existing try/catch
 * blocks stay unchanged.
 *
 * Usage:
 *   const response = await withRetry(
 *       () => axios.get(url, options),
 *       { label: 'Brave', maxAttempts: 3 }
 *   );
 *
 * @param {function} fn                          - Zero-argument async function
 * @param {object}   [retryOptions]
 * @param {number}   [retryOptions.maxAttempts=3]
 * @param {number}   [retryOptions.backoffMs=500]
 * @param {string}   [retryOptions.label='']
 * @returns {Promise<*>}
 */
async function withRetry(fn, retryOptions = {}) {
    const { maxAttempts = 3, backoffMs = 500, label = '' } = retryOptions;
    const tag = label ? `[${label}] ` : '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            // Axios-style: HTTP error status exposed on err.response
            const httpStatus = err.response?.status;
            if (httpStatus && !_isRetryableStatus(httpStatus)) {
                throw err;   // permanent 4xx — rethrow immediately
            }

            if (attempt === maxAttempts) {
                logger.warn({ err: err.message, httpStatus, attempt },
                    `🔄 ${tag}withRetry: retries exhausted`);
                throw err;
            }

            let waitMs = backoffMs * Math.pow(2, attempt - 1);
            if (httpStatus === 429) {
                const ra = err.response?.headers?.['retry-after'];
                if (ra) {
                    const sec = parseInt(ra, 10);
                    if (isFinite(sec)) waitMs = Math.min(sec * 1000, MAX_RETRY_AFTER_MS);
                }
            }
            logger.warn({ err: err.message, httpStatus, attempt, maxAttempts, waitMs },
                `🔄 ${tag}withRetry: error, retrying`);
            await sleep(waitMs);
        }
    }
}

module.exports = { fetchWithRetry, withRetry, RETRYABLE_HTTP_STATUSES };
