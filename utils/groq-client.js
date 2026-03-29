const axios = require('axios');
const logger = require('../lib/logger');
const usageTracker = require('./playground-usage');
const { config } = require('../config');

function resolveAIToken(context) {
    if (context === 'audit') return config.ai.dashboardAiKey;
    if (context === 'vision') return process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
    return process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
}

async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(axiosConfig.url, axiosConfig.data, axiosConfig.config);

            if (response.data?.usage) {
                usageTracker.recordUsage(serviceType, response.data.usage);
            }

            return response;
        } catch (error) {
            lastError = error;

            const status = error.response?.status;
            const headers = error.response?.headers || {};
            const errorBody = error.response?.data;

            const promptTokensEstimate = axiosConfig.data?.messages
                ? JSON.stringify(axiosConfig.data.messages).length / 4
                : null;
            logger.warn({
                attempt: attempt + 1,
                maxAttempts: maxRetries + 1,
                status,
                rateLimitRequests: headers['x-ratelimit-limit-requests'] || null,
                rateLimitRemaining: headers['x-ratelimit-remaining-requests'] || null,
                retryAfter: headers['retry-after'] || null,
                promptTokensEstimate: typeof promptTokensEstimate === 'number' ? Math.round(promptTokensEstimate) : null,
                errorBody
            }, 'Groq API error');

            if (status === 429 && attempt < maxRetries) {
                const retryAfter = headers['retry-after'];
                const delayMs = retryAfter
                    ? parseInt(retryAfter) * 1000
                    : Math.min(1000 * Math.pow(2, attempt), 8000);
                logger.debug({ delayMs, attempt: attempt + 1, maxRetries }, 'Groq 429: retrying');
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

module.exports = { resolveAIToken, groqWithRetry };
