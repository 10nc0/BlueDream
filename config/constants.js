/**
 * Centralized Constants & Configuration
 * Magic numbers extracted from index.js for easier tuning and maintenance
 */

// ==================== Timeouts (milliseconds) ====================
const TIMEOUTS = {
  DATABASE_CONNECTION: 30000,      // PostgreSQL connection timeout (cold start buffer)
  DATABASE_STATEMENT: 30000,       // Statement execution timeout
  DISCORD_CALL: 5000,              // Per Discord API call
  DISCORD_FETCH_BATCH: 30000,      // Batch message fetch from Discord
  GROQ_REQUEST: 15000,             // Groq API calls (text)
  SEARCH_REQUEST: 5000,            // DuckDuckGo / Brave search timeout
  WHISPER_AUDIO: 30000,            // Groq Whisper audio transcription
  COMPRESSION_TASK: 3000,          // Image/file compression
  TWILIO_WEBHOOK: 3000,            // Twilio API calls
  SESSION_IDLE: 30000              // Session idle timeout
};

// ==================== Capacity & Rate Limits ====================
const CAPACITY = {
  TEXT_REQUESTS_PER_HOUR: 240,     // Global text query capacity
  VISION_REQUESTS_PER_HOUR: 120,   // Global vision/photo capacity
  BRAVE_REQUESTS_PER_HOUR: 360,    // Global Brave search capacity
  ACTIVE_USER_WINDOW_MS: 180 * 60 * 1000, // 180 minutes for active user tracking
  
  // Burst throttling
  BURST_THRESHOLD: 5,              // >5 requests in 15s triggers burst throttle
  BURST_WINDOW_MS: 15 * 1000,      // 15 second window for burst detection
  
  // Duplicate detection
  DUPLICATE_BLOCK_DURATION_MS: 60 * 1000, // 60 second block for duplicate prompts
  
  // Circuit breaker
  ABUSE_EVENT_THRESHOLD: 5,        // Events in 1 hour triggers cooldown
  ABUSE_COOLDOWN_MS: 30 * 60 * 1000, // 30 minute cooldown
  ABUSE_WINDOW_MS: 60 * 60 * 1000, // 1 hour window for counting abuse
  ABUSE_WARNING_LEVELS: [3, 4],    // Progressive warnings at 3/5 and 4/5
  ABUSE_FORGIVENESS_HOURS: 1       // 1 hour of good behavior resets counter
};

// ==================== Caching ====================
const CACHE = {
  TTL_MS: 24 * 60 * 60 * 1000,    // 24 hour TTL for factual responses
  MAX_ENTRIES: 1000,               // Maximum cache entries (LRU eviction)
  QUERY_RATE_LIMIT_MS: 60 * 1000   // 1 minute between reputation DB lookups
};

// ==================== Session ====================
const SESSION = {
  MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000 // 1 week session lifetime
};

// ==================== Discord ====================
const DISCORD = {
  MAX_MESSAGE_FETCHES: 10,         // Fetch up to 10 batches (1000+ messages)
  THREAD_PAGINATION_LIMIT: 100     // Messages per fetch
};

// ==================== AI Models ====================
const AI_MODELS = {
  TEXT_MODEL: 'llama-3.3-70b-versatile',
  VISION_MODEL: 'llama-3.2-11b-vision-preview', // Vision-capable model for image analysis
  VISION: 'llama-3.2-11b-vision-preview',       // Alias for backward compatibility
  AUDIO_MODEL: 'whisper-large-v3-turbo',
  
  // Temperature settings (H₀ protocol: 0.15 for reasoning, avoids hallucination)
  TEMPERATURE_REASONING: 0.15,     // For deterministic, fact-based responses
  TEMPERATURE_CREATIVE: 0.7,       // For creative responses (if used)
  
  MAX_TOKENS: 1500,
  TOP_P: 0.95
};

// ==================== Groq Retry Strategy ====================
const GROQ_RETRY = {
  TEXT_MAX_RETRIES: 3,             // Text queries: 3 retry attempts
  VISION_MAX_RETRIES: 2,           // Vision queries: 2 retry attempts
  BASE_DELAY_MS: 1000,             // Initial 1s delay
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
  MAX_TOTAL_SIZE_MB: 50,           // 50MB total attachment limit
  MAX_DIMENSIONS_PX: 2048,         // Resize images to max 2048px
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

// ==================== Miscellaneous ====================
const MISC = {
  PLAYROUND_GC_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hour maintenance window
  MEDIA_PURGE_DAYS: 3,             // Clean media older than 3 days
  DORMANCY_CLEANUP_DAYS: 60,       // Revoke access after 60 days dormancy
  GENESIS_BREATH_RATE: 0.618       // Golden ratio for Hermes breath cycles (φ)
};

module.exports = {
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
  MISC
};
