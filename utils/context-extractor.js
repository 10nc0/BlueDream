/**
 * Context Extractor - Stage -1 Pre-processing
 * 
 * Extracts entities and metadata from conversation history (8-message window)
 * WITHOUT bleeding prior reasoning/answers into current query.
 * 
 * Now integrates with LocalMemoryManager for φ-compressed episodic memory:
 * - Every 2nd query → 5-sentence summary (5/8 ≈ 1/φ compression)
 * - Side-door attachment injection when referenced
 * - Human-like recall vs calculator-like entity extraction
 * 
 * Output is used for:
 * - Ticker resolution (when user says "stock price" and "netflix" was mentioned earlier)
 * - Topic continuity (understanding what domain we're discussing)
 * - Attachment context (knowing what files were uploaded previously)
 * - Memory context (natural language summary of conversation)
 */

const { getMemoryManager } = require('./memory-manager');

const KNOWN_COMPANIES = new Map([
  ['netflix', 'NFLX'],
  ['apple', 'AAPL'],
  ['google', 'GOOGL'],
  ['alphabet', 'GOOGL'],
  ['microsoft', 'MSFT'],
  ['amazon', 'AMZN'],
  ['meta', 'META'],
  ['facebook', 'META'],
  ['tesla', 'TSLA'],
  ['nvidia', 'NVDA'],
  ['amd', 'AMD'],
  ['intel', 'INTC'],
  ['disney', 'DIS'],
  ['walmart', 'WMT'],
  ['costco', 'COST'],
  ['starbucks', 'SBUX'],
  ['mcdonald', 'MCD'],
  ['mcdonalds', 'MCD'],
  ['coca-cola', 'KO'],
  ['coca cola', 'KO'],
  ['coke', 'KO'],
  ['pepsi', 'PEP'],
  ['pepsico', 'PEP'],
  ['jpmorgan', 'JPM'],
  ['boeing', 'BA'],
  ['ford', 'F'],
  ['uber', 'UBER'],
  ['lyft', 'LYFT'],
  ['paypal', 'PYPL'],
  ['salesforce', 'CRM'],
  ['adobe', 'ADBE'],
  ['oracle', 'ORCL'],
  ['ibm', 'IBM'],
  ['cisco', 'CSCO'],
  ['qualcomm', 'QCOM'],
  ['broadcom', 'AVGO'],
  ['shopify', 'SHOP'],
  ['spotify', 'SPOT'],
  ['airbnb', 'ABNB'],
  ['palantir', 'PLTR'],
  ['coinbase', 'COIN'],
  ['robinhood', 'HOOD'],
  ['zoom', 'ZM'],
  ['slack', 'WORK'],
  ['snap', 'SNAP'],
  ['snapchat', 'SNAP'],
  ['twitter', 'X'],
  ['x corp', 'X'],
  ['at&t', 'T'],
  ['verizon', 'VZ'],
  ['t-mobile', 'TMUS']
]);

const FINANCIAL_TOPICS = [
  'stock', 'stocks', 'share', 'shares', 'price', 'trend', 'analysis',
  'market', 'trading', 'invest', 'investment', 'dividend', 'earnings',
  'ema', 'psi', 'ψ', 'phi', 'φ', 'crossover', 'golden cross', 'death cross',
  'bullish', 'bearish', 'momentum', 'volatility', 'forecast', 'outlook'
];

/**
 * @typedef {Object} ContextEntity
 * @property {string} name - Entity name (e.g., "netflix")
 * @property {string|null} ticker - Inferred ticker if applicable
 * @property {string} type - Entity type: 'company' | 'ticker' | 'topic' | 'attachment'
 * @property {number} recency - Message index (0 = most recent)
 * @property {number} confidence - 0-1 confidence score
 */

/**
 * @typedef {Object} ContextResult
 * @property {ContextEntity[]} entities - Extracted entities with metadata
 * @property {string|null} inferredTicker - Best guess ticker from history
 * @property {string|null} dominantTopic - Primary topic detected
 * @property {Object[]} attachmentMeta - Attachment metadata from history
 * @property {boolean} hasFinancialContext - Whether financial discussion detected
 */

/**
 * Extract context from conversation history
 * 
 * @param {Array<{role: string, content: string}>} history - Conversation history (newest last)
 * @param {Array<Object>} attachmentHistory - Attachment metadata from history
 * @param {number} windowSize - Number of messages to consider (default 8)
 * @returns {ContextResult}
 */
function extractContext(history = [], attachmentHistory = [], windowSize = 8) {
  const result = {
    entities: [],
    inferredTicker: null,
    dominantTopic: null,
    attachmentMeta: [],
    hasFinancialContext: false
  };
  
  if (!history || history.length === 0) {
    return result;
  }
  
  // Take last N messages, prioritize user messages for entity extraction
  const recentHistory = history.slice(-windowSize);
  
  // Extract entities from USER messages only (no reasoning bleed from assistant)
  for (let i = 0; i < recentHistory.length; i++) {
    const msg = recentHistory[i];
    const recency = recentHistory.length - 1 - i; // 0 = most recent
    
    // Only extract from user messages to avoid reasoning bleed
    if (msg.role === 'user' && msg.content) {
      const extracted = extractEntitiesFromText(msg.content, recency);
      result.entities.push(...extracted);
    }
  }
  
  // Process attachment history
  if (attachmentHistory && attachmentHistory.length > 0) {
    const recentAttachments = attachmentHistory.slice(-windowSize);
    for (const att of recentAttachments) {
      if (att.name) {
        result.attachmentMeta.push({
          name: att.name,
          type: att.type || detectAttachmentType(att.name),
          timestamp: att.timestamp
        });
      }
    }
  }
  
  // Determine inferred ticker (most recent company mention with highest confidence)
  const tickerEntities = result.entities
    .filter(e => e.ticker && e.type === 'company')
    .sort((a, b) => {
      // Sort by recency first (lower = more recent), then confidence
      if (a.recency !== b.recency) return a.recency - b.recency;
      return b.confidence - a.confidence;
    });
  
  if (tickerEntities.length > 0) {
    result.inferredTicker = tickerEntities[0].ticker;
  }
  
  // Detect if financial context exists
  result.hasFinancialContext = result.entities.some(e => 
    e.type === 'topic' && FINANCIAL_TOPICS.includes(e.name.toLowerCase())
  ) || result.entities.some(e => e.type === 'company' || e.type === 'ticker');
  
  // Determine dominant topic
  const topicCounts = {};
  for (const entity of result.entities) {
    if (entity.type === 'topic') {
      topicCounts[entity.name] = (topicCounts[entity.name] || 0) + 1;
    }
  }
  const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
  if (sortedTopics.length > 0) {
    result.dominantTopic = sortedTopics[0][0];
  }
  
  return result;
}

/**
 * Extract entities from a single text message
 */
function extractEntitiesFromText(text, recency) {
  const entities = [];
  const lowerText = text.toLowerCase();
  
  // 1. Check for known company names
  for (const [company, ticker] of KNOWN_COMPANIES) {
    if (lowerText.includes(company)) {
      entities.push({
        name: company,
        ticker: ticker,
        type: 'company',
        recency,
        confidence: 0.9
      });
    }
  }
  
  // 2. Check for explicit $TICKER format
  const dollarTickers = text.match(/\$([A-Z]{1,5})\b/g);
  if (dollarTickers) {
    for (const match of dollarTickers) {
      const ticker = match.replace('$', '');
      entities.push({
        name: ticker,
        ticker: ticker,
        type: 'ticker',
        recency,
        confidence: 1.0
      });
    }
  }
  
  // 3. Check for financial topics
  for (const topic of FINANCIAL_TOPICS) {
    if (lowerText.includes(topic)) {
      entities.push({
        name: topic,
        ticker: null,
        type: 'topic',
        recency,
        confidence: 0.8
      });
    }
  }
  
  return entities;
}

/**
 * Detect attachment type from filename
 */
function detectAttachmentType(filename) {
  if (!filename) return 'unknown';
  const lower = filename.toLowerCase();
  
  if (lower.match(/\.(xlsx|xls|csv)$/)) return 'spreadsheet';
  if (lower.match(/\.(pdf)$/)) return 'pdf';
  if (lower.match(/\.(doc|docx)$/)) return 'document';
  if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/)) return 'image';
  if (lower.match(/\.(mp3|wav|m4a|ogg)$/)) return 'audio';
  
  return 'unknown';
}

/**
 * Merge context with current query for enhanced ticker detection
 * Returns combined text suitable for ticker extraction
 */
function mergeContextForTickerDetection(currentQuery, contextResult) {
  if (!contextResult || !contextResult.inferredTicker) {
    return currentQuery;
  }
  
  // If current query has financial keywords but no ticker, inject context
  const lowerQuery = (currentQuery || '').toLowerCase();
  const hasFinancialKeyword = FINANCIAL_TOPICS.some(t => lowerQuery.includes(t));
  
  if (hasFinancialKeyword && contextResult.inferredTicker) {
    // Prepend context hint for ticker detection
    return `[Context: discussing ${contextResult.inferredTicker}] ${currentQuery}`;
  }
  
  return currentQuery;
}

/**
 * Enhanced context extraction with φ-compressed memory
 * Combines entity extraction with human-like episodic memory
 * 
 * @param {string} sessionId - Session identifier (e.g., IP address)
 * @param {string} currentQuery - Current user query
 * @param {Array<{role: string, content: string}>} history - Conversation history
 * @param {Array<Object>} attachmentHistory - Attachment metadata
 * @param {Object|null} currentAttachment - Current query's attachment if any
 * @returns {Promise<Object>} Enhanced context result with memory
 */
async function extractContextWithMemory(sessionId, currentQuery, history = [], attachmentHistory = [], currentAttachment = null) {
  const memory = getMemoryManager(sessionId);
  
  // Sync attachment history to memory (ensures side-door can find older uploads)
  // Refresh existing entries if content changed (handles re-uploads)
  if (attachmentHistory && attachmentHistory.length > 0) {
    for (const att of attachmentHistory) {
      if (att.processedText && att.processedText.length > 0) {
        // Check if this attachment is already in memory (by name)
        const existingIndex = memory.attachments.findIndex(a => a.name === att.name);
        
        if (existingIndex >= 0) {
          // REFRESH: Update existing entry if content is different (re-upload case)
          const existing = memory.attachments[existingIndex];
          if (existing.extractedText !== att.processedText) {
            memory.attachments[existingIndex] = {
              id: Date.now(),
              name: att.name,
              type: att.type || 'document',
              extractedText: att.processedText,
              shortDesc: att.shortSummary || att.name,
              timestamp: Date.now()
            };
            console.log(`📎 Memory: Refreshed attachment "${att.name}" (${att.processedText.length} chars)`);
          }
        } else {
          // NEW: Add new attachment
          memory.attachments.push({
            id: Date.now(),
            name: att.name,
            type: att.type || 'document',
            extractedText: att.processedText,
            shortDesc: att.shortSummary || att.name,
            timestamp: Date.now()
          });
          console.log(`📎 Memory: Added attachment "${att.name}" (${att.processedText.length} chars)`);
        }
      }
    }
    // Keep only last 8 attachments
    while (memory.attachments.length > 8) {
      memory.attachments.shift();
    }
  }
  
  // Get entity-based context (existing logic)
  const entityContext = extractContext(history, attachmentHistory);
  
  // Check if we should generate a new summary (every 2nd query)
  const shouldSummarize = memory.shouldSummarize();
  
  if (shouldSummarize) {
    // Sync memory with current history before summarizing
    // This ensures memory has all messages up to now
    await memory.generateSummary();
  }
  
  // Get memory context for current query
  const memoryContext = memory.getContextForPrompt(currentQuery);
  
  // Build the memory prompt string
  const memoryPrompt = memory.buildMemoryPrompt(currentQuery);
  
  // Merge entity context with memory context
  return {
    // Entity-based (calculator-like)
    entities: entityContext.entities,
    inferredTicker: entityContext.inferredTicker,
    dominantTopic: entityContext.dominantTopic,
    hasFinancialContext: entityContext.hasFinancialContext,
    
    // Memory-based (human-like)
    memorySummary: memoryContext.memorySummary,
    memoryPrompt: memoryPrompt,
    attachmentContext: memoryContext.attachmentContext,
    hasMemory: memoryContext.hasMemory,
    
    // Stats
    memoryStats: memory.getStats()
  };
}

/**
 * Record a message exchange in memory (call after response is complete)
 * 
 * @param {string} sessionId - Session identifier
 * @param {string} userQuery - User's query
 * @param {string} assistantResponse - Assistant's response
 * @param {Object|null} attachment - Attachment metadata if any
 */
function recordInMemory(sessionId, userQuery, assistantResponse, attachment = null) {
  const memory = getMemoryManager(sessionId);
  
  // Add user message WITHOUT attachment (attachment was already synced in Stage -1 with full text)
  // This prevents truncated duplicates from overwriting the full extraction
  memory.addMessage('user', userQuery, null);
  
  // Add assistant response (truncate if very long)
  const truncatedResponse = assistantResponse.length > 1000 
    ? assistantResponse.slice(0, 1000) + '...[truncated]'
    : assistantResponse;
  memory.addMessage('assistant', truncatedResponse);
  
  console.log(`📝 Memory recorded: user (${userQuery.length} chars), assistant (${truncatedResponse.length} chars)`);
}

/**
 * Clear memory for a session (e.g., on "forget" command or clear chat)
 * @param {string} sessionId
 */
function clearSessionMemory(sessionId) {
  const { clearMemory } = require('./memory-manager');
  clearMemory(sessionId);
  console.log(`🧹 Memory cleared for session: ${sessionId}`);
}

module.exports = {
  extractContext,
  extractContextWithMemory,
  extractEntitiesFromText,
  mergeContextForTickerDetection,
  recordInMemory,
  clearSessionMemory,
  KNOWN_COMPANIES,
  FINANCIAL_TOPICS
};
