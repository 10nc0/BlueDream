/**
 * QUERY SCOPE — independent intent extraction for audit verification.
 *
 * Separate from buildCapsuleChain so the verifier can re-derive the user's
 * requested scope WITHOUT trusting the same chain that produced the LLM's
 * working set. If the chain has a filter gap (e.g. Task #169's year-only
 * regression, or any relative-time-phrase blind-spot), the verifier still
 * detects when the LLM's count covers a broader scope than the query asked.
 *
 * Temporal dimensions come from `./temporal-resolver` so absolute, relative,
 * and combined "when" phrases (kemarin, bulan lalu, last 3 months, YTD, …)
 * all expand the same way the LLM-side prompt uses them.
 *
 * ── Sender shapes ──────────────────────────────────────────────────────────
 *
 * `extractSendersFromQuery` recognises five sender shapes. Each entry in the
 * returned `senders` array is an object:
 *
 *   { raw: string, normalized: string, shape: string }
 *
 * Supported shapes and their match semantics:
 *
 *   shape        example token          message-side match
 *   ────────     ─────────────────────  ───────────────────────────────────────
 *   email        john@acme.com          lowercase-exact against sender field
 *   handle       @alice                 strip leading @, lowercase-exact
 *   line_uid     Uf0123456789abcdef…    lowercase-exact (U + 32 hex chars)
 *   snowflake    123456789012345678     exact string (17–19 digit Discord id)
 *   phone        +62812345678           digit-strip, suffix-or-exact match
 *
 * To add a new shape: append one entry to SENDER_SHAPE_REGISTRY below.
 * Each entry must supply:
 *   name       – shape tag string
 *   queryRegex – regex (no flags) used to scan the query string
 *   normalize  – fn(rawToken) → canonical string stored in `normalized`
 *   matches    – fn(messageField, normalizedQueryToken) → boolean
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Returns (parseQueryScope):
 *   {
 *     datePatterns:    string[]   YYYY-MM prefixes (broad/month-precision)
 *     dayPatterns:     string[]   YYYY-MM-DD prefixes (only for day-precision
 *                                  phrases — kemarin/today/last 7 days/etc.)
 *     actionKeywords:  string[]   e.g. ['perbaikan', 'servis', ...]
 *     plates:          string[]   normalized plates explicitly named in query
 *     senders:         Array<{ raw: string, normalized: string, shape: string }>
 *     hasAny:          boolean    true iff any dimension above is non-empty
 *   }
 */

'use strict';

const { resolveTemporalScope, toTenantYMD, toTenantYM, DEFAULT_TZ } = require('./temporal-resolver');
const { ACTION_KEYWORDS, PLATE_REGEX } = require('./capsule-chain');

/* ── backward-compat export kept for callers that imported PHONE_REGEX ── */
const PHONE_REGEX = /\+?\d{8,15}/;

/* ── Sender shape registry ──────────────────────────────────────────────── */

/**
 * Each entry is evaluated left-to-right. A token that matches an earlier
 * shape does NOT fall through to later shapes, so more-specific patterns
 * must appear before less-specific ones.
 *
 * Order: email → handle → line_uid → snowflake → phone
 *   email/handle are structurally distinct (contain @).
 *   line_uid starts with U + 32 hex chars — unambiguous.
 *   snowflake is 17–19 pure digits (above phone's 8–15 ceiling).
 *   phone catches the remaining 8–15 digit tokens.
 */
const SENDER_SHAPE_REGISTRY = [
    {
        name: 'email',
        queryRegex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
        normalize: tok => tok.toLowerCase(),
        matches(field, norm) {
            return String(field).toLowerCase() === norm;
        }
    },
    {
        name: 'handle',
        queryRegex: /@[a-zA-Z0-9_]{1,64}/,
        normalize: tok => tok.replace(/^@/, '').toLowerCase(),
        matches(field, norm) {
            return String(field).replace(/^@/, '').toLowerCase() === norm;
        }
    },
    {
        name: 'line_uid',
        queryRegex: /U[0-9a-fA-F]{32}/,
        normalize: tok => tok.toLowerCase(),
        matches(field, norm) {
            return String(field).toLowerCase() === norm;
        }
    },
    {
        name: 'snowflake',
        queryRegex: /\d{17,19}/,
        normalize: tok => tok,
        matches(field, norm) {
            return String(field).replace(/\D/g, '') === norm;
        }
    },
    {
        name: 'phone',
        queryRegex: /\+?\d{8,15}/,
        normalize: tok => tok.replace(/\D/g, ''),
        matches(field, norm) {
            const digits = String(field).replace(/\D/g, '');
            return digits === norm || digits.endsWith(norm);
        }
    }
];

/* ── Helpers ────────────────────────────────────────────────────────────── */

function normalizePlate(raw) {
    return raw.replace(/\s+/g, ' ').toUpperCase().trim();
}

function extractPlatesFromQuery(query) {
    if (!query || typeof query !== 'string') return [];
    const out = [];
    const re = new RegExp(PLATE_REGEX.source, 'gi');
    let m;
    while ((m = re.exec(query)) !== null) {
        out.push(normalizePlate(m[0]));
    }
    return [...new Set(out)];
}

function extractActionKeywordsFromQuery(query) {
    if (!query || typeof query !== 'string') return [];
    const queryLower = query.toLowerCase();
    const found = new Set();
    for (const [, kws] of Object.entries(ACTION_KEYWORDS)) {
        for (const kw of kws) {
            if (queryLower.includes(kw)) {
                for (const k of kws) found.add(k);
                break;
            }
        }
    }
    return [...found];
}

/**
 * Extract sender tokens from a query string.
 * Iterates SENDER_SHAPE_REGISTRY left-to-right so more-specific shapes win.
 * Uses character-position claiming: once a character index is owned by an
 * earlier shape, any later-shape match that overlaps that range is skipped.
 * This prevents e.g. `@acme` from being extracted separately after the email
 * shape has already claimed `john@acme.com`, or digit sub-runs from being
 * extracted as phone tokens after a LINE uid or snowflake claimed them.
 * Returns an array of { raw, normalized, shape } objects.
 */
function extractSendersFromQuery(query) {
    if (!query || typeof query !== 'string') return [];

    const claimed = new Set(); // character positions already owned by a match
    const out = [];

    for (const shapeDef of SENDER_SHAPE_REGISTRY) {
        const re = new RegExp(shapeDef.queryRegex.source, 'g');
        let m;
        while ((m = re.exec(query)) !== null) {
            const start = m.index;
            const end   = m.index + m[0].length;

            /* Skip if any character in this match is already claimed. */
            let overlaps = false;
            for (let i = start; i < end; i++) {
                if (claimed.has(i)) { overlaps = true; break; }
            }
            if (overlaps) continue;

            for (let i = start; i < end; i++) claimed.add(i);

            const raw = m[0];
            out.push({
                raw,
                normalized: shapeDef.normalize(raw),
                shape: shapeDef.name
            });
        }
    }

    return out;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

function parseQueryScope(query, opts = {}) {
    const temporal = resolveTemporalScope(query, { now: opts.now, tz: opts.tz });
    const datePatterns = temporal.datePatterns || [];
    const dayPatterns = temporal.dayPatterns || [];
    const actionKeywords = extractActionKeywordsFromQuery(query);
    const plates = extractPlatesFromQuery(query);
    const senders = extractSendersFromQuery(query);
    const hasAny = datePatterns.length > 0
                   || dayPatterns.length > 0
                   || actionKeywords.length > 0
                   || plates.length > 0
                   || senders.length > 0;
    return {
        datePatterns,
        dayPatterns,
        actionKeywords,
        plates,
        senders,
        hasAny,
        temporalContext: temporal.context,
        matchedTemporalPhrases: temporal.matchedPhrases || []
    };
}

/**
 * Test a single message-like object against a parsed scope.
 *   - Day precision wins when present: msg's YYYY-MM-DD must equal one of
 *     scope.dayPatterns. This is the strict path used for "kemarin", "today",
 *     "last 7 days" etc. — datePatterns are NOT consulted because day-precision
 *     phrases by construction subsume any month-bucket they might overlap.
 *   - Otherwise: msg's YYYY-MM prefix must startsWith one of scope.datePatterns.
 *   - actionKeywords: msg.content (or .preview) must include at least one.
 *   - senders: the message's sender field is tested against each scope sender
 *     using its shape's matches() function; passes on the first hit.
 *     Each shape defines its own normalization and comparison semantics
 *     (see SENDER_SHAPE_REGISTRY above).
 * Empty scope dimensions are no-ops (don't filter).
 * Returns true iff message matches ALL non-empty dimensions.
 */
function messageMatchesScope(msg, scope) {
    if (!scope || !scope.hasAny) return true;
    if (!msg) return false;

    const hasDay = scope.dayPatterns && scope.dayPatterns.length > 0;
    const hasMonth = scope.datePatterns && scope.datePatterns.length > 0;

    if (hasDay || hasMonth) {
        const tz = (scope.temporalContext && scope.temporalContext.tz) || DEFAULT_TZ;
        const ts = msg.timestamp || msg.createdAt || '';
        if (!ts) return false;

        if (hasDay) {
            const ymd = toTenantYMD(ts, tz);
            if (!ymd || !scope.dayPatterns.includes(ymd)) return false;
        } else {
            const ym = toTenantYM(ts, tz);
            if (!ym || !scope.datePatterns.some(p => ym.startsWith(p))) return false;
        }
    }

    if (scope.actionKeywords && scope.actionKeywords.length > 0) {
        const content = (msg.content || msg.text || msg.preview || '').toLowerCase();
        if (!scope.actionKeywords.some(kw => content.includes(kw))) return false;
    }

    if (scope.senders && scope.senders.length > 0) {
        const senderField = String(msg.from || msg.sender || msg.phone || msg.author || '');
        if (!senderField) return false;

        const matched = scope.senders.some(({ normalized, shape }) => {
            const shapeDef = SENDER_SHAPE_REGISTRY.find(s => s.name === shape);
            if (!shapeDef) return false;
            return shapeDef.matches(senderField, normalized);
        });
        if (!matched) return false;
    }

    return true;
}

module.exports = {
    parseQueryScope,
    messageMatchesScope,
    extractActionKeywordsFromQuery,
    extractPlatesFromQuery,
    extractSendersFromQuery,
    normalizePlate,
    PHONE_REGEX,
    SENDER_SHAPE_REGISTRY
};
