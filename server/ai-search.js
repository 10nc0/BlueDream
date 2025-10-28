const OpenAI = require('openai');

// This is using Replit's AI Integrations service, which provides OpenAI-compatible API access without requiring your own OpenAI API key.
// the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});

// True LRU cache for AI queries (cost optimization)
class SearchCache {
  constructor(maxSize = 100, ttlMinutes = 15) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMinutes * 60 * 1000; // Convert to ms
  }

  normalizeQuery(query) {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  get(query) {
    const key = this.normalizeQuery(query);
    const cached = this.cache.get(key);
    
    if (!cached) return null;
    
    // Check if expired
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    // LRU: Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, cached);
    
    return cached.value;
  }

  set(query, value) {
    const key = this.normalizeQuery(query);
    
    // Remove if already exists (to re-add at end)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // LRU: Remove least recently used if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }
}

const searchCache = new SearchCache();

/**
 * Database schema context for AI
 */
const DATABASE_SCHEMA = {
  messages: {
    columns: ['id', 'bot_id', 'sender_name', 'sender_id', 'message_content', 'message_type', 'timestamp', 'forward_status', 'error_message', 'media_url'],
    description: 'Contains all WhatsApp messages forwarded through bridges',
    message_types: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact'],
    forward_status: ['success', 'failed', 'pending']
  },
  bots: {
    columns: ['id', 'input_platform', 'output_platform', 'contact_info', 'tags'],
    description: 'Bridge configurations (WhatsApp to Discord, etc.)'
  }
};

/**
 * System prompt for AI search interpretation
 */
const SYSTEM_PROMPT = `You are a search query interpreter for a messaging bridge system called Nyan Bridge.

Your job is to analyze natural language search queries and extract structured search parameters.

Database Schema:
- messages table: ${DATABASE_SCHEMA.messages.description}
  Columns: ${DATABASE_SCHEMA.messages.columns.join(', ')}
  message_type values: ${DATABASE_SCHEMA.messages.message_types.join(', ')}
  forward_status values: ${DATABASE_SCHEMA.messages.forward_status.join(', ')}

Examples of queries you should handle:
- "messages from Giovanni last week" → sender_name contains "Giovanni", date range last 7 days
- "images sent in October" → message_type = 'image', date range October
- "failed deliveries today" → forward_status = 'failed', date range today
- "messages about project" → message_content contains "project"
- "videos from yesterday" → message_type = 'video', date range yesterday
- "all messages from +1234567890" → sender_id = '+1234567890'
- "stickers sent this month" → message_type = 'sticker', date range this month

Current date context: ${new Date().toISOString().split('T')[0]}

Respond in JSON format with:
{
  "intent": "brief description of what user wants",
  "filters": {
    "sender_name": "name pattern or null",
    "sender_id": "phone number or null",
    "message_content": "text to search in message content or null",
    "message_type": "one of the valid types or null",
    "forward_status": "success/failed/pending or null",
    "date_from": "YYYY-MM-DD or null",
    "date_to": "YYYY-MM-DD or null"
  },
  "date_context": "human readable date context like 'last week', 'October', 'today', etc. or null",
  "suggestions": ["array of 2-3 related search suggestions"]
}`;

/**
 * Interpret natural language search query using AI with 3-second timeout
 */
async function interpretSearchQuery(query) {
  try {
    // Check cache first
    const cached = searchCache.get(query);
    if (cached) {
      console.log('🎯 Using cached AI search result for:', query);
      return cached;
    }

    console.log('🤖 AI interpreting search query:', query);
    
    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 3000); // 3-second timeout
    
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini', // Fast and cost-effective for this use case
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: query }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 500
      }, {
        signal: abortController.signal
      });

      clearTimeout(timeoutId);

      const result = JSON.parse(completion.choices[0].message.content);
      
      // Cache the result
      searchCache.set(query, result);
      
      console.log('✅ AI interpretation:', result);
      return result;
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      // If aborted due to timeout, throw specific error
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        throw new Error('AI timeout');
      }
      throw error;
    }
    
  } catch (error) {
    console.error('❌ AI search interpretation failed:', error.message);
    throw error;
  }
}

/**
 * Validate and sanitize filters to prevent SQL injection
 */
function validateFilters(filters) {
  const validated = {};
  
  // Validate date formats
  if (filters.date_from) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRegex.test(filters.date_from)) {
      validated.dateFrom = filters.date_from;
    }
  }
  
  if (filters.date_to) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRegex.test(filters.date_to)) {
      validated.dateTo = filters.date_to;
    }
  }
  
  // Validate message_type
  if (filters.message_type && DATABASE_SCHEMA.messages.message_types.includes(filters.message_type)) {
    validated.messageType = filters.message_type;
  }
  
  // Validate forward_status
  if (filters.forward_status && DATABASE_SCHEMA.messages.forward_status.includes(filters.forward_status)) {
    validated.status = filters.forward_status;
  }
  
  // Sanitize text searches (remove dangerous characters)
  if (filters.sender_name) {
    validated.senderName = filters.sender_name.replace(/[;'"\\]/g, '');
  }
  
  if (filters.sender_id) {
    validated.senderId = filters.sender_id.replace(/[;'"\\]/g, '');
  }
  
  if (filters.message_content) {
    validated.q = filters.message_content.replace(/[;'"\\]/g, '');
  }
  
  return validated;
}

/**
 * Fallback to simple pattern-based search (when AI fails)
 */
function fallbackSearch(query) {
  console.log('⚠️ Falling back to pattern-based search');
  
  const result = {
    intent: `Search for: ${query}`,
    filters: {
      message_content: query
    },
    date_context: null,
    suggestions: [],
    fallback: true
  };
  
  // Try to extract common patterns
  const lowerQuery = query.toLowerCase();
  
  // Detect message types
  if (lowerQuery.includes('image') || lowerQuery.includes('photo') || lowerQuery.includes('picture')) {
    result.filters.message_type = 'image';
  } else if (lowerQuery.includes('video')) {
    result.filters.message_type = 'video';
  } else if (lowerQuery.includes('audio') || lowerQuery.includes('voice')) {
    result.filters.message_type = 'audio';
  }
  
  // Detect status
  if (lowerQuery.includes('failed') || lowerQuery.includes('error')) {
    result.filters.forward_status = 'failed';
  } else if (lowerQuery.includes('success')) {
    result.filters.forward_status = 'success';
  }
  
  return result;
}

module.exports = {
  interpretSearchQuery,
  validateFilters,
  fallbackSearch,
  searchCache
};
