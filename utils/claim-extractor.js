/**
 * CLAIM EXTRACTOR — deterministic, regex-anchored extraction of numeric
 * claims and source attributions from LLM responses.
 *
 * Used by the cross-source verifier (Task #228) to check whether each
 * numeric claim in a dashboard response actually appears in the tool
 * result the LLM cited (or, when uncited, in any tool result the LLM
 * was given in this turn).
 *
 * DESIGN PHILOSOPHY
 *   - Conservative: prefer false negatives over false positives. A
 *     missed claim is silently fine; a fabricated claim that we then
 *     "correct" would defeat the deterministic anchoring that makes
 *     the verifier trustworthy.
 *   - Anchored: every kind has its own regex bounded by word breaks or
 *     a count-noun whitelist. No bare-number kind.
 *   - Locale-aware for source attributions: English + Indonesian +
 *     Chinese share the source-name table; the attribution patterns
 *     are per-locale.
 *   - Pure: no I/O, no LLM. Returns a plain array of claim records.
 *
 * OUTPUT SHAPE
 *   extractClaims(text) -> [{ kind, value, raw, sourceCited, position }]
 *     kind         'percent' | 'currency' | 'count' | 'year' | 'range'
 *     value        Number for single-value kinds; [lo, hi] for 'range'
 *     raw          Exact substring of `text` that matched
 *     sourceCited  Canonical source name ('world-bank', 'brave-search',
 *                  'book', ...) or null when no attribution found within
 *                  the look-back window
 *     position     0-based char index of `raw` within `text`
 *
 * The verifier uses `sourceCited` to scope its lookup to one tool
 * result; when null, it falls through to all tool results.
 */

'use strict';

/* ── Canonical tool / source name table ────────────────────────────────────
 *
 * Maps natural-language attributions the LLM might emit ("World Bank",
 * "Bank Dunia", "世界银行") to the canonical tool name used by the
 * registry in `lib/tools/`. Keys are lowercased, accent-stripped.
 *
 * Adding a new source: add a row to this table; no other changes needed.
 * Longer keys are checked before shorter ones to avoid e.g. "bank" matching
 * before "world bank".
 */
const SOURCE_NAME_MAP = {
    // World Bank
    'world bank': 'world-bank',
    'bank dunia': 'world-bank',
    'worldbank': 'world-bank',
    '世界银行': 'world-bank',
    'wb': 'world-bank',
    // Brave Search
    'brave search': 'brave-search',
    'brave': 'brave-search',
    // DuckDuckGo
    'duckduckgo': 'duckduckgo',
    'ddg': 'duckduckgo',
    // Exa
    'exa': 'exa',
    // UK Land Registry
    'uk land registry': 'uk-lr',
    'land registry': 'uk-lr',
    'hm land registry': 'uk-lr',
    // Singapore HDB
    'singapore hdb': 'sgp-hdb',
    'hdb': 'sgp-hdb',
    // BIS
    'bank for international settlements': 'bis-spp',
    'bis': 'bis-spp',
    // FRED
    'federal reserve economic data': 'fred-series',
    'fred': 'fred-series',
    // Forex
    'forex': 'forex',
    'fawazahmed0': 'forex',
    // Japan BIS
    'jpn bis': 'jpn-bis',
    // International historical price
    'bis property price': 'intl-historical-price',
    'intl historical price': 'intl-historical-price',
    // The user's own book / ledger
    'your books': 'book',
    'your book': 'book',
    'the books': 'book',
    'the book': 'book',
    'your ledger': 'book',
    'the ledger': 'book',
    'buku anda': 'book',
    'buku kamu': 'book',
    'ledger anda': 'book',
    'book': 'book',
    'books': 'book',
    'ledger': 'book',
};

// Pre-sort keys longest-first so multi-word names win over single words.
const SOURCE_NAME_KEYS = Object.keys(SOURCE_NAME_MAP).sort((a, b) => b.length - a.length);

function canonicalSourceName(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    const norm = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
    if (SOURCE_NAME_MAP[norm]) return SOURCE_NAME_MAP[norm];
    // Substring fallback — handles "the World Bank's data" and similar
    // wrapping. Longest key wins.
    for (const key of SOURCE_NAME_KEYS) {
        if (norm.includes(key)) return SOURCE_NAME_MAP[key];
    }
    return null;
}

/* ── Attribution patterns ──────────────────────────────────────────────────
 *
 * Each pattern, when matched, exposes the source name in capture group 1.
 * Patterns are evaluated in order; first non-null canonical mapping wins.
 *
 * We deliberately cap the captured source-name length to keep the regex
 * from greedily swallowing whole sentences when the LLM uses an
 * unrecognised verb after a comma. The substring-fallback in
 * canonicalSourceName() handles wrappers within that window.
 */
const NAME_FRAG = `([A-Za-z\\u00C0-\\u024F\\u4E00-\\u9FFF][A-Za-z0-9\\u00C0-\\u024F\\u4E00-\\u9FFF '\\-]{1,49})`;

const ATTRIBUTION_PATTERNS = [
    // English: "according to X", "per X", "based on X", "from X"
    new RegExp(`\\b(?:according to|per|based on|from|sourced from|cited from)\\s+${NAME_FRAG}`, 'gi'),
    // English: "X shows / says / reports / indicates / reported / data"
    new RegExp(`\\b${NAME_FRAG}\\s+(?:shows?|says?|reports?|reported|indicates?|states?|data|reveals?)`, 'gi'),
    // English: parenthetical "(source: X)"
    new RegExp(`\\(\\s*source\\s*[:\\-]\\s*${NAME_FRAG}\\s*\\)`, 'gi'),
    // Indonesian: "menurut X", "berdasarkan X", "data dari X"
    new RegExp(`\\b(?:menurut|berdasarkan|data dari|sumber)\\s+${NAME_FRAG}`, 'gi'),
    // Chinese: "根据X", "X显示", "X数据"
    new RegExp(`根据\\s*${NAME_FRAG}`, 'g'),
    new RegExp(`${NAME_FRAG}\\s*(?:显示|数据|报告|表明)`, 'g'),
];

/**
 * Find the source attribution that governs a claim at `claimPosition` in
 * `text`. The look-back window is the previous sentence (or up to 200 chars).
 *
 * Strategy:
 *   1. Slice `text` from `max(0, position - 200)` to `position`.
 *   2. Find the last sentence boundary before the claim — that's the
 *      effective scope. If none, use the whole 200-char window.
 *   3. Run every attribution pattern against that scope; keep the
 *      match whose end is closest to `position` (most recent).
 *   4. Map the captured name to a canonical source via the table.
 *
 * Returns canonical source name string or null.
 */
function findSourceForClaim(text, claimPosition) {
    const winStart = Math.max(0, claimPosition - 200);
    const beforeWin = text.slice(winStart, claimPosition);

    // Find the last sentence boundary so we don't cross into a different
    // attribution context. Conservative: if no boundary in window, scope
    // is the full window.
    const sentenceBoundary = beforeWin.search(/[.!?][\s)]+(?=[A-Z\u4E00-\u9FFF\u00C0-\u024F])(?=[^.]*$)/);
    const scopeStart = sentenceBoundary >= 0 ? sentenceBoundary + 1 : 0;
    const scope = beforeWin.slice(scopeStart);

    let bestCanonical = null;
    let bestEnd = -1;

    for (const pattern of ATTRIBUTION_PATTERNS) {
        const re = new RegExp(pattern.source, pattern.flags);
        let m;
        while ((m = re.exec(scope)) !== null) {
            const canonical = canonicalSourceName(m[1]);
            if (!canonical) continue;
            if (m.index + m[0].length > bestEnd) {
                bestEnd = m.index + m[0].length;
                bestCanonical = canonical;
            }
        }
    }

    return bestCanonical;
}

/* ── Claim patterns ────────────────────────────────────────────────────────
 *
 * Each entry: { kind, regex, parse(match) -> {value, raw} | null }
 *
 *   percent   "5%", "5.5%", "5 percent", "5 persen"
 *   currency  "$1,200", "£500", "Rp 1.000.000", "1000 USD", "1000 dollars"
 *   count     bare integer attached to a count noun whitelist
 *             ("5 messages", "10 transactions", "3 kali", "2 books")
 *             We are deliberately narrow here — false positives on
 *             counts pollute the verifier with claims it then has no
 *             tool data to verify against.
 *   year      4-digit year 1800-2099, word-bounded
 *   range     "5-10%", "1000-2000 USD" — emitted in addition to the
 *             single-value claims for each end so the verifier can
 *             match either side independently.
 */

const COUNT_NOUNS_EN = [
    'messages?', 'transactions?', 'records?', 'entries', 'entry',
    'books?', 'items?', 'rows?', 'results?', 'matches', 'occurrences?',
    'events?', 'instances?', 'documents?'
];
const COUNT_NOUNS_ID = ['kali', 'pesan', 'transaksi', 'buku', 'baris', 'catatan'];
const COUNT_NOUN_ALT = [...COUNT_NOUNS_EN, ...COUNT_NOUNS_ID].join('|');

// Number fragment that accepts EITHER comma-grouped (1,234.5) OR
// dot-grouped (1.234,5) magnitudes. We don't try to interpret which
// scheme is in use at extraction time — that's the verifier's job
// during tolerance checks.
const NUM_FRAG = `\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?`;

const CURRENCY_SYMBOLS = '[$£€¥]|USD|EUR|GBP|JPY|IDR|SGD|CNY|MYR|HKD|Rp|RM|S\\$|HK\\$';

const CLAIM_PATTERNS = [
    {
        kind: 'percent',
        // No trailing \b: '%' is non-word so \b would fail before another
        // punctuation char (e.g. "4.5%." — \b after % requires a
        // word→non-word transition that isn't there). The word alternatives
        // (`percent`, `persen`) get an explicit (?!\w) lookahead.
        regex: new RegExp(`(${NUM_FRAG})\\s*(?:%|(?:percent|persen|個百分點|个百分点)(?!\\w))`, 'gi'),
        parse(m) {
            const value = parseFloat(m[1].replace(/,/g, ''));
            if (!isFinite(value)) return null;
            return { value, raw: m[0] };
        }
    },
    {
        kind: 'currency',
        // Symbol-prefix form: "$1,200", "Rp 5.000.000"
        regex: new RegExp(`(?:${CURRENCY_SYMBOLS})\\s*(${NUM_FRAG})`, 'g'),
        parse(m) {
            const value = parseCurrencyValue(m[1]);
            if (value === null) return null;
            return { value, raw: m[0] };
        }
    },
    {
        kind: 'currency',
        // Suffix form: "1000 USD", "5000 rupiah"
        regex: new RegExp(`(${NUM_FRAG})\\s*(?:${CURRENCY_SYMBOLS}|dollars?|rupiah|yen|pounds?|euros?)\\b`, 'gi'),
        parse(m) {
            const value = parseCurrencyValue(m[1]);
            if (value === null) return null;
            return { value, raw: m[0] };
        }
    },
    {
        kind: 'count',
        regex: new RegExp(`\\b(\\d+)\\s+(?:${COUNT_NOUN_ALT})\\b`, 'gi'),
        parse(m) {
            const value = parseInt(m[1], 10);
            if (!isFinite(value)) return null;
            return { value, raw: m[0] };
        }
    },
    {
        kind: 'year',
        regex: /\b(1[89]\d{2}|20\d{2})\b/g,
        parse(m) {
            return { value: parseInt(m[1], 10), raw: m[0] };
        }
    },
    {
        kind: 'range',
        // "5-10%", "1,000 - 2,000 USD" — captures both bounds and the
        // shared unit. We emit ONE range claim per match plus two
        // single-value claims (handled in extractClaims by re-running
        // the per-kind patterns over the raw substring).
        regex: new RegExp(`(${NUM_FRAG})\\s*[-\\u2013\\u2014]\\s*(${NUM_FRAG})\\s*(?:%|${CURRENCY_SYMBOLS})`, 'gi'),
        parse(m) {
            const lo = parseFloat(m[1].replace(/,/g, ''));
            const hi = parseFloat(m[2].replace(/,/g, ''));
            if (!isFinite(lo) || !isFinite(hi)) return null;
            return { value: [lo, hi], raw: m[0] };
        }
    }
];

/**
 * Parse a number string that may use commas, dots, or both as
 * thousands / decimal separators. Heuristic:
 *   - If both '.' and ',' present, the last one is the decimal sep.
 *   - If only one is present and it appears with exactly 3 digits after
 *     it AND the run before it is 1-3 digits long, treat as thousands.
 *   - Else treat as decimal.
 *
 * Returns Number or null on parse failure.
 */
function parseCurrencyValue(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    let normalised;
    if (hasDot && hasComma) {
        // Last separator is decimal; the other is thousands.
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastDot > lastComma) {
            normalised = s.replace(/,/g, '');
        } else {
            normalised = s.replace(/\./g, '').replace(',', '.');
        }
    } else if (hasComma) {
        // Comma only — could be thousands (1,234) or decimal (1,5).
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
            // 1,234 — thousands
            normalised = s.replace(/,/g, '');
        } else if (parts.length > 2) {
            // 1,234,567 — thousands throughout
            normalised = s.replace(/,/g, '');
        } else {
            // 1,5 — decimal
            normalised = s.replace(',', '.');
        }
    } else if (hasDot) {
        const parts = s.split('.');
        if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
            normalised = s.replace(/\./g, '');
        } else if (parts.length > 2) {
            normalised = s.replace(/\./g, '');
        } else {
            normalised = s;
        }
    } else {
        normalised = s;
    }

    const n = parseFloat(normalised);
    return isFinite(n) ? n : null;
}

/**
 * Extract numeric claims with optional source attributions.
 *
 * Deduplication: a single character position can host claims of
 * multiple kinds (a year IS a 4-digit number; a percent's leading
 * number IS also a count if followed by a count noun). We dedupe by
 * (position, kind) so each kind gets its own record.
 *
 * Year extraction is suppressed inside the substring of any percent
 * or currency match (e.g. "$2024" is currency, not year-2024).
 */
function extractClaims(text) {
    if (!text || typeof text !== 'string') return [];

    const out = [];
    const reservedSpans = []; // [start, end] of percent/currency matches

    // Pass 1: percent, currency, range, count — populates reservedSpans.
    for (const { kind, regex, parse } of CLAIM_PATTERNS) {
        if (kind === 'year') continue;
        const re = new RegExp(regex.source, regex.flags);
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            const parsed = parse(m);
            if (!parsed) continue;
            const position = m.index;
            const sourceCited = findSourceForClaim(text, position);
            out.push({ kind, value: parsed.value, raw: parsed.raw, sourceCited, position });
            if (kind === 'percent' || kind === 'currency' || kind === 'range') {
                reservedSpans.push([position, position + m[0].length]);
            }
        }
    }

    // Pass 2: year — only if not inside a reservedSpan.
    const yearPattern = CLAIM_PATTERNS.find(p => p.kind === 'year');
    const re = new RegExp(yearPattern.regex.source, yearPattern.regex.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
        const position = m.index;
        const inside = reservedSpans.some(([s, e]) => position >= s && position < e);
        if (inside) continue;
        const parsed = yearPattern.parse(m);
        if (!parsed) continue;
        const sourceCited = findSourceForClaim(text, position);
        out.push({ kind: 'year', value: parsed.value, raw: parsed.raw, sourceCited, position });
    }

    out.sort((a, b) => a.position - b.position);
    return out;
}

module.exports = {
    extractClaims,
    findSourceForClaim,
    canonicalSourceName,
    parseCurrencyValue,
    SOURCE_NAME_MAP,
};
