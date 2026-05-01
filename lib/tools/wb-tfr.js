'use strict';

/**
 * World Bank Total Fertility Rate fetcher.
 *
 * Indicator: SP.DYN.TFRT.IN  (fertility rate, total — births per woman)
 * Scope:     Country-level, annual. Data typically available with a ~2-year lag.
 * Coverage:  ~200 countries, 1960-present.
 * API docs:  https://datahelpdesk.worldbank.org/knowledgebase/articles/898581
 *
 * Used as the PRIMARY structured source in _fetchTFRData (Brave acts as a
 * recency supplement when WB has no data within MAX_LAG). Country-level
 * (not city-level), but sufficient for the seed-metric comparison table.
 *
 * Returns the TFR value for the year closest to targetYear within a ±4-year
 * tolerance, or null if no data is available.
 */

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');

const WB_BASE   = 'https://api.worldbank.org/v2/country';
const SOURCE_URL = 'https://data.worldbank.org/indicator/SP.DYN.TFRT.IN';
const TTL_MS    = 24 * 60 * 60 * 1000;
const MAX_LAG   = 4;

/**
 * Fetch TFR from World Bank for a given country (ISO2) and target year.
 *
 * @param {string}        iso2       - ISO-3166-1 alpha-2 country code (e.g. 'SG', 'JP')
 * @param {number|string} targetYear - Desired year (e.g. 2025, 2000)
 * @returns {Promise<{value:number, year:number, sourceUrl:string}|null>}
 */
async function fetchWbTFR(iso2, targetYear) {
    iso2 = String(iso2).toUpperCase();
    const year = parseInt(targetYear, 10);
    if (!isFinite(year)) return null;

    const cacheKey = `wb-tfr:${iso2}`;
    const cached = urlCache.get(cacheKey);
    let rows = cached;

    if (rows === undefined) {
        const url = `${WB_BASE}/${iso2}/indicator/SP.DYN.TFRT.IN?format=json&per_page=60&mrv=60`;
        try {
            const res = await fetchWithRetry(url, {
                headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0' },
                signal: AbortSignal.timeout(10000)
            }, { maxAttempts: 3, backoffMs: 500, label: 'WB-TFR' });

            if (!res.ok) {
                logger.warn({ status: res.status, iso2 }, '🌍 WB-TFR: HTTP error');
                urlCache.set(cacheKey, null, TTL_MS);
                return null;
            }

            const json = await res.json();
            // World Bank response format: [metadata_obj, [{ date:'YYYY', value:number|null }, ...]]
            rows = Array.isArray(json) && Array.isArray(json[1]) ? json[1] : null;
            if (!rows || rows.length === 0) {
                logger.warn({ iso2 }, '🌍 WB-TFR: no data rows in response');
                urlCache.set(cacheKey, null, TTL_MS);
                return null;
            }
            urlCache.set(cacheKey, rows, TTL_MS);
            logger.debug({ iso2, count: rows.length }, '🌍 WB-TFR: fetched indicator rows');
        } catch (err) {
            logger.warn({ iso2, err: err.message }, '🌍 WB-TFR: fetch error');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }
    }

    if (!rows) return null;

    // Find the row with a valid value whose year is closest to targetYear,
    // within MAX_LAG years tolerance.
    let best = null;
    let bestDist = Infinity;

    for (const row of rows) {
        const rowYear = parseInt(row.date, 10);
        if (!isFinite(rowYear) || row.value == null || !isFinite(row.value) || row.value <= 0) continue;
        const dist = Math.abs(rowYear - year);
        if (dist <= MAX_LAG && dist < bestDist) {
            best = { value: parseFloat(row.value), year: rowYear, sourceUrl: SOURCE_URL };
            bestDist = dist;
        }
    }

    if (best) {
        logger.debug(
            { iso2, targetYear: year, foundYear: best.year, value: best.value },
            '🌍 WB-TFR: returning value'
        );
    } else {
        logger.debug({ iso2, targetYear: year }, '🌍 WB-TFR: no value within tolerance');
    }

    return best;
}

module.exports = { fetchWbTFR, SOURCE_URL };
