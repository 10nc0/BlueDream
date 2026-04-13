'use strict';

const logger = require('./logger');
const { assertValidSchemaName } = require('./validators');
const { buildTally, getMonthWindow, fetchMessagesFromPostgres } = require('./monthly-closing');
const { generateBookCsv } = require('../utils/book-csv-export');

const GUARD_PREFIX = 'monthly_email';

async function claimEmailGuard(pool, guardKey) {
    const key = `${GUARD_PREFIX}_${guardKey}`;
    try {
        const result = await pool.query(
            `INSERT INTO core.system_counters (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO NOTHING`,
            [key, Date.now()]
        );
        return result.rowCount > 0;
    } catch (err) {
        logger.warn({ err: err.message, guardKey }, '📧 Monthly email: guard check failed');
        return false;
    }
}

async function clearEmailGuard(pool, guardKey) {
    const key = `${GUARD_PREFIX}_${guardKey}`;
    await pool.query(`DELETE FROM core.system_counters WHERE key = $1`, [key]);
}

async function fetchTenantAdminEmail(pool, tenantSchema) {
    const schemaSafe = assertValidSchemaName(tenantSchema);
    try {
        const result = await pool.query(
            `SELECT email FROM ${schemaSafe}.users WHERE is_genesis_admin = TRUE LIMIT 1`
        );
        return result.rows[0]?.email || null;
    } catch (err) {
        logger.warn({ err: err.message, tenantSchema }, '📧 Monthly email: could not fetch admin email');
        return null;
    }
}

async function fetchDropsForBook(pool, tenantSchema, bookId, monthStart, monthEnd) {
    const schemaSafe = assertValidSchemaName(tenantSchema);
    try {
        const result = await pool.query(
            `SELECT extracted_tags AS tags
             FROM ${schemaSafe}.drops
             WHERE book_id = $1
               AND created_at >= $2
               AND created_at < $3`,
            [bookId, monthStart, monthEnd]
        );
        return result.rows;
    } catch {
        return [];
    }
}

function buildTallyHtml(tally, bookName, monthLabel) {
    const topTags = Object.entries(tally.tags || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    const topDropTags = Object.entries(tally.drop_tags || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    const topContribs = (tally.contributors || []).slice(0, 10);

    let html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#e2e8f0;background:#0f172a;padding:1.5rem;border-radius:8px;">
  <h2 style="color:#a78bfa;margin-bottom:0.25rem;">📚 ${bookName}</h2>
  <p style="color:#64748b;font-size:0.85rem;margin-top:0;">${monthLabel} — monthly report</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:1rem;">
    <tr>
      <td style="padding:0.5rem;background:#1e293b;border-radius:4px 0 0 4px;color:#94a3b8;font-size:0.8rem;">Messages</td>
      <td style="padding:0.5rem;background:#1e293b;font-weight:bold;">${tally.total_messages}</td>
      <td style="padding:0.5rem;color:#94a3b8;font-size:0.8rem;">Text</td>
      <td style="padding:0.5rem;">${tally.text_messages}</td>
      <td style="padding:0.5rem;color:#94a3b8;font-size:0.8rem;">Media</td>
      <td style="padding:0.5rem;border-radius:0 4px 4px 0;">${tally.media_messages}</td>
    </tr>
  </table>`;

    if (topContribs.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Contributors (${tally.contributor_count})</p>
<p style="font-size:0.85rem;word-break:break-all;">${topContribs.join(', ')}</p>`;
    }

    if (topTags.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Top message tags</p>
<p style="font-size:0.85rem;">${topTags.map(([t, c]) => `${t} (${c})`).join(' · ')}</p>`;
    }

    if (topDropTags.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Top drop tags</p>
<p style="font-size:0.85rem;">${topDropTags.map(([t, c]) => `${t} (${c})`).join(' · ')}</p>`;
    }

    const langs = Object.entries(tally.languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (langs.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Languages</p>
<p style="font-size:0.85rem;">${langs.map(([l, c]) => `${l} (${c})`).join(' · ')}</p>`;
    }

    if (tally.time_range) {
        html += `<p style="color:#64748b;font-size:0.75rem;">First: ${tally.time_range.earliest} · Last: ${tally.time_range.latest}</p>`;
    }

    html += `</div>`;
    return html;
}

const MAX_SEND_ATTEMPTS = 3;
const SEND_BASE_DELAY_MS = 1000;

async function sendWithRetry(resend, payload, attempt = 1) {
    let data, error;
    try {
        ({ data, error } = await resend.emails.send(payload));
    } catch (err) {
        error = err;
    }

    if (!error) return data;

    const status = error?.statusCode ?? error?.response?.status ?? error?.status;
    const isPermanent = status && status >= 400 && status < 500 && status !== 429;

    if (isPermanent || attempt >= MAX_SEND_ATTEMPTS) {
        const err = typeof error === 'object' ? error : new Error(String(error));
        err.statusCode = status;
        throw err;
    }

    const retryAfterHeader = error?.response?.headers?.['retry-after'];
    const delayMs = retryAfterHeader
        ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
        : Math.min(SEND_BASE_DELAY_MS * Math.pow(2, attempt - 1), 30_000);

    logger.warn({ attempt, delayMs, status }, '📧 Monthly email: Resend transient error — retrying');
    await new Promise(r => setTimeout(r, delayMs));
    return sendWithRetry(resend, payload, attempt + 1);
}

async function runMonthlyEmail(pool, { overrideMonth = null, force = false } = {}) {
    const { Resend } = require('resend');
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
        logger.warn('📧 Monthly email: RESEND_API_KEY not set, skipping');
        return { skipped: true, reason: 'no_resend_key' };
    }

    const { monthStart, monthEnd, label } = getMonthWindow(overrideMonth);
    const guardKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

    if (force) {
        await clearEmailGuard(pool, guardKey);
        logger.info({ guardKey }, '📧 Monthly email: force-cleared guard');
    }

    const won = await claimEmailGuard(pool, guardKey);
    if (!won) {
        logger.info({ guardKey }, '📧 Monthly email: already ran for this month (guard), skipping');
        return { skipped: true, reason: 'duplicate_guard', guardKey };
    }

    logger.info({ label, guardKey }, '📧 Starting monthly email export');

    const resend = new Resend(resendApiKey);
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@nyanbook.app';

    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        await clearEmailGuard(pool, guardKey);
        logger.error({ err }, '📧 Monthly email: DB connect failed — guard released');
        return { skipped: true, reason: 'db_error' };
    }

    let totalTenants = 0;
    let sentEmails = 0;
    let skippedTenants = 0;

    try {
        const tenants = await client.query(`
            SELECT id, tenant_schema
            FROM core.tenant_catalog
            WHERE status = 'active'
            ORDER BY id
        `);

        for (const tenant of tenants.rows) {
            const { tenant_schema } = tenant;
            totalTenants++;

            try {
                const adminEmail = await fetchTenantAdminEmail(pool, tenant_schema);
                if (!adminEmail) {
                    skippedTenants++;
                    logger.debug({ tenantSchema: tenant_schema }, '📧 Monthly email: no admin email, skipping tenant');
                    continue;
                }

                const schemaSafe = assertValidSchemaName(tenant_schema);

                const booksResult = await client.query(
                    `SELECT id, name, fractal_id
                     FROM ${schemaSafe}.books
                     WHERE status = 'active'
                       AND archived = false
                       AND monthly_email_backup = TRUE
                     ORDER BY id`
                );

                if (booksResult.rows.length === 0) {
                    skippedTenants++;
                    logger.debug({ tenantSchema: tenant_schema }, '📧 Monthly email: no opted-in books, skipping tenant');
                    continue;
                }

                const bookSections = [];
                const attachments = [];

                for (const book of booksResult.rows) {
                    const messages = await fetchMessagesFromPostgres(pool, tenant_schema, book.fractal_id, monthStart, monthEnd);
                    if (messages.length === 0) continue;

                    const drops = await fetchDropsForBook(pool, tenant_schema, book.id, monthStart, monthEnd);
                    const tally = buildTally(messages, label, drops);
                    tally.book_name = book.name;
                    tally.book_fractal_id = book.fractal_id;

                    const csvContent = await generateBookCsv(pool, tenant_schema, book.fractal_id, book.name, monthStart, monthEnd);
                    const csvFilename = `${book.name.replace(/[^a-z0-9]/gi, '_')}_${guardKey}.csv`;

                    attachments.push({
                        filename: csvFilename,
                        content: Buffer.from(csvContent, 'utf8').toString('base64')
                    });

                    bookSections.push(buildTallyHtml(tally, book.name, label));
                }

                if (bookSections.length === 0) {
                    skippedTenants++;
                    logger.debug({ tenantSchema: tenant_schema }, '📧 Monthly email: no messages in window, skipping tenant');
                    continue;
                }

                const totalRecords = bookSections.length;
                const subject = `Your Nyanbook — ${label} — ${attachments.reduce((sum, a) => sum, 0) + totalRecords} update(s) across ${bookSections.length} book(s)`;

                const html = `
<!DOCTYPE html>
<html>
<body style="background:#0a0f1e;margin:0;padding:1rem;">
  <div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
    <h1 style="color:#a78bfa;font-size:1.2rem;margin-bottom:0.5rem;">📖 Your Nyanbook — ${label}</h1>
    <p style="color:#64748b;font-size:0.8rem;margin-bottom:1.5rem;">Monthly backup &amp; report. CSV file(s) attached.</p>
    ${bookSections.join('<hr style="border-color:#1e293b;margin:1rem 0;">')}
    <hr style="border-color:#1e293b;margin:1.5rem 0;">
    <p style="color:#475569;font-size:0.7rem;">Delivered by Nyanbook~ · To stop receiving these, uncheck "Email me monthly backup and report" in each book's settings.</p>
  </div>
</body>
</html>`;

                await sendWithRetry(resend, {
                    from: fromEmail,
                    to: adminEmail,
                    subject,
                    html,
                    attachments
                });

                sentEmails++;
                logger.info({ tenantSchema: tenant_schema, to: adminEmail, books: bookSections.length }, '📧 Monthly email sent');
            } catch (tenantErr) {
                skippedTenants++;
                logger.error({ tenantSchema: tenant_schema, err: tenantErr }, '📧 Monthly email: tenant error');
            }
        }

        logger.info({ label, totalTenants, sentEmails, skippedTenants }, '📧 Monthly email export complete');
        return { success: true, label, guardKey, totalTenants, sentEmails, skippedTenants };
    } finally {
        client.release();
    }
}

module.exports = { runMonthlyEmail };
