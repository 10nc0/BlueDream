const axios = require('axios');
const usageTracker = require('./playground-usage');
const { BRAND } = require('../config/brand');
const { LLM_MODEL, LLM_API_URL, resolveLLMToken } = require('../config/llm');
const { withRetry } = require('../lib/fetch-retry');

// Legacy names retained so callers need not maintain their own provider policy.
function resolveAIToken() {
    return resolveLLMToken();
}

async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    const token = resolveAIToken();
    if (!token) throw new Error('OPENROUTER_API_KEY is required for Meta Muse Ember.');
    const options = axiosConfig.config || {};
    const timeout = options.timeout ?? 30000;
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const response = await withRetry(() => axios.post(
        LLM_API_URL,
        { ...axiosConfig.data, model: LLM_MODEL },
        {
            ...options, signal, timeout,
            headers: {
                ...options.headers,
                Authorization: `Bearer ${token}`,
                'HTTP-Referer': BRAND.openrouterReferer,
                'X-Title': BRAND.openrouterTitle,
            },
        }
    ), { maxAttempts: maxRetries + 1, signal, backoffMs: 1000,
        shouldRetry: error => error.code !== 'AI_CAPACITY' });
    if (response.data?.usage) usageTracker.recordUsage(serviceType, response.data.usage);
    return response;
}

// Old Kimi-first callers now share the exact same model, deadline and budget.
const kimiFirst = groqWithRetry;

module.exports = { resolveAIToken, groqWithRetry, kimiFirst };
