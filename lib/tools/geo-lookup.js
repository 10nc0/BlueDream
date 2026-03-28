'use strict';

const {
    CITY_EXPAND,
    CITY_TO_COUNTRY,
    COUNTRY_CITY_MAP,
    CURRENCY_REGISTRY,
} = require('../../utils/geo-data');

const LOOKUP_TYPES = {
    city_to_country: 'Resolve a city name to its country',
    country_to_cities: 'List major cities for a country',
    expand_abbreviation: 'Expand a city abbreviation (e.g. "la" → "los angeles")',
    currency_lookup: 'Look up currency info for a region or currency code',
};

function cityToCountry(query) {
    if (!query) return null;
    const key = query.toLowerCase().trim();
    const country = CITY_TO_COUNTRY[key];
    return country ? { city: key, country } : null;
}

function countryToCities(query) {
    if (!query) return null;
    const key = query.toLowerCase().trim();
    const cities = COUNTRY_CITY_MAP[key];
    return Array.isArray(cities) ? { country: key, cities: [...cities] } : null;
}

function expandAbbreviation(query) {
    if (!query) return null;
    const key = query.toLowerCase().trim();
    const expanded = CITY_EXPAND[key];
    return expanded ? { abbreviation: key, expanded } : null;
}

function currencyLookup(query) {
    if (!query) return null;
    const upper = query.toUpperCase().trim();
    const lower = query.toLowerCase().trim();

    if (CURRENCY_REGISTRY[upper]) {
        const entry = CURRENCY_REGISTRY[upper];
        return { code: upper, symbols: [...entry.symbols], regions: [...entry.cities] };
    }

    for (const [code, entry] of Object.entries(CURRENCY_REGISTRY)) {
        if (entry.cities.includes(lower)) {
            return { code, symbols: [...entry.symbols], regions: [...entry.cities], matchedBy: lower };
        }
    }

    for (const [code, entry] of Object.entries(CURRENCY_REGISTRY)) {
        const lowerSymbols = entry.symbols.map(s => s.toLowerCase());
        if (lowerSymbols.includes(lower)) {
            return { code, symbols: [...entry.symbols], regions: [...entry.cities], matchedBy: lower };
        }
    }

    return null;
}

const HANDLERS = {
    city_to_country: cityToCountry,
    country_to_cities: countryToCities,
    expand_abbreviation: expandAbbreviation,
    currency_lookup: currencyLookup,
};

module.exports = {
    name: 'geo-lookup',
    description: 'Geographic metadata lookup. Resolves city→country, country→cities, city abbreviation expansion, and currency→region mapping. Pure static data — no network calls, no side effects.',
    parameters: {
        type: { type: 'string', required: true, description: `Lookup type: ${Object.keys(LOOKUP_TYPES).join(', ')}` },
        query: { type: 'string', required: true, description: 'The city, country, abbreviation, or currency code/symbol to look up' },
    },

    async execute({ type, query } = {}) {
        if (!type || !HANDLERS[type]) {
            return {
                success: false,
                error: `Invalid lookup type. Must be one of: ${Object.keys(LOOKUP_TYPES).join(', ')}`,
                result: null,
            };
        }

        if (!query || typeof query !== 'string') {
            return { success: false, error: 'No query provided', result: null };
        }

        const handler = HANDLERS[type];
        const result = handler(query);

        return {
            success: result !== null,
            type,
            query,
            result,
        };
    },
};
