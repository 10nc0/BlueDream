'use strict';

const { assertValidSchemaName } = require('../lib/validators');
const logger = require('../lib/logger');

function escapeCsvField(value) {
    const str = (value === null || value === undefined) ? '' : String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function buildCsvRow(fields) {
    return fields.map(escapeCsvField).join(',');
}

const CSV_HEADER = buildCsvRow([
    'timestamp',
    'book_name',
    'sender',
    'content',
    'attachment_url',
    'attachment_cid',
    'message_id'
]);

async function generateBookCsv(pool, tenantSchema, bookFractalId, bookName, since, until) {
    const schemaSafe = assertValidSchemaName(tenantSchema);

    const params = [bookFractalId];
    let whereClause = 'WHERE book_fractal_id = $1';

    if (since) {
        params.push(since);
        whereClause += ` AND recorded_at >= $${params.length}`;
    }
    if (until) {
        params.push(until);
        whereClause += ` AND recorded_at < $${params.length}`;
    }

    try {
        const result = await pool.query(
            `SELECT message_fractal_id, sender_name, body, media_url, attachment_cid, recorded_at
             FROM ${schemaSafe}.anatta_messages
             ${whereClause}
             ORDER BY recorded_at ASC`,
            params
        );

        const rows = result.rows.map(row => buildCsvRow([
            row.recorded_at ? new Date(row.recorded_at).toISOString() : '',
            bookName || '',
            row.sender_name || '',
            row.body || '',
            row.media_url || '',
            row.attachment_cid || '',
            row.message_fractal_id || ''
        ]));

        return [CSV_HEADER, ...rows].join('\n');
    } catch (err) {
        logger.warn({ err: err.message, tenantSchema, bookFractalId }, '📊 CSV export: anatta_messages query failed');
        return CSV_HEADER + '\n';
    }
}

module.exports = { generateBookCsv };
