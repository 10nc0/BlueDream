'use strict';

// Never expose hidden reasoning as the user's answer or log provider content.
function completionMetadata(data) {
    const choice = data?.choices?.[0];
    return {
        finishReason: ['stop', 'length', 'content_filter', 'tool_calls'].includes(choice?.finish_reason)
            ? choice.finish_reason : 'unknown',
        contentChars: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
        completionTokens: Number.isFinite(data?.usage?.completion_tokens) ? data.usage.completion_tokens : null,
        reasoningTokens: Number.isFinite(data?.usage?.completion_tokens_details?.reasoning_tokens)
            ? data.usage.completion_tokens_details.reasoning_tokens : null
    };
}

function completionError(code) {
    const error = new Error(code);
    error.code = code;
    error.providerCompleted = true; // Malformed paid output must not trigger transport retries.
    return error;
}

function requireCompletionText(data) {
    const metadata = completionMetadata(data);
    if (metadata.finishReason === 'length') throw completionError('AI_RESPONSE_TRUNCATED');
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw completionError('AI_RESPONSE_EMPTY');
    return content;
}

module.exports = { completionMetadata, completionError, requireCompletionText };
