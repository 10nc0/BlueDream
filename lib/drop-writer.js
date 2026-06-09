const crypto = require('crypto');
const MetadataExtractor = require('./metadata-extractor');

const metadataExtractor = new MetadataExtractor();

function dedupTags(primary, secondary) {
    const seen = new Map();
    for (const t of [...primary, ...secondary]) {
        const key = t.toLowerCase();
        if (!seen.has(key)) seen.set(key, key);
    }
    return [...seen.values()];
}

function computePayloadId(sourceId) {
    return 'pi_' + crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 32);
}

async function writeDrop({ pool, tenantSchema, bookInternalId, sourceId, metadataText, tags = [], sentAt = null, phiStamp = null }) {
    const existing = await pool.query(
        `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 AND source_id = $2`,
        [bookInternalId, sourceId]
    );

    let drop, extracted;

    if (existing.rows.length > 0) {
        const combinedText = existing.rows[0].metadata_text + ' ' + metadataText;
        extracted = metadataExtractor.extract(combinedText);
        const mergedTags = dedupTags(extracted.tags, tags);

        const result = await pool.query(`
            UPDATE ${tenantSchema}.drops
            SET metadata_text     = $1,
                extracted_tags    = $2::text[],
                extracted_dates   = $3::text[],
                phi_breathe_stamp = $4,
                sent_at           = COALESCE($7, sent_at),
                updated_at        = NOW()
            WHERE book_id = $5 AND source_id = $6
            RETURNING *
        `, [combinedText, mergedTags, extracted.dates, phiStamp, bookInternalId, sourceId, sentAt]);

        extracted = { tags: mergedTags, dates: extracted.dates };
        drop = result.rows[0];
    } else {
        extracted = metadataExtractor.extract(metadataText);
        const mergedTags = dedupTags(extracted.tags, tags);

        const result = await pool.query(`
            INSERT INTO ${tenantSchema}.drops
                (book_id, source_id, metadata_text, extracted_tags, extracted_dates, phi_breathe_stamp, sent_at)
            VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7)
            RETURNING *
        `, [bookInternalId, sourceId, metadataText, mergedTags, extracted.dates, phiStamp, sentAt]);

        extracted = { tags: mergedTags, dates: extracted.dates };
        drop = result.rows[0];
    }

    return { drop, extracted, payload_id: computePayloadId(sourceId) };
}

module.exports = { writeDrop, computePayloadId };
