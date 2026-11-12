'use strict';

const { deliveryContext } = require('./ordered-inpipe');

function hold(message) {
    return Object.assign(new Error(message), { code: 'INPIPE_HELD' });
}

// A persisted snapshot wins before any mutable book lookup on retry.
async function bookSnapshot(key, load) {
    const create = async () => {
        const book = await load();
        if (!book) throw hold('Book unavailable; explicit disposition required');
        return book;
    };
    const context = deliveryContext.getStore();
    return context ? context.memo(key, create) : create();
}

async function requireMedia(channel, msg, rawPayload) {
    if (!msg.hasMedia) return null;
    const media = await channel.downloadMedia(rawPayload.mediaUrl, rawPayload.mediaContentType);
    if (!media?.buffer?.length) {
        throw Object.assign(new Error('Attachment unavailable; retry required'), { code: 'INPIPE_MEDIA_FAILED' });
    }
    return media;
}

module.exports = { hold, bookSnapshot, requireMedia };
