/**
 * TEMPORAL RESOLVER — single source of truth for "when is the user asking about?"
 *
 * One module that the LLM-side prompt builder AND the independent audit verifier
 * both consume, so a query like "perbaikan bulan lalu" expands the same way in
 * both layers. Without this, the verifier's #171 safety net silently goes blind
 * for any relative-time question.
 *
 * Inputs:
 *   - query: user's raw text
 *   - now:  Date (defaults to system time; dependency-injected for tests)
 *   - tz:   IANA timezone (defaults to Asia/Jakarta — the project's tenant base)
 *
 * Output of resolveTemporalScope():
 *   {
 *     datePatterns: string[]   YYYY-MM prefixes (always; unifies absolute + relative)
 *     dayPatterns:  string[]   YYYY-MM-DD prefixes (only for day-precision phrases:
 *                              kemarin, today, last N days, last week, etc.)
 *     hasTemporal:  boolean
 *     matchedPhrases: string[] human-readable trace of which phrases matched
 *     context: { now, tz, todayLocalISO, currentYM, currentYMD, todayParts }
 *   }
 *
 * Coverage (one place, not many):
 *   ABSOLUTE
 *     - bare year ("2026", with prefix words like "tahun/in/year/during/for/of")
 *     - month + year (English, Indonesian, 3-letter abbrev — anywhere)
 *     - ISO YYYY-MM
 *     - quarters Q1..Q4 YYYY
 *     - ranges: "antara X dan Y", "between X and Y", "from X to Y",
 *               "dari X sampai/hingga Y", "X to/until Y", "X sampai/hingga Y"
 *   RELATIVE (anchored at `now` in `tz`)
 *     - hari ini / today
 *     - kemarin / yesterday, kemarin lusa / day before yesterday
 *     - {bulan|minggu|tahun|kuartal|hari|pekan} {ini|lalu|depan|sebelumnya|berikutnya}
 *     - this/last/past/previous/next {day|week|month|quarter|year}
 *     - last/past/previous/in the last/over the last N {unit}
 *     - N {unit} terakhir / N {unit} (yang) lalu / N {unit} ago
 *     - YTD / year-to-date / tahun berjalan
 *     - MTD / month-to-date / bulan berjalan
 *     - QTD / quarter-to-date / kuartal berjalan
 *     - sejak X / since X / from X (open-ended → through today)
 *
 * Plate-shape guard ("BA 2026 QO" must NOT trigger a year filter) is preserved
 * from the previous absolute extractor verbatim.
 *
 * ── ADDING A NEW LOCALE ──────────────────────────────────────────────────────
 * 1. Create `utils/temporal-locales/<code>.js` following the shape documented in
 *    `utils/temporal-locales/en.js`.  Fill in monthNames, monthAbbrevs, unitMap,
 *    relFragments, todayRegex, yesterdayRegex, dayBeforeYesterdayRegex,
 *    dayBeforeYesterdayLabel, and xtdAliases.  Set `_id` to the ISO 639-1 code.
 * 2. Add one `require` line to `utils/temporal-locales/index.js`.
 * 3. That is the entire change — no edits to this file or any other are needed.
 */

'use strict';

// ── LOCALE REGISTRY ──────────────────────────────────────────────────
// Loaded from the single registration point (utils/temporal-locales/index.js).
// To add a new locale: edit only that index file — no changes here required.
const LOCALE_REGISTRY = require('./temporal-locales');

// ── COMBINED VOCAB TABLES (derived from registry) ────────────────────
// These module-level constants preserve the same names as before so all
// internal callers and the re-exported _internals surface keep working.

const _enLocale = LOCALE_REGISTRY.find(l => l._id === 'en');
const _idLocale = LOCALE_REGISTRY.find(l => l._id === 'id');

/** English full month names (re-exported for backward compat). */
const MONTH_NAMES_EN = _enLocale.monthNames;

/** Indonesian full month names (re-exported for backward compat). */
const MONTH_NAMES_ID = _idLocale.monthNames;

/**
 * Per-month abbreviation arrays merged across all locales.
 * Equivalent to the previous hand-written MONTH_ABBREVS constant.
 */
const MONTH_ABBREVS = (() => {
    const merged = Array.from({ length: 12 }, () => []);
    for (const locale of LOCALE_REGISTRY) {
        locale.monthAbbrevs.forEach((abbrevs, i) => {
            for (const a of abbrevs) {
                if (!merged[i].includes(a)) merged[i].push(a);
            }
        });
    }
    return merged;
})();

/**
 * Per-position arrays of ALL locale month names derived from the registry.
 * Index i holds every locale's name for month i+1 (0-indexed).
 * Adding a new locale automatically makes its month names available everywhere
 * endpoint/range/since parsing is built — no resolver edits required.
 */
const _ALL_MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
    LOCALE_REGISTRY.map(l => l.monthNames[i])
);

/**
 * Combined month-name + abbreviation alternation string for regex construction.
 * Pre-computed once at boot; used by both the absolute extractor (ranges,
 * month+year step) and the relative extractor (sejak/since pattern).
 */
const _MONTH_ALT = [..._ALL_MONTH_NAMES.flat(), ...MONTH_ABBREVS.flat()].join('|');

/**
 * Combined unit-word → canonical-unit map merged across all locales.
 * Equivalent to the previous hand-written REL_UNIT constant.
 */
const REL_UNIT = Object.assign({}, ...LOCALE_REGISTRY.map(l => l.unitMap));

/** Regex alternation of all unit words (used inside larger patterns). */
const UNIT_RX = Object.keys(REL_UNIT).join('|');

// Pre-build combined XTD regex strings once at boot for performance.
const _ytdParts = ['ytd', 'year[\\s-]to[\\s-]date'];
const _mtdParts = ['mtd', 'month[\\s-]to[\\s-]date'];
const _qtdParts = ['qtd', 'quarter[\\s-]to[\\s-]date'];
for (const locale of LOCALE_REGISTRY) {
    if (locale.xtdAliases.ytd) _ytdParts.push(locale.xtdAliases.ytd);
    if (locale.xtdAliases.mtd) _mtdParts.push(locale.xtdAliases.mtd);
    if (locale.xtdAliases.qtd) _qtdParts.push(locale.xtdAliases.qtd);
}
const _ytdRe = new RegExp(`\\b(?:${[...new Set(_ytdParts)].join('|')})\\b`);
const _mtdRe = new RegExp(`\\b(?:${[...new Set(_mtdParts)].join('|')})\\b`);
const _qtdRe = new RegExp(`\\b(?:${[...new Set(_qtdParts)].join('|')})\\b`);

const DEFAULT_TZ = 'Asia/Jakarta';

// ── TZ + date helpers ────────────────────────────────────────────────
function formatYMDInTz(date, tz) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}
function partsInTz(date, tz) {
    const ymd = formatYMDInTz(date, tz);
    const [y, m, d] = ymd.split('-').map(Number);
    return { year: y, month: m, day: d };
}
function ymPad(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }
function ymdPad(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Convert any timestamp-like value (Date, ISO string, ms epoch) to its
// **tenant-local** YMD / YM strings. The verifier MUST compare messages
// against tz-derived dayPatterns/datePatterns using the same wall-clock
// anchor — using the JS UTC ISO string here would mis-bucket messages
// near midnight in non-UTC tenant timezones.
function toTenantYMD(ts, tz) {
    const d = (ts instanceof Date) ? ts : new Date(ts);
    if (isNaN(d.getTime())) return null;
    return formatYMDInTz(d, tz || DEFAULT_TZ);
}
function toTenantYM(ts, tz) {
    const ymd = toTenantYMD(ts, tz);
    return ymd ? ymd.substring(0, 7) : null;
}
function addMonths(year, month, delta) {
    const idx = year * 12 + (month - 1) + delta;
    return { year: Math.floor(idx / 12), month: ((idx % 12) + 12) % 12 + 1 };
}
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function expandMonthRangeParts(s, e) {
    if (!s || !e) return [];
    let a = s, b = e;
    if (a.year > b.year || (a.year === b.year && a.month > b.month)) [a, b] = [b, a];
    const out = [];
    let y = a.year, m = a.month;
    while (y < b.year || (y === b.year && m <= b.month)) {
        out.push(ymPad(y, m));
        const nx = addMonths(y, m, 1);
        y = nx.year; m = nx.month;
    }
    return out;
}
function expandDayRangeParts(s, e) {
    if (!s || !e) return [];
    let a = s, b = e;
    const cmp = (x, y) => x.year - y.year || x.month - y.month || x.day - y.day;
    if (cmp(a, b) > 0) [a, b] = [b, a];
    const out = [];
    let y = a.year, m = a.month, d = a.day;
    // Iterate via UTC arithmetic — DST-safe for date-only iteration since
    // we're just consuming UTC midnight ticks then projecting back to YMD.
    while (y < b.year ||
           (y === b.year && m < b.month) ||
           (y === b.year && m === b.month && d <= b.day)) {
        out.push(ymdPad(y, m, d));
        const next = new Date(Date.UTC(y, m - 1, d + 1));
        y = next.getUTCFullYear();
        m = next.getUTCMonth() + 1;
        d = next.getUTCDate();
    }
    return out;
}
function windowToPatterns(win) {
    if (!win) return { datePatterns: [], dayPatterns: [] };
    const dayPatterns = win.dayPrecision
        ? expandDayRangeParts(win.startParts, win.endParts)
        : [];
    const datePatterns = expandMonthRangeParts(
        { year: win.startParts.year, month: win.startParts.month },
        { year: win.endParts.year, month: win.endParts.month }
    );
    return { datePatterns, dayPatterns };
}

// ── ABSOLUTE EXTRACTOR ───────────────────────────────────────────────
// Behavioural twin of the previous audit-context.extractDatePatterns. Moved
// here so the resolver is the single source of truth. All existing
// test-audit-date-patterns.js cases are expected to keep passing unchanged.
function _parseEndpointText(text) {
    const t = text.trim().toLowerCase();
    const isoMatch = t.match(/^(\d{4})-(\d{1,2})$/);
    if (isoMatch) {
        const yr = parseInt(isoMatch[1], 10);
        const mo = parseInt(isoMatch[2], 10);
        if (yr >= 1900 && yr <= 2099 && mo >= 1 && mo <= 12) return { year: yr, month: mo };
        return null;
    }
    for (let i = 0; i < 12; i++) {
        const variants = [..._ALL_MONTH_NAMES[i], ...MONTH_ABBREVS[i]];
        const re = new RegExp(`^(?:${variants.join('|')})[\\s,./_-]*(\\d{4})$`);
        const m = t.match(re);
        if (m) {
            const yr = parseInt(m[1], 10);
            if (yr >= 1900 && yr <= 2099) return { year: yr, month: i + 1 };
            return null;
        }
    }
    const yMatch = t.match(/^(\d{4})$/);
    if (yMatch) {
        const yr = parseInt(yMatch[1], 10);
        if (yr >= 1900 && yr <= 2099) return { year: yr, month: null };
    }
    return null;
}
function _expandMonthRangeRaw(a, b) {
    if (!a || !b) return [];
    const aMo = a.month != null ? a.month : 1;
    const bMo = b.month != null ? b.month : 1;
    let earlier, later;
    if (a.year < b.year || (a.year === b.year && aMo <= bMo)) {
        earlier = a; later = b;
    } else {
        earlier = b; later = a;
    }
    const startMo = earlier.month != null ? earlier.month : 1;
    const endMo   = later.month   != null ? later.month   : 12;
    const out = [];
    let y = earlier.year;
    let m = startMo;
    while (y < later.year || (y === later.year && m <= endMo)) {
        out.push(ymPad(y, m));
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return out;
}

function extractAbsolutePatterns(query) {
    if (!query || typeof query !== 'string') return [];
    let queryLower = query.toLowerCase();
    let queryOrig  = query;
    const patternSet = new Set();

    const maskRange = (start, end) => {
        const len = end - start;
        const spaces = ' '.repeat(len);
        queryLower = queryLower.substring(0, start) + spaces + queryLower.substring(end);
        queryOrig  = queryOrig.substring(0, start)  + spaces + queryOrig.substring(end);
    };

    // STEP 0a — RANGES
    const monthAlt = _MONTH_ALT;
    const endpointStr = `(?:(?:${monthAlt})[\\s,./_-]*\\d{4}|\\d{4}-\\d{1,2}|\\d{4})`;
    const rangeRegexes = [
        new RegExp(`\\b(?:antara|between)\\s+(${endpointStr})\\s+(?:dan|and)\\s+(${endpointStr})\\b`, 'gi'),
        new RegExp(`\\b(?:from|dari)\\s+(${endpointStr})\\s+(?:to|until|sampai|hingga)\\s+(${endpointStr})\\b`, 'gi'),
        new RegExp(`\\b(${endpointStr})\\s+(?:to|until|sampai|hingga)\\s+(${endpointStr})\\b`, 'gi'),
    ];
    for (const re of rangeRegexes) {
        re.lastIndex = 0;
        let rm;
        while ((rm = re.exec(queryLower)) !== null) {
            const start = _parseEndpointText(rm[1]);
            const end   = _parseEndpointText(rm[2]);
            if (!start || !end) continue;
            for (const ymPrefix of _expandMonthRangeRaw(start, end)) patternSet.add(ymPrefix);
            maskRange(rm.index, rm.index + rm[0].length);
        }
    }

    // STEP 0b — QUARTERS
    const quarterRe = /\bQ([1-4])[\s,./_-]*(\d{4})\b/gi;
    let qm;
    while ((qm = quarterRe.exec(queryLower)) !== null) {
        const q = parseInt(qm[1], 10);
        const year = parseInt(qm[2], 10);
        if (year < 1900 || year > 2099) continue;
        const startMo = (q - 1) * 3 + 1;
        for (let mo = startMo; mo < startMo + 3; mo++) {
            patternSet.add(ymPad(year, mo));
        }
        maskRange(qm.index, qm.index + qm[0].length);
    }

    // STEP 1 — month + year
    const monthYearWordsToMark = [];
    for (let i = 0; i < 12; i++) {
        const variants = [..._ALL_MONTH_NAMES[i], ...MONTH_ABBREVS[i]];
        const regex = new RegExp(`\\b(${variants.join('|')})[\\s,./_-]*(\\d{4})\\b`, 'gi');
        let m;
        while ((m = regex.exec(queryLower)) !== null) {
            const monthNum = String(i + 1).padStart(2, '0');
            patternSet.add(`${m[2]}-${monthNum}`);
            const yearStartInMatch = m[0].lastIndexOf(m[2]);
            monthYearWordsToMark.push({
                start: m.index + yearStartInMatch,
                end:   m.index + yearStartInMatch + 4
            });
        }
    }

    // STEP 2 — ISO YYYY-MM
    const isoRe = /(\d{4})-(\d{1,2})\b/g;
    let isoMatch;
    while ((isoMatch = isoRe.exec(queryLower)) !== null) {
        const mo = parseInt(isoMatch[2], 10);
        if (mo < 1 || mo > 12) continue;
        patternSet.add(`${isoMatch[1]}-${String(mo).padStart(2, '0')}`);
    }

    // STEP 3 — explicit year-only prefixes
    const yearsExplicit = new Set();
    const explicitYearRe = /\b(?:tahun|thn|taun|in|year|during|for|of|untuk)\s+(\d{4})\b/gi;
    let ym;
    while ((ym = explicitYearRe.exec(queryLower)) !== null) {
        const y = parseInt(ym[1], 10);
        if (y >= 1900 && y <= 2099) yearsExplicit.add(ym[1]);
    }

    // STEP 4 — bare 4-digit year (with plate guard)
    const bareYearRe = /\b(\d{4})\b/g;
    let bm;
    while ((bm = bareYearRe.exec(queryOrig)) !== null) {
        const yearStr = bm[1];
        const year = parseInt(yearStr, 10);
        if (year < 1900 || year > 2099) continue;
        const startIdx = bm.index;
        const endIdx = startIdx + yearStr.length;
        if (monthYearWordsToMark.some(r => r.start === startIdx && r.end === endIdx)) continue;
        if (queryOrig[endIdx] === '-' && /\d/.test(queryOrig[endIdx + 1] || '')) continue;
        if (/\d/.test(queryOrig[startIdx - 1] || '')) continue;
        if (/\d/.test(queryOrig[endIdx] || '')) continue;
        const beforeOrig = queryOrig.substring(Math.max(0, startIdx - 8), startIdx);
        const afterOrig = queryOrig.substring(endIdx, Math.min(queryOrig.length, endIdx + 8));
        const plateBefore = /(?:^|[^A-Za-z])[A-Za-z]{1,2}\s+$/.test(beforeOrig);
        const plateAfter = /^\s+[A-Za-z]{1,3}(?=$|[^A-Za-z])/.test(afterOrig);
        if (plateBefore && plateAfter) continue;
        yearsExplicit.add(yearStr);
    }

    // STEP 5 — expand bare-year mentions to all 12 months
    for (const year of yearsExplicit) {
        for (let mo = 1; mo <= 12; mo++) {
            patternSet.add(ymPad(parseInt(year, 10), mo));
        }
    }

    return Array.from(patternSet);
}

// ── RELATIVE EXTRACTOR ───────────────────────────────────────────────
function unitWindow(unit, offset, todayParts) {
    const { year: y, month: m, day: d } = todayParts;
    if (unit === 'day') {
        const next = new Date(Date.UTC(y, m - 1, d + offset));
        const p = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
        return { startParts: p, endParts: p, dayPrecision: true };
    }
    if (unit === 'week') {
        // ISO week: Monday = start of week.
        const utc = new Date(Date.UTC(y, m - 1, d));
        const dow = (utc.getUTCDay() + 6) % 7; // Mon=0..Sun=6
        const monStart = new Date(Date.UTC(y, m - 1, d - dow + offset * 7));
        const sunEnd   = new Date(Date.UTC(y, m - 1, d - dow + offset * 7 + 6));
        return {
            startParts: { year: monStart.getUTCFullYear(), month: monStart.getUTCMonth() + 1, day: monStart.getUTCDate() },
            endParts:   { year: sunEnd.getUTCFullYear(),   month: sunEnd.getUTCMonth() + 1,   day: sunEnd.getUTCDate() },
            dayPrecision: true
        };
    }
    if (unit === 'month') {
        const t = addMonths(y, m, offset);
        return {
            startParts: { year: t.year, month: t.month, day: 1 },
            endParts:   { year: t.year, month: t.month, day: daysInMonth(t.year, t.month) },
            dayPrecision: false
        };
    }
    if (unit === 'quarter') {
        const currentQ = Math.ceil(m / 3);
        const targetQIdx = (currentQ - 1) + offset;
        const targetYear = y + Math.floor(targetQIdx / 4);
        const targetQ = ((targetQIdx % 4) + 4) % 4 + 1;
        const startMo = (targetQ - 1) * 3 + 1;
        const endMo = startMo + 2;
        return {
            startParts: { year: targetYear, month: startMo, day: 1 },
            endParts:   { year: targetYear, month: endMo, day: daysInMonth(targetYear, endMo) },
            dayPrecision: false
        };
    }
    if (unit === 'year') {
        const targetYear = y + offset;
        return {
            startParts: { year: targetYear, month: 1, day: 1 },
            endParts:   { year: targetYear, month: 12, day: 31 },
            dayPrecision: false
        };
    }
    return null;
}

// "last N {unit}" — N units ending today (inclusive)
function lastNWindow(unit, n, todayParts) {
    const { year: y, month: m, day: d } = todayParts;
    if (unit === 'day') {
        const start = new Date(Date.UTC(y, m - 1, d - (n - 1)));
        return {
            startParts: { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() },
            endParts:   todayParts,
            dayPrecision: true
        };
    }
    if (unit === 'week') {
        const start = new Date(Date.UTC(y, m - 1, d - (n * 7 - 1)));
        return {
            startParts: { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() },
            endParts:   todayParts,
            dayPrecision: true
        };
    }
    if (unit === 'month') {
        const start = addMonths(y, m, -(n - 1));
        return {
            startParts: { year: start.year, month: start.month, day: 1 },
            endParts:   { year: y, month: m, day: daysInMonth(y, m) },
            dayPrecision: false
        };
    }
    if (unit === 'quarter') {
        const currentQ = Math.ceil(m / 3);
        const startQIdx = (currentQ - 1) - (n - 1);
        const startYear = y + Math.floor(startQIdx / 4);
        const startQ = ((startQIdx % 4) + 4) % 4 + 1;
        const startMo = (startQ - 1) * 3 + 1;
        const endMo = (currentQ - 1) * 3 + 3;
        return {
            startParts: { year: startYear, month: startMo, day: 1 },
            endParts:   { year: y, month: endMo, day: daysInMonth(y, endMo) },
            dayPrecision: false
        };
    }
    if (unit === 'year') {
        return {
            startParts: { year: y - (n - 1), month: 1, day: 1 },
            endParts:   { year: y, month: 12, day: 31 },
            dayPrecision: false
        };
    }
    return null;
}

// "N {unit} ago" / "N {unit} lalu" — single point unit, N back from current
function nUnitsAgoWindow(unit, n, todayParts) {
    return unitWindow(unit, -n, todayParts);
}

function extractRelativePatterns(query, todayParts) {
    if (!query || typeof query !== 'string') {
        return { datePatterns: [], dayPatterns: [], matched: [] };
    }
    const q = query.toLowerCase();
    const allDate = new Set();
    const allDay = new Set();
    const matched = [];
    const consume = (label, win) => {
        if (!win) return;
        const { datePatterns, dayPatterns } = windowToPatterns(win);
        datePatterns.forEach(p => allDate.add(p));
        dayPatterns.forEach(p => allDay.add(p));
        matched.push(label);
    };

    // Day-before-yesterday must precede plain yesterday/kemarin.
    // Each locale owns its own regex fragment; a locale whose dby pattern also
    // subsumes the yesterday pattern (e.g. "kemarin lusa" contains "kemarin")
    // suppresses the yesterday match for that locale.
    for (const locale of LOCALE_REGISTRY) {
        if (locale.dayBeforeYesterdayRegex &&
            new RegExp(`\\b(?:${locale.dayBeforeYesterdayRegex})\\b`).test(q)) {
            consume(locale.dayBeforeYesterdayLabel || 'day before yesterday',
                    unitWindow('day', -2, todayParts));
        }
    }
    for (const locale of LOCALE_REGISTRY) {
        if (!locale.yesterdayRegex) continue;
        if (!new RegExp(`\\b(?:${locale.yesterdayRegex})\\b`).test(q)) continue;
        // Skip if the locale's day-before-yesterday pattern also fires (it
        // subsumes the yesterday word — e.g. "kemarin lusa" ⊇ "kemarin").
        const dbyBlocks = locale.dayBeforeYesterdayRegex &&
            new RegExp(`\\b(?:${locale.dayBeforeYesterdayRegex})\\b`).test(q);
        if (!dbyBlocks) consume('yesterday', unitWindow('day', -1, todayParts));
    }
    for (const locale of LOCALE_REGISTRY) {
        if (locale.todayRegex && new RegExp(`\\b(?:${locale.todayRegex})\\b`).test(q)) {
            consume('today', unitWindow('day', 0, todayParts));
        }
    }

    let m;

    // ── Suffix-style: "{unit} {word}" — Indonesian ("bulan lalu", "tahun ini")
    // Skip when preceded by "<digits> " — the longer "N {unit} lalu/terakhir"
    // form below owns those (so "2 bulan lalu" is point=2-months-ago, NOT
    // double-matched as also "bulan lalu" = 1-month-ago).
    for (const locale of LOCALE_REGISTRY) {
        const { unitSuffixMap } = locale.relFragments;
        if (!unitSuffixMap) continue;
        const suffixes = Object.keys(unitSuffixMap).join('|');
        const re = new RegExp(`\\b(${UNIT_RX})\\s+(${suffixes})\\b`, 'g');
        while ((m = re.exec(q)) !== null) {
            const before = q.substring(Math.max(0, m.index - 12), m.index);
            if (/\d+\s+$/.test(before)) continue;
            const unit = REL_UNIT[m[1]];
            if (!unit) continue;
            const offset = unitSuffixMap[m[2]];
            if (offset === undefined) continue;
            // Preserve the original captured phrase in matchedPhrases so
            // tests can see the literal locale token (e.g. "bulan lalu").
            consume(`${m[1]} ${m[2]}`, unitWindow(unit, offset, todayParts));
        }
    }

    // ── Prefix-style: "{word} {unit}" — English ("last month", "this quarter")
    // Same digit-prefix guard: "last 3 months" won't fit this regex anyway
    // since it has a digit between "last" and "month".
    for (const locale of LOCALE_REGISTRY) {
        const { unitPrefixMap } = locale.relFragments;
        if (!unitPrefixMap) continue;
        const prefixes = Object.keys(unitPrefixMap).join('|');
        const re = new RegExp(`\\b(${prefixes})\\s+(${UNIT_RX})\\b`, 'g');
        while ((m = re.exec(q)) !== null) {
            const which = m[1];
            const unit = REL_UNIT[m[2]];
            if (!unit) continue;
            const offset = unitPrefixMap[which];
            if (offset === undefined) continue;
            consume(`${which} ${m[2]}`, unitWindow(unit, offset, todayParts));
        }
    }

    // ── N-unit suffix (ID): "N {unit} terakhir" / "N {unit} (yang) lalu"
    for (const locale of LOCALE_REGISTRY) {
        const { lastNSuffixLastN, lastNSuffixNAgo } = locale.relFragments;
        if (!lastNSuffixLastN && !lastNSuffixNAgo) continue;
        const suffixAlt = [lastNSuffixLastN, lastNSuffixNAgo].filter(Boolean).join('|');
        const re = new RegExp(`\\b(\\d+)\\s+(${UNIT_RX})\\s+(${suffixAlt})\\b`, 'g');
        while ((m = re.exec(q)) !== null) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 1000) continue;
            const unit = REL_UNIT[m[2]];
            if (!unit) continue;
            const which = m[3];
            if (lastNSuffixLastN && new RegExp(`^(?:${lastNSuffixLastN})`).test(which)) {
                consume(`${n} ${unit} terakhir`, lastNWindow(unit, n, todayParts));
            } else if (lastNSuffixNAgo) {
                consume(`${n} ${unit} lalu`, nUnitsAgoWindow(unit, n, todayParts));
            }
        }
    }

    // ── N-unit prefix (EN): "last/past/… N {unit}"
    for (const locale of LOCALE_REGISTRY) {
        const { lastNPrefix } = locale.relFragments;
        if (!lastNPrefix) continue;
        const re = new RegExp(
            `\\b(?:${lastNPrefix})\\s+(\\d+)\\s+(${UNIT_RX})\\b`,
            'g'
        );
        while ((m = re.exec(q)) !== null) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 1000) continue;
            const unit = REL_UNIT[m[2]];
            if (!unit) continue;
            consume(`last ${n} ${unit}`, lastNWindow(unit, n, todayParts));
        }
    }

    // ── Ago suffix (EN): "N {unit} ago"
    for (const locale of LOCALE_REGISTRY) {
        const { agoSuffix } = locale.relFragments;
        if (!agoSuffix) continue;
        const re = new RegExp(`\\b(\\d+)\\s+(${UNIT_RX})\\s+${agoSuffix}\\b`, 'g');
        while ((m = re.exec(q)) !== null) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 1000) continue;
            const unit = REL_UNIT[m[2]];
            if (!unit) continue;
            consume(`${n} ${unit} ago`, nUnitsAgoWindow(unit, n, todayParts));
        }
    }

    // ── XTD aliases (combined from all locales at boot)
    if (_ytdRe.test(q)) {
        consume('YTD', {
            startParts: { year: todayParts.year, month: 1, day: 1 },
            endParts: todayParts,
            dayPrecision: false
        });
    }
    if (_mtdRe.test(q)) {
        consume('MTD', {
            startParts: { year: todayParts.year, month: todayParts.month, day: 1 },
            endParts: todayParts,
            dayPrecision: false
        });
    }
    if (_qtdRe.test(q)) {
        const currentQ = Math.ceil(todayParts.month / 3);
        const startMo = (currentQ - 1) * 3 + 1;
        consume('QTD', {
            startParts: { year: todayParts.year, month: startMo, day: 1 },
            endParts: todayParts,
            dayPrecision: false
        });
    }

    // ── "sejak X" / "since X" → open-ended through today
    const monthAlt = _MONTH_ALT;
    const sinceEndpointStr = `(?:(?:${monthAlt})[\\s,./_-]*\\d{4}|\\d{4}-\\d{1,2}|\\d{4})`;
    const sinceRe = new RegExp(`\\b(?:sejak|since)\\s+(${sinceEndpointStr})\\b`, 'gi');
    while ((m = sinceRe.exec(q)) !== null) {
        const start = _parseEndpointText(m[1]);
        if (!start) continue;
        const startMonth = start.month != null ? start.month : 1;
        consume(`since ${m[1]}`, {
            startParts: { year: start.year, month: startMonth, day: 1 },
            endParts: todayParts,
            dayPrecision: false
        });
    }

    return {
        datePatterns: [...allDate],
        dayPatterns: [...allDay],
        matched
    };
}

// ── PUBLIC API ───────────────────────────────────────────────────────
function getTemporalContext({ now, tz } = {}) {
    const nowDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    const tenantTz = tz || DEFAULT_TZ;
    const todayParts = partsInTz(nowDate, tenantTz);
    return {
        now: nowDate,
        tz: tenantTz,
        todayLocalISO: ymdPad(todayParts.year, todayParts.month, todayParts.day),
        currentYM: ymPad(todayParts.year, todayParts.month),
        currentYMD: ymdPad(todayParts.year, todayParts.month, todayParts.day),
        todayParts
    };
}

function resolveTemporalScope(query, { now, tz } = {}) {
    const ctx = getTemporalContext({ now, tz });
    const absolute = extractAbsolutePatterns(query || '');
    const relative = extractRelativePatterns(query || '', ctx.todayParts);
    const datePatterns = [...new Set([...absolute, ...relative.datePatterns])];
    const dayPatterns = [...new Set(relative.dayPatterns)];
    return {
        datePatterns,
        dayPatterns,
        hasTemporal: datePatterns.length > 0 || dayPatterns.length > 0,
        matchedPhrases: relative.matched,
        context: ctx
    };
}

// Backward-compat shim — the previous extractDatePatterns(query) signature
// is preserved exactly. New callers may pass { now, tz } as a 2nd argument.
function extractDatePatterns(query, opts) {
    return resolveTemporalScope(query, opts || {}).datePatterns;
}

module.exports = {
    DEFAULT_TZ,
    MONTH_NAMES_EN,
    MONTH_NAMES_ID,
    MONTH_ABBREVS,
    getTemporalContext,
    resolveTemporalScope,
    extractDatePatterns,
    toTenantYMD,
    toTenantYM,
    // Internals exposed for unit tests
    _internals: {
        LOCALE_REGISTRY,
        partsInTz,
        addMonths,
        daysInMonth,
        expandMonthRangeParts,
        expandDayRangeParts,
        unitWindow,
        lastNWindow,
        nUnitsAgoWindow,
        extractAbsolutePatterns,
        extractRelativePatterns,
        windowToPatterns
    }
};
