'use strict';

const { PHI_BREATHE } = require('../config/constants');
const logger = require('./logger');
const { detectLanguage } = require('../utils/language-detector');
const entityExtractor = require('./tools/entity-extractor');

const INACTIVITY_THRESHOLD_DAYS = PHI_BREATHE.MONTHLY_CLOSING_INACTIVITY_DAYS || 60;

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function getMonthWindow() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return {
        monthStart,
        monthEnd,
        label: `${MONTH_NAMES[monthStart.getUTCMonth()]} ${monthStart.getUTCFullYear()}`
    };
}

async function fetchDiscordMessagesForWindow(thothBot, threadId, monthStart, monthEnd) {
    if (!thothBot?.client || !thothBot.ready) return [];

    try {
        const channel = await thothBot.client.channels.fetch(threadId);
        if (!channel) return [];

        const collected = [];
        let lastId = null;
        let done = false;

        while (!done) {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;

            const batch = await channel.messages.fetch(opts);
            if (batch.size === 0) break;

            for (const [, m] of batch) {
                if (m.createdAt < monthStart) {
                    done = true;
                    break;
                }
                if (m.createdAt >= monthStart && m.createdAt < monthEnd) {
                    const embed = m.embeds[0];
                    const fields = embed?.fields || [];
                    const getField = (name) => fields.find(f => f.name === name)?.value;

                    const mediaField = getField('Media');
                    let media = null;
                    if (mediaField) {
                        const match = mediaField.match(/^(.+?)\s*\((.+?)\)$/);
                        media = match ? { type: match[1], size: match[2] } : { type: mediaField };
                    }

                    collected.push({
                        id: m.id,
                        phone: getField('Phone') ?? null,
                        text: embed?.description || '',
                        media,
                        attachmentCount: m.attachments.size,
                        attachmentTotalSize: [...m.attachments.values()].reduce((sum, a) => sum + (a.size || 0), 0),
                        timestamp: m.createdAt
                    });
                }
                lastId = m.id;
            }

            if (batch.size < 100) break;
        }

        return collected;
    } catch (err) {
        logger.warn({ threadId, err }, '⚠️ Monthly closing: failed to fetch Discord messages');
        return [];
    }
}

async function isBookActive(pool, tenantSchema, bookId) {
    try {
        const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            `SELECT 1 FROM ${tenantSchema}.drops WHERE book_id = $1 AND created_at >= $2 LIMIT 1`,
            [bookId, cutoff]
        );
        return result.rows.length > 0;
    } catch {
        return false;
    }
}

async function buildTally(messages, monthLabel) {
    const tally = {
        month: monthLabel,
        generated_at: new Date().toISOString(),
        total_messages: messages.length,
        text_messages: 0,
        media_messages: 0,
        total_attachment_bytes: 0,
        contributors: new Set(),
        entities: {},
        languages: {},
        tags: {}
    };

    const allText = [];

    for (const msg of messages) {
        if (msg.media) {
            tally.media_messages++;
        } else {
            tally.text_messages++;
        }

        tally.total_attachment_bytes += msg.attachmentTotalSize || 0;

        if (msg.phone) tally.contributors.add(msg.phone);

        if (msg.text) {
            allText.push(msg.text);

            const lang = detectLanguage(msg.text);
            if (lang.confidence >= 0.3) {
                tally.languages[lang.lang] = (tally.languages[lang.lang] || 0) + 1;
            }

            const hashtagMatches = msg.text.match(/#\w+/g);
            if (hashtagMatches) {
                for (const tag of hashtagMatches) {
                    const normalized = tag.toLowerCase();
                    tally.tags[normalized] = (tally.tags[normalized] || 0) + 1;
                }
            }
        }
    }

    const combinedText = allText.join('\n');
    if (combinedText.length > 0) {
        const extraction = await entityExtractor.execute(combinedText);
        if (extraction.success) {
            tally.entities = extraction.summary;
        }
    }

    tally.contributors = [...tally.contributors];
    tally.contributor_count = tally.contributors.length;

    if (messages.length > 0) {
        const timestamps = messages.map(m => m.timestamp.getTime());
        tally.time_range = {
            earliest: new Date(Math.min(...timestamps)).toISOString(),
            latest: new Date(Math.max(...timestamps)).toISOString()
        };
    }

    return tally;
}

async function runBookClosing(pool, thothBot, book, tenantSchema, monthStart, monthEnd, monthLabel) {
    const threadId = book.output_credentials?.output_01?.thread_id;
    if (!threadId) {
        logger.debug({ bookName: book.name, tenantSchema }, '📊 Monthly closing: no thread_id, skipping');
        return null;
    }

    const active = await isBookActive(pool, tenantSchema, book.id);
    if (!active) {
        logger.debug({ bookName: book.name, tenantSchema }, '📊 Monthly closing: inactive book (60d), skipping');
        return null;
    }

    const messages = await fetchDiscordMessagesForWindow(thothBot, threadId, monthStart, monthEnd);
    if (messages.length === 0) {
        logger.debug({ bookName: book.name, tenantSchema }, '📊 Monthly closing: no messages in window, skipping');
        return null;
    }

    const tally = await buildTally(messages, monthLabel);
    tally.book_name = book.name;
    tally.book_fractal_id = book.fractal_id;

    return tally;
}

async function runMonthlyClosing(pool, bots, closingGuard) {
    const thothBot = bots?.thoth;
    const idrisBot = bots?.idris;

    if (!thothBot?.client || !thothBot.ready) {
        logger.warn('📊 Monthly closing: Thoth not ready, skipping');
        return { skipped: true, reason: 'thoth_not_ready' };
    }
    if (!idrisBot?.postMonthlyClosing) {
        logger.warn('📊 Monthly closing: Idris not ready, skipping');
        return { skipped: true, reason: 'idris_not_ready' };
    }

    const { monthStart, monthEnd, label } = getMonthWindow();
    const guardKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

    if (closingGuard.has(guardKey)) {
        logger.info({ guardKey }, '📊 Monthly closing: already ran for this month, skipping');
        return { skipped: true, reason: 'duplicate_guard' };
    }

    logger.info({ label, guardKey }, '📊 Starting monthly book closing');

    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        logger.error({ err }, '📊 Monthly closing: failed to connect to DB');
        return { skipped: true, reason: 'db_error' };
    }

    try {
        const tenants = await client.query(`
            SELECT id, tenant_schema, ai_log_thread_id 
            FROM core.tenant_catalog 
            WHERE status = 'active'
            ORDER BY id
        `);

        let totalBooks = 0;
        let closedBooks = 0;
        let skippedBooks = 0;

        for (const tenant of tenants.rows) {
            const { tenant_schema, ai_log_thread_id } = tenant;
            if (!ai_log_thread_id) continue;

            try {
                const booksResult = await client.query(
                    `SELECT id, name, fractal_id, output_credentials FROM ${tenant_schema}.books WHERE status = 'active' ORDER BY id`
                );

                for (const book of booksResult.rows) {
                    totalBooks++;
                    try {
                        const tally = await runBookClosing(pool, thothBot, book, tenant_schema, monthStart, monthEnd, label);
                        if (!tally) {
                            skippedBooks++;
                            continue;
                        }

                        await idrisBot.postMonthlyClosing(ai_log_thread_id, tally);
                        closedBooks++;
                        logger.info({ bookName: book.name, tenantSchema: tenant_schema }, '📊 Monthly closing: posted');
                    } catch (bookErr) {
                        logger.error({ bookName: book.name, err: bookErr }, '📊 Monthly closing: book error');
                        skippedBooks++;
                    }
                }
            } catch (tenantErr) {
                logger.error({ tenantSchema: tenant_schema, err: tenantErr }, '📊 Monthly closing: tenant error');
            }
        }

        closingGuard.set(guardKey, Date.now());
        logger.info({ label, totalBooks, closedBooks, skippedBooks }, '📊 Monthly closing complete');
        return { success: true, label, totalBooks, closedBooks, skippedBooks };
    } finally {
        client.release();
    }
}

module.exports = {
    runMonthlyClosing,
    runBookClosing,
    buildTally,
    getMonthWindow,
    INACTIVITY_THRESHOLD_DAYS
};
