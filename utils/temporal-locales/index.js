'use strict';

/**
 * Locale registry — the ONLY file that needs editing when adding a new locale.
 *
 * Steps to add a language:
 *   1. Create `utils/temporal-locales/<code>.js` following the shape in en.js.
 *   2. Add one require() line below.
 *   3. Done — no changes to temporal-resolver.js or any other file required.
 */
module.exports = [
    require('./en'),
    require('./id'),
];
