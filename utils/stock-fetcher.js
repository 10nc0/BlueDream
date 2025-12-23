/**
 * Stock Price Fetcher - Node.js wrapper for yfinance Python script
 * Fetches historical stock prices for Ψ-EMA analysis
 */

const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');

const STOCK_TICKER_REGEX = /\b([A-Z]{1,5})\b/g;
const DOLLAR_TICKER_REGEX = /\$([A-Z]{1,5})\b/gi;
const COMMON_NON_TICKERS = new Set([
  'EMA', 'SMA', 'RSI', 'MACD', 'USD', 'EUR', 'GBP', 'JPY', 'CNY',
  'AI', 'API', 'URL', 'USA', 'UK', 'EU', 'CEO', 'CFO', 'CTO',
  'NYSE', 'NASDAQ', 'ETF', 'IPO', 'SEC', 'GDP', 'CPI', 'FED',
  'FOR', 'THE', 'AND', 'BUT', 'NOT', 'ARE', 'WAS', 'HAS', 'HAD',
  'PSI', 'PHI', 'ETA', 'WHAT', 'IS', 'OF', 'TO', 'IN', 'ON', 'AT',
  'BY', 'WITH', 'FROM', 'AS', 'OR', 'IF', 'BE', 'SO', 'AN', 'IT',
  'MY', 'ME', 'WE', 'US', 'DO', 'GO', 'NO', 'UP', 'OUT', 'ALL',
  'STOCK', 'STOCKS', 'PRICE', 'PRICES', 'CHART', 'CHARTS'
]);

const KNOWN_TICKERS = new Set([
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'TSLA',
  'BRK', 'JPM', 'UNH', 'JNJ', 'WMT', 'PG', 'XOM', 'CVX',
  'HD', 'BAC', 'PFE', 'ABBV', 'KO', 'PEP', 'TMO', 'AVGO',
  'MRK', 'CSCO', 'ACN', 'ABT', 'DHR', 'VZ', 'ADBE', 'CRM', 'NKE',
  'CMCSA', 'INTC', 'AMD', 'NFLX', 'QCOM', 'TXN', 'IBM', 'ORCL',
  'INTU', 'AMAT', 'PYPL', 'UBER', 'SQ', 'PLTR', 'COIN', 'ROKU',
  'ZM', 'DOCU', 'CRWD', 'DDOG', 'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'ARKK',
  'ASML', 'LMT', 'RTX', 'BA', 'CAT', 'DE', 'UPS', 'FDX', 'DIS', 'SBUX'
]);

const AMBIGUOUS_TICKERS = new Set([
  'META', 'COST', 'SHOP', 'SNAP', 'NOW', 'NET', 'V', 'MA', 'F', 'T', 'X', 'C', 'A', 'D', 'K', 'M', 'W', 'Y', 'Z'
]);

function detectStockTicker(query) {
  if (!query || typeof query !== 'string') return null;
  
  // Priority 1: Check for $TICKER format (e.g., $META, $SBUX, $meta) - highest priority
  // This is the ONLY way to match ambiguous tickers (META, COST, SHOP, etc.)
  const dollarMatches = query.match(DOLLAR_TICKER_REGEX);
  if (dollarMatches && dollarMatches.length > 0) {
    const ticker = dollarMatches[0].replace('$', '').toUpperCase();
    if (ticker.length >= 1 && ticker.length <= 5) {
      return ticker;
    }
  }
  
  // Priority 2: Check for KNOWN tickers in any case (safe because they're whitelisted)
  // This allows "nvda", "NVDA", "Nvda" to all work
  const words = query.match(/\b[A-Za-z]{2,5}\b/g) || [];
  for (const word of words) {
    const upper = word.toUpperCase();
    // Skip ambiguous tickers - they need $PREFIX
    if (AMBIGUOUS_TICKERS.has(upper)) {
      continue;
    }
    // Match known unambiguous tickers
    if (KNOWN_TICKERS.has(upper)) {
      return upper;
    }
  }
  
  // Priority 3: Unknown but valid-looking UPPERCASE tickers (user typed in caps)
  // Only match all-caps words to avoid false positives on common words
  const originalUppercaseWords = query.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const word of originalUppercaseWords) {
    if (AMBIGUOUS_TICKERS.has(word)) {
      continue;
    }
    if (!COMMON_NON_TICKERS.has(word)) {
      return word;
    }
  }
  
  return null;
}

function isPsiEMAStockQuery(query) {
  if (!query || typeof query !== 'string') return false;
  
  const lowerQuery = query.toLowerCase();
  const hasPsiEMA = /(?:psi|ψ|phi|φ)\s*[-]?\s*ema/i.test(query) ||
                    /ema\s*(?:for|of|on)/i.test(query) ||
                    /(?:crossover|golden\s*cross|death\s*cross)/i.test(query);
  
  const ticker = detectStockTicker(query);
  
  return hasPsiEMA && ticker !== null;
}

function fetchStockPrices(ticker, days = 365) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'fetch-stock-prices.py');
    
    const python = spawn('python', [scriptPath, ticker, days.toString()]);
    
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
  isPsiEMAStockQuery,
  fetchStockPrices,
  calculateDataAge,
  extractTickerWithAI,
  smartDetectTicker,
  KNOWN_TICKERS,
  COMMON_NON_TICKERS,
  AMBIGUOUS_TICKERS
};
