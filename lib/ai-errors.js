'use strict';

// Public, allowlisted error contract shared by JSON and SSE playground routes.
// Do not expose provider/driver error messages, SQL or request configurations.
function publicAIError(error) {
    if (error?.failure) return error.failure; // Pipeline's already-sanitized result.
    if (['AI_RESPONSE_EMPTY', 'AI_RESPONSE_TRUNCATED', 'AI_AUDIT_INVALID', 'AI_STREAM_INVALID', 'AI_STREAM_INCOMPLETE'].includes(error?.code)) {
        return {
            code: error.code, status: 502,
            message: error.code === 'AI_AUDIT_INVALID'
                ? 'The verification service returned an incomplete or invalid result. I could not verify an answer. Your question was not retried automatically.'
                : 'The AI provider returned an empty or incomplete answer. Your question was not retried automatically.'
        };
    }
    if (error?.code === 'AI_CAPACITY') {
        const status = error.status || 503;
        return {
            code: 'AI_CAPACITY', status, retryAfter: error.retryAfter || 60,
            message: status === 503
                ? error.providerCompleted
                    ? 'AI usage could not be recorded. Your request was not retried automatically. Please try again later.'
                    : error.capacityReason === 'deadline'
                        ? 'AI capacity checks timed out. Please try again shortly.'
                        : 'AI capacity checks are temporarily unavailable. Please try again shortly.'
                : error.message
        };
    }
    if (error?.name === 'TimeoutError' || error?.code === 'ECONNABORTED') {
        return { code: 'AI_TIMEOUT', status: 504, message: 'The AI request timed out. Please try again shortly.' };
    }
    const status = Number(error?.response?.status ?? error?.statusCode ?? error?.status);
    if (status === 429) {
        return { code: 'AI_PROVIDER_BUSY', status: 503,
            message: 'The AI provider is temporarily busy. Please try again shortly.' };
    }
    if (status >= 400) {
        return { code: 'AI_PROVIDER_UNAVAILABLE', status: 502,
            message: 'The AI provider is currently unavailable. Please try again shortly.' };
    }
    return { code: 'AI_PROCESSING_FAILED', status: 500,
        message: 'Something went wrong processing your request. Please try again.' };
}

module.exports = { publicAIError };
