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
    let attempts = 0;
    let response;
    try {
        response = await withRetry(({ attempt }) => {
            attempts = attempt;
            return axios.post(
                LLM_API_URL,
                // Ember defaults to max reasoning. Thinking and visible output
                // share max_tokens; leave room for the answer without raising caps.
                { ...axiosConfig.data, model: LLM_MODEL,
                    reasoning: axiosConfig.data.reasoning ?? { effort: 'low' } },
                {
                    ...options, signal, timeout,
                    headers: {
                        ...options.headers,
                        Authorization: `Bearer ${token}`,
                        'HTTP-Referer': BRAND.openrouterReferer,
                        'X-Title': BRAND.openrouterTitle,
                    },
                }
            );
        }, { maxAttempts: axiosConfig.data.stream ? 1 : maxRetries + 1, signal, backoffMs: 1000,
            shouldRetry: error => error.code !== 'AI_CAPACITY' });
    } catch (error) {
        error.attempts = attempts;
        throw error;
    }
    if (response.data?.usage) usageTracker.recordUsage(serviceType, response.data.usage);
    if (response.data?.usage) {
        const u = response.data.usage;
        require('../lib/logger').debug(`AI prompt usage ${JSON.stringify({
            promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens,
            stream: !!axiosConfig.data.stream, attempts
        })}`);
    }
    return response;
}

// Old Kimi-first callers now share the exact same model, deadline and budget.
const kimiFirst = groqWithRetry;

module.exports = { resolveAIToken, groqWithRetry, kimiFirst };
