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

// Maps Groq model names → Ollama model tags (best approximation).
// Overrideable per-request via OLLAMA_MODEL env var.
// @ref: https://ollama.ai/library
const GROQ_TO_OLLAMA = {
    'llama-3.3-70b-versatile':  'llama3.3',
    'llama-3.1-70b-versatile':  'llama3.1',
    'llama3-70b-8192':          'llama3',
    'llama3-8b-8192':           'llama3:8b',
    'mixtral-8x7b-32768':       'mixtral',
    'gemma2-9b-it':             'gemma2:9b',
};

// Audio models use a different endpoint/body format — no cloud-or-local fallback
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

// Returns the Ollama model tag to use: OLLAMA_MODEL env override → GROQ_TO_OLLAMA map → default llama3.2
function resolveOllamaModel(groqModel) {
    return process.env.OLLAMA_MODEL || GROQ_TO_OLLAMA[groqModel] || 'llama3.2';
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

// Returns true for errors that indicate the provider is unavailable — eligible for next fallback.
// 4xx client errors (bad request, auth, not found, etc.) are NOT eligible: they will fail on
// every provider and masking them would hide real request bugs.
function _isEligibleForFallback(error) {
    const status = error.response?.status;
    if (!status) return true;         // no response = connection/network failure
    if (status === 429) return true;  // rate-limited and all retries exhausted
    if (status >= 500) return true;   // server error
    return false;                     // 4xx and other client errors — rethrow as-is
}

// Returns true when a real API token appears to be present in the Authorization header.
// resolveAIToken() returns undefined when no key is set, producing 'Bearer undefined'.
// Detecting this avoids a round-trip to Groq that would always 401.
function _hasBearerToken(authHeader) {
    return typeof authHeader === 'string'
        && authHeader.startsWith('Bearer ')
        && !authHeader.includes('undefined')
        && authHeader.length > 10;
}

// Exported — three-tier fallback: Groq → OpenRouter → Ollama.
// Each tier is only attempted when the previous fails with a retriable error.
// If OLLAMA_BASE_URL is set and no Groq/OpenRouter keys are configured,
// Ollama is used as the sole provider (fully offline / sovereign mode).
// All existing callers use this function unchanged — the cascade is transparent.
async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    const groqModel = axiosConfig.data?.model;
    const isAudio = AUDIO_MODELS.has(groqModel);

    // Detect whether the caller injected a real Groq token.
    // Skip the Groq attempt entirely when no key is configured — avoids a guaranteed 401
    // and routes directly into the fallback chain (OpenRouter → Ollama).
    const authHeader = axiosConfig.config?.headers?.Authorization || '';
    const hasGroqToken = _hasBearerToken(authHeader);

    let lastError = null;

    // ── Tier 1: Groq ──────────────────────────────────────────────────────────
    if (hasGroqToken) {
        try {
            return await _groqCore(axiosConfig, maxRetries, serviceType);
        } catch (err) {
            // Audio models have no fallback path — Groq is the only provider
            if (isAudio) throw err;
            if (!_isEligibleForFallback(err)) throw err;
            lastError = err;
        }
    }

    // Audio models without a Groq token have no fallback path
    if (isAudio) {
        throw new Error('Audio transcription requires a valid GROQ API token (PLAYGROUND_AI_KEY or PLAYGROUND_GROQ_TOKEN)');
    }

    // ── Tier 2: OpenRouter ────────────────────────────────────────────────────
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (OPENROUTER_API_KEY) {
        const orModel = GROQ_TO_OPENROUTER[groqModel] || groqModel;
        logger.warn(
            { groqModel, orModel, groqStatus: lastError?.response?.status },
            lastError ? '🔀 LLM fallback: Groq → OpenRouter' : '⚡ LLM: no Groq token → OpenRouter'
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
            if (response.data?.usage) usageTracker.recordUsage(serviceType, response.data.usage);
            logger.info({ orModel }, '✅ OpenRouter fallback succeeded');
            return response;
        } catch (orError) {
            logger.error({ err: orError, orModel }, '❌ OpenRouter fallback failed');
            if (!_isEligibleForFallback(orError)) throw orError;
            lastError = orError;
            // fall through to Ollama
        }
    }

    // ── Tier 3: Ollama (sovereign / offline) ─────────────────────────────────
    const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
    if (OLLAMA_BASE_URL) {
        const ollamaModel = resolveOllamaModel(groqModel);
        logger.warn(
            { groqModel, ollamaModel, ollamaBase: OLLAMA_BASE_URL },
            lastError ? '🦙 LLM fallback: Ollama (sovereign tier)' : '⚡ LLM: no cloud keys → Ollama (offline mode)'
        );
        try {
            // Strip the upstream Authorization header — Ollama doesn't use API keys by default.
            // Re-add only if OLLAMA_API_KEY is explicitly configured (secured Ollama instances).
            const { Authorization: _stripped, ...baseHeaders } = axiosConfig.config?.headers || {};
            const ollamaHeaders = { ...baseHeaders, 'Content-Type': 'application/json' };
            if (process.env.OLLAMA_API_KEY) {
                ollamaHeaders.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
            }

            const ollamaData = { ...axiosConfig.data, model: ollamaModel };
            const ollamaConfig = {
                ...axiosConfig.config,
                headers: ollamaHeaders,
                timeout: (axiosConfig.config?.timeout ?? 30000) * 2, // Ollama can be slower
            };

            const response = await axios.post(
                `${OLLAMA_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`,
                ollamaData,
                ollamaConfig
            );
            if (response.data?.usage) usageTracker.recordUsage(serviceType, response.data.usage);
            logger.info({ ollamaModel }, '✅ Ollama fallback succeeded');
            return response;
        } catch (ollamaError) {
            logger.error({ err: ollamaError, ollamaModel }, '❌ Ollama fallback failed');
            throw ollamaError;
        }
    }

    // No providers available or all failed — throw the most recent error
    if (lastError) throw lastError;
    throw new Error(
        'No LLM provider configured. Set at least one of: PLAYGROUND_AI_KEY (Groq), OPENROUTER_API_KEY, or OLLAMA_BASE_URL.'
    );
}

module.exports = { resolveAIToken, resolveOllamaModel, groqWithRetry };
