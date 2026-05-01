'use strict';

/**
 * International historical residential price router.
 *
 * Given a (normalized) city key and a target year, selects the correct
 * authoritative source and returns { value, currency, date, sourceUrl } or null.
 *
 * Priority order:
 *
 *   1. Authoritative direct-data sources (city-specific, highest quality):
 *      Singapore → data.gov.sg HDB Resale Flat Prices (SGD)
 *      Tokyo / Osaka / Kyoto / Nagoya / Fukuoka / Sapporo / Yokohama / Kobe
 *                → MLIT Real Estate Transaction Price (JPY)
 *      London / Manchester / Birmingham / Edinburgh / Bristol
 *                → UK Land Registry HPI SPARQL (GBP)
 *
 *   2. Generic BIS WS_SPP index-ratio fallback (country-wide nominal index):
 *      For Japan cities: triggered automatically when MLIT is unreachable.
 *      For all other cities not matched above: country ISO2 is derived from
 *        CITY_TO_COUNTRY + COUNTRY_ISO2 in utils/geo-data.js and the BIS
 *        series Q.{ISO2}.N.628 is fetched — covering ~50 countries without
 *        any per-country code. Requires a Numbeo USD anchor (currentPsmUsd).
 *        Returns null gracefully if the country is not in BIS WS_SPP coverage.
 *
 *   3. Brave search + micro-extraction (caller's responsibility — returns null here).
 *
 * NOTE: This module handles HISTORICAL prices only.
 *       Current prices for non-US cities are fetched via Numbeo.
 *       US cities use FRED (handled separately in pipeline-orchestrator.js).
 */

const { fetchSgpHdbPricePerSqm }  = require('./sgp-hdb');
const { fetchUkLrPricePerSqm }    = require('./uk-lr');
const { fetchBisPricePerSqm }     = require('./bis-spp');
const { CITY_TO_COUNTRY, COUNTRY_ISO2 } = require('../../utils/geo-data');

// Maps lower-case city key → authoritative source tag.
// Only cities with high-quality direct data sources appear here.
// BIS generic fallback requires no entry — it resolves country via geo-data.
const CITY_SOURCE = {
    // Singapore — HDB Resale Flat Prices (data.gov.sg)
    'singapore': 'sgp',

    // Japan — MLIT Real Estate Transaction Price (first attempt)
    // BIS WS_SPP Japan index is the fallback when MLIT is unreachable.
    'tokyo':    'jpn',
    'osaka':    'jpn',
    'kyoto':    'jpn',
    'nagoya':   'jpn',
    'fukuoka':  'jpn',
    'sapporo':  'jpn',
    'yokohama': 'jpn',
    'kobe':     'jpn',

    // United Kingdom — Land Registry HPI SPARQL
    'london':      'uk',
    'manchester':  'uk',
    'birmingham':  'uk',
    'edinburgh':   'uk',
    'bristol':     'uk',
};

/**
 * Fetch historical residential price per sqm for a non-US city.
 *
 * @param {string}       cityKey         - Normalized city key (lowercase, e.g. 'singapore')
 * @param {string|number} targetYear     - Target year (e.g. '2001', 2001)
 * @param {number|null}  [currentPsmUsd] - Current price per sqm in USD from Numbeo.
 *   Used for the BIS index-ratio fallback via World Bank FX conversion.
 *   Pass null/undefined when not available.
 * @param {number|null}  [currentPsmLcu] - Current price per sqm in local currency from Numbeo.
 *   Used as a direct BIS anchor when Numbeo shows non-USD prices (e.g. ¥ for Tokyo).
 *   Takes precedence over currentPsmUsd in the BIS fallback when provided.
 * @param {string|null}  [lcuCurrency] - ISO-4217 currency code for currentPsmLcu (e.g. 'JPY').
 *   Used by bis-spp to validate the LCU currency matches the expected ISO2 currency.
 * @returns {Promise<{value:number, currency:string, date:string, sourceUrl:string}|null>}
 */
async function fetchIntlHistoricalPrice(cityKey, targetYear, currentPsmUsd = null, currentPsmLcu = null, lcuCurrency = null) {
    const key    = (cityKey || '').toLowerCase().trim();
    const source = CITY_SOURCE[key];
    const bisOpts = (currentPsmLcu != null && currentPsmLcu > 0)
        ? { currentPsmLcu, lcuCurrency: lcuCurrency || null }
        : {};

    // ── Authoritative direct-data sources ────────────────────────────────────
    switch (source) {
        case 'sgp':
            return fetchSgpHdbPricePerSqm(targetYear);

        case 'jpn': {
            // BIS Japan country-wide residential property index.
            // Prefers LCU anchor (¥ from Numbeo) when available; falls back to USD anchor + FX.
            const hasUsd = currentPsmUsd != null && currentPsmUsd > 0;
            const hasLcu = bisOpts.currentPsmLcu != null;
            if (hasUsd || hasLcu) {
                return fetchBisPricePerSqm('JP', key, targetYear, currentPsmUsd, bisOpts);
            }
            return null;
        }

        case 'uk':
            return fetchUkLrPricePerSqm(key, targetYear);
    }

    // ── Generic BIS WS_SPP fallback — any BIS-covered country ────────────────
    // For cities not matched by an authoritative source above, derive the country
    // ISO2 from geo-data and attempt the BIS parametric fetch. Works automatically
    // for Seoul, Sydney, Frankfurt, Paris, etc. — no per-country files required.
    // Returns null if the country is not in BIS WS_SPP or no anchor is available.
    const hasUsd = currentPsmUsd != null && currentPsmUsd > 0;
    const hasLcu = bisOpts.currentPsmLcu != null;
    if (hasUsd || hasLcu) {
        const country = CITY_TO_COUNTRY[key];
        const iso2    = country ? COUNTRY_ISO2[country.toLowerCase()] : null;
        if (iso2) {
            return fetchBisPricePerSqm(iso2, key, targetYear, currentPsmUsd, bisOpts);
        }
    }

    return null;
}

module.exports = { fetchIntlHistoricalPrice, CITY_SOURCE };
