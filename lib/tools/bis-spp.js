'use strict';

/**
 * Generic BIS WS_SPP (Selected Property Prices) fetcher.
 *
 * Handles any BIS-covered country parametrically — no per-country files needed.
 *
 * Series key pattern: Q.{ISO2}.N.628  (quarterly, nominal, residential)
 * API base:  https://stats.bis.org/api/v2/data/dataflow/BIS/WS_SPP/1.0/
 * FX source: World Bank PA.NUS.FCRF (official LCU / USD annual average)
 *
 * Algorithm (same for every country):
 *   1. Fetch BIS nominal property price index for targetYear and currentYear.
 *   2. Fetch World Bank LCU/USD official rate for the same country.
 *   3. Convert the Numbeo USD anchor to LCU via the World Bank rate.
 *   4. Scale by (hist_index / ref_index) → historical LCU/sqm estimate.
 *
 * Returns { value, currency, date, sourceUrl } or null on any failure.
 * The currency matches the World Bank LCU income currency, so the
 * seed-metric years-to-buy calculation stays valid regardless of country.
 *
 * Source: https://www.bis.org/statistics/pp.htm
 */

const { urlCache }         = require('../fetch-cache');
const logger               = require('../logger');
const { ISO2_TO_CURRENCY } = require('../../utils/geo-data');
const { fetchWithRetry }   = require('../fetch-retry');

const BIS_BASE    = 'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_SPP/1.0';
const WB_FX_BASE  = 'https://api.worldbank.org/v2/country';
const SOURCE_URL  = 'https://www.bis.org/statistics/pp.htm';
const TTL_MS      = 24 * 60 * 60 * 1000;

// ── BIS index fetch ────────────────────────────────────────────────────────

/**
 * Fetch BIS nominal residential property price index for any ISO-3166-1 alpha-2
 * country code. Parses the SDMX XML response.
 *
 * Returns array of { period:'YYYY-Qn', value:number } or null.
 *
 * @param {string} iso2       - Country ISO-3166-1 alpha-2 code (e.g. 'JP', 'KR', 'AU')
 * @param {number} startYear
 * @param {number} endYear
 * @returns {Promise<Array<{period:string,value:number}>|null>}
 */
async function fetchBisIndex(iso2, startYear, endYear) {
    iso2 = String(iso2).toUpperCase();
    const cacheKey = `bis-spp:index:${iso2}:${startYear}:${endYear}`;
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug({ iso2, startYear, endYear }, '🌐 BIS SPP: cache hit');
        return cached;
    }

    const url = `${BIS_BASE}/Q.${iso2}.N.628?startPeriod=${startYear}&endPeriod=${endYear}`;
    try {
        const res = await fetchWithRetry(url, {
            headers: {
                'Accept': 'application/xml, */*',
                'User-Agent': 'NyanBook-AI-Reader/1.0 (research reader)'
            },
            signal: AbortSignal.timeout(14000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'BIS' });

        if (!res.ok) {
            logger.warn({ status: res.status, iso2, url }, '🌐 BIS SPP: HTTP error');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const xml = await res.text();

        // SDMX StructureSpecificData: <Obs TIME_PERIOD="2001-Q1" OBS_VALUE="139.13" ...>
        const obs = [];
        for (const m of xml.matchAll(/TIME_PERIOD="([^"]+)"[^/]*OBS_VALUE="([^"]+)"/g)) {
            const value = parseFloat(m[2]);
            if (isFinite(value)) obs.push({ period: m[1], value });
        }

        if (obs.length === 0) {
            logger.warn({ iso2, url }, '🌐 BIS SPP: no observations parsed from response');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        urlCache.set(cacheKey, obs, TTL_MS);
        logger.debug({ iso2, count: obs.length, startYear, endYear }, '🌐 BIS SPP: fetched index');
        return obs;

    } catch (err) {
        logger.warn({ iso2, err: err.message }, '🌐 BIS SPP: fetch error');
        urlCache.set(cacheKey, null, TTL_MS);
        return null;
    }
}

// ── World Bank LCU/USD exchange rate ──────────────────────────────────────

/**
 * Fetch the most recent available official LCU/USD exchange rate from World Bank
 * for any country by ISO-3166-1 alpha-2 code.
 *
 * Returns LCU per 1 USD (e.g. ~150 for JPY, ~1300 for KRW), or null on failure.
 *
 * @param {string} iso2 - Country ISO-3166-1 alpha-2 code
 * @returns {Promise<number|null>}
 */
async function fetchLcuPerUsd(iso2) {
    iso2 = String(iso2).toUpperCase();
    const cacheKey = `bis-spp:fx:${iso2}`;
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url = `${WB_FX_BASE}/${iso2}/indicator/PA.NUS.FCRF?format=json&mrv=5&per_page=10`;
    try {
        const res = await fetchWithRetry(url, {
            headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0' },
            signal: AbortSignal.timeout(10000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'BIS-FX' });

        if (!res.ok) {
            logger.warn({ status: res.status, iso2 }, '🌐 BIS SPP: World Bank FX HTTP error');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const json = await res.json();
        // World Bank response: [metadata, [{ value, date }, ...]]
        const rows = Array.isArray(json) ? json[1] : null;
        if (!rows) { urlCache.set(cacheKey, null, TTL_MS); return null; }

        const row = rows.find(r => r.value != null && isFinite(r.value) && r.value > 0);
        if (!row) {
            logger.warn({ iso2 }, '🌐 BIS SPP: no valid FX value from World Bank');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const rate = parseFloat(row.value);
        urlCache.set(cacheKey, rate, TTL_MS);
        logger.debug({ iso2, rate, date: row.date }, '🌐 BIS SPP: LCU/USD rate from World Bank');
        return rate;

    } catch (err) {
        logger.warn({ iso2, err: err.message }, '🌐 BIS SPP: World Bank FX fetch error');
        urlCache.set(cacheKey, null, TTL_MS);
        return null;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the annual average index value for a given year from quarterly observations.
 *
 * @param {Array<{period:string,value:number}>} obs
 * @param {number} year
 * @returns {number|null}
 */
function annualAverage(obs, year) {
    const yearStr = String(year);
    const yearObs = obs.filter(o => o.period.startsWith(yearStr + '-'));
    if (yearObs.length === 0) return null;
    return yearObs.reduce((s, o) => s + o.value, 0) / yearObs.length;
}

/**
 * Pure computation: given pre-fetched inputs, return the estimated historical LCU/sqm.
 * Exported for deterministic unit testing — no network calls involved.
 *
 * @param {number} currentPsmUsd - Current price per sqm in USD (Numbeo anchor)
 * @param {number} lcuPerUsd     - Official exchange rate: LCU per 1 USD
 * @param {number} histIndex     - BIS annual average index for the historical year
 * @param {number} refIndex      - BIS annual average index for the reference (current) year
 * @returns {number} Estimated historical price per sqm in LCU (rounded)
 */
function computeHistoricalLcu(currentPsmUsd, lcuPerUsd, histIndex, refIndex) {
    return Math.round(currentPsmUsd * lcuPerUsd * (histIndex / refIndex));
}

/**
 * Pure computation: LCU anchor path — no FX conversion needed.
 * Use when Numbeo already shows prices in local currency (e.g. ¥ for Tokyo).
 * Exported for deterministic unit testing — no network calls involved.
 *
 * @param {number} currentPsmLcu - Current price per sqm in local currency (Numbeo anchor)
 * @param {number} histIndex     - BIS annual average index for the historical year
 * @param {number} refIndex      - BIS annual average index for the reference (current) year
 * @returns {number} Estimated historical price per sqm in LCU (rounded)
 */
function computeHistoricalLcuFromLcu(currentPsmLcu, histIndex, refIndex) {
    return Math.round(currentPsmLcu * (histIndex / refIndex));
}

/**
 * Pure computation: full LCU anchor path from pre-fetched BIS obs arrays.
 * Combines annualAverage + computeHistoricalLcuFromLcu in the exact sequence
 * fetchBisPricePerSqm uses — exported for deterministic unit testing with
 * synthetic/mocked obs data (no network calls).
 *
 * @param {number}                              currentPsmLcu - Current LCU price per sqm
 * @param {Array<{period:string,value:number}>} obs           - Pre-fetched BIS quarterly obs
 * @param {number|string}                       targetYear    - Historical year (e.g. 2001)
 * @param {number}                              refYear       - Reference (current) year
 * @returns {number|null} Estimated historical LCU/sqm, or null if index data missing
 */
function computeLcuPathFromObs(currentPsmLcu, obs, targetYear, refYear) {
    const year = parseInt(targetYear, 10);
    if (!obs || !isFinite(year)) return null;

    const histIndex = annualAverage(obs, year);
    let refIndex = annualAverage(obs, refYear);
    if (refIndex === null) refIndex = annualAverage(obs, refYear - 1);
    if (histIndex === null || refIndex === null) return null;

    return computeHistoricalLcuFromLcu(currentPsmLcu, histIndex, refIndex);
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Estimate historical residential price per sqm in local currency using BIS index ratio.
 *
 * The returned currency matches World Bank LCU income for the same country,
 * so the seed-metric years-to-buy calculation stays valid.
 *
 * Two anchor modes:
 *   USD path (default): pass currentPsmUsd > 0; World Bank FX converts it to LCU.
 *   LCU path (new):     pass opts.currentPsmLcu > 0 when Numbeo already shows local
 *                       currency (e.g. ¥ for Tokyo). No FX conversion needed.
 *
 * @param {string}        iso2            - ISO-3166-1 alpha-2 code (e.g. 'JP', 'KR', 'AU')
 * @param {string}        cityKey         - Normalized city key (for logging only)
 * @param {number|string} targetYear      - Historical year (e.g. 2001)
 * @param {number|null}   currentPsmUsd   - Current price per sqm in USD (Numbeo anchor, USD path)
 * @param {object}        [opts={}]
 * @param {number|null}   [opts.currentPsmLcu] - Current price per sqm in local currency (LCU path)
 * @returns {Promise<{value:number, currency:string, date:string, sourceUrl:string}|null>}
 */
async function fetchBisPricePerSqm(iso2, cityKey, targetYear, currentPsmUsd, opts = {}) {
    iso2 = String(iso2).toUpperCase();
    const year = parseInt(targetYear, 10);
    if (!isFinite(year)) return null;

    const currentPsmLcu = (opts && isFinite(opts.currentPsmLcu) && opts.currentPsmLcu > 0)
        ? opts.currentPsmLcu : null;
    const hasUsdAnchor = isFinite(currentPsmUsd) && currentPsmUsd > 0;
    const hasLcuAnchor = currentPsmLcu !== null;

    if (!hasUsdAnchor && !hasLcuAnchor) {
        logger.debug({ iso2, cityKey, year }, '🌐 BIS SPP: no current price anchor — skipping');
        return null;
    }

    const currency = ISO2_TO_CURRENCY[iso2];
    if (!currency) {
        logger.warn({ iso2 }, '🌐 BIS SPP: unknown currency for ISO2, cannot tag result');
        return null;
    }

    const currentYear = new Date().getFullYear();

    // LCU anchor path: no FX fetch needed — Numbeo already reported local currency price.
    // Only taken when the LCU anchor is valid AND currency matches the ISO2 expectation.
    const lcuCurrencyOpt = (opts && opts.lcuCurrency) ? String(opts.lcuCurrency).toUpperCase() : null;
    const lcuCurrencyMatches = !lcuCurrencyOpt || lcuCurrencyOpt === currency;

    if (hasLcuAnchor && !lcuCurrencyMatches) {
        // Detected symbol (e.g. £) does not match the ISO2 expected currency (e.g. JPY).
        // Reject the LCU anchor to prevent a wrong-currency computation.
        logger.warn(
            { iso2, cityKey, year, detectedCurrency: lcuCurrencyOpt, expectedCurrency: currency },
            '🌐 BIS SPP: LCU currency mismatch — rejecting LCU anchor; falling through to USD path'
        );
        if (!hasUsdAnchor) return null;
    }

    if (hasLcuAnchor && lcuCurrencyMatches) {
        const obs = await fetchBisIndex(iso2, year, currentYear);
        if (!obs) {
            logger.warn({ iso2, cityKey, year }, '🌐 BIS SPP: LCU path — BIS index unavailable');
            return null;
        }

        const histIndex = annualAverage(obs, year);
        let refIndex = annualAverage(obs, currentYear);
        if (refIndex === null) refIndex = annualAverage(obs, currentYear - 1);

        if (histIndex === null || refIndex === null) {
            logger.warn({ iso2, year, currentYear, histIndex, refIndex },
                '🌐 BIS SPP: LCU path — cannot compute annual average');
            return null;
        }

        const historicalPsm = computeHistoricalLcuFromLcu(currentPsmLcu, histIndex, refIndex);

        logger.debug(
            {
                iso2, cityKey, year, currency,
                histIndex:    histIndex.toFixed(2),
                refIndex:     refIndex.toFixed(2),
                ratio:        (histIndex / refIndex).toFixed(4),
                currentPsmLcu,
                historicalPsm,
                anchorPath:   'lcu'
            },
            '🌐 BIS SPP: estimated historical price/sqm (LCU anchor)'
        );

        return {
            value:     historicalPsm,
            currency,
            date:      `${year}-06`,
            sourceUrl: SOURCE_URL
        };
    }

    // USD anchor path (original behaviour — unchanged).
    const [obs, lcuPerUsd] = await Promise.all([
        fetchBisIndex(iso2, year, currentYear),
        fetchLcuPerUsd(iso2)
    ]);

    if (!obs || !lcuPerUsd) {
        logger.warn(
            { iso2, cityKey, year, hasBis: !!obs, hasFx: !!lcuPerUsd },
            '🌐 BIS SPP: missing data, cannot compute'
        );
        return null;
    }

    const histIndex = annualAverage(obs, year);
    let refIndex = annualAverage(obs, currentYear);
    if (refIndex === null) refIndex = annualAverage(obs, currentYear - 1);

    if (histIndex === null || refIndex === null) {
        logger.warn({ iso2, year, currentYear, histIndex, refIndex },
            '🌐 BIS SPP: cannot compute annual average — missing quarters');
        return null;
    }

    const historicalPsm = computeHistoricalLcu(currentPsmUsd, lcuPerUsd, histIndex, refIndex);

    logger.debug(
        {
            iso2, cityKey, year, currency,
            histIndex:    histIndex.toFixed(2),
            refIndex:     refIndex.toFixed(2),
            ratio:        (histIndex / refIndex).toFixed(4),
            lcuPerUsd:    lcuPerUsd.toFixed(4),
            historicalPsm,
            anchorPath:   'usd'
        },
        '🌐 BIS SPP: estimated historical price/sqm (USD anchor)'
    );

    return {
        value:     historicalPsm,
        currency,
        date:      `${year}-06`,
        sourceUrl: SOURCE_URL
    };
}

module.exports = {
    fetchBisIndex,
    fetchLcuPerUsd,
    annualAverage,
    computeHistoricalLcu,
    computeHistoricalLcuFromLcu,
    computeLcuPathFromObs,
    fetchBisPricePerSqm
};
