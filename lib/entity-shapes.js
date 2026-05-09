'use strict';

/**
 * entity-shapes.js — Single source of truth for entity-recognition regexes
 * and their associated numeric thresholds.
 *
 * All audit modules (audit-capsule, capsule-chain, entity-extractor) import
 * PLATE_REGEX from here so the pattern is defined exactly once.
 */

// ── License-plate shape ────────────────────────────────────────────────────
// Named constants for the numeric boundaries used inside the pattern so that
// changing one threshold (e.g. allowing 3-letter prefixes) only requires
// editing the constant, not the regex string.
const PLATE_PREFIX_MIN = 1;   // minimum letters before digits
const PLATE_PREFIX_MAX = 2;   // maximum letters before digits
const PLATE_DIGITS_MIN = 1;   // minimum digit characters
const PLATE_DIGITS_MAX = 4;   // maximum digit characters
const PLATE_SUFFIX_MIN = 1;   // minimum letters after digits
const PLATE_SUFFIX_MAX = 3;   // maximum letters after digits

/**
 * PLATE_SHAPE_FRAGMENT — unanchored, no capture groups, uses `\s*` between
 * parts so it matches both spaced ("BA 9960 QO") and compact ("BA9960QO") forms.
 * Use this inside larger patterns (e.g. claim-extraction regexes) to avoid
 * duplicating the numeric bounds.
 */
const PLATE_SHAPE_FRAGMENT =
    `[A-Z]{${PLATE_PREFIX_MIN},${PLATE_PREFIX_MAX}}\\s*\\d{${PLATE_DIGITS_MIN},${PLATE_DIGITS_MAX}}\\s*[A-Z]{${PLATE_SUFFIX_MIN},${PLATE_SUFFIX_MAX}}`;

/**
 * PLATE_REGEX — matches Indonesian/Malaysian-style vehicle licence plates of
 * the form:  [1–2 letters]  [1–4 digits]  [1–3 letters]
 * e.g.  "BA 9960 QO",  "B 1234 ABC",  "D 12 XY"
 *
 * The regex is stateful (lastIndex resets on every fresh exec loop).
 * Always clone via `new RegExp(PLATE_REGEX.source, 'gi')` before iterating.
 */
const PLATE_REGEX = new RegExp(
    `\\b(${PLATE_SHAPE_FRAGMENT})\\b`,
    'gi'
);

// ── Phone-number digit thresholds ─────────────────────────────────────────
const PHONE_DIGITS_MIN = 7;
const PHONE_DIGITS_MAX = 15;

module.exports = {
    PLATE_REGEX,
    PLATE_SHAPE_FRAGMENT,
    PLATE_PREFIX_MIN,
    PLATE_PREFIX_MAX,
    PLATE_DIGITS_MIN,
    PLATE_DIGITS_MAX,
    PLATE_SUFFIX_MIN,
    PLATE_SUFFIX_MAX,
    PHONE_DIGITS_MIN,
    PHONE_DIGITS_MAX
};
