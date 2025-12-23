/**
 * LocalMemoryManager - φ-Compressed Episodic Memory
 * 
 * Provides human-like conversation recall:
 * - 8-message sliding window (raw recent messages)
 * - Every 2nd query → 5-sentence summary (φ ratio: 5/8 ≈ 1/φ)
 * - Attachment side-door for direct context injection
 * 
 * Output: Hybrid memory = episodic summaries + precise recent + attachment recall
 * 
 * Security: Uses hashed session IDs, enforces message size limits
 */

const axios = require('axios');
const crypto = require('crypto');

const MAX_MESSAGE_SIZE = 50000; // 50KB per message
const MAX_ATTACHMENT_TEXT_SIZE = 100000; // 100KB per attachment

/**
 * Hash session ID for privacy
 * @param {string} sessionId - Raw session ID (e.g., IP)
 * @returns {string} Hashed session key
 */
function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(`${sessionId}:nyan-memory`).digest('hex').slice(0, 16);
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SUMMARY_MODEL = 'llama-3.1-8b-instant';
const MAX_WINDOW = 8;
const SUMMARY_TRIGGER_INTERVAL = 2;
const MAX_SUMMARY_SENTENCES = 5;

const ATTACHMENT_REF_KEYWORDS = [
  'the document', 'that document', 'this document',
  'the file', 'that file', 'this file',
  'the pdf', 'that pdf', 'this pdf',
  'the report', 'that report', 'this report',
  'the data', 'that data', 'this data',
  'the attachment', 'that attachment',
  'the excel', 'the spreadsheet', 'the csv',
  'the image', 'that image', 'the photo',
  'uploaded', 'you analyzed', 'you extracted',
  'from earlier', 'from before', 'mentioned earlier'
];

class LocalMemoryManager {
  constructor(maxWindow = MAX_WINDOW) {
    this.maxWindow = maxWindow;
    this.messages = [];
    this.currentSummary = "";
    this.attachments = [];
    this.queryCount = 0;
    this.lastSummaryTime = null;
    this.nyanBooted = false;  // Track if full NYAN was injected this session
  }
  
  /**
   * Check if this is the first query (full NYAN needed)
   * After first query, subsequent queries use compressed NYAN
   * @returns {boolean} true if full NYAN should be injected
   */
  isFirstQuery() {
    return !this.nyanBooted;
  }
  
  /**
   * Mark NYAN as booted for this session
   * Call after first reasoning pass completes
   */
  markNyanBooted() {
    this.nyanBooted = true;
    console.log('🐱 NYAN Protocol booted for session');
  }

  /**
   * Add a message to the memory window
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message content
   * @param {Object|null} attachment - Optional attachment metadata
   */
  addMessage(role, content, attachment = null) {
    let safeContent = content;
    if (typeof content === 'string' && content.length > MAX_MESSAGE_SIZE) {
      safeContent = content.slice(0, MAX_MESSAGE_SIZE) + '... [truncated]';
      console.warn(`⚠️ Message truncated from ${content.length} to ${MAX_MESSAGE_SIZE} chars`);
    }
    
    this.messages.push({ 
      role, 
      content: safeContent,
      timestamp: Date.now()
    });

    if (attachment) {
      let extractedText = attachment.processedText || attachment.extractedText || '';
      if (extractedText.length > MAX_ATTACHMENT_TEXT_SIZE) {
        extractedText = extractedText.slice(0, MAX_ATTACHMENT_TEXT_SIZE) + '... [truncated]';
        console.warn(`⚠️ Attachment text truncated from ${(attachment.processedText || attachment.extractedText || '').length} to ${MAX_ATTACHMENT_TEXT_SIZE} chars`);
      }
      
      this.attachments.push({
        id: Date.now(),
        name: (attachment.name || 'unnamed').slice(0, 255),
        type: (attachment.type || 'unknown').slice(0, 100),
        extractedText,
        shortDesc: (attachment.shortSummary || attachment.summary || this._generateShortDesc(attachment)).slice(0, 500),
        timestamp: Date.now()
      });
    }

    if (this.messages.length > this.maxWindow) {
      this.messages.shift();
    }

    if (this.attachments.length > this.maxWindow) {
      this.attachments.shift();
    }
  }

  /**
   * Generate short description for attachment if not provided
   */
  _generateShortDesc(attachment) {
    const name = attachment.name || 'file';
    const type = attachment.type || '';
    const textLen = (attachment.processedText || attachment.extractedText || '').length;
    
    if (textLen > 0) {
      return `${name} (${type}, ${textLen} chars extracted)`;
    }
    return `${name} (${type})`;
  }

  /**
   * Check if summary should be generated (every 2nd user query)
   * @returns {boolean}
   */
  shouldSummarize() {
    this.queryCount++;
    return this.queryCount % SUMMARY_TRIGGER_INTERVAL === 0 && this.messages.length >= 2;
  }

  /**
   * Generate φ-compressed summary of conversation + attachments
   * Uses fast Groq model for low latency
   */
  async generateSummary() {
    if (this.messages.length === 0) {
      return this.currentSummary;
    }

    const conversationContext = this.messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const attachmentMentions = this.attachments.length > 0
      ? '\n\nAttachments in this conversation:\n' + this.attachments.map(a => 
          `- "${a.name}": ${a.shortDesc}`
        ).join('\n')
      : '';

    const prompt = `Summarize this conversation in up to ${MAX_SUMMARY_SENTENCES} sentences. Be concise but preserve key context.

MUST include:
1. Main topics discussed and any decisions/conclusions
2. Any documents/files uploaded and what they contained (key data points)
3. What the user seems to want or is asking about
4. Any specific entities mentioned (companies, people, numbers)

Conversation:
${conversationContext}
${attachmentMentions}

Write the summary as natural prose, not a list. Focus on what a helpful assistant would need to remember to continue this conversation naturally.`;

    try {
      const groqToken = process.env.PLAYGROUND_GROQ_TOKEN;
      if (!groqToken) {
        console.warn('⚠️ No GROQ token for memory summarization');
        return this.currentSummary;
      }
      
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: SUMMARY_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${groqToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      this.currentSummary = response.data?.choices?.[0]?.message?.content?.trim() || '';
      this.lastSummaryTime = Date.now();

      const keepCount = Math.min(4, this.messages.length);
      this.messages = this.messages.slice(-keepCount);
      this.queryCount = 0;

      console.log(`📝 Memory summarized: ${this.currentSummary.length} chars, kept ${keepCount} recent messages`);
      
      return this.currentSummary;
    } catch (error) {
      console.error('❌ Memory summary generation failed:', error.message);
      return this.currentSummary;
    }
  }

  /**
   * Check if query references attachments (side-door detection)
   * @param {string} query - Current user query
   * @returns {boolean}
   */
  _detectsAttachmentReference(query) {
    const lowerQuery = query.toLowerCase();
    return ATTACHMENT_REF_KEYWORDS.some(kw => lowerQuery.includes(kw));
  }

  /**
   * Find most relevant attachment for query
   * @param {string} query - Current user query
   * @returns {Object|null}
   */
  _findRelevantAttachment(query) {
    if (this.attachments.length === 0) return null;

    const lowerQuery = query.toLowerCase();
    
    for (const att of [...this.attachments].reverse()) {
      const nameLower = att.name.toLowerCase();
      if (lowerQuery.includes(nameLower.split('.')[0])) {
        return att;
      }
    }

    if (lowerQuery.includes('pdf') || lowerQuery.includes('document') || lowerQuery.includes('report')) {
      const pdfAtt = [...this.attachments].reverse().find(a => 
        a.type?.includes('pdf') || a.name?.toLowerCase().includes('.pdf')
      );
      if (pdfAtt) return pdfAtt;
    }

    if (lowerQuery.includes('excel') || lowerQuery.includes('spreadsheet') || lowerQuery.includes('csv')) {
      const excelAtt = [...this.attachments].reverse().find(a => 
        a.type?.includes('sheet') || a.type?.includes('excel') || 
        a.name?.toLowerCase().match(/\.(xlsx?|csv)$/)
      );
      if (excelAtt) return excelAtt;
    }

    if (lowerQuery.includes('image') || lowerQuery.includes('photo') || lowerQuery.includes('picture')) {
      const imgAtt = [...this.attachments].reverse().find(a => 
        a.type?.includes('image')
      );
      if (imgAtt) return imgAtt;
    }

    return this.attachments[this.attachments.length - 1];
  }

  /**
   * Get full context for prompt (summary + recent + side-door attachment)
   * @param {string} newQuery - Current user query
   * @returns {Object} Context object with memory and attachment data
   */
  getContextForPrompt(newQuery) {
    const result = {
      memorySummary: this.currentSummary || null,
      recentMessages: this.messages.slice(-4),
      attachmentContext: null,
      hasMemory: this.currentSummary?.length > 0 || this.messages.length > 0
    };

    if (this._detectsAttachmentReference(newQuery)) {
      const relevantAtt = this._findRelevantAttachment(newQuery);
      if (relevantAtt && relevantAtt.extractedText) {
        const maxChars = 4000;
        result.attachmentContext = {
          name: relevantAtt.name,
          type: relevantAtt.type,
          shortDesc: relevantAtt.shortDesc,
          content: relevantAtt.extractedText.slice(0, maxChars),
          truncated: relevantAtt.extractedText.length > maxChars
        };
        console.log(`📎 Side-door: Injecting attachment "${relevantAtt.name}" (${result.attachmentContext.content.length} chars)`);
      }
    }

    return result;
  }

  /**
   * Build memory context string for LLM prompt
   * @param {string} newQuery - Current user query
   * @returns {string}
   */
  buildMemoryPrompt(newQuery) {
    const ctx = this.getContextForPrompt(newQuery);
    let prompt = '';

    if (ctx.memorySummary) {
      prompt += `[CONVERSATION MEMORY]\n${ctx.memorySummary}\n\n`;
    }

    if (ctx.recentMessages.length > 0) {
      prompt += `[RECENT EXCHANGE]\n`;
      for (const msg of ctx.recentMessages) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const contentPreview = msg.content.length > 200 
          ? msg.content.slice(0, 200) + '...' 
          : msg.content;
        prompt += `${role}: ${contentPreview}\n`;
      }
      prompt += '\n';
    }

    if (ctx.attachmentContext) {
      prompt += `[REFERENCED DOCUMENT: ${ctx.attachmentContext.name}]\n`;
      prompt += `Type: ${ctx.attachmentContext.type}\n`;
      prompt += `Summary: ${ctx.attachmentContext.shortDesc}\n`;
      prompt += `Content:\n${ctx.attachmentContext.content}\n`;
      if (ctx.attachmentContext.truncated) {
        prompt += `[Content truncated - full document is longer]\n`;
      }
      prompt += '\n';
    }

    return prompt;
  }

  /**
   * Get attachment list for reference
   * @returns {Array}
   */
  getAttachmentList() {
    return this.attachments.map(a => ({
      name: a.name,
      type: a.type,
      shortDesc: a.shortDesc,
      hasContent: a.extractedText?.length > 0
    }));
  }

  /**
   * Get memory stats
   * @returns {Object}
   */
  getStats() {
    return {
      messageCount: this.messages.length,
      attachmentCount: this.attachments.length,
      hasSummary: this.currentSummary?.length > 0,
      summaryLength: this.currentSummary?.length || 0,
      queryCount: this.queryCount,
      lastSummaryTime: this.lastSummaryTime
    };
  }

  /**
   * Clear all memory (for new session)
   */
  clear() {
    this.messages = [];
    this.currentSummary = "";
    this.attachments = [];
    this.queryCount = 0;
    this.lastSummaryTime = null;
  }

  /**
   * Export memory state for persistence
   * @returns {Object}
   */
  export() {
    return {
      messages: this.messages,
      currentSummary: this.currentSummary,
      attachments: this.attachments.map(a => ({
        ...a,
        extractedText: a.extractedText?.slice(0, 2000)
      })),
      queryCount: this.queryCount,
      lastSummaryTime: this.lastSummaryTime
    };
  }

  /**
   * Import memory state from persistence
   * @param {Object} state
   */
  import(state) {
    if (state.messages) this.messages = state.messages;
    if (state.currentSummary) this.currentSummary = state.currentSummary;
    if (state.attachments) this.attachments = state.attachments;
    if (state.queryCount !== undefined) this.queryCount = state.queryCount;
    if (state.lastSummaryTime) this.lastSummaryTime = state.lastSummaryTime;
  }
}

const sessionMemories = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sessionId, manager] of sessionMemories) {
    const lastActivity = Math.max(
      manager.lastSummaryTime || 0,
      ...manager.messages.map(m => m.timestamp || 0),
      0
    );
    if (lastActivity > 0 && now - lastActivity > SESSION_TTL_MS) {
      sessionMemories.delete(sessionId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Auto-cleaned ${cleaned} expired memory sessions (TTL: ${SESSION_TTL_MS / 60000} min)`);
  }
}, 5 * 60 * 1000);

/**
 * Get or create memory manager for a session
 * @param {string} sessionId - Session identifier (e.g., IP address)
 * @param {boolean} useHash - Whether to hash the session ID (default: true)
 * @returns {LocalMemoryManager}
 */
function getMemoryManager(sessionId, useHash = true) {
  const key = useHash ? hashSessionId(sessionId) : sessionId;
  if (!sessionMemories.has(key)) {
    sessionMemories.set(key, new LocalMemoryManager());
  }
  return sessionMemories.get(key);
}

/**
 * Clear memory for a session
 * @param {string} sessionId
 * @param {boolean} useHash - Whether to hash the session ID (default: true)
 */
function clearMemory(sessionId, useHash = true) {
  const key = useHash ? hashSessionId(sessionId) : sessionId;
  if (sessionMemories.has(key)) {
    sessionMemories.get(key).clear();
    sessionMemories.delete(key);
  }
}

/**
 * Cleanup old sessions (call periodically)
 * @param {number} maxAgeMs - Max age in milliseconds (default 1 hour)
 */
function cleanupOldSessions(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [sessionId, manager] of sessionMemories) {
    const lastActivity = Math.max(
      manager.lastSummaryTime || 0,
      ...manager.messages.map(m => m.timestamp || 0)
    );
    if (now - lastActivity > maxAgeMs) {
      sessionMemories.delete(sessionId);
      console.log(`🧹 Cleaned up stale memory session: ${sessionId}`);
    }
  }
}

module.exports = {
  LocalMemoryManager,
  getMemoryManager,
  clearMemory,
  clearSession: clearMemory,
  cleanupOldSessions,
  hashSessionId,
  MAX_MESSAGE_SIZE,
  MAX_ATTACHMENT_TEXT_SIZE
};
