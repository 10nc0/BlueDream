'use strict';

/**
 * Output destination resolver — single source of truth for Discord delivery addressing.
 *
 * Canonical shape stored on books.output_credentials:
 *   {
 *     output_01: { type, webhook_url, thread_id, thread_name, channel_id },
 *     output_0n: { type, webhook_url, thread_id, thread_name, channel_id },
 *     // legacy flat fallback (pre-nested schema, output_01 only):
 *     thread_id, thread_name
 *   }
 *
 * @typedef {Object} ResolvedOutput
 * @property {'thread'|'channel'} type
 * @property {string|null}        webhook_url
 * @property {string|null}        thread_id
 * @property {string|null}        thread_name
 * @property {string|null}        channel_id
 */

const SLOT_TO_URL_FIELD = {
    output_01: 'output_01_url',
    output_0n: 'output_0n_url'
};

/**
 * Resolve a normalized output destination for a book + slot.
 *
 * @param {Object} book   Book row (must include output_credentials; output_NN_url optional fallback)
 * @param {'output_01'|'output_0n'} slot
 * @returns {ResolvedOutput|null}
 */
function resolveOutput(book, slot) {
    if (!book || !slot) return null;
    if (slot !== 'output_01' && slot !== 'output_0n') return null;

    let creds = book.output_credentials;
    if (typeof creds === 'string') {
        try { creds = JSON.parse(creds); } catch { creds = null; }
    }
    if (!creds || typeof creds !== 'object') creds = {};

    const nested = creds[slot];
    if (nested && typeof nested === 'object' && (nested.thread_id || nested.channel_id || nested.webhook_url)) {
        return {
            type: nested.type || (nested.thread_id ? 'thread' : 'channel'),
            webhook_url: nested.webhook_url || book[SLOT_TO_URL_FIELD[slot]] || null,
            thread_id: nested.thread_id || null,
            thread_name: nested.thread_name || null,
            channel_id: nested.channel_id || null
        };
    }

    // Legacy flat fallback — only applies to output_01 (no flat output_0n ever existed).
    if (slot === 'output_01' && creds.thread_id) {
        return {
            type: 'thread',
            webhook_url: book.output_01_url || null,
            thread_id: creds.thread_id,
            thread_name: creds.thread_name || null,
            channel_id: null
        };
    }

    return null;
}

module.exports = { resolveOutput };
