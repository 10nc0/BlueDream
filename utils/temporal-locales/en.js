'use strict';

/**
 * English locale vocabulary for the temporal resolver.
 *
 * Shape contract (all fields required; null means "not applicable in this locale"):
 *   _id                  string           locale identifier
 *   monthNames           string[12]       full lowercase month names
 *   monthAbbrevs         (string[])[12]   per-position abbreviation arrays
 *   unitMap              Record<string,string>  locale unit words → canonical unit
 *   relFragments         object           regex fragment strings (not compiled)
 *     .unitPrefixMap     Record<string,number>|null  "{word} {unit}" → offset
 *     .unitSuffixMap     Record<string,number>|null  "{unit} {word}" → offset
 *     .lastNPrefix       string|null      regex alt for "last N {unit}" prefix
 *     .lastNSuffixLastN  string|null      regex alt for "N {unit} <lastN-word>"
 *     .lastNSuffixNAgo   string|null      regex alt for "N {unit} <nAgo-word>"
 *     .agoSuffix         string|null      literal suffix word for "N {unit} ago"
 *   todayRegex              string|null   \b-wrapped pattern for "today"
 *   yesterdayRegex          string|null   \b-wrapped pattern for "yesterday"
 *   dayBeforeYesterdayRegex string|null   \b-wrapped pattern for "day before yesterday"
 *   dayBeforeYesterdayLabel string         human-readable label for matchedPhrases traces
 *   xtdAliases              object        locale-specific XTD alias fragments
 *     .ytd  string|null
 *     .mtd  string|null
 *     .qtd  string|null
 *
 * Note on field naming: early planning docs used `relativeRegexes`, `todayWords`,
 * `yesterdayWords`. The implemented contract uses `relFragments` (regex fragment
 * strings, not compiled RegExps) and dedicated `*Regex` / `*Label` fields.
 * This is intentional — raw fragment strings compose better at boot without
 * carrying pre-compiled state. The `tests/test-temporal-locales.js` shape tests
 * are the authoritative contract.
 */
module.exports = {
    _id: 'en',

    monthNames: [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'
    ],

    monthAbbrevs: [
        ['jan'],
        ['feb'],
        ['mar', 'mrt'],
        ['apr'],
        [],
        ['jun'],
        ['jul'],
        ['aug'],
        ['sep', 'sept'],
        ['oct'],
        ['nov'],
        ['dec'],
    ],

    unitMap: {
        'day': 'day', 'days': 'day',
        'week': 'week', 'weeks': 'week',
        'month': 'month', 'months': 'month',
        'quarter': 'quarter', 'quarters': 'quarter',
        'year': 'year', 'years': 'year'
    },

    relFragments: {
        unitPrefixMap: { 'this': 0, 'last': -1, 'past': -1, 'previous': -1, 'next': 1 },
        unitSuffixMap: null,
        lastNPrefix: 'last|past|previous|in\\s+the\\s+(?:last|past)|over\\s+the\\s+(?:last|past)',
        lastNSuffixLastN: null,
        lastNSuffixNAgo: null,
        agoSuffix: 'ago'
    },

    todayRegex: 'today',
    yesterdayRegex: 'yesterday',
    dayBeforeYesterdayRegex: 'day\\s+before\\s+yesterday',
    dayBeforeYesterdayLabel: 'day before yesterday',

    xtdAliases: {
        ytd: 'year[\\s-]to[\\s-]date',
        mtd: 'month[\\s-]to[\\s-]date',
        qtd: 'quarter[\\s-]to[\\s-]date'
    }
};
