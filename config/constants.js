/**
 * Centralized Constants & Configuration
 * Magic numbers extracted from index.js for easier tuning and maintenance
 * 
 * ANNOTATION FORMAT for externally-derived values:
 *   @source: Service/API name and tier
 *   @ref: Documentation URL
 *   @verified: Date last checked (YYYY-MM-DD)
 *   @bottleneck: true if this is the limiting factor for throughput
 * 
 * grep "@source" to find all external API dependencies
 * grep "@verified" to find values needing spec refresh
 */

// ==================== Time Base Units (milliseconds) ====================
// Use these instead of repeating math like 24 * 60 * 60 * 1000
const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000
};

// ==================== Timeouts (milliseconds) ====================
const TIMEOUTS = {
  DATABASE_CONNECTION: 30000,      // PostgreSQL connection timeout (cold start buffer)
  DATABASE_STATEMENT: 30000,       // Statement execution timeout
  
  // @source: Discord API
  // @ref: https://discord.com/developers/docs/topics/rate-limits
  // @verified: 2026-01-10
  DISCORD_CALL: 5000,              // Per Discord API call
  DISCORD_FETCH_BATCH: 30000,      // Batch message fetch from Discord
  
  // @source: Groq API
  // @ref: https://console.groq.com/docs/rate-limits
  // @verified: 2026-01-10
  GROQ_REQUEST: 15000,             // Groq API calls (text)
  
  SEARCH_REQUEST: 5000,            // DuckDuckGo / Brave search timeout
  
  // @source: Groq Whisper API
  // @ref: https://console.groq.com/docs/speech-text
  // @verified: 2026-01-10
  WHISPER_AUDIO: 30000,            // Groq Whisper audio transcription (large files)
  
  COMPRESSION_TASK: 3000,          // Image/file compression
  
  // @source: Twilio API
  // @ref: https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides
  // @verified: 2026-01-10
  TWILIO_WEBHOOK: 3000,            // Twilio webhook timeout (their default is 15s, we use 3s)
  
  SESSION_IDLE: 30000              // Session idle timeout
};

// ==================== Capacity & Rate Limits ====================
const CAPACITY = {
  // @source: Groq API (Free tier - shared across all playground users)
  // @ref: https://console.groq.com/docs/rate-limits
  // @verified: 2026-01-10
  // @bottleneck: true - primary throughput limiter
  // NOTE: These are internal soft caps for fair sharing, not Groq's limits
  TEXT_REQUESTS_PER_HOUR: 240,     // Internal cap for shared playground (conservative)
  VISION_REQUESTS_PER_HOUR: 120,   // Internal cap for vision (more compute-intensive)
  
  // @source: Brave Search API (Free tier)
  // @ref: https://brave.com/search/api/#pricing
  // @verified: 2026-01-10
  // @bottleneck: true - search augmentation limiter
  // NOTE: Internal cap; actual API limit varies by plan tier
  BRAVE_REQUESTS_PER_HOUR: 360,    // Internal cap for shared playground
  
  ACTIVE_USER_WINDOW_MS: 180 * TIME.MINUTE, // 180 minutes for active user tracking
  
  // Burst throttling
  BURST_THRESHOLD: 5,              // >5 requests in 15s triggers burst throttle
  BURST_WINDOW_MS: 15 * 1000,      // 15 second window for burst detection
  
  // Duplicate detection
  DUPLICATE_BLOCK_DURATION_MS: 60 * 1000, // 60 second block for duplicate prompts
  
  // Circuit breaker
  ABUSE_EVENT_THRESHOLD: 5,        // Events in 1 hour triggers cooldown
  ABUSE_COOLDOWN_MS: 30 * TIME.MINUTE, // 30 minute cooldown
  ABUSE_WINDOW_MS: TIME.HOUR, // 1 hour window for counting abuse
  ABUSE_WARNING_LEVELS: [3, 4],    // Progressive warnings at 3/5 and 4/5
  ABUSE_FORGIVENESS_HOURS: 1       // 1 hour of good behavior resets counter
};

// ==================== Caching ====================
const CACHE = {
  TTL_MS: TIME.DAY,    // 24 hour TTL for factual responses
  MAX_ENTRIES: 1000,               // Maximum cache entries (LRU eviction)
  QUERY_RATE_LIMIT_MS: TIME.MINUTE   // 1 minute between reputation DB lookups
};

// ==================== Session ====================
const SESSION = {
  MAX_AGE_MS: TIME.WEEK // 1 week session lifetime
};

// ==================== Discord ====================
const DISCORD = {
  // @source: Discord API
  // @ref: https://discord.com/developers/docs/resources/channel#get-channel-messages
  // @verified: 2026-01-10
  MAX_MESSAGE_FETCHES: 10,         // Fetch up to 10 batches (1000+ messages)
  THREAD_PAGINATION_LIMIT: 100     // Messages per fetch (Discord max: 100)
};

// ==================== LLM Backend Router ====================
// Priority: DEEPSEEK_API (DeepSeek R1) → Groq (Kimi K2)
// Both are OpenAI-compatible; swap URL + model + token at the call site.
const LLM_BACKENDS = {
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    // deepseek-reasoner generates chain-of-thought before answering — needs much longer timeouts
    timeouts: {
      reasoning: 120000,   // S2 main reasoning (think + answer)
      toolCall:   90000,   // seed-metric walk-the-dog rounds
      audit:      60000,   // two-pass audit
      extract:    10000    // core-question extraction (short, non-reasoning call)
    }
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'moonshotai/kimi-k2-instruct',
    timeouts: {
      reasoning: 15000,
      toolCall:  30000,
      audit:     15000,
      extract:    3000
    }
  }
};

function getLLMBackend() {
  return process.env.DEEPSEEK_API ? LLM_BACKENDS.deepseek : LLM_BACKENDS.groq;
}

// ==================== AI Models ====================
// @source: Groq API - Model availability changes with releases
// @ref: https://console.groq.com/docs/models
// @verified: 2026-01-10
const AI_MODELS = {
  TEXT_MODEL: 'moonshotai/kimi-k2-instruct',               // Groq fallback model
  VISION_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct', // Groq Vision model (2025)
  VISION: 'meta-llama/llama-4-scout-17b-16e-instruct',       // Alias for backward compatibility
  AUDIO_MODEL: 'whisper-large-v3-turbo',                     // Groq Whisper model
  
  // Temperature settings (H₀ protocol: 0.15 for reasoning, avoids hallucination)
  TEMPERATURE_REASONING: 0.15,     // For deterministic, fact-based responses
  TEMPERATURE_CREATIVE: 0.7,       // For creative responses (if used)
  
  // @source: Groq API token limits per model
  // @ref: https://console.groq.com/docs/models (context window varies by model)
  MAX_TOKENS: 1500,
  TOP_P: 0.95
};

// ==================== Groq Retry Strategy ====================
// @source: Groq API 429 behavior (rate limit response includes retry-after header)
// @ref: https://console.groq.com/docs/rate-limits
// @verified: 2026-01-10
const GROQ_RETRY = {
  TEXT_MAX_RETRIES: 3,             // Text queries: 3 retry attempts
  VISION_MAX_RETRIES: 2,           // Vision queries: 2 retry attempts (more expensive)
  BASE_DELAY_MS: 1000,             // Initial 1s delay (Groq retry-after typically 1-5s)
  MAX_DELAY_MS: 4000               // Cap at 4s (1s → 2s → 4s)
};

// ==================== Reputation System ====================
const REPUTATION = {
  COEFFICIENT: 0.3,               // Logarithmic growth speed
  BASE_MULTIPLIER: 1.0,            // Starting multiplier
  MAX_MULTIPLIER: 1.5,             // Cap at 50% cost reduction
  DAY_CAP_MULTIPLIER: Math.exp(0.3 * 100) // ~100 days to reach max
};

// ==================== File Uploads ====================
const FILE_UPLOAD = {
  // @source: Twilio WhatsApp media limits
  // @ref: https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages
  // @verified: 2026-01-10
  MAX_TOTAL_SIZE_MB: 50,           // 50MB total (Twilio limit: 16MB per message, we batch)
  
  // @source: Groq Vision API image requirements
  // @ref: https://console.groq.com/docs/vision
  // @verified: 2026-01-10
  MAX_DIMENSIONS_PX: 2048,         // Resize images to max 2048px (vision model optimal)
  JPEG_QUALITY: 0.85               // 85% JPEG quality for compression
};

// ==================== Playground (shared client/server) ====================
const PLAYGROUND = {
  MAX_ATTACHMENTS: 10,             // Maximum file attachments per message
  MAX_HISTORY_TURNS: 8,            // 8 turns = 16 messages (user + assistant)
  MAX_FILE_SIZE_MB: 25,            // Single file size limit
  SUPPORTED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  SUPPORTED_DOC_TYPES: ['application/pdf', 'text/plain', 'text/csv', 
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
};

// ==================== AI Audit (Nyan AI) ====================
const AUDIT = {
  MAX_MESSAGES: 2000,              // Maximum messages to sample for context (unified for both engines)
  MAX_PROMPT_CHARS: 100000,        // Maximum characters in prompt to LLM
  PROMPT_OVERHEAD_CHARS: 2000,     // Reserved chars for system prompt/formatting
  MESSAGE_TRUNCATE_LENGTH: 150,    // Truncate individual messages to this length in context
  
  // LLM call settings
  LLM_MAX_RETRIES: 3,              // Retry attempts for failed LLM calls
  LLM_TIMEOUT_MS: 60000,           // 60 second timeout for LLM calls
  LLM_RETRY_DELAYS: [1000, 2000, 4000], // Exponential backoff delays
  
  // Status emoji mapping (shared by Idris bot)
  STATUS_EMOJI: {
    'PASS': '✅',
    'FAIL': '❌',
    'WARNING': '⚠️',
    'REVIEW': '🔍',
    'NYAN': '🌈',
    'UNKNOWN': '❓'
  }
};

// ==================== Phi Breathe Orchestrator ====================
const PHI_BREATHE = {
  BASE_INTERVAL_MS: 4000,          // φ^0 = 4000ms base interval
  PHI: 1.618033988749895,          // Golden ratio φ
  MEMORY_CLEANUP_INTERVAL_MS: 15 * TIME.MINUTE,  // 15 minutes
  MEDIA_PURGE_INTERVAL_MS: TIME.DAY, // 24 hours
  DORMANCY_CLEANUP_INTERVAL_MS: TIME.DAY, // 24 hours
  SHARE_INVITE_CLEANUP_INTERVAL_MS: TIME.DAY, // 24 hours
  USAGE_CLEANUP_INTERVAL_MS: TIME.HOUR // 1 hour
};

// ==================== IP Geolocation Cache ====================
// @source: ip-api.com (free tier: 45 req/min)
// @ref: https://ip-api.com/docs/api:json
// @verified: 2026-01-10
const IP_GEO = {
  SUCCESS_TTL_MS: TIME.HOUR,  // 1 hour for successful lookups (reduce API calls)
  FAILURE_TTL_MS: 5 * TIME.MINUTE,   // 5 minutes for failed lookups
  REQUEST_TIMEOUT_MS: 3000         // 3 second timeout for API calls
};

// ==================== Miscellaneous ====================
const MISC = {
  PLAYROUND_GC_INTERVAL_MS: TIME.DAY, // 24 hour maintenance window
  MEDIA_PURGE_DAYS: 3,             // Clean media older than 3 days
  DORMANCY_CLEANUP_DAYS: 60,       // Revoke access after 60 days dormancy
  SHARE_INVITE_TIMEOUT_DAYS: 7,    // Expire share invites after 7 days if not registered
  GENESIS_BREATH_RATE: 0.618       // Golden ratio for Hermes breath cycles (φ)
};

module.exports = {
  TIME,
  TIMEOUTS,
  CAPACITY,
  CACHE,
  SESSION,
  DISCORD,
  AI_MODELS,
  GROQ_RETRY,
  REPUTATION,
  FILE_UPLOAD,
  PLAYGROUND,
  AUDIT,
  PHI_BREATHE,
  IP_GEO,
  MISC,
  LLM_BACKENDS,
  getLLMBackend
};
