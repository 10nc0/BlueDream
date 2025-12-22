/**
 * Stock Price Fetcher - Node.js wrapper for yfinance Python script
 * Fetches historical stock prices for Ψ-EMA analysis
 */

const { spawn } = require('child_process');
const path = require('path');

const STOCK_TICKER_REGEX = /\b([A-Z]{1,5})\b/g;
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
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA',
  'BRK', 'JPM', 'V', 'MA', 'UNH', 'JNJ', 'WMT', 'PG', 'XOM', 'CVX',
  'HD', 'BAC', 'COST', 'PFE', 'ABBV', 'KO', 'PEP', 'TMO', 'AVGO',
  'MRK', 'CSCO', 'ACN', 'ABT', 'DHR', 'VZ', 'ADBE', 'CRM', 'NKE',
  'CMCSA', 'INTC', 'AMD', 'NFLX', 'QCOM', 'TXN', 'IBM', 'ORCL',
  'NOW', 'INTU', 'AMAT', 'PYPL', 'UBER', 'SQ', 'SHOP', 'SNAP',
  'PLTR', 'COIN', 'ROKU', 'ZM', 'DOCU', 'CRWD', 'NET', 'DDOG',
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'ARKK'
]);

function detectStockTicker(query) {
  if (!query || typeof query !== 'string') return null;
  
  const upperQuery = query.toUpperCase();
  const matches = upperQuery.match(STOCK_TICKER_REGEX) || [];
  
  for (const match of matches) {
    if (KNOWN_TICKERS.has(match)) {
      return match;
    }
  }
  
  for (const match of matches) {
    if (!COMMON_NON_TICKERS.has(match) && match.length >= 2 && match.length <= 5) {
      if (/^[A-Z]+$/.test(match)) {
        return match;
      }
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

function fetchStockPrices(ticker, days = 90) {
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

module.exports = {
  detectStockTicker,
  isPsiEMAStockQuery,
  fetchStockPrices,
  calculateDataAge,
  KNOWN_TICKERS,
  COMMON_NON_TICKERS
};
