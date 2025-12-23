/**
 * Stock Price Fetcher - Node.js wrapper for yfinance Python script
 * Fetches historical stock prices for Ψ-EMA analysis
 */

const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');

const DOLLAR_TICKER_REGEX = /\$([A-Za-z]{1,5})\b/gi;

// ========================================
// Ψ-EMA LEGO KEYS (Push-based 2/3 detection)
// If 2 out of 3 keys present → unlock Ψ-EMA gate
// ========================================

// KEY 1: VERBS (action words for stock analysis)
const PSI_EMA_VERBS = new Set([
  'analyze', 'analyse', 'diagnose', 'view', 'forecast', 'predict',
  'evaluate', 'assess', 'review', 'check', 'examine', 'show', 'get',
  'fetch', 'calculate', 'compute', 'determine', 'measure', 'track',
  'monitor', 'watch', 'study', 'inspect', 'investigate', 'scan',
  'lookup', 'find', 'search', 'query', 'pull', 'display', 'report'
]);

// KEY 2: ADJECTIVES (descriptive words for financial analysis)
const PSI_EMA_ADJECTIVES = new Set([
  'price', 'trend', 'wave', 'fourier', 'ema', 'momentum', 'volatility',
  'pattern', 'signal', 'chart', 'technical', 'stock', 'share', 'shares',
  'equity', 'market', 'trading', 'psi', 'phi', 'fibonacci', 'golden',
  'death', 'cross', 'convergence', 'divergence', 'bullish', 'bearish',
  'moving', 'average', 'resistance', 'support', 'breakout', 'breakdown',
  'overbought', 'oversold', 'rsi', 'macd', 'performance', 'outlook'
]);

// Words that look like tickers but aren't (blocklist)
const COMMON_NON_TICKERS = new Set([
  'EMA', 'SMA', 'RSI', 'MACD', 'USD', 'EUR', 'GBP', 'JPY', 'CNY',
  'AI', 'API', 'URL', 'USA', 'UK', 'EU', 'CEO', 'CFO', 'CTO',
  'NYSE', 'NASDAQ', 'ETF', 'IPO', 'SEC', 'GDP', 'CPI', 'FED',
  'FOR', 'THE', 'AND', 'BUT', 'NOT', 'ARE', 'WAS', 'HAS', 'HAD',
  'PSI', 'PHI', 'ETA', 'WHAT', 'IS', 'OF', 'TO', 'IN', 'ON', 'AT',
  'BY', 'WITH', 'FROM', 'AS', 'OR', 'IF', 'BE', 'SO', 'AN', 'IT',
  'MY', 'ME', 'WE', 'US', 'DO', 'GO', 'NO', 'UP', 'OUT', 'ALL',
  'CAN', 'YOU', 'YOUR', 'THIS', 'THAT', 'HOW', 'WHY', 'WHEN',
  'PLEASE', 'STOCK', 'STOCKS', 'PRICE', 'PRICES', 'CHART', 'CHARTS',
  'TREND', 'WAVE', 'SIGNAL', 'PATTERN', 'MARKET', 'SHARE', 'SHARES'
]);

// Single-letter tickers need $PREFIX to avoid false positives
const AMBIGUOUS_SINGLE_LETTERS = new Set(['A', 'B', 'C', 'D', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']);

// Common short English words that should NEVER be tickers (blocklist)
const COMMON_SHORT_WORDS = new Set([
  'DATA', 'INFO', 'HERE', 'THAT', 'JUST', 'SOME', 'MORE', 'LESS',
  'MUCH', 'MANY', 'VERY', 'ALSO', 'ONLY', 'EVEN', 'LIKE', 'RANGE',
  'GOOD', 'BEST', 'WELL', 'LAST', 'LONG', 'HIGH', 'LOW', 'NEW',
  'OLD', 'BIG', 'HUGE', 'REAL', 'TRUE', 'FULL', 'OPEN', 'NEXT',
  'BACK', 'OVER', 'SUCH', 'SAME', 'EACH', 'BOTH', 'MADE', 'BEEN',
  'COME', 'CAME', 'GONE', 'DONE', 'TOOK', 'MAKE', 'TAKE', 'GIVE',
  'GAVE', 'HELP', 'WANT', 'NEED', 'KNOW', 'KNEW', 'LOOK', 'WORK',
  'YEAR', 'WEEK', 'DAYS', 'TIME', 'LIFE', 'PART', 'CASE', 'IDEA',
  'FACT', 'FEEL', 'SAID', 'SAYS', 'TELL', 'TOLD', 'KEEP', 'KEPT',
  'CALL', 'FIND', 'FOUND', 'TALK', 'TURN', 'MOVE', 'LIVE', 'ABLE',
  'SHOW', 'SHOWS', 'VIEW', 'VIEWS', 'FETCH', 'PULL', 'PUSH', 'PLAN',
  'GOAL', 'TEST', 'TASK', 'ITEM', 'FILE', 'PAGE', 'SITE', 'CODE'
]);

// ========================================
// PUSH → PUSH → AUTHENTICATE PATTERN
// ========================================
// 1. PUSH verb key (if found)
// 2. PUSH adjective key (if found)
// 3. PUSH ticker key (if valid capitalized ticker found)
// 4. AUTHENTICATE: 2/3 keys + ticker required → unlock gate
// 
// TICKER PRIORITY ($format is highest confidence):
// Priority 1: $TICKER format (like $NVDA) - BYPASS all blocklists
// Priority 2: ALL-CAPS (like NVDA) - checked against blocklists
// Priority 3: Titlecase (like Nvda) - checked against blocklists
// Priority 4: lowercase - NEVER accepted (signals no intent)
// ========================================

/**
 * Detect potential stock ticker (KEY 3: OBJECT)
 * STRICT: Only accepts $TICKER, ALL-CAPS, or Titlecase (not lowercase)
 */
function detectPotentialTicker(query) {
  if (!query || typeof query !== 'string') return null;
  
  // Priority 1: $TICKER format (explicit, highest confidence)
  const dollarMatches = query.match(DOLLAR_TICKER_REGEX);
  if (dollarMatches && dollarMatches.length > 0) {
    const ticker = dollarMatches[0].replace('$', '').toUpperCase();
    if (ticker.length >= 1 && ticker.length <= 5) {
      return ticker;
    }
  }
  
  // Priority 2: ALL-CAPS words (NVDA, AAPL, ULTA)
  const allCapsWords = query.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const word of allCapsWords) {
    if (!COMMON_NON_TICKERS.has(word) && !COMMON_SHORT_WORDS.has(word)) {
      return word;
    }
  }
  
  // Priority 3: Titlecase words (Ulta, Nvda)
  const titleCaseWords = query.match(/\b[A-Z][a-z]{1,4}\b/g) || [];
  for (const word of titleCaseWords) {
    const upper = word.toUpperCase();
    if (!COMMON_NON_TICKERS.has(upper) && !COMMON_SHORT_WORDS.has(upper)) {
      return upper;
    }
  }
  
  // NO lowercase - require explicit capitalization or $prefix
  return null;
}

/**
 * Push-based Ψ-EMA key detection
 * Collects keys: verb, adjective, ticker (object)
 * IMPORTANT: Words used as verb/adjective are excluded from ticker detection
 * @returns {{ keys: Array, ticker: string|null, shouldTrigger: boolean }}
 */
function detectPsiEMAKeys(query) {
  if (!query || typeof query !== 'string') {
    return { keys: [], ticker: null, shouldTrigger: false };
  }
  
  const keys = [];
  const usedWords = new Set(); // Track words already used as verb/adjective
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.match(/\b[a-z]+\b/g) || [];
  
  // Push KEY 1: Verb
  for (const word of words) {
    if (PSI_EMA_VERBS.has(word)) {
      keys.push({ type: 'verb', value: word });
      usedWords.add(word.toUpperCase()); // Mark as used
      break; // Only need one
    }
  }
  
  // Push KEY 2: Adjective
  for (const word of words) {
    if (PSI_EMA_ADJECTIVES.has(word)) {
      keys.push({ type: 'adjective', value: word });
      usedWords.add(word.toUpperCase()); // Mark as used
      break; // Only need one
    }
  }
  
  // Push KEY 3: Ticker (Object) - EXCLUDE words already used as verb/adjective
  // If we have BOTH verb AND adjective (strong stock context), allow lowercase tickers
  const hasStrongContext = keys.length >= 2;
  const ticker = hasStrongContext 
    ? detectPotentialTickerWithContext(query, usedWords)  // Allow lowercase if strong context
    : detectPotentialTickerExcluding(query, usedWords);   // Require uppercase if weak context
  
  if (ticker) {
    keys.push({ type: 'object', value: ticker });
  }
  
  // 2/3 keys → unlock Ψ-EMA gate
  // BUT require at least one key to be an OBJECT (ticker) to prevent false positives
  // "show me chart" = verb + adj = 2 keys but NO ticker → LIMBO JUNK (non-negotiable)
  const hasTickerKey = keys.some(k => k.type === 'object');
  const shouldTrigger = keys.length >= 2 && hasTickerKey;
  
  // Log with helpful $format hint for limbo junk cases
  if (shouldTrigger) {
    console.log(`🔑 Ψ-EMA Keys: [${keys.map(k => `${k.type}:${k.value}`).join(', ')}] → ✅ UNLOCK`);
  } else if (keys.length >= 1 && !hasTickerKey) {
    // Has verb/adj but no ticker → limbo junk
    console.log(`🔑 Ψ-EMA Keys: [${keys.map(k => `${k.type}:${k.value}`).join(', ')}] → ❌ LIMBO JUNK (no ticker - try $TICKER format like $NVDA)`);
  } else {
    console.log(`🔑 Ψ-EMA Keys: [${keys.map(k => `${k.type}:${k.value}`).join(', ')}] → ❌ locked`);
  }
  
  return { keys, ticker, shouldTrigger };
}

/**
 * Detect potential ticker WITH strong context (verb + adjective present)
 * STILL requires capitalization - no lowercase tickers allowed
 * Same as without context - capitalization is the signal of intent
 */
function detectPotentialTickerWithContext(query, excludeWords) {
  // Same as strict version - capitalization is required regardless of context
  return detectPotentialTickerExcluding(query, excludeWords);
}

/**
 * Detect potential ticker WITHOUT strong context
 * STRICTER: Only accept uppercase/$prefix, no lowercase
 */
function detectPotentialTickerExcluding(query, excludeWords) {
  if (!query || typeof query !== 'string') return null;
  
  // Priority 1: $TICKER format (explicit, highest confidence)
  const dollarMatches = query.match(DOLLAR_TICKER_REGEX);
  if (dollarMatches && dollarMatches.length > 0) {
    const ticker = dollarMatches[0].replace('$', '').toUpperCase();
    if (ticker.length >= 1 && ticker.length <= 5) {
      return ticker;
    }
  }
  
  // Priority 2: ALL-CAPS words (NVDA, AAPL, ULTA) - user typed explicitly
  const allCapsWords = query.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const word of allCapsWords) {
    if (!COMMON_NON_TICKERS.has(word) && !excludeWords.has(word) && !COMMON_SHORT_WORDS.has(word)) {
      return word;
    }
  }
  
  // Priority 3: Titlecase words (Ulta, Nvda) - company name references
  const titleCaseWords = query.match(/\b[A-Z][a-z]{1,4}\b/g) || [];
  for (const word of titleCaseWords) {
    const upper = word.toUpperCase();
    if (!COMMON_NON_TICKERS.has(upper) && !excludeWords.has(upper) && !COMMON_SHORT_WORDS.has(upper)) {
      return upper;
    }
  }
  
  // NO lowercase words without strong context
  return null;
}

// Legacy function for backward compatibility
function detectStockTicker(query) {
  return detectPotentialTicker(query);
}

function isPsiEMAStockQuery(query) {
  const { shouldTrigger } = detectPsiEMAKeys(query);
  return shouldTrigger;
}

function fetchStockPrices(ticker) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'fetch-stock-prices.py');
    
    // Python script handles exact period strings: 3mo daily, 15mo weekly
    const python = spawn('python', [scriptPath, ticker]);
    
    let stdout = '';
    let stderr = '';
    
    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        return;
      }
      
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse stock data: ${e.message}`));
      }
    });
    
    python.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
    
    setTimeout(() => {
      python.kill();
      reject(new Error('Stock fetch timed out after 30 seconds'));
    }, 30000);
  });
}

/**
 * Calculate the age of stock data (most recent close date)
 * Returns { age, daysOld, isStale, timestamp, flag }
 */
function calculateDataAge(endDate) {
  if (!endDate || typeof endDate !== 'string') {
    return { age: 'UNKNOWN', daysOld: null, isStale: false, timestamp: endDate, flag: '⚠️' };
  }
  
  try {
    const dataDate = new Date(endDate);
    const now = new Date();
    
    // Normalize to midnight UTC for accurate day counting
    const dataTime = new Date(dataDate.getFullYear(), dataDate.getMonth(), dataDate.getDate());
    const nowTime = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const diffMs = nowTime - dataTime;
    const daysOld = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    let ageLabel, flag, isStale = false;
    if (daysOld === 0) {
      ageLabel = 'TODAY';
      flag = '✅';
    } else if (daysOld === 1) {
      ageLabel = 'YESTERDAY (1 day old)';
      flag = '⚠️';
      isStale = true;  // Weekend data might be expected, but note it
    } else if (daysOld <= 3) {
      ageLabel = `${daysOld} DAYS OLD`;
      flag = '⚠️';
      isStale = true;
    } else {
      ageLabel = `${daysOld} DAYS OLD (STALE)`;
      flag = '🚩';
      isStale = true;
    }
    
    return {
      age: ageLabel,
      daysOld,
      isStale,
      timestamp: endDate,
      flag
    };
  } catch (err) {
    return { age: 'ERROR', daysOld: null, isStale: false, timestamp: endDate, flag: '❌' };
  }
}

/**
 * AI-powered ticker extraction for company names
 * Uses fast Groq call to map "meta" → "META", "ford" → "F", etc.
 * Returns: { ticker: string, confidence: 'high'|'medium'|'low', reason: string } or null
 */
async function extractTickerWithAI(query) {
  if (!query || typeof query !== 'string') return null;
  if (!process.env.GROQ_API_KEY) {
    console.log('⚠️ AI ticker extraction skipped: No GROQ_API_KEY');
    return null;
  }
  
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are a stock ticker extraction assistant. Extract the stock ticker symbol from the user's query.

RULES:
1. Return ONLY a JSON object: {"ticker": "SYMBOL", "confidence": "high|medium|low", "reason": "brief explanation"}
2. For US stocks, return the NYSE/NASDAQ ticker (e.g., "meta" → "META", "ford" → "F", "apple" → "AAPL")
3. If query mentions commodities (gold, oil, silver), crypto (bitcoin, ethereum), or private companies → return {"ticker": null, "confidence": "high", "reason": "not a public stock"}
4. If unclear or no company mentioned → return {"ticker": null, "confidence": "low", "reason": "no company detected"}
5. confidence: "high" = certain match, "medium" = likely match, "low" = guess

EXAMPLES:
- "price analysis on meta stock" → {"ticker": "META", "confidence": "high", "reason": "Meta Platforms Inc"}
- "how is ford doing" → {"ticker": "F", "confidence": "high", "reason": "Ford Motor Company"}
- "gold price forecast" → {"ticker": null, "confidence": "high", "reason": "commodity, not a stock"}
- "what's the weather" → {"ticker": null, "confidence": "high", "reason": "no company mentioned"}`
          },
          { role: 'user', content: query }
        ],
        temperature: 0,
        max_tokens: 100
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    
    const content = response.data.choices[0]?.message?.content?.trim() || '';
    
    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`⚠️ AI ticker extraction: No JSON in response`);
      return null;
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    if (result.ticker && typeof result.ticker === 'string') {
      const ticker = result.ticker.toUpperCase().replace(/[^A-Z]/g, '');
      // Validate: non-empty, 1-5 chars, only letters
      if (ticker && ticker.length >= 1 && ticker.length <= 5 && /^[A-Z]+$/.test(ticker)) {
        console.log(`🤖 AI extracted ticker: ${ticker} (${result.confidence}) - ${result.reason}`);
        return { ticker, confidence: result.confidence || 'medium', reason: result.reason || '' };
      } else {
        console.log(`⚠️ AI returned invalid ticker format: "${result.ticker}" → "${ticker}"`);
      }
    }
    
    if (result.reason) {
      console.log(`🤖 AI ticker extraction: No ticker - ${result.reason}`);
    }
    return null;
    
  } catch (err) {
    console.log(`⚠️ AI ticker extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Smart ticker detection: Rule-based first, then AI fallback
 * Returns ticker string or null
 */
async function smartDetectTicker(query) {
  // Try rule-based detection first (fast, no API call)
  const ruleTicker = detectStockTicker(query);
  if (ruleTicker) {
    console.log(`📊 Rule-based ticker: ${ruleTicker}`);
    return ruleTicker;
  }
  
  // Check if query seems financial before calling AI
  const lowerQuery = (query || '').toLowerCase();
  const financialKeywords = ['stock', 'price', 'share', 'shares', 'market', 'trading', 'invest', 'analysis', 'forecast', 'outlook', 'ema', 'wave', 'psi', 'ψ'];
  const hasFinancialContext = financialKeywords.some(kw => lowerQuery.includes(kw));
  
  if (!hasFinancialContext) {
    return null;
  }
  
  // AI fallback for company name extraction
  const aiResult = await extractTickerWithAI(query);
  if (aiResult && aiResult.ticker) {
    return aiResult.ticker;
  }
  
  return null;
}

module.exports = {
  detectStockTicker,
  detectPotentialTicker,
  detectPsiEMAKeys,
  isPsiEMAStockQuery,
  fetchStockPrices,
  calculateDataAge,
  extractTickerWithAI,
  smartDetectTicker,
  COMMON_NON_TICKERS,
  PSI_EMA_VERBS,
  PSI_EMA_ADJECTIVES
};
