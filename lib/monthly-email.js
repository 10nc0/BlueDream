'use strict';

const logger = require('./logger');
const { assertValidSchemaName } = require('./validators');
const { buildTally, getMonthWindow, fetchMessagesFromPostgres } = require('./monthly-closing');
const { generateBookCsvRows, CSV_HEADER } = require('../utils/book-csv-export');
const { EMAIL } = require('../config/constants');
const { resolveContributors } = require('./line-profile');

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

// Resolve the recipient address for a tenant's monthly email.
// Priority:
//   1. The user with `is_genesis_admin = TRUE` (system-level admin — only tenant_1
//      historically). Kept for back-compat / future use.
//   2. The earliest user (smallest id) — i.e. the tenant creator. Every tenant
//      has exactly one such user from signup, even when the genesis flag is FALSE.
// This covers the 60+ tenants whose creators were not flagged is_genesis_admin
// (because that flag is system-wide-first-user-only, not per-tenant-admin).
async function fetchTenantAdminEmail(pool, tenantSchema) {
    const schemaSafe = assertValidSchemaName(tenantSchema);
    try {
        const result = await pool.query(
            `SELECT email
             FROM ${schemaSafe}.users
             ORDER BY (is_genesis_admin IS TRUE) DESC, id ASC
             LIMIT 1`
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

    // Auto-extracted content keywords (parallel to user-typed tags above).
    // Tag terms are already excluded inside buildTally() to avoid duplication.
    const topKeywords = Array.isArray(tally.keywords) ? tally.keywords : [];
    if (topKeywords.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Top keywords</p>
<p style="font-size:0.85rem;">${topKeywords.map(([w, c]) => `${w} (${c})`).join(' · ')}</p>`;
    }

    // Reference codes — pure-digit tokens (license-plate digit-parts,
    // order numbers, mileages, prices, etc.) sourced from the same
    // message bodies as the keywords above, but kept in their own block
    // because readers scan numbers as a distinct category.
    const refCodes = Array.isArray(tally.reference_codes) ? tally.reference_codes : [];
    if (refCodes.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Top reference codes</p>
<p style="font-size:0.85rem;">${refCodes.map(([t, c]) => `${t} (${c})`).join(' · ')}</p>`;
    }

    // Media-type breakdown — folds raw MIME types into six display
    // buckets (image / video / audio / document / archive / other) and
    // hides any bucket with zero count so the block stays compact.
    // Skipped entirely when there are no media messages at all (every
    // bucket is zero) so text-only books don't render an empty header.
    const breakdown = tally.media_breakdown && typeof tally.media_breakdown === 'object'
        ? tally.media_breakdown
        : null;
    if (breakdown) {
        const breakdownEntries = Object.entries(breakdown).filter(([, c]) => c > 0);
        if (breakdownEntries.length > 0) {
            html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Media breakdown</p>
<p style="font-size:0.85rem;">${breakdownEntries.map(([b, c]) => `${b} (${c})`).join(' · ')}</p>`;
        }
    }

    if (topDropTags.length > 0) {
        html += `<p style="color:#94a3b8;font-size:0.8rem;margin-bottom:0.25rem;">Top drop tags</p>
<p style="font-size:0.85rem;">${topDropTags.map(([t, c]) => `${t} (${c})`).join(' · ')}</p>`;
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

// tenantSchemaFilter — when set (e.g. 'tenant_34'), only that single tenant
// is processed. Used for retrying a specific tenant after a transient bounce
// without re-sending to everyone else who already received the month's email.
async function runMonthlyEmail(pool, { overrideMonth = null, force = false, tenantSchemaFilter = null } = {}) {
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
    const fromEmail = `${EMAIL.FROM_NAME} <${EMAIL.FROM_ADDRESS}>`;

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
        // tenantSchemaFilter narrows the run to one tenant (used by the admin
        // endpoint when retrying a single bounced recipient). Validated below.
        const filterSql = tenantSchemaFilter ? `AND tenant_schema = $1` : '';
        const filterArgs = tenantSchemaFilter ? [tenantSchemaFilter] : [];
        if (tenantSchemaFilter) {
            // Defensive: only allow valid tenant_N schema names. Same regex as
            // assertValidSchemaName guards SQL injection on schema-qualified
            // identifiers downstream.
            if (!/^tenant_\d+$/.test(tenantSchemaFilter)) {
                await clearEmailGuard(pool, guardKey);
                logger.error({ tenantSchemaFilter }, '📧 Monthly email: invalid tenantSchemaFilter — guard released');
                // Don't release here — outer finally handles client.release().
                // (Earlier this had a manual release here too, which double-released.)
                return { skipped: true, reason: 'invalid_tenant_filter' };
            }
        }

        const tenants = await client.query(`
            SELECT id, tenant_schema
            FROM core.tenant_catalog
            WHERE status = 'active'
            ${filterSql}
            ORDER BY id
        `, filterArgs);

        // Per-tenant work as a function so we can run several in flight at once.
        // Returns an outcome marker; the caller increments shared counters
        // after the promise settles (race-free in JS's single-threaded loop).
        async function processTenant(tenant) {
            const { tenant_schema } = tenant;
            try {
                const adminEmail = await fetchTenantAdminEmail(pool, tenant_schema);
                if (!adminEmail) {
                    logger.info({ tenantSchema: tenant_schema, reason: 'no_admin_email' }, '📧 Monthly email: skip — no admin email');
                    return 'skipped';
                }

                const schemaSafe = assertValidSchemaName(tenant_schema);

                // Opt-in by default: NULL or TRUE both qualify; only explicit FALSE opts out.
                // The migration sets DEFAULT TRUE, but tenants on older schemas (pre-007)
                // may still have NULL; treating NULL as opt-in honors the user-facing default.
                // pool.query (not client.query) — must be parallel-safe because
                // the outer loop runs tenants concurrently up to SEND_CONCURRENCY,
                // and a single pg client cannot interleave queries.
                const booksResult = await pool.query(
                    `SELECT id, name, fractal_id
                     FROM ${schemaSafe}.books
                     WHERE status = 'active'
                       AND archived = false
                       AND monthly_email_backup IS NOT FALSE
                     ORDER BY id`
                );

                if (booksResult.rows.length === 0) {
                    logger.info({ tenantSchema: tenant_schema, reason: 'no_opt_in_books' }, '📧 Monthly email: skip — no opted-in books');
                    return 'skipped';
                }

                const bookSections = [];
                const allCsvRows = [];
                let totalMessages = 0;

                for (const book of booksResult.rows) {
                    const messages = await fetchMessagesFromPostgres(pool, tenant_schema, book.fractal_id, monthStart, monthEnd);
                    if (messages.length === 0) continue;

                    totalMessages += messages.length;

                    const drops = await fetchDropsForBook(pool, tenant_schema, book.id, monthStart, monthEnd);
                    const tally = buildTally(messages, label, drops);
                    tally.book_name = book.name;
                    tally.book_fractal_id = book.fractal_id;

                    // Resolve LINE userIds → display names at render time. Phone numbers,
                    // Discord IDs, emails pass through unchanged. Failures fall back to
                    // the raw ID so the email always renders something sensible.
                    tally.contributors = await resolveContributors(tally.contributors);

                    const bookRows = await generateBookCsvRows(pool, tenant_schema, book.fractal_id, book.name, monthStart, monthEnd);
                    allCsvRows.push(...bookRows);

                    bookSections.push(buildTallyHtml(tally, book.name, label));
                }

                if (bookSections.length === 0) {
                    logger.info({ tenantSchema: tenant_schema, reason: 'no_messages_in_window', books: booksResult.rows.length }, '📧 Monthly email: skip — books had no messages in window');
                    return 'skipped';
                }

                const consolidatedCsv = [CSV_HEADER, ...allCsvRows].join('\n');
                const consolidatedFilename = `nyanbook_${guardKey}_monthly_backup.csv`;
                const attachments = [{
                    filename: consolidatedFilename,
                    content: Buffer.from(consolidatedCsv, 'utf8').toString('base64')
                }];

                const subject = `Your Nyanbook — ${label} — ${totalMessages} records across ${bookSections.length} book${bookSections.length !== 1 ? 's' : ''}`;

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

                logger.info({ tenantSchema: tenant_schema, to: adminEmail, books: bookSections.length }, '📧 Monthly email sent');
                return 'sent';
            } catch (tenantErr) {
                logger.error({ tenantSchema: tenant_schema, err: tenantErr }, '📧 Monthly email: tenant error');
                return 'skipped';
            }
        }

        // Concurrency-limited, paced launcher. Two complementary throttles:
        //   1) SEND_PACING_MS staggers LAUNCHES (prevents bursts that would
        //      breach Resend's per-second limit even with low concurrency).
        //   2) SEND_CONCURRENCY caps in-flight sends (prevents runaway
        //      parallelism at large tenant counts).
        // At defaults (concurrency=3, pacing=250ms) the steady-state ceiling
        // is ~3 sends/sec and ~12 in-flight/sec under burst — comfortably
        // inside Resend's Pro 10/sec window. Free-tier forks should set
        // MONTHLY_EMAIL_SEND_CONCURRENCY=2 + SEND_PACING_MS=500.
        const concurrency = Math.max(1, EMAIL.SEND_CONCURRENCY || 1);
        const pacingMs    = Math.max(0, EMAIL.SEND_PACING_MS    || 0);
        const inFlight    = new Set();
        const outcomes    = [];
        let lastLaunchAt  = 0;

        for (const tenant of tenants.rows) {
            totalTenants++;

            // Pace LAUNCHES — minimum gap between starting two sends.
            if (pacingMs > 0) {
                const elapsed = Date.now() - lastLaunchAt;
                if (elapsed < pacingMs) {
                    await new Promise(r => setTimeout(r, pacingMs - elapsed));
                }
            }

            // Hold under concurrency cap.
            while (inFlight.size >= concurrency) {
                await Promise.race(inFlight);
            }

            lastLaunchAt = Date.now();
            const p = processTenant(tenant)
                .then(o => { outcomes.push(o); })
                .finally(() => inFlight.delete(p));
            inFlight.add(p);
        }

        // Drain remaining in-flight sends before reporting totals.
        await Promise.all(inFlight);

        for (const o of outcomes) {
            if (o === 'sent') sentEmails++;
            else skippedTenants++;
        }

        // Release the guard if zero emails were actually dispatched. The guard
        // exists to prevent two parallel instances from double-sending — but if
        // nothing was sent, there's nothing to deduplicate, and keeping the guard
        // would force operators to use ?force=true on every retry.
        if (sentEmails === 0) {
            await clearEmailGuard(pool, guardKey);
            logger.warn({ label, guardKey, totalTenants, skippedTenants }, '📧 Monthly email export complete — 0 sent, guard released for retry');
        } else {
            logger.info({ label, totalTenants, sentEmails, skippedTenants }, '📧 Monthly email export complete');
        }
        return { success: true, label, guardKey, totalTenants, sentEmails, skippedTenants };
    } finally {
        client.release();
    }
}

module.exports = { runMonthlyEmail, buildTallyHtml };
