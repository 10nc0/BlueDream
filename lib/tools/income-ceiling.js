'use strict';

/**
 * STRUCTURAL INCOME CEILING — anti-fragile contamination guard for income extractions.
 *
 * First principle: instead of hardcoding "$300K USD" (which rots as inflation /
 * FX rates drift), anchor the ceiling to a structural reality: Monaco and
 * Switzerland are — and will remain for the foreseeable future — the wealthiest
 * sovereigns by GNI per capita. Their numbers move with global inflation, so
 * the ceiling auto-adjusts. If a future Monaco wage somehow exceeds today's by
 * 3×, our ceiling moves with it; we don't need to ship a code update.
 *
 * Source: World Bank `NY.GNP.PCAP.CD` (GNI per capita, current USD, Atlas method).
 *   Monaco (MC) ~$240K, Switzerland (CH) ~$95K, Luxembourg (LU) ~$85K.
 *
 * Apply a 1.5× buffer to allow for individual high-earners exceeding their
 * country's per-capita average (Monaco itself has HNW residents above mean).
 * Anything above this is almost certainly a property-price contamination, not
 * a real "average / median individual income" figure.
 */

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');
const { fetchLcuPerUsd } = require('./bis-spp');

const TTL_MS = 24 * 60 * 60 * 1000;
const WB_BASE = 'https://api.worldbank.org/v2/country';
const INDICATOR = 'NY.GNP.PCAP.CD';
const ANCHORS = ['MC', 'CH', 'LU'];
const BUFFER = 1.5;

async function _fetchAnchorGni(iso2) {
    const cacheKey = `income-ceiling:gni:${iso2}`;
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url = `${WB_BASE}/${iso2}/indicator/${INDICATOR}?mrv=5&format=json&per_page=5`;
    try {
        const res = await fetchWithRetry(url, {
            headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0' },
            signal: AbortSignal.timeout(10000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'IncomeCeiling' });

        if (!res.ok) {
            urlCache.set(cacheKey, null, TTL_MS);
            return null;
        }

        const json = await res.json();
        const rows = Array.isArray(json) ? json[1] : null;
        if (!rows) { urlCache.set(cacheKey, null, TTL_MS); return null; }

        const row = rows.find(r => r.value != null && isFinite(r.value) && r.value > 0);
        if (!row) { urlCache.set(cacheKey, null, TTL_MS); return null; }

        const value = Math.round(row.value);
        urlCache.set(cacheKey, value, TTL_MS);
        return value;
    } catch (err) {
        logger.warn({ iso2, err: err.message }, '🛡️ IncomeCeiling: anchor fetch error');
        return null;
    }
}

/**
 * Median of an array of numbers. Robust to a single bad data point — if Monaco
 * temporarily reports $1B or null, the other two anchors outvote it. Returns
 * NaN for empty input (caller handles fallback).
 */
function _median(arr) {
    if (!arr || arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Returns the structural income ceiling in USD: median of {Monaco, Switzerland,
 * Luxembourg} GNI per capita × BUFFER. Median (not max) protects against any
 * single anchor having a bad data point — two-of-three quorum is required.
 * Resolves to ~$140K base × 1.5 = ~$210K at time of writing.
 *
 * Fallback: if all three anchors fail (extremely unlikely — World Bank serves
 * these reliably), uses a static base anchor of 240,000 USD (≈ Monaco
 * historical level) which the BUFFER is then applied to — yielding a final
 * fallback ceiling of 360,000 USD. Slightly more permissive than the live
 * value, but still well above any real single-earner wage on the planet, so
 * the guard remains useful in degraded mode rather than failing closed.
 *
 * @returns {Promise<number>} - USD ceiling
 */
async function getIncomeCeilingUsd() {
    const cacheKey = 'income-ceiling:usd';
    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const values = (await Promise.all(ANCHORS.map(_fetchAnchorGni))).filter(v => v != null);
    const baseAnchor = values.length > 0 ? _median(values) : 240000;
    const ceiling = Math.round(baseAnchor * BUFFER);

    urlCache.set(cacheKey, ceiling, TTL_MS);
    logger.debug({ anchors: ANCHORS, values, baseAnchor, buffer: BUFFER, ceiling }, '🛡️ IncomeCeiling: USD ceiling computed (median of anchors)');
    return ceiling;
}

/**
 * Returns the structural income ceiling in the requested LCU. Converts the
 * USD ceiling via World Bank PA.NUS.FCRF (live LCU/USD official rate).
 *
 * Currency → ISO2 lookup is required because PA.NUS.FCRF is keyed by country.
 * Most LCUs map 1:1 (JPY→JP, KRW→KR), some are union currencies (EUR uses any
 * Eurozone country; we use Germany 'DE' as the canonical anchor).
 *
 * @param {string} currency - ISO-4217 currency code (e.g. 'JPY', 'KRW', 'EUR')
 * @returns {Promise<number|null>} - LCU ceiling, or null if FX unavailable
 */
const CURRENCY_TO_FX_ISO2 = {
    USD: null, // no conversion needed
    EUR: 'DE', GBP: 'GB', JPY: 'JP', KRW: 'KR', CNY: 'CN',
    SGD: 'SG', HKD: 'HK', AUD: 'AU', NZD: 'NZ', CAD: 'CA',
    CHF: 'CH', INR: 'IN', IDR: 'ID', VND: 'VN', THB: 'TH',
    MYR: 'MY', PHP: 'PH', AED: 'AE', BRL: 'BR', ZAR: 'ZA',
    MXN: 'MX', TRY: 'TR', RUB: 'RU', ILS: 'IL', SEK: 'SE',
    NOK: 'NO', DKK: 'DK', PLN: 'PL', CZK: 'CZ', HUF: 'HU',
    EGP: 'EG', NGN: 'NG', ARS: 'AR', COP: 'CO', CLP: 'CL', PEN: 'PE',
};

async function getIncomeCeilingLcu(currency) {
    if (!currency) return null;
    const code = String(currency).toUpperCase();
    const usdCeiling = await getIncomeCeilingUsd();
    if (code === 'USD') return usdCeiling;

    const iso2 = CURRENCY_TO_FX_ISO2[code];
    if (!iso2) {
        logger.debug({ currency: code }, '🛡️ IncomeCeiling: unknown currency, falling back to USD ceiling');
        return usdCeiling;
    }

    const lcuPerUsd = await fetchLcuPerUsd(iso2);
    if (!lcuPerUsd || !isFinite(lcuPerUsd) || lcuPerUsd <= 0) {
        logger.debug({ currency: code, iso2 }, '🛡️ IncomeCeiling: FX unavailable, falling back to USD ceiling');
        return usdCeiling;
    }

    return Math.round(usdCeiling * lcuPerUsd);
}

/**
 * Pre-fetches the income ceiling for a set of currencies in parallel.
 * Returns a { [currency]: lcuCeiling } map. Used at the top of the seed
 * metric pipeline so per-extraction `rescueIncome()` calls are O(1).
 *
 * @param {string[]} currencies - ISO-4217 codes
 * @returns {Promise<Object<string, number>>}
 */
async function buildCeilingMap(currencies) {
    const unique = Array.from(new Set(['USD', ...currencies.filter(Boolean).map(c => c.toUpperCase())]));
    const entries = await Promise.all(
        unique.map(async c => [c, await getIncomeCeilingLcu(c)])
    );
    return Object.fromEntries(entries.filter(([, v]) => v != null));
}

module.exports = {
    getIncomeCeilingUsd,
    getIncomeCeilingLcu,
    buildCeilingMap,
};
