'use strict';

const logger = require('./logger');

class FetchCache {
    constructor(options = {}) {
        this._cache = new Map();
        this._defaultTTL = options.ttl || 5 * 60 * 1000;
        this._maxEntries = options.maxEntries || 200;
        this._hits = 0;
        this._misses = 0;
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
}

const braveCache = new FetchCache({ ttl: 3 * 60 * 1000, maxEntries: 100 });
const urlCache = new FetchCache({ ttl: 10 * 60 * 1000, maxEntries: 50 });
const duckduckgoCache = new FetchCache({ ttl: 5 * 60 * 1000, maxEntries: 50 });

module.exports = { FetchCache, braveCache, urlCache, duckduckgoCache };
