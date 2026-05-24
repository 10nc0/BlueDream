/**
 * lib/agent-pipe-schema.js
 *
 * Shared schema + MIME helpers for the agent pipe endpoints.
 * Imported by both routes/pipe.js (the real handler) and
 * tests/test-agent-pipe-attachments.js (the unit tests),
 * so schema changes are automatically validated by the test suite.
 */

'use strict';

const { z } = require('zod');

// ── Size limits ───────────────────────────────────────────────────────────────
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;  // 10 MB per photo
const MAX_DOC_BYTES   = 20 * 1024 * 1024;  // 20 MB per document

// ── MIME helpers — canonical definitions live in lib/attachment-packet.js ─────
// Re-exported here so this module's public API is unchanged.
const {
    MIME_FROM_EXT,
    deriveMimeFromDoc,
    deriveMimeFromPhoto,
} = require('./attachment-packet');

// ── Reusable refinements ──────────────────────────────────────────────────────
const HTTPS_ONLY = (val) => val == null || /^https?:\/\//i.test(val);

// ── Webhook payload schema ────────────────────────────────────────────────────
// Used by POST /api/webhook/:fractalId and POST /api/agent/message.
const webhookPayloadSchema = z.object({
    text: z.string().max(10000, 'Message too long').optional().default(''),
    username: z.string().max(100, 'Username too long').optional().default('External'),
    avatar_url: z.string().url('Invalid avatar URL')
        .refine(HTTPS_ONLY, 'Only HTTP/HTTPS URLs allowed')
        .optional().nullable(),
    media_url: z.string()
        .url('Invalid media URL')
        .refine(
            url => !url.startsWith('data:'),
            'data: URIs are not accepted for media_url. Send the file via the documents[] or photos[] fields instead.'
        )
        .refine(HTTPS_ONLY, 'Only HTTP/HTTPS URLs allowed')
        .optional().nullable(),
    media_type: z.string()
        .max(255, 'media_type too long')
        .regex(
            /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(;.*)?$/,
            'Invalid MIME type'
        )
        .optional().nullable(),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone format').optional().nullable(),
    email: z.string().email('Invalid email format').optional().nullable(),
    // Base64 attachment fields — agent can dump files directly without external hosting.
    // Max 5 photos (10 MB each), max 5 documents (20 MB each).
    // Extracted text is appended to body; has_attachment is set to true.
    photos: z.array(
        z.union([
            z.string().min(1, 'Photo data must not be empty'),
            z.object({
                name: z.string().optional(),
                data: z.string().min(1, 'Photo data must not be empty')
            })
        ])
    ).max(5, 'Max 5 photos per message').optional(),
    documents: z.array(
        z.object({
            name: z.string().min(1, 'Document name is required'),
            data: z.string().min(1, 'Document data must not be empty'),
            type: z.string().optional()
        })
    ).max(5, 'Max 5 documents per message').optional()
});

module.exports = {
    webhookPayloadSchema,
    MAX_PHOTO_BYTES,
    MAX_DOC_BYTES,
    MIME_FROM_EXT,
    deriveMimeFromDoc,
    deriveMimeFromPhoto,
};
