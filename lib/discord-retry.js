'use strict';

// A 429 is explicit non-delivery. Never apply this policy to ambiguous errors.
function retryDelay(error) {
    if (error.response?.status !== 429) return null;
    const seconds = Number(error.response.data?.retry_after);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
    error.retryAfterMs = delay;
    return delay;
}

async function retryDiscord(send) {
    for (let attempt = 0; ; attempt++) {
        try { return await send(); }
        catch (error) {
            const delay = retryDelay(error);
            if (delay === null || attempt >= 2 || delay > 30000) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

module.exports = { retryDelay, retryDiscord };
