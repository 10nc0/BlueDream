'use strict';

/**
 * BIS WS_SPP Japan Residential Property Price Index — thin wrapper.
 *
 * Delegates to the generic bis-spp module with iso2='JP'.
 * All logic lives in lib/tools/bis-spp.js — no duplication.
 *
 * Kept for backward compatibility: existing callers and tests that import
 * fetchJpnBisPricePerSqm, fetchBisJpnIndex, fetchJpyPerUsd, annualAverage,
 * or computeHistoricalJpy continue to work without modification.
 *
 * Source: https://www.bis.org/statistics/pp.htm
 */

const {
    fetchBisIndex,
    fetchLcuPerUsd,
    annualAverage,
    computeHistoricalLcu,
    fetchBisPricePerSqm,
} = require('./bis-spp');

const ISO2 = 'JP';

/**
 * Fetch BIS Japan nominal property price index for the given year range.
 * @param {number} startYear
 * @param {number} endYear
 * @returns {Promise<Array<{period:string,value:number}>|null>}
 */
function fetchBisJpnIndex(startYear, endYear) {
    return fetchBisIndex(ISO2, startYear, endYear);
}

/**
 * Fetch the most recent available official JPY/USD exchange rate from World Bank.
 * Returns JPY per 1 USD (e.g. ~150), or null on failure.
 * @returns {Promise<number|null>}
 */
function fetchJpyPerUsd() {
    return fetchLcuPerUsd(ISO2);
}

/**
 * Pure computation: given pre-fetched inputs, return the estimated historical JPY/sqm.
 * Exported for deterministic unit testing — no network calls involved.
 * @param {number} currentPsmUsd
 * @param {number} jpyPerUsd
 * @param {number} histIndex
 * @param {number} refIndex
 * @returns {number}
 */
function computeHistoricalJpy(currentPsmUsd, jpyPerUsd, histIndex, refIndex) {
    return computeHistoricalLcu(currentPsmUsd, jpyPerUsd, histIndex, refIndex);
}

/**
 * Estimate historical residential price per sqm in JPY using BIS index ratio.
 * Returns { value, currency:'JPY', date, sourceUrl } or null.
 * @param {string}        cityKey
 * @param {number|string} targetYear
 * @param {number}        currentPsmUsd
 * @returns {Promise<{value:number, currency:'JPY', date:string, sourceUrl:string}|null>}
 */
function fetchJpnBisPricePerSqm(cityKey, targetYear, currentPsmUsd) {
    return fetchBisPricePerSqm(ISO2, cityKey, targetYear, currentPsmUsd);
}

module.exports = {
    fetchJpnBisPricePerSqm,
    fetchBisJpnIndex,
    annualAverage,
    fetchJpyPerUsd,
    computeHistoricalJpy,
};
