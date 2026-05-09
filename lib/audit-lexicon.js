'use strict';

/**
 * audit-lexicon.js — Single source of truth for the action + count-unit
 * vocabulary used across the audit pipeline.
 *
 * Rules:
 *  - Every word that appears in an audit regex must originate here.
 *  - The four applyCorrections sentence-shape templates are built at module
 *    load from these constants so the word lists appear exactly once.
 *  - Adding a new count unit or connector word automatically propagates to
 *    all four templates without touching audit-capsule.js.
 */

// ── Action vocabulary ──────────────────────────────────────────────────────
/**
 * ACTION_KEYWORDS — grouped by intent.  capsule-chain uses these to filter
 * messages by action type; query-scope uses them to extract scope dimensions.
 */
const ACTION_KEYWORDS = {
    repair:  ['perbaikan', 'perbaiki', 'servis', 'service', 'ganti', 'repair', 'fix', 'maintenance'],
    masuk:   ['masuk', 'datang', 'tiba', 'arrive', 'check-in', 'checkin'],
    keluar:  ['keluar', 'selesai', 'ambil', 'pick up', 'pickup', 'done', 'complete']
};

// ── Count-unit vocabulary ──────────────────────────────────────────────────
/**
 * Three tiers of count-unit alternations, ordered by permissiveness.
 * Each tier is used by the matching sentence-shape template below.
 */

// Full set — used in separator and reversed-prefix templates
// e.g.  "BA 9960 QO: 5 kali perbaikan"  /  "5 perbaikan untuk BA 9960 QO"
const COUNT_UNITS_FULL = ['kali', 'times?', 'perbaikan', 'repair'];

// Parenthetical set — used in the parens template
// e.g.  "BA 9960 QO (5 kali)"  /  "BA 9960 QO (3x)"
const COUNT_UNITS_PAREN = ['kali', 'times?', 'x'];

// Basic set — used in bare-suffix template
// e.g.  "BA 9960 QO 5 kali"
const COUNT_UNITS_BASIC = ['kali', 'times?'];

// Connector words between count and entity in the reversed-prefix template
// e.g.  "5 perbaikan untuk BA 9960 QO"
const CONNECTOR_WORDS = ['untuk', 'for'];

// ── Pre-built regex fragments ─────────────────────────────────────────────
// Exported so callers can compose claim-extraction regexes from the same
// vocabulary without duplicating the word lists.
const COUNT_UNITS_FULL_FRAG  = COUNT_UNITS_FULL.join('|');
const COUNT_UNITS_PAREN_FRAG = COUNT_UNITS_PAREN.join('|');
const COUNT_UNITS_BASIC_FRAG = COUNT_UNITS_BASIC.join('|');

const _full      = COUNT_UNITS_FULL_FRAG;
const _paren     = COUNT_UNITS_PAREN_FRAG;
const _basic     = COUNT_UNITS_BASIC_FRAG;
const _connector = `(?:${CONNECTOR_WORDS.join('|')})?`;

/**
 * buildCorrectionPatterns(entityPattern, claimedCount)
 *
 * Returns the four sentence-shape RegExp objects used by applyCorrections.
 * Both `entityPattern` and `claimedCount` are caller-supplied so the lexicon
 * pieces (word lists) live here while the per-mismatch pieces live in the
 * caller.
 *
 * Template descriptions:
 *   [0] Separator  — "BA 9960 QO: 5 kali perbaikan"
 *   [1] Parens     — "BA 9960 QO (5 kali)"
 *   [2] Suffix     — "BA 9960 QO 5 kali"
 *   [3] Prefix     — "5 perbaikan untuk BA 9960 QO"
 */
function buildCorrectionPatterns(entityPattern, claimedCount) {
    return [
        new RegExp(`(${entityPattern})\\s*[-\u2013:]\\s*${claimedCount}\\s*(${_full})`,        'gi'),
        new RegExp(`(${entityPattern})[^()]*\\(${claimedCount}\\s*(${_paren})\\)`,              'gi'),
        new RegExp(`(${entityPattern})\\s+${claimedCount}\\s*(${_basic})\\b`,                  'gi'),
        new RegExp(`${claimedCount}\\s*(${_full})\\s*${_connector}\\s*(${entityPattern})`,     'gi')
    ];
}

module.exports = {
    ACTION_KEYWORDS,
    COUNT_UNITS_FULL,
    COUNT_UNITS_PAREN,
    COUNT_UNITS_BASIC,
    COUNT_UNITS_FULL_FRAG,
    COUNT_UNITS_PAREN_FRAG,
    COUNT_UNITS_BASIC_FRAG,
    CONNECTOR_WORDS,
    buildCorrectionPatterns
};
