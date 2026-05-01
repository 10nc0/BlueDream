'use strict';

/**
 * UK Land Registry House Price Index — SPARQL endpoint
 *
 * Returns estimated residential price per sqm (GBP) for London and other
 * UK cities for a given year. Uses the UK HPI average house price for the
 * specified region and divides by the statutory average floor area (75 sqm)
 * to derive a per-sqm figure.
 *
 * Source: HM Land Registry / ONS UK House Price Index
 *         https://landregistry.data.gov.uk/app/ukhpi
 *
 * Average dwelling floor area (75 sqm) is the ONS MHCLG median for existing
 * stock in England and Wales. This is a structural proxy — directionally
 * accurate for decade-scale comparisons.
 */

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');

const SPARQL_ENDPOINT = 'https://landregistry.data.gov.uk/landregistry/query';
const AVG_FLOOR_AREA_SQM = 75;
const TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_URL = 'https://landregistry.data.gov.uk/app/ukhpi';

// Maps city key → HPI region URI fragment
const CITY_REGION_URI = {
    'london':       'http://landregistry.data.gov.uk/id/region/london',
    'manchester':   'http://landregistry.data.gov.uk/id/region/north-west',
    'birmingham':   'http://landregistry.data.gov.uk/id/region/west-midlands',
    'edinburgh':    'http://landregistry.data.gov.uk/id/region/scotland',
    'bristol':      'http://landregistry.data.gov.uk/id/region/south-west',
};

function buildQuery(regionUri, year) {
    return `
PREFIX hpi: <http://landregistry.data.gov.uk/def/ukhpi/>
SELECT ?month ?avgPrice WHERE {
  ?obs hpi:refRegion <${regionUri}> ;
       hpi:averagePrice ?avgPrice ;
       hpi:refMonth ?month .
  FILTER(CONTAINS(STR(?month), "${year}"))
}
ORDER BY ?month
LIMIT 12`.trim();
}

/**
 * Returns { value, currency, date, sourceUrl } or null.
 * value: estimated price per sqm in GBP (= avg house price ÷ 75 sqm)
 */
async function fetchUkLrPricePerSqm(cityKey, targetYear) {
    const year = parseInt(targetYear, 10);
    if (!isFinite(year)) return null;

    const regionUri = CITY_REGION_URI[cityKey.toLowerCase()];
    if (!regionUri) {
        logger.debug({ cityKey }, '🇬🇧 UK LR: no region mapping for this city');
        return null;
    }

    const cacheKey = `uk-lr:${cityKey}:${year}`;
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug({ cityKey, year }, '🇬🇧 UK LR: cache hit');
        return cached;
    }

    const query = buildQuery(regionUri, year);
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;

    try {
        const res = await fetchWithRetry(url, {
            headers: {
                'Accept': 'application/sparql-results+json',
                'User-Agent': 'NyanBook-AI-Reader/1.0 (compatible; research reader)'
            },
            signal: AbortSignal.timeout(14000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'UK-LR' });

        if (!res.ok) {
            logger.warn({ cityKey, year, status: res.status }, '🇬🇧 UK LR: HTTP error');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const json = await res.json();
        const bindings = json?.results?.bindings || [];

        if (bindings.length === 0) {
            logger.warn({ cityKey, year }, '🇬🇧 UK LR: no data for this year');
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        // Take the mid-year observation (June if available, otherwise first record)
        const midYear = bindings.find(b => (b.month?.value || '').includes(`${year}-06`)) || bindings[0];
        const avgPrice = parseFloat(midYear.avgPrice?.value);
        const month = midYear.month?.value || `${year}-06`;

        if (!isFinite(avgPrice) || avgPrice <= 0) {
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const pricePerSqm = Math.round(avgPrice / AVG_FLOOR_AREA_SQM);
        const result = {
            value: pricePerSqm,
            currency: 'GBP',
            date: month,
            sourceUrl: SOURCE_URL
        };

        urlCache.set(cacheKey, result, TTL_MS);
        logger.debug({ cityKey, year, avgPrice, pricePerSqm }, '🇬🇧 UK LR: price/sqm');
        return result;

    } catch (err) {
        logger.warn({ cityKey, year, err: err.message }, '🇬🇧 UK LR: fetch error');
        urlCache.set(cacheKey, null, TTL_MS);
        return null;
    }
}

module.exports = { fetchUkLrPricePerSqm };
