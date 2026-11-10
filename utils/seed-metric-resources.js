'use strict';

const logger = require('../lib/logger');
const { buildCeilingMap } = require('../lib/tools/income-ceiling');
const { CITY_EXPAND, CITY_TO_COUNTRY, COUNTRY_ISO2, ISO2_TO_CURRENCY, cityToExpectedCurrency } = require('./geo-data');

const CITY_CONTRACT = Object.fromEntries(Object.entries(CITY_EXPAND).map(([abbr, full]) => [full, abbr]));

function seedMetricCities(preflight) {
    return [...new Set((preflight?.seedMetricSearchQueries || []).map(query => {
        // National fallback searches are evidence, not additional city rows.
        if (/\bnational average property price\b/i.test(String(query))) return null;
        const match = String(query).match(/^([a-z\s]+)\s+(?:residential|average|median|housing|apartment)/i);
        if (!match) return null;
        const city = match[1].trim().toLowerCase();
        return CITY_CONTRACT[city] || city;
    }).filter(Boolean))];
}

function seedMetricCurrencies(cities) {
    const currencies = new Set(['USD']);
    for (const city of cities) {
        const key = String(city).trim().toLowerCase();
        const expanded = CITY_EXPAND[key] || key;
        const country = CITY_TO_COUNTRY[expanded] || CITY_TO_COUNTRY[key];
        const iso2 = country && COUNTRY_ISO2[country.toLowerCase()];
        const currency = cityToExpectedCurrency(expanded) || (iso2 && ISO2_TO_CURRENCY[iso2]);
        if (currency) currencies.add(currency);
    }
    return [...currencies];
}

// Preserve the hoisted Promise, and extend it only for currencies belonging to
// cities discovered later by Round 1. Never warm the whole currency registry.
function ensureSeedMetricCeilings(state, cities, fetchMap = buildCeilingMap) {
    const wanted = seedMetricCurrencies(cities);
    if (!state.ceilingCurrencies) {
        // Existing externally supplied maps retain their original contract.
        state.ceilingCurrencies = new Set(state.ceilingMapP ? wanted : []);
    }
    const missing = wanted.filter(currency => !state.ceilingCurrencies.has(currency));
    if (!missing.length) return state.ceilingMapP;
    for (const currency of missing) state.ceilingCurrencies.add(currency);
    const previous = state.ceilingMapP || Promise.resolve({});
    const next = Promise.resolve().then(() => fetchMap(missing)).catch(err => {
        logger.warn(`🛡️ Income ceiling fetch failed (${missing.join(', ')}): ${err.message} — degraded mode`);
        return {};
    });
    state.ceilingMapP = Promise.all([previous, next]).then(([existing, added]) => ({ ...existing, ...added }));
    return state.ceilingMapP;
}

function dedupPushUrl(urls, entry) {
    const url = typeof entry === 'string' ? entry : entry.url;
    if (!urls.some(existing => (typeof existing === 'string' ? existing : existing.url) === url)) {
        urls.push(entry);
    }
}

module.exports = { seedMetricCities, seedMetricCurrencies, ensureSeedMetricCeilings, dedupPushUrl };
