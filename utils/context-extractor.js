/**
 * Context Extractor - Stage -1 Pre-processing
 * 
 * Responsibilities (PURE EXTRACTION, NO MODE DECISIONS):
 * - Extract entities from conversation history (companies, tickers, topics)
 * - Manage session memory (sliding window)
 * - Infer context from prior messages
 * 
 * Mode detection is delegated to preflight-router.js via mode-registry.js
 */

const { getMemoryManager } = require('./memory-manager');
const { detectAttachmentType } = require('./file-types');

const KNOWN_COMPANIES = new Map([
  ['netflix', 'NFLX'], ['apple', 'AAPL'], ['google', 'GOOGL'], ['alphabet', 'GOOGL'],
  ['microsoft', 'MSFT'], ['amazon', 'AMZN'], ['meta', 'META'], ['facebook', 'META'],
  ['tesla', 'TSLA'], ['nvidia', 'NVDA'], ['amd', 'AMD'], ['intel', 'INTC'],
  ['disney', 'DIS'], ['walmart', 'WMT'], ['costco', 'COST'], ['starbucks', 'SBUX'],
  ['mcdonald', 'MCD'], ['mcdonalds', 'MCD'], ['coca-cola', 'KO'], ['coca cola', 'KO'],
  ['coke', 'KO'], ['pepsi', 'PEP'], ['pepsico', 'PEP'], ['jpmorgan', 'JPM'],
  ['boeing', 'BA'], ['ford', 'F'], ['uber', 'UBER'], ['lyft', 'LYFT'],
  ['paypal', 'PYPL'], ['salesforce', 'CRM'], ['adobe', 'ADBE'], ['oracle', 'ORCL'],
  ['ibm', 'IBM'], ['cisco', 'CSCO'], ['qualcomm', 'QCOM'], ['broadcom', 'AVGO'],
  ['shopify', 'SHOP'], ['spotify', 'SPOT'], ['airbnb', 'ABNB'], ['palantir', 'PLTR'],
  ['coinbase', 'COIN'], ['robinhood', 'HOOD'], ['zoom', 'ZM'], ['slack', 'WORK'],
  ['snap', 'SNAP'], ['snapchat', 'SNAP'], ['twitter', 'X'], ['x corp', 'X'],
  ['at&t', 'T'], ['verizon', 'VZ'], ['t-mobile', 'TMUS']
]);

const FINANCIAL_TOPICS = [
  'stock', 'stocks', 'share', 'shares', 'price', 'trend', 'analysis',
  'market', 'trading', 'invest', 'investment', 'dividend', 'earnings',
  'ema', 'psi', 'ψ', 'phi', 'φ', 'crossover', 'golden cross', 'death cross',
  'bullish', 'bearish', 'momentum', 'volatility', 'forecast', 'outlook'
];

function extractContext(history = [], attachmentHistory = [], windowSize = 8) {
  const result = {
    entities: [],
    inferredTicker: null,
    dominantTopic: null,
    attachmentMeta: [],
    hasFinancialContext: false
  };
  
  if (!history || history.length === 0) return result;
  
  const recentHistory = history.slice(-windowSize);
  
  for (let i = 0; i < recentHistory.length; i++) {
    const msg = recentHistory[i];
    const recency = recentHistory.length - 1 - i;
    if (msg.role === 'user' && msg.content) {
      const extracted = extractEntitiesFromText(msg.content, recency);
      result.entities.push(...extracted);
    }
  }
  
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
  
  const tickerEntities = result.entities
    .filter(e => e.ticker && e.type === 'company')
    .sort((a, b) => (a.recency !== b.recency) ? a.recency - b.recency : b.confidence - a.confidence);
  
  if (tickerEntities.length > 0) result.inferredTicker = tickerEntities[0].ticker;
  
  result.hasFinancialContext = result.entities.some(e => 
    e.type === 'topic' && FINANCIAL_TOPICS.includes(e.name.toLowerCase())
  ) || result.entities.some(e => e.type === 'company' || e.type === 'ticker');
  
  const topicCounts = {};
  for (const entity of result.entities) {
    if (entity.type === 'topic') {
      topicCounts[entity.name] = (topicCounts[entity.name] || 0) + 1;
    }
  }
  const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
  if (sortedTopics.length > 0) result.dominantTopic = sortedTopics[0][0];
  
  return result;
}

function extractEntitiesFromText(text, recency) {
  const entities = [];
  const lowerText = text.toLowerCase();
  
  for (const [company, ticker] of KNOWN_COMPANIES) {
    if (lowerText.includes(company)) {
      entities.push({ name: company, ticker, type: 'company', recency, confidence: 0.9 });
    }
  }
  
  const dollarTickers = text.match(/\$([A-Z]{1,5})\b/g);
  if (dollarTickers) {
    for (const match of dollarTickers) {
      const ticker = match.replace('$', '');
      entities.push({ name: ticker, ticker, type: 'ticker', recency, confidence: 1.0 });
    }
  }
  
  for (const topic of FINANCIAL_TOPICS) {
    if (lowerText.includes(topic)) {
      entities.push({ name: topic, ticker: null, type: 'topic', recency, confidence: 0.8 });
    }
  }
  
  return entities;
}


function mergeContextForTickerDetection(currentQuery, contextResult) {
  if (!contextResult || !contextResult.inferredTicker) return currentQuery;
  const lowerQuery = (currentQuery || '').toLowerCase();
  const hasFinancialKeyword = FINANCIAL_TOPICS.some(t => lowerQuery.includes(t));
  if (hasFinancialKeyword && contextResult.inferredTicker) {
    return `[Context: discussing ${contextResult.inferredTicker}] ${currentQuery}`;
  }
  return currentQuery;
}

async function extractContextWithMemory(sessionId, currentQuery, history = [], attachmentHistory = [], currentAttachment = null) {
  const memory = getMemoryManager(sessionId);
  
  if (attachmentHistory && attachmentHistory.length > 0) {
    for (const att of attachmentHistory) {
      if (att.processedText && att.processedText.length > 0) {
        const existingIndex = memory.attachments.findIndex(a => a.name === att.name);
        if (existingIndex >= 0) {
          const existing = memory.attachments[existingIndex];
          if (existing.extractedText !== att.processedText) {
            memory.attachments[existingIndex] = {
              id: Date.now(), name: att.name, type: att.type || 'document',
              extractedText: att.processedText, shortDesc: att.shortSummary || att.name, timestamp: Date.now()
            };
          }
        } else {
          memory.attachments.push({
            id: Date.now(), name: att.name, type: att.type || 'document',
            extractedText: att.processedText, shortDesc: att.shortSummary || att.name, timestamp: Date.now()
          });
        }
      }
    }
    while (memory.attachments.length > 8) memory.attachments.shift();
  }
  
  const entityContext = extractContext(history, attachmentHistory);
  if (memory.shouldSummarize()) await memory.generateSummary();
  
  const memoryContext = memory.getContextForPrompt(currentQuery);
  const memoryPrompt = memory.buildMemoryPrompt(currentQuery);
  

  return {
    entities: entityContext.entities,
    inferredTicker: entityContext.inferredTicker,
    dominantTopic: entityContext.dominantTopic,
    hasFinancialContext: entityContext.hasFinancialContext,
    memorySummary: memoryContext.memorySummary,
    memoryPrompt: memoryPrompt,
    attachmentContext: memoryContext.attachmentContext,
    hasMemory: memoryContext.hasMemory,
    memoryStats: memory.getStats()
  };
}

function recordInMemory(sessionId, userQuery, assistantResponse, attachment = null) {
  const memory = getMemoryManager(sessionId);
  memory.addMessage('user', userQuery, null);
  const truncatedResponse = assistantResponse.length > 1000 ? assistantResponse.slice(0, 1000) + '...[truncated]' : assistantResponse;
  memory.addMessage('assistant', truncatedResponse);
}

function clearSessionMemory(sessionId) {
  const { clearMemory } = require('./memory-manager');
  clearMemory(sessionId);
}

function isSessionFirstQuery(sessionId) {
  const memory = getMemoryManager(sessionId);
  return memory.isFirstQuery();
}

function markSessionNyanBooted(sessionId) {
  const memory = getMemoryManager(sessionId);
  memory.markNyanBooted();
}

module.exports = {
  extractContext, extractContextWithMemory, extractEntitiesFromText,
  mergeContextForTickerDetection, recordInMemory, clearSessionMemory,
  isSessionFirstQuery, markSessionNyanBooted, KNOWN_COMPANIES, FINANCIAL_TOPICS
};
