const axios = require('axios');
const logger = require('../lib/logger');
const usageTracker = require('./playground-usage');
const { config } = require('../config');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Maps Groq model names → OpenRouter model IDs
// @ref: https://openrouter.ai/models
const GROQ_TO_OPENROUTER = {
    'llama-3.3-70b-versatile':                   'meta-llama/llama-3.3-70b-instruct',
    'llama-3.1-70b-versatile':                   'meta-llama/llama-3.1-70b-instruct',
    'llama3-70b-8192':                            'meta-llama/llama-3-70b-instruct',
    'llama3-8b-8192':                             'meta-llama/llama-3-8b-instruct',
    'mixtral-8x7b-32768':                         'mistralai/mixtral-8x7b-instruct',
    'gemma2-9b-it':                               'google/gemma-2-9b-it',
    // Vision model — same ID works on both Groq and OpenRouter
    'meta-llama/llama-4-scout-17b-16e-instruct':  'meta-llama/llama-4-scout-17b-16e-instruct',
};

// Audio models use a different endpoint/body format — no OpenRouter fallback
const AUDIO_MODELS = new Set([
    'whisper-large-v3-turbo',
    'whisper-large-v3',
    'distil-whisper-large-v3-en',
]);

function resolveAIToken(context) {
    if (context === 'audit') return config.ai.dashboardAiKey;
    if (context === 'vision') return process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
    return process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN;
}

// Internal — Groq only, with exponential-backoff retry on 429
async function _groqCore(axiosConfig, maxRetries, serviceType) {
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

// Exported — tries Groq first, then OpenRouter if OPENROUTER_API_KEY is configured.
// All existing callers use this function unchanged — the fallback is transparent.
async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    try {
        return await _groqCore(axiosConfig, maxRetries, serviceType);
    } catch (groqError) {
        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

        // No fallback configured — rethrow the original Groq error unchanged
        if (!OPENROUTER_API_KEY) throw groqError;

        const groqModel = axiosConfig.data?.model;

        // Audio models use a different request format — cannot proxy through OpenRouter
        if (AUDIO_MODELS.has(groqModel)) throw groqError;

        const orModel = GROQ_TO_OPENROUTER[groqModel] || groqModel;
        logger.warn(
            { groqModel, orModel, groqStatus: groqError.response?.status },
            '🔀 LLM fallback: Groq → OpenRouter'
        );

        try {
            const orData = { ...axiosConfig.data, model: orModel };
            const orConfig = {
                ...axiosConfig.config,
                headers: {
                    ...(axiosConfig.config?.headers || {}),
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://nyanbook.io',
                    'X-Title': 'Nyanbook',
                },
            };

            const response = await axios.post(OPENROUTER_API_URL, orData, orConfig);

            if (response.data?.usage) {
                usageTracker.recordUsage(serviceType, response.data.usage);
            }

            logger.info({ orModel }, '✅ OpenRouter fallback succeeded');
            return response;
        } catch (orError) {
            logger.error({ err: orError, orModel }, '❌ OpenRouter fallback also failed');
            throw orError;
        }
    }
}

module.exports = { resolveAIToken, groqWithRetry };
