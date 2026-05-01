'use strict';

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');

// GNI per capita (Atlas method, NY.GNP.PCAP.CD) is not individual take-home salary —
// it is a country-level income proxy. It overestimates real-world earner income in
// high-tax countries slightly, but is the most consistent free global benchmark
// for relative affordability comparison.
//
// NY.GNP.PCAP.CN is the same indicator expressed in current local currency units (LCU).
// Using LCU income avoids forex conversion entirely when the property price is also
// expressed in the same LCU (which is the case for BIS WS_SPP/JPY, SGP HDB/SGD,
// UK LR/GBP, and Brave LLM extractions).

const WB_TTL_MS = 24 * 60 * 60 * 1000;
const WB_BASE = 'https://api.worldbank.org/v2/country';
const INDICATOR_USD = 'NY.GNP.PCAP.CD';
const INDICATOR_LCU = 'NY.GNP.PCAP.CN';

async function _fetchWorldBankGniRaw(iso2, targetYear, indicator, currency) {
    const cacheKey = targetYear
        ? `worldbank:${indicator}:${iso2}:${targetYear}`
        : `worldbank:${indicator}:${iso2}:latest`;

    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug({ iso2, targetYear, indicator }, '🌍 WorldBank: cache hit');
        return cached;
    }

    const params = targetYear
        ? `?date=${targetYear}&format=json&per_page=1`
        : `?mrv=5&format=json&per_page=5`;

    const url = `${WB_BASE}/${iso2}/indicator/${indicator}${params}`;

    try {
        const res = await fetchWithRetry(url, {
            headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0 (compatible; research reader)' },
            signal: AbortSignal.timeout(12000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'WorldBank' });

        if (!res.ok) {
            logger.warn({ iso2, targetYear, indicator, status: res.status }, '🌍 WorldBank: HTTP error');
            return null;
        }

        const json = await res.json();

        if (!Array.isArray(json) || !Array.isArray(json[1]) || json[1].length === 0) {
            logger.warn({ iso2, targetYear, indicator }, '🌍 WorldBank: unexpected response shape');
            urlCache.set(cacheKey, null, WB_TTL_MS);
            return null;
        }

        const entries = json[1];
        let chosen = null;

        for (const entry of entries) {
            if (entry.value != null && isFinite(entry.value) && entry.value > 0) {
                chosen = entry;
                break;
            }
        }

        if (!chosen) {
            logger.warn({ iso2, targetYear, indicator }, '🌍 WorldBank: no non-null value found');
            urlCache.set(cacheKey, null, WB_TTL_MS);
            return null;
        }

        const result = {
            value: Math.round(chosen.value),
            year: parseInt(chosen.date, 10),
            currency
        };

        urlCache.set(cacheKey, result, WB_TTL_MS);
        logger.debug({ iso2, targetYear, indicator, result }, '🌍 WorldBank: fetched GNI');
        return result;
    } catch (err) {
        logger.warn({ iso2, targetYear, indicator, err: err.message }, '🌍 WorldBank: fetch error');
        return null;
    }
}

// GNI per capita in USD (Atlas method) — used for US cities
async function fetchWorldBankGni(iso2, targetYear) {
    return _fetchWorldBankGniRaw(iso2, targetYear, INDICATOR_USD, 'USD');
}

// GNI per capita in local currency units — used for all non-US countries so that
// the income denomination matches the property price denomination, making the
// years formula valid without any forex conversion.
async function fetchWorldBankGniLcu(iso2, targetYear, lcu) {
    return _fetchWorldBankGniRaw(iso2, targetYear, INDICATOR_LCU, lcu || 'USD');
}

module.exports = { fetchWorldBankGni, fetchWorldBankGniLcu };
