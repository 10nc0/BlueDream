'use strict';

const logger = require('./logger');

class FetchCache {
    constructor(options = {}) {
        this._cache = new Map();
        this._defaultTTL = options.ttl || 5 * 60 * 1000;
        this._maxEntries = options.maxEntries || 200;
        this._hits = 0;
        this._misses = 0;
        this._inflight = new Map();
    }

    _normalizeKey(key) {
        return String(key).trim().toLowerCase().replace(/\s+/g, ' ');
    }

    _evictExpired() {
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (now > entry.expiresAt) this._cache.delete(key);
        }
    }

    get(key) {
        const normalized = this._normalizeKey(key);
        const entry = this._cache.get(normalized);
        if (!entry) {
            this._misses++;
            return undefined;
        }
        if (Date.now() > entry.expiresAt) {
            this._cache.delete(normalized);
            this._misses++;
            return undefined;
        }
        this._hits++;
        return entry.value;
    }

    set(key, value, ttl) {
        const normalized = this._normalizeKey(key);
        if (this._cache.size >= this._maxEntries) {
            this._evictExpired();
            if (this._cache.size >= this._maxEntries) {
                const oldest = this._cache.keys().next().value;
                this._cache.delete(oldest);
            }
        }
        this._cache.set(normalized, {
            value,
            expiresAt: Date.now() + (ttl || this._defaultTTL),
            createdAt: Date.now()
        });
    }

    has(key) {
        const normalized = this._normalizeKey(key);
        const entry = this._cache.get(normalized);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this._cache.delete(normalized);
            return false;
        }
        return true;
    }

    invalidate(key) {
        return this._cache.delete(this._normalizeKey(key));
    }

    clear() {
        this._cache.clear();
        this._hits = 0;
        this._misses = 0;
    }

    stats() {
        this._evictExpired();
        const total = this._hits + this._misses;
        return {
            entries: this._cache.size,
            hits: this._hits,
            misses: this._misses,
            hitRate: total > 0 ? Math.round((this._hits / total) * 100) : 0
        };
    }

    async getOrFetch(key, fetcher, ttl) {
        const cached = this.get(key);
        if (cached !== undefined) {
            logger.debug({ key: key.substring(0, 60) }, '🗄️ Cache HIT');
            return cached;
        }
        logger.debug({ key: key.substring(0, 60) }, '🗄️ Cache MISS — fetching');
        const result = await fetcher();
        if (result !== null && result !== undefined) {
            this.set(key, result, ttl);
        }
        return result;
    }

    /**
     * Single-flight fetch — the thundering-herd guard.
     *
     * When the cache is cold and N concurrent callers all request the same key
     * at once, only ONE real fetch is fired; every other caller receives the
     * same in-flight Promise.  Once the fetch settles the result (including
     * null for failures) is written to the cache so future callers get an
     * instant cache hit.
     *
     * Null is cached explicitly (for the supplied TTL) so a consistent API
     * outage doesn't trigger a retry storm on every subsequent call.
     *
     * @param {string}   key     - Cache key
     * @param {function} fetcher - Async zero-arg function; return null on failure (do not throw)
     * @param {number}   [ttl]   - TTL override in ms
     * @returns {Promise<*>}
     */
    coalesce(key, fetcher, ttl) {
        const cached = this.get(key);
        if (cached !== undefined) return Promise.resolve(cached);

        const normalized = this._normalizeKey(key);
        if (this._inflight.has(normalized)) {
            return this._inflight.get(normalized);
        }

        const promise = (async () => {
            try {
                const result = await fetcher();
                this.set(key, result, ttl);
                return result;
            } catch (err) {
                this.set(key, null, ttl);
                return null;
            } finally {
                this._inflight.delete(normalized);
            }
        })();

        this._inflight.set(normalized, promise);
        return promise;
    }
}

const braveCache = new FetchCache({ ttl: 3 * 60 * 1000, maxEntries: 100 });
const urlCache = new FetchCache({ ttl: 10 * 60 * 1000, maxEntries: 50 });
const duckduckgoCache = new FetchCache({ ttl: 5 * 60 * 1000, maxEntries: 50 });
const exaCache = new FetchCache({ ttl: 5 * 60 * 1000, maxEntries: 50 });

module.exports = { FetchCache, braveCache, urlCache, duckduckgoCache, exaCache };
