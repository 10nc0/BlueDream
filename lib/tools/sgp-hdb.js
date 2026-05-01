'use strict';

/**
 * Singapore HDB Resale Flat Prices — data.gov.sg CKAN API
 *
 * Returns the median resale price per sqm (SGD) for HDB flats for a given year.
 * Source: Housing & Development Board via data.gov.sg (public, no auth required).
 *
 * Resource coverage:
 *   adbbddd3-30e2-445f-a123-29bee150a6fe  → 1990-1999
 *   8c00bf08-9124-479e-aeca-7cc411d884c4  → 2000-2012
 *   83b2fc37-ce8c-4df4-968b-370fd818138b  → 2012-2025
 */

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');

const CKAN_BASE = 'https://data.gov.sg/api/action/datastore_search';

const RESOURCE_BY_ERA = [
    { from: 1990, to: 1999, id: 'adbbddd3-30e2-445f-a123-29bee150a6fe' },
    { from: 2000, to: 2012, id: '8c00bf08-9124-479e-aeca-7cc411d884c4' },
    { from: 2012, to: 2025, id: '83b2fc37-ce8c-4df4-968b-370fd818138b' },
];

const TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_URL = 'https://data.gov.sg/dataset/resale-flat-prices';

function pickResource(year) {
    for (const era of RESOURCE_BY_ERA) {
        if (year >= era.from && year <= era.to) return era.id;
    }
    return null;
}

/**
 * Returns { value, currency, date, sourceUrl } or null.
 * value: median HDB resale price per sqm in SGD
 * date:  "YYYY-06" (mid-year representative month)
 *
 * Retries up to 3 times with exponential backoff via the shared fetchWithRetry utility.
 */
async function fetchSgpHdbPricePerSqm(targetYear) {
    const year = parseInt(targetYear, 10);
    if (!isFinite(year)) return null;

    const resourceId = pickResource(year);
    if (!resourceId) {
        logger.debug({ year }, '🇸🇬 SGP HDB: no resource covers this year');
        return null;
    }

    const cacheKey = `sgp-hdb:${year}`;
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug({ year }, '🇸🇬 SGP HDB: cache hit');
        return cached;
    }

    // Fetch mid-year (June) as a representative sample; limit 1000 gives a stable median.
    const month = `${year}-06`;
    const url = new URL(CKAN_BASE);
    url.searchParams.set('resource_id', resourceId);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('filters', JSON.stringify({ month }));

    try {
        const res = await fetchWithRetry(url.toString(), {
            headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0 (compatible; research reader)' },
            signal: AbortSignal.timeout(14000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'SGP-HDB' });

        if (!res.ok) {
            logger.warn({ year, status: res.status }, '🇸🇬 SGP HDB: HTTP error');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const json = await res.json();

        if (!json.success || !json.result?.records?.length) {
            logger.warn({ year, month }, '🇸🇬 SGP HDB: no records returned');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const psmList = json.result.records
            .map(r => parseFloat(r.resale_price) / parseFloat(r.floor_area_sqm))
            .filter(v => isFinite(v) && v > 100);  // sanity floor: >100 SGD/sqm

        if (psmList.length === 0) {
            logger.warn({ year, month }, '🇸🇬 SGP HDB: no valid price/sqm records');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const sorted = psmList.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];

        const result = {
            value: Math.round(median),
            currency: 'SGD',
            date: month,
            sourceUrl: SOURCE_URL
        };

        urlCache.set(cacheKey, result, TTL_MS);
        logger.debug({ year, month, median: result.value, n: psmList.length }, '🇸🇬 SGP HDB: price/sqm');
        return result;

    } catch (err) {
        logger.warn({ year, err: err.message }, '🇸🇬 SGP HDB: fetch error');
        urlCache.set(cacheKey, null, TTL_MS);
        return null;
    }
}

module.exports = { fetchSgpHdbPricePerSqm };
