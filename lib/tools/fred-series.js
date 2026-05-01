'use strict';

const { urlCache }       = require('../fetch-cache');
const logger             = require('../logger');
const { fetchWithRetry } = require('../fetch-retry');

const SQFT_TO_SQM = 10.764;
const FRED_TTL_MS = 24 * 60 * 60 * 1000;

// Fetches and caches the raw CSV rows [{date, value}] for an MSA code.
// Shared by both current and historical callers to avoid double HTTP fetches.
async function _fetchFredRows(msaCode) {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=MEDLISPRIPERSQUFEE${msaCode}`;
    const cacheKey = `fred:${msaCode}:rows`;

    const cached = urlCache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug({ msaCode }, '🏦 FRED: rows cache hit');
        return cached;
    }

    try {
        const res = await fetchWithRetry(url, {
            headers: { 'User-Agent': 'NyanBook-AI-Reader/1.0 (compatible; research reader)' },
            signal: AbortSignal.timeout(12000)
        }, { maxAttempts: 3, backoffMs: 500, label: 'FRED' });

        if (!res.ok) {
            logger.warn({ msaCode, status: res.status }, '🏦 FRED: HTTP error');
            urlCache.set(cacheKey, null, FRED_TTL_MS);
            return null;
        }

        const text = await res.text();
        const lines = text.trim().split('\n');
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
            const [date, rawVal] = lines[i].split(',');
            if (!rawVal || rawVal.trim() === '.' || rawVal.trim() === '') continue;
            const val = parseFloat(rawVal.trim());
            if (!isFinite(val) || val <= 0) continue;
            rows.push({ date: date ? date.trim() : null, value: val });
        }

        if (rows.length === 0) {
            logger.warn({ msaCode }, '🏦 FRED: no valid rows in CSV');
            urlCache.set(cacheKey, null, FRED_TTL_MS);
            return null;
        }

        urlCache.set(cacheKey, rows, FRED_TTL_MS);
        logger.debug({ msaCode, rowCount: rows.length }, '🏦 FRED: fetched CSV rows');
        return rows;
    } catch (err) {
        logger.warn({ msaCode, err: err.message }, '🏦 FRED: fetch error');
        return null;
    }
}

async function fetchFredPerSqft(msaCode) {
    const rows = await _fetchFredRows(msaCode);
    if (!rows || rows.length === 0) return null;
    const last = rows[rows.length - 1];
    logger.debug({ msaCode, value: last.value, date: last.date }, '🏦 FRED: fetched $/sqft');
    return { value: last.value, date: last.date };
}

// Pure helper: given a rows array [{date, value}] and a targetYear string/number, returns the
// row whose year is closest to targetYear. No hard distance cutoff — nearest always wins.
// Exported for unit testing without HTTP.
function _findNearestRowForYear(rows, targetYear) {
    if (!rows || rows.length === 0) return null;
    const target = parseInt(targetYear, 10);
    if (!isFinite(target)) return null;

    let best = null;
    let bestDist = Infinity;

    for (const row of rows) {
        if (!row.date) continue;
        const rowYear = parseInt(row.date.slice(0, 4), 10);
        const dist = Math.abs(rowYear - target);
        if (dist < bestDist) {
            bestDist = dist;
            best = row;
        }
    }
    return best;   // null if no valid rows
}

// Returns the $/sqft value for the row closest to targetYear.
// No hard distance cutoff: returns nearest available even when the series starts after targetYear
// (e.g. MEDLISPRIPERSQUFEE starts 2016, targetYear=2000 → returns 2016 row, dist=16).
// A real data point is more useful than null; callers can inspect .date for the actual year.
async function fetchFredPerSqftForYear(msaCode, targetYear) {
    const rows = await _fetchFredRows(msaCode);
    const best = _findNearestRowForYear(rows, targetYear);

    if (best === null) {
        logger.debug({ msaCode, targetYear }, '🏦 FRED: no rows available');
        return null;
    }

    const dist = Math.abs(parseInt(best.date.slice(0, 4), 10) - parseInt(targetYear, 10));
    logger.debug({ msaCode, targetYear, date: best.date, value: best.value, dist }, '🏦 FRED: historical $/sqft (nearest)');
    return { value: best.value, date: best.date };
}

async function fetchFredPerSqm(msaCode) {
    const sqft = await fetchFredPerSqft(msaCode);
    if (!sqft) return null;
    return {
        value: Math.round(sqft.value * SQFT_TO_SQM),
        currency: 'USD',
        date: sqft.date
    };
}

async function fetchFredPerSqmForYear(msaCode, targetYear) {
    const sqft = await fetchFredPerSqftForYear(msaCode, targetYear);
    if (!sqft) return null;
    return {
        value: Math.round(sqft.value * SQFT_TO_SQM),
        currency: 'USD',
        date: sqft.date
    };
}

module.exports = { fetchFredPerSqft, fetchFredPerSqm, fetchFredPerSqftForYear, fetchFredPerSqmForYear, _findNearestRowForYear };
