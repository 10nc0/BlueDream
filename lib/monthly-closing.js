'use strict';

const { PHI_BREATHE, EMAIL } = require('../config/constants');
const { assertValidSchemaName } = require('./validators');
const logger = require('./logger');
const { extractKeywords, extractNumericTokens, DEFAULT_STOPWORDS } = require('./keyword-extractor');
const { mimeToBucket } = require('../utils/media-type');

// Display order for the "Media breakdown" block. Buckets render in this
// order regardless of insertion order so two consecutive emails always
// look the same. Buckets with zero count are dropped at render time.
const MEDIA_BUCKETS = ['image', 'video', 'audio', 'document', 'archive', 'other'];

// Forker stopword override: EMAIL.KEYWORDS_STOPWORDS replaces only the
// languages it lists; everything else falls back to the built-in defaults.
// Computed once at module load so we don't rebuild the merged map per book.
const STOPWORDS_BY_LANG = EMAIL.KEYWORDS_STOPWORDS
    ? { ...DEFAULT_STOPWORDS, ...EMAIL.KEYWORDS_STOPWORDS }
    : DEFAULT_STOPWORDS;

const INACTIVITY_THRESHOLD_DAYS = PHI_BREATHE.MONTHLY_CLOSING_INACTIVITY_DAYS || 60;

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// Returns the previous calendar month window (UTC).
// If overrideMonth is 'YYYY-MM', uses that month instead.
function getMonthWindow(overrideMonth) {
    let monthStart, monthEnd;

    if (overrideMonth && /^\d{4}-\d{2}$/.test(overrideMonth)) {
        const [year, month] = overrideMonth.split('-').map(Number);
        monthStart = new Date(Date.UTC(year, month - 1, 1));
        monthEnd   = new Date(Date.UTC(year, month, 1));
    } else {
        const now = new Date();
        monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        monthEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }

    return {
        monthStart,
        monthEnd,
        label: `${MONTH_NAMES[monthStart.getUTCMonth()]} ${monthStart.getUTCFullYear()}`
    };
}

// DB-persisted guard — survives restarts.
// Returns true if this instance won the race (first to claim this month).
// Returns false if already ran (another instance beat us, or we already ran).
async function claimDbGuard(pool, guardKey) {
    const key = `monthly_closing_${guardKey}`;
    try {
        const result = await pool.query(
            `INSERT INTO core.system_counters (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO NOTHING`,
            [key, Date.now()]
        );
        return result.rowCount > 0;
    } catch (err) {
        logger.warn({ err: err.message, guardKey }, '📊 Monthly closing: guard check failed');
        return false;
    }
}

// Removes the DB guard — used by force-run to allow re-execution.
async function clearDbGuard(pool, guardKey) {
    const key = `monthly_closing_${guardKey}`;
    await pool.query(`DELETE FROM core.system_counters WHERE key = $1`, [key]);
}

// Read messages directly from anatta_messages (PostgreSQL — source of truth).
// No Discord, no bot dependency.
async function fetchMessagesFromPostgres(pool, tenantSchema, bookFractalId, monthStart, monthEnd) {
    const schemaSafe = assertValidSchemaName(tenantSchema);
    try {
        const result = await pool.query(
            `SELECT sender_name, body, has_attachment, media_url, media_type, recorded_at
             FROM ${schemaSafe}.anatta_messages
             WHERE book_fractal_id = $1
               AND recorded_at >= $2
               AND recorded_at < $3
             ORDER BY recorded_at ASC`,
            [bookFractalId, monthStart, monthEnd]
        );
        return result.rows.map(row => ({
            phone:               row.sender_name || null,
            text:                row.body || '',
            media:               row.has_attachment ? { type: row.media_url ? 'attachment' : 'unknown' } : null,
            mediaType:           row.media_type || null,
            attachmentTotalSize: 0,
            timestamp:           new Date(row.recorded_at)
        }));
    } catch (err) {
        logger.warn({ err: err.message, tenantSchema, bookFractalId }, '📊 Monthly closing: anatta_messages query failed');
        return [];
    }
}

// Check if book had messages in anatta_messages within the inactivity window.
async function isBookActive(pool, tenantSchema, bookFractalId) {
    const schemaSafe = assertValidSchemaName(tenantSchema);
    try {
        const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            `SELECT 1 FROM ${schemaSafe}.anatta_messages
             WHERE book_fractal_id = $1 AND recorded_at >= $2
             LIMIT 1`,
            [bookFractalId, cutoff]
        );
        return result.rows.length > 0;
    } catch {
        return false;
    }
}

// Build a simple count-based tally from Postgres-sourced messages.
// No LLM calls — pure math.
// drops: optional array of drop rows (must have a tags column, text[], or similar).
//        Pass [] or omit to leave drop_tags empty — Discord path is unaffected.
function buildTally(messages, monthLabel, drops = []) {
    const tally = {
        month:                monthLabel,
        generated_at:         new Date().toISOString(),
        total_messages:       messages.length,
        text_messages:        0,
        media_messages:       0,
        // Per-bucket attachment counts. Initialised to zero for every
        // bucket so renderers don't have to undefined-check; zero buckets
        // are filtered out at render time so the block stays compact.
        media_breakdown:      Object.fromEntries(MEDIA_BUCKETS.map(b => [b, 0])),
        total_attachment_bytes: 0,
        contributors:         new Set(),
        tags:                 {},
        drop_tags:            {}
    };

    for (const msg of messages) {
        if (msg.media) {
            tally.media_messages++;
            // Bucket the MIME (mediaType is already plumbed through from
            // anatta_messages.media_type by fetchMessagesFromPostgres).
            // Falls back to 'other' so attachments without a MIME are
            // still represented in the breakdown rather than silently
            // dropped from the total.
            const bucket = mimeToBucket(msg.mediaType);
            tally.media_breakdown[bucket] = (tally.media_breakdown[bucket] || 0) + 1;
        } else {
            tally.text_messages++;
        }

        tally.total_attachment_bytes += msg.attachmentTotalSize || 0;

        if (msg.phone) tally.contributors.add(msg.phone);

        if (msg.text) {
            const hashtagMatches = msg.text.match(/#\w+/g);
            if (hashtagMatches) {
                for (const tag of hashtagMatches) {
                    const normalized = tag.toLowerCase();
                    tally.tags[normalized] = (tally.tags[normalized] || 0) + 1;
                }
            }
        }
    }

    for (const drop of drops) {
        const rawTags = drop.tags || drop.tag_list || [];
        const tagArray = Array.isArray(rawTags) ? rawTags : [];
        for (const tag of tagArray) {
            if (!tag) continue;
            const normalized = String(tag).toLowerCase();
            tally.drop_tags[normalized] = (tally.drop_tags[normalized] || 0) + 1;
        }
    }

    tally.contributors     = [...tally.contributors];
    tally.contributor_count = tally.contributors.length;

    // Auto-extract content keywords from message bodies. Tags above are
    // user-typed labels (#perbaikan); keywords surface what was discussed
    // even when no hashtag was applied. Already-tagged terms are excluded
    // from the keyword list to avoid double-display.
    const tagWords = new Set(
        Object.keys(tally.tags).map(t => t.replace(/^#/, '').toLowerCase())
    );
    tally.keywords = extractKeywords(messages, {
        excludeWords: tagWords,
        topN: EMAIL.KEYWORDS_TOP_N,
        minLength: EMAIL.KEYWORDS_MIN_LENGTH,
        stopwordsByLang: STOPWORDS_BY_LANG
    });

    // Reference codes — pure-digit tokens within the configured length
    // window. Surfaced in their own email block (see buildTallyHtml in
    // lib/monthly-email.js) because they read very differently from
    // content keywords: plates, invoices, mileages, prices etc. Length
    // window keeps phones out (see extractNumericTokens for the
    // reasoning behind the defaults).
    tally.reference_codes = extractNumericTokens(messages, {
        topN: EMAIL.KEYWORDS_REFERENCE_TOP_N,
        minDigitLength: EMAIL.KEYWORDS_DIGIT_MIN_LENGTH,
        maxDigitLength: EMAIL.KEYWORDS_DIGIT_MAX_LENGTH
    });

    if (messages.length > 0) {
        const timestamps = messages.map(m => m.timestamp.getTime());
        tally.time_range = {
            earliest: new Date(Math.min(...timestamps)).toISOString(),
            latest:   new Date(Math.max(...timestamps)).toISOString()
        };
    }

    return tally;
}

// Per-book closing: 2 gates only — has thread_id + has messages in window.
async function runBookClosing(pool, book, tenantSchema, monthStart, monthEnd, monthLabel) {
    let outputCredentials = book.output_credentials;
    if (typeof outputCredentials === 'string') {
        try { outputCredentials = JSON.parse(outputCredentials); } catch { outputCredentials = {}; }
    }

    const threadId = outputCredentials?.output_01?.thread_id;
    if (!threadId) {
        logger.debug({ bookName: book.name }, '📊 Monthly closing: no thread_id, skipping');
        return null;
    }

    const messages = await fetchMessagesFromPostgres(pool, tenantSchema, book.fractal_id, monthStart, monthEnd);
    if (messages.length === 0) {
        logger.debug({ bookName: book.name }, '📊 Monthly closing: no messages in window, skipping');
        return null;
    }

    const tally = buildTally(messages, monthLabel);
    tally.book_name       = book.name;
    tally.book_fractal_id = book.fractal_id;
    tally.thread_id       = threadId;

    return tally;
}

// Main entry point. Two gates: Idris ready + DB guard.
// overrideMonth: 'YYYY-MM' string, or null for previous calendar month.
// force: if true, clears the DB guard first (manual backfill use).
async function runMonthlyClosing(pool, bots, { overrideMonth = null, force = false } = {}) {
    const idrisBot = bots?.idris;

    if (!idrisBot?.postMonthlyClosing) {
        logger.warn('📊 Monthly closing: Idris not ready, skipping');
        return { skipped: true, reason: 'idris_not_ready' };
    }

    const { monthStart, monthEnd, label } = getMonthWindow(overrideMonth);
    const guardKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

    if (force) {
        await clearDbGuard(pool, guardKey);
        logger.info({ guardKey }, '📊 Monthly closing: force-cleared DB guard');
    }

    const won = await claimDbGuard(pool, guardKey);
    if (!won) {
        logger.info({ guardKey }, '📊 Monthly closing: already ran for this month (DB guard), skipping');
        return { skipped: true, reason: 'duplicate_guard', guardKey };
    }

    logger.info({ label, guardKey }, '📊 Starting monthly book closing');

    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        // Release guard so a retry can re-run
        await clearDbGuard(pool, guardKey);
        logger.error({ err }, '📊 Monthly closing: failed to connect to DB — guard released for retry');
        return { skipped: true, reason: 'db_error' };
    }

    let totalBooks = 0;
    let closedBooks = 0;
    let skippedBooks = 0;

    try {
        const tenants = await client.query(`
            SELECT id, tenant_schema
            FROM core.tenant_catalog
            WHERE status = 'active'
            ORDER BY id
        `);

        for (const tenant of tenants.rows) {
            const { tenant_schema } = tenant;

            try {
                const booksResult = await client.query(
                    `SELECT id, name, fractal_id, output_credentials
                     FROM ${assertValidSchemaName(tenant_schema)}.books
                     WHERE status = 'active'
                     ORDER BY id`
                );

                for (const book of booksResult.rows) {
                    totalBooks++;
                    try {
                        // Quick activity pre-check (60-day window)
                        const active = await isBookActive(pool, tenant_schema, book.fractal_id);
                        if (!active) {
                            skippedBooks++;
                            logger.debug({ bookName: book.name }, '📊 Monthly closing: inactive (60d), skipping');
                            continue;
                        }

                        const tally = await runBookClosing(pool, book, tenant_schema, monthStart, monthEnd, label);
                        if (!tally) {
                            skippedBooks++;
                            continue;
                        }

                        await idrisBot.postMonthlyClosing(tally.thread_id, tally);
                        closedBooks++;
                        logger.info({ bookName: book.name, tenantSchema: tenant_schema }, '📊 Monthly closing: posted to book thread');
                    } catch (bookErr) {
                        logger.error({ bookName: book.name, err: bookErr }, '📊 Monthly closing: book error');
                        skippedBooks++;
                    }
                }
            } catch (tenantErr) {
                logger.error({ tenantSchema: tenant_schema, err: tenantErr }, '📊 Monthly closing: tenant error');
            }
        }

        logger.info({ label, totalBooks, closedBooks, skippedBooks }, '📊 Monthly closing complete');
        return { success: true, label, guardKey, totalBooks, closedBooks, skippedBooks };
    } finally {
        client.release();
    }
}

module.exports = {
    runMonthlyClosing,
    runBookClosing,
    buildTally,
    getMonthWindow,
    fetchMessagesFromPostgres,
    INACTIVITY_THRESHOLD_DAYS
};
