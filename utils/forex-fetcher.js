/**
 * Forex Fetcher - Currency exchange rate data using fawazahmed0 API
 * 
 * Free API with zero rate limits, no API key required.
 * CDN-backed (jsDelivr + Cloudflare) for reliability.
 * 
 * Source: https://github.com/fawazahmed0/exchange-api
 */

const axios = require('axios');

const FOREX_API_BASE = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1';
const FOREX_API_FALLBACK = 'https://latest.currency-api.pages.dev/v1';

const COMMON_FOREX_PAIRS = [
  'USDJPY', 'EURUSD', 'GBPUSD', 'USDCHF', 'AUDUSD', 'USDCAD',
  'NZDUSD', 'EURJPY', 'GBPJPY', 'EURGBP', 'AUDJPY', 'CADJPY',
  'EURCAD', 'EURAUD', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPNZD',
  'AUDCAD', 'AUDNZD', 'NZDCAD', 'USDSGD', 'USDHKD', 'USDCNY',
  'USDKRW', 'USDTHB', 'USDMYR', 'USDINR', 'USDPHP', 'USDIDR',
  'USDTWD', 'USDMXN', 'USDBRL', 'USDZAR', 'USDTRY', 'USDPLN',
  'USDSEK', 'USDNOK', 'USDDKK', 'USDCZK', 'USDHUF', 'USDRUB'
];

const CURRENCY_NAMES = {
  USD: 'US Dollar',
  EUR: 'Euro',
  JPY: 'Japanese Yen',
  GBP: 'British Pound',
  CHF: 'Swiss Franc',
  AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar',
  NZD: 'New Zealand Dollar',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  CNY: 'Chinese Yuan',
  KRW: 'South Korean Won',
  THB: 'Thai Baht',
  MYR: 'Malaysian Ringgit',
  INR: 'Indian Rupee',
  PHP: 'Philippine Peso',
  IDR: 'Indonesian Rupiah',
  TWD: 'Taiwan Dollar',
  MXN: 'Mexican Peso',
  BRL: 'Brazilian Real',
  ZAR: 'South African Rand',
  TRY: 'Turkish Lira',
  PLN: 'Polish Zloty',
  SEK: 'Swedish Krona',
  NOK: 'Norwegian Krone',
  DKK: 'Danish Krone',
  CZK: 'Czech Koruna',
  HUF: 'Hungarian Forint',
  RUB: 'Russian Ruble'
};

const ISO_4217_CURRENCIES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS',
  'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
  'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU',
  'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK',
  'SGD', 'SHP', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'THB',
  'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX',
  'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XOF',
  'XPF', 'YER', 'ZAR', 'ZMW', 'ZWL'
]);

function isValidCurrency(code) {
  return ISO_4217_CURRENCIES.has(code);
}

/**
 * Detect forex pair from query
 * Supports formats: USD/JPY, USDJPY, usd jpy, "yen", "dollar to yen"
 * 
 * Pair-agnostic: accepts any valid 3-letter currency pair (A-Z{3}/A-Z{3})
 * API response will tell us if the pair is invalid
 * 
 * @param {string} query - User's query
 * @returns {Object|null} { base, quote, pair } or null if not forex
 */
function detectForexPair(query) {
  if (!query) return null;
  
  const upper = query.toUpperCase();
  const lower = query.toLowerCase();
  
  // Pattern 1: Direct pair notation (USDJPY, USD/JPY, USD-JPY, EUR CHF)
  // Validate against ISO 4217 currency codes to prevent false positives
  const directMatch = upper.match(/\b([A-Z]{3})[\/\-\s]?([A-Z]{3})\b/);
  if (directMatch) {
    const base = directMatch[1];
    const quote = directMatch[2];
    // Validate both are real ISO 4217 currencies and not same currency
    if (base !== quote && isValidCurrency(base) && isValidCurrency(quote)) {
      return {
        base: base,
        quote: quote,
        pair: base + quote
      };
    }
  }
  
  // Pattern 2: Natural language ("dollar to yen", "yen rate", "usd jpy")
  const currencyAliases = {
    'dollar': 'USD', 'usd': 'USD', 'buck': 'USD', 'bucks': 'USD',
    'yen': 'JPY', 'jpy': 'JPY', 'japanese yen': 'JPY',
    'euro': 'EUR', 'eur': 'EUR', 'euros': 'EUR',
    'pound': 'GBP', 'gbp': 'GBP', 'sterling': 'GBP', 'quid': 'GBP',
    'franc': 'CHF', 'chf': 'CHF', 'swiss franc': 'CHF',
    'aussie': 'AUD', 'aud': 'AUD', 'australian dollar': 'AUD',
    'loonie': 'CAD', 'cad': 'CAD', 'canadian dollar': 'CAD',
    'kiwi': 'NZD', 'nzd': 'NZD', 'new zealand dollar': 'NZD',
    'sing dollar': 'SGD', 'sgd': 'SGD', 'singapore dollar': 'SGD',
    'yuan': 'CNY', 'cny': 'CNY', 'renminbi': 'CNY', 'rmb': 'CNY',
    'won': 'KRW', 'krw': 'KRW', 'korean won': 'KRW',
    'rupee': 'INR', 'inr': 'INR', 'indian rupee': 'INR'
  };
  
  // Find all currencies mentioned
  const foundCurrencies = [];
  for (const [alias, code] of Object.entries(currencyAliases)) {
    if (lower.includes(alias)) {
      foundCurrencies.push(code);
    }
  }
  
  // Remove duplicates and limit to first 2
  const uniqueCurrencies = [...new Set(foundCurrencies)].slice(0, 2);
  
  if (uniqueCurrencies.length === 2) {
    const [base, quote] = uniqueCurrencies;
    return {
      base,
      quote,
      pair: base + quote
    };
  }
  
  // Single currency mentioned - assume vs USD
  if (uniqueCurrencies.length === 1 && uniqueCurrencies[0] !== 'USD') {
    return {
      base: 'USD',
      quote: uniqueCurrencies[0],
      pair: 'USD' + uniqueCurrencies[0]
    };
  }
  
  return null;
}

/**
 * Detect if query is about forex/currency
 * 
 * @param {string} query - User's query
 * @returns {boolean}
 */
function isForexQuery(query) {
  if (!query) return false;
  const lower = query.toLowerCase();
  
  const forexKeywords = [
    'forex', 'fx', 'currency', 'exchange rate', 'exchange rates',
    'usd', 'jpy', 'eur', 'gbp', 'dollar', 'yen', 'euro', 'pound',
    'to yen', 'to dollar', 'to euro', 'vs dollar', 'vs yen',
    'dollar rate', 'yen rate', 'forex rate', 'currency rate',
    'how much is', 'what is 1', 'convert'
  ];
  
  return forexKeywords.some(kw => lower.includes(kw));
}

/**
 * Fetch forex rate from fawazahmed0 API
 * 
 * @param {string} base - Base currency (e.g., 'USD')
 * @param {string} quote - Quote currency (e.g., 'JPY')
 * @returns {Promise<Object>} Forex data
 */
async function fetchForexRate(base, quote) {
  const baseLower = base.toLowerCase();
  const quoteLower = quote.toLowerCase();
  
  let data = null;
  let error = null;
  
  // Try primary CDN first
  try {
    const url = `${FOREX_API_BASE}/currencies/${baseLower}.json`;
    const response = await axios.get(url, { timeout: 5000 });
    data = response.data;
  } catch (primaryErr) {
    console.log(`⚠️ Forex primary API failed: ${primaryErr.message}, trying fallback...`);
    
    // Try fallback
    try {
      const fallbackUrl = `${FOREX_API_FALLBACK}/currencies/${baseLower}.json`;
      const response = await axios.get(fallbackUrl, { timeout: 5000 });
      data = response.data;
    } catch (fallbackErr) {
      error = `Both forex APIs failed: ${fallbackErr.message}`;
      console.log(`❌ Forex fallback also failed: ${fallbackErr.message}`);
    }
  }
  
  if (!data) {
    return {
      base,
      quote,
      pair: base + quote,
      rate: null,
      error: error || 'Failed to fetch forex data',
      timestamp: new Date().toISOString()
    };
  }
  
  // Extract rate from response
  const rate = data[baseLower]?.[quoteLower];
  const date = data.date;
  
  if (!rate) {
    return {
      base,
      quote,
      pair: base + quote,
      rate: null,
      error: `Rate not found for ${base}/${quote}`,
      timestamp: new Date().toISOString()
    };
  }
  
  // Calculate inverse rate
  const inverseRate = 1 / rate;
  
  return {
    base,
    quote,
    pair: base + quote,
    rate: rate,
    inverseRate: inverseRate,
    baseName: CURRENCY_NAMES[base] || base,
    quoteName: CURRENCY_NAMES[quote] || quote,
    date: date,
    timestamp: new Date().toISOString(),
    source: 'fawazahmed0/exchange-api'
  };
}

/**
 * Build forex context string for LLM grounding
 * 
 * @param {Object} forexData - Data from fetchForexRate
 * @returns {string} Formatted context for system message
 */
function buildForexContext(forexData) {
  if (!forexData || forexData.error) {
    return `⚠️ Forex data unavailable: ${forexData?.error || 'Unknown error'}`;
  }
  
  const { base, quote, rate, inverseRate, baseName, quoteName, date } = forexData;
  
  return `═══════════════════════════════════════════════════════════════════════════════
FOREX EXCHANGE RATE (Real-time data: fawazahmed0 API)
═══════════════════════════════════════════════════════════════════════════════
**${base}/${quote}** (${baseName} to ${quoteName})
• Rate: **1 ${base} = ${rate.toFixed(4)} ${quote}**
• Inverse: **1 ${quote} = ${inverseRate.toFixed(6)} ${base}**
• Data Date: ${date}

INSTRUCTION: Use this EXACT rate for any forex-related calculations.
Do NOT hallucinate different exchange rates. This is grounded real-time data.
`;
}

module.exports = {
  detectForexPair,
  isForexQuery,
  fetchForexRate,
  buildForexContext,
  COMMON_FOREX_PAIRS,
  CURRENCY_NAMES
};
