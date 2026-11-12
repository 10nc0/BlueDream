'use strict';

function hasAttachment(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Buffer.isBuffer(value)) return value.length > 0;
    return !!value && typeof value === 'object' &&
        ((typeof value.data === 'string' && value.data.trim().length > 0) ||
         (Buffer.isBuffer(value.data) && value.data.length > 0));
}

function validatePlaygroundInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'Request body must be an object.';
    }
    if (body.message != null && typeof body.message !== 'string') {
        return 'Message must be text.';
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const single = ['photo', 'audio', 'document'].some(key => hasAttachment(body[key]));
    const lists = ['photos', 'audios', 'documents'].some(key =>
        Array.isArray(body[key]) && body[key].some(hasAttachment));
    const zip = typeof body.zipData === 'string' && body.zipData.trim().length > 0;
    const context = Array.isArray(body.contextAttachments) && body.contextAttachments.some(hasAttachment);
    return message || single || lists || zip || context
        ? null
        : 'Enter a message or attach a photo, audio clip, or document.';
}

module.exports = { validatePlaygroundInput };
