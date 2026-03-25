/**
 * Stock Price Fetcher - Pure Node.js via yahoo-finance2
 * Fetches historical stock prices for Ψ-EMA analysis
 * Replaced Python/yfinance spawn with direct JS equivalent (same output shape)
 */

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// ============================================================================
// PHI-INTERPOLATION (ported from fetch-stock-prices.py)
// Fills small gaps (2-3 days) using φ-weighted midpoint
// ============================================================================
const PHI = 1.6180339887498949;

function phiInterpolate(closes, dates) {
    if (closes.length < 2) return { closes, dates, flags: closes.map(() => false) };
    const out = [], outDates = [], flags = [];
    for (let i = 0; i < closes.length; i++) {
        out.push(closes[i]);
        outDates.push(dates[i]);
        flags.push(false);
        if (i < closes.length - 1) {
            const curr = new Date(dates[i]);
            const next = new Date(dates[i + 1]);
            const gapDays = Math.round((next - curr) / (1000 * 60 * 60 * 24));
            if (gapDays >= 2 && gapDays <= 3) {
                const midValue = closes[i] + (closes[i + 1] - closes[i]) / PHI;
                const midDate = new Date(curr.getTime() + Math.floor(gapDays / 2) * 24 * 60 * 60 * 1000);
                out.push(midValue);
                outDates.push(midDate.toISOString().split('T')[0] + '*');
                flags.push(true);
            }
        }
    }
    return { closes: out, dates: outDates, flags };
}

// ============================================================================
// ATOMIC UNITS OF PRODUCTION (ported from fetch-stock-prices.py)
// Atomic units: structure (state/flow/guard) is the invariant form.
// Sector-level units are domain facts (barrels for Energy, beds for Healthcare),
// not fabrications — they hold for every company in that sector.
// Technology is the exception: too broad. Software/SaaS vs semiconductor/hardware
// have completely different physical quantities, so Technology is split by industry.
// Hardware industries → null (LLM infers from business description).
// Unknown/unmapped → null (honest silence over wrong template).
// ============================================================================
const SECTOR_ATOMIC_UNITS = {
    'Financial Services':    ['loan book (state)', 'issuance (flow)', 'payments (flow)', 'AUM (state)', 'TPV (flow)'],
    'Consumer Cyclical':     ['inventory (state)', 'orders (flow)', 'shipments (flow)', 'GMV booked (state)', 'tickets (flow)'],
    'Consumer Defensive':    ['inventory (state)', 'orders (flow)', 'baskets (flow)', 'GMV booked (state)', 'tickets (flow)'],
    'Basic Materials':       ['reserves (state)', 'stockpile (state)', 'extraction (flow)', 'shipments (flow)', 'production (flow)'],
    'Energy':                ['reserves (state)', 'capacity MW (state)', 'barrels (flow)', 'MWh (flow)', 'production (flow)'],
    'Real Estate':           ['portfolio value (state)', 'units (state)', 'acquisitions (flow)', 'rental income (flow)', 'NOI (flow)'],
    'Industrials':           ['inventory (state)', 'WIP (state)', 'production (flow)', 'shipments (flow)', 'backlog (state)'],
    'Communication Services':['subscribers (state)', 'ARPU × subs (flow)', 'churn (flow)', 'net adds (flow)', 'MAU (state)'],
    'Healthcare':            ['patient panel (state)', 'bed capacity (state)', 'visits (flow)', 'procedures (flow)', 'admissions (flow)'],
    'Utilities':             ['capacity MW (state)', 'customers (state)', 'MWh generated (flow)', 'sales (flow)', 'connections (state)'],
    // Technology split by industry below — not listed here
};

// Technology sub-sector: software/internet/cloud companies use SaaS metrics.
const TECH_SOFTWARE_UNITS = ['ARR/MRR (state)', 'subscriptions (state)', 'new contracts (flow)', 'API calls (flow)', 'users (state)'];

// Technology/hardware: unit NAMES by industry — not quanta.
// The name tells the reader what to count; the actual number is theirs to verify physically.
// Parsing quanta from EDGAR is derivative truth (dogma). Naming is structural (teaching).
const TECH_HARDWARE_ATOMIC_UNITS = {
    'Semiconductors':                       ['chips (state)', 'wafers (state)', 'wafer starts (flow)', 'bit shipments (flow)', 'fab yield (guard)'],
    'Semiconductor Equipment & Materials':  ['tools (state)', 'wafer capacity (state)', 'tool orders (flow)', 'wafers processed (flow)', 'tool uptime (guard)'],
    'Electronic Components':                ['components (state)', 'inventory (state)', 'units shipped (flow)', 'production (flow)', 'defect rate (guard)'],
    'Electronics & Computer Distribution': ['SKUs (state)', 'inventory (state)', 'orders (flow)', 'shipments (flow)', 'return rate (guard)'],
    'Computer Hardware':                    ['units (state)', 'inventory (state)', 'shipments (flow)', 'orders (flow)', 'defect rate (guard)'],
    'Consumer Electronics':                 ['devices (state)', 'inventory (state)', 'units shipped (flow)', 'orders (flow)', 'return rate (guard)'],
    'Disk & Optical Drives':                ['drives (state)', 'inventory (state)', 'units shipped (flow)', 'capacity (state)', 'defect rate (guard)'],
    'Scientific & Technical Instruments':   ['instruments (state)', 'inventory (state)', 'orders (flow)', 'shipments (flow)', 'calibration rate (guard)'],
};

// Software/internet industries — SaaS metrics are correct.
const TECH_SOFTWARE_INDUSTRIES = new Set([
    'Software—Application', 'Software—Infrastructure', 'Software',
    'Internet Content & Information', 'Information Technology Services',
]);

function inferAtomicUnits(sector, industry) {
    if (sector === 'Technology') {
        if (industry && TECH_HARDWARE_ATOMIC_UNITS[industry]) return TECH_HARDWARE_ATOMIC_UNITS[industry].slice(0, 5);
        if (industry && TECH_SOFTWARE_INDUSTRIES.has(industry)) return TECH_SOFTWARE_UNITS.slice(0, 5);
        return null; // unknown tech sub-type → LLM infers on LLM path, honest silence on bypass
    }
    if (sector && SECTOR_ATOMIC_UNITS[sector]) return SECTOR_ATOMIC_UNITS[sector].slice(0, 5);
    return null;
}

// Allow optional .X / .XX class suffix (BRK.A, BRK.B, BF.B) — no \b after dot
const DOLLAR_TICKER_REGEX = /\$([A-Za-z]{1,8}(?:\.[A-Za-z]{1,2})?)/gi;

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
    if (ticker.length >= 1 && ticker.length <= 8) {
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
  
  // PRIORITY 0: Compound verb detection - "psi ema" / "ψ-ema" / "psi-ema" as a single verb unit
  // This gives BOTH verb + adjective keys, enabling strong context for ticker rescue
  const hasPsiEmaCompound = /(?:psi|ψ)[\s\-]?ema/i.test(query);
  if (hasPsiEmaCompound) {
    keys.push({ type: 'verb', value: 'psi-ema' });
    keys.push({ type: 'adjective', value: 'analysis' });
    usedWords.add('PSI');
    usedWords.add('EMA');
    console.log(`🔑 Compound verb detected: "psi ema" → verb + adjective (strong context)`);
  }
  
  // Push KEY 1: Verb (skip if compound already provided one)
  if (!keys.some(k => k.type === 'verb')) {
    for (const word of words) {
      if (PSI_EMA_VERBS.has(word)) {
        keys.push({ type: 'verb', value: word });
        usedWords.add(word.toUpperCase()); // Mark as used
        break; // Only need one
      }
    }
  }
  
  // Push KEY 2: Adjective (skip if compound already provided one)
  if (!keys.some(k => k.type === 'adjective')) {
    for (const word of words) {
      if (PSI_EMA_ADJECTIVES.has(word)) {
        keys.push({ type: 'adjective', value: word });
        usedWords.add(word.toUpperCase()); // Mark as used
        break; // Only need one
      }
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
 * When strong Ψ-EMA context exists (psi + ema + verb/adj), allow lowercase after "for/of/on"
 */
function detectPotentialTickerWithContext(query, excludeWords) {
  // First try standard detection (uppercase/$prefix)
  const strictResult = detectPotentialTickerExcluding(query, excludeWords);
  if (strictResult) return strictResult;
  
  // Strong context rescue: Allow lowercase ticker after "for/of/on" prepositions
  // Pattern: "psi ema for tsla" / "analyze ema of nvda" / "show psi on aapl"
  const prepPattern = /\b(?:for|of|on)\s+([a-z]{2,5})\b/i;
  const prepMatch = query.match(prepPattern);
  if (prepMatch) {
    const candidate = prepMatch[1].toUpperCase();
    if (!COMMON_NON_TICKERS.has(candidate) && !excludeWords.has(candidate) && !COMMON_SHORT_WORDS.has(candidate)) {
      console.log(`🔧 Context rescue: lowercase "${prepMatch[1]}" → ${candidate} (after preposition)`);
      return candidate;
    }
  }
  
  return null;
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
    if (ticker.length >= 1 && ticker.length <= 8) {
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

/**
 * Sanitize ticker symbol to prevent command injection
 * Only allows uppercase letters and hyphens (for B-class shares like BRK-B)
 * @param {string} ticker - Raw ticker input
 * @returns {string|null} Sanitized ticker or null if invalid
 */
function sanitizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  
  // Normalize class-share dot notation to hyphen (BRK.A → BRK-A, BF.B → BF-B)
  const normalized = ticker.toUpperCase().replace(/\.([A-Z]{1,2})$/, '-$1');
  const sanitized = normalized.replace(/[^A-Z0-9\-\.]/g, '');
  
  if (sanitized.length < 1 || sanitized.length > 12) return null;
  if (!/^[A-Z]/.test(sanitized)) return null;
  
  return sanitized;
}

async function fetchStockPrices(ticker, customPeriod = null) {
    const safeTicker = sanitizeTicker(ticker);
    if (!safeTicker) throw new Error(`Invalid ticker format: ${ticker}`);

    const now = new Date();
    const dailyStart = new Date(now);
    dailyStart.setFullYear(dailyStart.getFullYear() - 1);
    const weeklyStart = new Date(now);
    weeklyStart.setFullYear(weeklyStart.getFullYear() - 4);

    const period2 = now.toISOString().split('T')[0];
    const dailyPeriod1 = dailyStart.toISOString().split('T')[0];
    const weeklyPeriod1 = weeklyStart.toISOString().split('T')[0];

    const queryOpts = { period1: dailyPeriod1, period2, interval: '1d' };
    if (customPeriod) {
        const yearsBack = parseInt(customPeriod) || 1;
        const custom = new Date(now);
        custom.setFullYear(custom.getFullYear() - yearsBack);
        queryOpts.period1 = custom.toISOString().split('T')[0];
    }

    const noValidate = { validateResult: false };
    const [dailyRaw, weeklyRaw, summaryRaw] = await Promise.all([
        yahooFinance.historical(safeTicker, queryOpts, noValidate),
        yahooFinance.historical(safeTicker, { period1: weeklyPeriod1, period2, interval: '1wk' }, noValidate),
        yahooFinance.quoteSummary(safeTicker, {
            modules: ['assetProfile', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'quoteType']
        }, noValidate).catch(() => ({})),
    ]);

    if (!dailyRaw || dailyRaw.length === 0) {
        throw new Error(`No data found for ${safeTicker}. Check if the ticker is valid.`);
    }

    const safeFloat = v => (v != null && !isNaN(Number(v))) ? Number(v) : null;
    const toDate = d => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];

    const dailyCloses = dailyRaw.map(r => r.close);
    const dailyDates  = dailyRaw.map(r => toDate(r.date));
    const weeklyCloses = (weeklyRaw || []).map(r => r.close);
    const weeklyDates  = (weeklyRaw || []).map(r => toDate(r.date));

    const daily  = phiInterpolate(dailyCloses, dailyDates);
    const weekly = weeklyCloses.length > 0
        ? phiInterpolate(weeklyCloses, weeklyDates)
        : { closes: [], dates: [], flags: [] };

    const profile      = summaryRaw?.assetProfile        || {};
    const sumDetail    = summaryRaw?.summaryDetail        || {};
    const keyStats     = summaryRaw?.defaultKeyStatistics || {};
    const finData      = summaryRaw?.financialData        || {};
    const quoteType    = summaryRaw?.quoteType            || {};

    const sector   = profile.sector   || null;
    const industry = profile.industry || null;

    const fundamentals = {};
    const pe  = safeFloat(sumDetail.trailingPE);   if (pe  !== null) fundamentals.peRatio        = pe;
    const fpe = safeFloat(sumDetail.forwardPE);    if (fpe !== null) fundamentals.forwardPE       = fpe;
    const dy  = safeFloat(sumDetail.dividendYield); if (dy  !== null) fundamentals.dividendYield   = dy;
    const mc  = safeFloat(sumDetail.marketCap);    if (mc  !== null) fundamentals.marketCap        = mc;
    const dte = safeFloat(finData.debtToEquity);   if (dte !== null) fundamentals.debtToEquity    = dte;
    if (sector)   fundamentals.sector   = sector;
    if (industry) fundamentals.industry = industry;
    // Infer atomic units from sector/industry map (domain facts, not LLM fabrication).
    // Returns null for Technology/hardware (inferred per-company by LLM hint on LLM path).
    const atomicUnits = inferAtomicUnits(sector, industry);
    if (atomicUnits) fundamentals.atomicUnits = atomicUnits;
    const biz = profile.longBusinessSummary || '';
    if (biz) {
        const first = biz.split('.')[0].trim();
        fundamentals.summary = first.length > 150 ? first.substring(0, 147) + '...' : first;
    }
    if (quoteType.quoteType) fundamentals.yfType = quoteType.quoteType;
    const bv  = safeFloat(keyStats.bookValue);         if (bv  !== null) fundamentals.bookValue         = bv;
    const h52 = safeFloat(sumDetail.fiftyTwoWeekHigh); if (h52 !== null) fundamentals.fiftyTwoWeekHigh  = h52;
    const l52 = safeFloat(sumDetail.fiftyTwoWeekLow);  if (l52 !== null) fundamentals.fiftyTwoWeekLow   = l52;
    const rps = safeFloat(finData.revenuePerShare);    if (rps !== null) fundamentals.revenuePerShare   = rps;

    const currentPrice = daily.closes[daily.closes.length - 1] ?? null;
    const name = quoteType.longName || quoteType.shortName || profile.longName || profile.shortName || safeTicker;
    const currency = sumDetail.currency || 'USD';

    const realDailyCount  = daily.flags.filter(f => !f).length;
    const realWeeklyCount = weekly.flags.filter(f => !f).length;
    const weeklyUnavailableReason = weekly.closes.length < 13
        ? `Stock history: only ${weekly.closes.length} weeks (need 13+ for basic EMA)` : null;

    return {
        ticker: safeTicker,
        name,
        currency,
        currentPrice,
        closes:    daily.closes,
        dates:     daily.dates,
        startDate: daily.dates[0]?.replace('*', '') || null,
        endDate:   daily.dates[daily.dates.length - 1]?.replace('*', '') || null,
        daily: {
            closes:             daily.closes,
            dates:              daily.dates,
            barCount:           realDailyCount,
            interpolatedCount:  daily.flags.filter(Boolean).length,
            startDate:          daily.dates[0]?.replace('*', '') || null,
            endDate:            daily.dates[daily.dates.length - 1]?.replace('*', '') || null,
        },
        weekly: {
            closes:             weekly.closes,
            dates:              weekly.dates,
            barCount:           realWeeklyCount,
            interpolatedCount:  weekly.flags.filter(Boolean).length,
            startDate:          weekly.dates[0]?.replace('*', '') || null,
            endDate:            weekly.dates[weekly.dates.length - 1]?.replace('*', '') || null,
            ...(weeklyUnavailableReason ? { unavailableReason: weeklyUnavailableReason } : {}),
        },
        fundamentals,
    };
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
  if (!process.env.NYANBOOK_AI_KEY && !process.env.GROQ_API_KEY) {
    console.log('⚠️ AI ticker extraction skipped: No NYANBOOK_AI_KEY');
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
3. For crypto assets, return the yfinance format with -USD suffix (e.g., "bitcoin" → "BTC-USD", "ethereum" → "ETH-USD", "solana" → "SOL-USD", "ripple" → "XRP-USD")
4. For commodities (gold, oil, silver) or private companies → return {"ticker": null, "confidence": "high", "reason": "not resolvable via yfinance"}
5. If unclear or no company/asset mentioned → return {"ticker": null, "confidence": "low", "reason": "no company or asset detected"}
6. confidence: "high" = certain match, "medium" = likely match, "low" = guess

EXAMPLES:
- "price analysis on meta stock" → {"ticker": "META", "confidence": "high", "reason": "Meta Platforms Inc"}
- "how is ford doing" → {"ticker": "F", "confidence": "high", "reason": "Ford Motor Company"}
- "bitcoin trend" → {"ticker": "BTC-USD", "confidence": "high", "reason": "Bitcoin yfinance format"}
- "ethereum analysis" → {"ticker": "ETH-USD", "confidence": "high", "reason": "Ethereum yfinance format"}
- "gold price forecast" → {"ticker": null, "confidence": "high", "reason": "commodity, not resolvable via yfinance"}
- "what's the weather" → {"ticker": null, "confidence": "high", "reason": "no company or asset mentioned"}`
          },
          { role: 'user', content: query }
        ],
        temperature: 0,
        max_tokens: 100
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.NYANBOOK_AI_KEY || process.env.GROQ_API_KEY}`,
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
      if (ticker && ticker.length >= 1 && ticker.length <= 8 && /^[A-Z]+$/.test(ticker)) {
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
  sanitizeTicker,
  COMMON_NON_TICKERS,
  PSI_EMA_VERBS,
  PSI_EMA_ADJECTIVES
};
