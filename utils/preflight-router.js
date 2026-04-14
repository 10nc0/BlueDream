/**
 * Preflight Router - Stage 0+1 Unified Query Pre-processing
 * 
 * Runs BEFORE the main LLM call to:
 * 1. Detect query mode (psi-ema, seed-metric, financial, legal, general)
 * 2. Extract structured inputs (tickers, attachments)
 * 3. Fetch external data (yfinance) if needed
 * 4. Return PreflightResult for downstream consumption
 * 
 * This consolidates scattered detection logic into a single module,
 * keeping NYAN Protocol pure (reasoning only) and reducing code bloat.
 */

const logger = require('../lib/logger');
const { detectStockTicker, detectPsiEMAKeys, smartDetectTicker, fetchStockPrices, calculateDataAge } = require('./stock-fetcher');
const { getPsiEMAContext, PsiEMADashboard, PSI_EMA_DOCUMENTATION } = require('./psi-EMA');
const { getFinancialPhysicsSeed } = require('./financial-physics');
const { getLegalAnalysisSeed, LEGAL_KEYWORDS_REGEX } = require('../prompts/legal-analysis');
const { getChemistryAnalysisSeed, CHEMISTRY_KEYWORDS_REGEX, modelIdToLabel } = require('../prompts/pharma-analysis');
const { getLLMBackend } = require('../config/constants');
const { processChemistryContent } = require('./attachment-cascade');
const { detectForexPair, isForexQuery, fetchForexRate, buildForexContext } = require('./forex-fetcher');
const { getSeedMetricProxy, detectSeedMetricIntent, buildSearchQueries, buildFallbackSearchQueries } = require('../prompts/seed-metric');
const { detectCodeMode, getLanguageFromExtension } = require('../lib/mode-registry');
const { isDesignQuestion, getSystemContextForDesign } = require('./code-context');
const { COUNTRY_CITY_MAP, KNOWN_CITIES_REGEX, CITY_EXPAND, COUNTRY_CITY_MAP_KEYS_PATTERN } = require('./geo-data');
const { NYAN_IDENTITY_DOCUMENTATION, REGISTRY_VERSION } = require('../prompts/nyan-identity');

const NYAN_IDENTITY_PATTERNS = [
  /^(?:who|what)\s+(?:are|is)\s+(?:you|nyan)\s*\??$/i,
  /^who\s+(?:made|built|created)\s+(?:you|nyanbook|nyan)\s*\??$/i,
  /^(?:what\s+is|tell\s+me\s+about|explain)\s+(?:the\s+)?nyanbook\s*\??$/i,
  /^(?:what\s+is|tell\s+me\s+about|explain)\s+(?:the\s+)?nyan\s*protocol\s*\??$/i,
  /^what\s+(?:can\s+you\s+do|are\s+your\s+capabilities)\s*\??$/i,
  /^how\s+does\s+(?:this|nyanbook|nyan)\s+work\s*\??$/i,
  /^what\s+is\s+(?:this\s+)?(?:nyanbook\s+)?playground\s*\??$/i,
  /^(?:what\s+is\s+)?blue\s*dream\s*\??$/i,
  /\bnyanbook\b.*\b(?:source\s*code|github|repo(?:sitory)?)\b/i,
  /\b(?:source\s*code|github|repo(?:sitory)?)\b.*\bnyanbook\b/i,
  /^(?:source\s*code|github|repo(?:sitory)?)\s*\??$/i,
  /^(?:where\s+is\s+(?:the\s+)?(?:source|code|repo))\s*\??$/i,
  /^siapa\s+(?:kamu|anda)\s*\??$/i,
  /^(?:kamu|anda)\s+siapa\s*\??$/i,
  /^(?:ini|itu)\s+apa\s*\??$/i,
  /^apa\s+(?:itu|ini)\s+nyanbook\s*\??$/i,
];

const PSI_EMA_IDENTITY_PATTERNS = [
  /^what\s+is\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\??$/i,
  /^(?:explain|describe)\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\??$/i,
  /^tell\s+me\s+about\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\??$/i,
  /^how\s+does\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\s+work\??$/i,
  /^what\s+(?:are|is)\s+(?:the\s+)?(?:theta|θ|z|r)\s+(?:in|for)\s+(?:psi|ψ)[\s\-]?ema\??$/i,
];

/**
 * Real-time intent detection - queries that require web search
 * Cascade: DDG → Brave (following existing pattern)
 */
const REALTIME_INTENT_PATTERNS = [
  /\b(epl|premier\s*league|nfl|nba|mlb|mls|nhl|nrl|afl|ufc|champions\s*league|europa\s*league|world\s*cup|la\s*liga|bundesliga|serie\s*a|ligue\s*1|eredivisie|super\s*lig)\b/i,
  /\b(formula[\s\-]*1|formula[\s\-]*2|f1|f2|motogp|moto2|indycar|nascar|wrc|dtm|fe|formula[\s\-]*e|grand[\s\-]*prix)\b/i,
  /\b(standings|championship\s+standings|points\s+table|drivers?\s+championship|constructors?\s+championship)\b/i,
  /\b(race\s+calendar|race\s+schedule|season\s+schedule|this\s+season|current\s+season|2025\s+season|2026\s+season)\b/i,
  /\b(who\s+(leads?|is\s+leading|won|is\s+winning)\s+the\s+(championship|league|season|race|title))\b/i,
  /\b(latest|recent|new|current)\s+(game|match|score|result|fixture|win|loss|draw|performance)\b/i,
  /\b(lakers|pistons|warriors|celtics|bulls|heat|knicks|nets|spurs|clippers|nuggets|bucks|sixers|76ers|suns|hawks|hornets|cavaliers|pacers|raptors|wizards|magic|grizzlies|pelicans|thunder|jazz|timberwolves|blazers|trail\s*blazers|kings|mavericks|rockets)\b/i,
  /\b(match|game|fixture|score|schedule|standings|results?)\s+(today|tonight|tomorrow|this\s*week|next\s*week|this\s*month|next\s*month|upcoming)\b/i,
  /\b(upcoming|next|today'?s?|tonight'?s?|this\s*week'?s?|this\s*month'?s?)\s+(match|game|fixture|schedule|results?|race)\b/i,
  /\b(latest|breaking|recent|current|today'?s?)\s+(news|headlines|events?|updates?|developments?)\b/i,
  /\bwhat\s+(?:is\s+)?happen(?:ing|ed)\s+(today|now|recently|this\s*week|this\s*month)\b/i,
  /\b(weather|forecast|temperature|rain|snow|sunny|cloudy)\s+(today|tomorrow|this\s*week|in\s+\w+)\b/i,
  /\b(today'?s?|tomorrow'?s?|current)\s+(weather|forecast|temperature)\b/i,
  /\b(when\s+is|what\s+time|schedule\s+for|upcoming)\b/i,
  /\b(live|real[\s\-]?time|right\s*now|currently)\b/i,
  /\b(search|google|look\s*up|find\s+(?:me\s+)?(?:the\s+)?(?:latest|current|recent))\b/i,
  /\b(what\s+is\s+the\s+(?:latest|current|recent))\b/i,
  /\b(who\s+is|who'?s)\s+(?:the\s+)?(?:current\s+)?(?:president|prime[\s\-]minister|chancellor|ceo|mayor|governor|king|queen|leader|minister|secretary|general|director|chairman|head\s+of)\b/i,
  /\b(siapa|quien|qui\s+est|wer\s+ist|chi\s+è|hvem\s+er)\b/i,
  /\b(presiden|presidente|président|premier[\s\-]?ministre|primer[\s\-]?ministro|bundeskanzler|perdana\s+menteri)\b/i,
  /\b(jadwal|pertandingan|klasemen|hasil\s+pertandingan|siaran\s+langsung|skor)\b/i,
  /\b(hari\s+ini|minggu\s+ini|bulan\s+ini|tahun\s+ini|malam\s+ini|besok)\b/i,
  /\b(terkini|terbaru|sekarang|saat\s+ini|live\s+score)\b/i,
  /\b(jadual|keputusan|perlawanan|minggu\s+depan|bulan\s+depan)\b/i,
  /今天|今晚|今日|本周|本月|本年|下周|下月|明天|最新|直播|赛程|比赛|赛果|积分榜|战报|球队|日程/,
];

const ABSTRACT_TOPIC_PATTERNS = [
  /\b(prove\s+that|proof\s+of|theorem|lemma|corollary|axiom|postulate|QED)\b/i,
  /\b(integral|derivative|eigenvalue|eigenvector|determinant|matrix\s+multiplication|polynomial\s+division)\b/i,
  /\b(solve\s+for\s+[xyz]|factor|simplif|expand\s+the\s+expression|evaluate\s+the\s+(limit|sum|integral))\b/i,
  /\b(write\s+(?:me\s+)?(?:a\s+)?(?:poem|song|story|essay|haiku|limerick|sonnet|novel|script|screenplay))\b/i,
  /\b(imagine|creative\s+writing|fictional|roleplay|pretend|hypothetical\s+scenario)\b/i,
  /\b(hello|hi|hey|good\s+(morning|afternoon|evening)|how\s+are\s+you|what'?s?\s+up|thanks|thank\s+you)\b/i,
  /\b(explain\s+(?:this|my)\s+code|debug|refactor|code\s+review|syntax\s+error|stack\s+trace)\b/i,
  /\b(translate|convert)\s+(?:this|the\s+following)\s+(?:to|into)\b/i,
  /\b(summarize|summarise|tldr|tl;dr)\b/i,
];

function detectRealtimeIntent(query) {
  if (!query || typeof query !== 'string') return false;
  return REALTIME_INTENT_PATTERNS.some(pattern => pattern.test(query));
}

function detectAbstractTopic(query) {
  if (!query || typeof query !== 'string') return false;
  return ABSTRACT_TOPIC_PATTERNS.some(pattern => pattern.test(query));
}

function shouldSearchDDG(query) {
  if (!query || typeof query !== 'string') return false;
  if (detectRealtimeIntent(query)) return true;
  if (detectAbstractTopic(query)) return false;
  if (query.trim().split(/\s+/).length < 2) return false;
  return true;
}

const TEMPORAL_HIGH_PATTERNS = [
  /\b(score|standings|results?|match|game|fixture|live|real[\s\-]?time|breaking|tonight|today)\b/i,
  /\b(price|stock|market|bitcoin|crypto|btc|eth|forex|exchange\s*rate|trading)\b/i,
  /\b(weather|forecast|temperature|humidity)\b/i,
  /\b(election|vote|poll|ballot|primary|runoff)\b/i,
  /\b(epl|premier\s*league|nfl|nba|mlb|ufc|f1|formula[\s\-]*1|champions\s*league)\b/i,
];

const TEMPORAL_MEDIUM_PATTERNS = [
  /\b(who\s+is|who'?s)\s+(?:the\s+)?(?:current\s+)?(?:president|prime[\s\-]minister|ceo|mayor|governor|chancellor|leader|head\s+of)\b/i,
  /\b(population|gdp|inflation|unemployment|interest\s*rate)\b/i,
  /\b(latest|recent|current|new)\s+(version|release|update|policy|law|regulation)\b/i,
  /\b(siapa|quien|qui\s+est|wer\s+ist)\b/i,
];

function classifyTemporalVolatility(query, mode = null) {
  if (!query || typeof query !== 'string') return 'low';
  if (mode && mode !== 'general') return 'low';
  if (TEMPORAL_HIGH_PATTERNS.some(p => p.test(query))) return 'high';
  if (TEMPORAL_MEDIUM_PATTERNS.some(p => p.test(query))) return 'medium';
  return 'low';
}

/**
 * BLOB DETECTION: Extract main query from large text blobs
 * 
 * When users paste large text (explanations, code, articles), the actual query
 * is usually in the first or last 2-3 sentences. This prevents false positives
 * like "Step 1:" being detected as ticker "STEP".
 * 
 * Threshold: 500 chars or 10+ sentences → treat as blob
 * 
 * @param {string} text - Full user input
 * @returns {Object} { mainQuery, isBlob, fullText }
 */
function extractMainQuery(text) {
  if (!text || typeof text !== 'string') {
    return { mainQuery: '', isBlob: false, fullText: '' };
  }
  
  const BLOB_CHAR_THRESHOLD = 500;
  const BLOB_SENTENCE_THRESHOLD = 10;
  
  // Split into sentences (handle common patterns)
  const sentences = text.split(/(?<=[.!?])\s+|(?<=\n)\s*/g).filter(s => s.trim().length > 0);
  
  const isBlob = text.length > BLOB_CHAR_THRESHOLD || sentences.length >= BLOB_SENTENCE_THRESHOLD;
  
  if (!isBlob) {
    return { mainQuery: text, isBlob: false, fullText: text };
  }
  
  // Extract first 3 sentences + last 2 sentences as "main query"
  const firstN = sentences.slice(0, 3);
  const lastN = sentences.slice(-2);
  
  // Dedupe if overlap
  const mainSentences = [...new Set([...firstN, ...lastN])];
  const mainQuery = mainSentences.join(' ');
  
  logger.debug(`📦 BLOB DETECTED: ${text.length} chars, ${sentences.length} sentences → extracted ${mainSentences.length} main sentences for classification`);
  
  return { mainQuery, isBlob: true, fullText: text };
}

/**
 * @typedef {Object} PreflightResult
 * @property {string} mode - Query mode: 'psi-ema' | 'seed-metric' | 'financial' | 'legal' | 'general'
 * @property {string|null} ticker - Extracted stock ticker (e.g., 'META')
 * @property {Object|null} stockData - Raw yfinance data if fetched
 * @property {Object|null} psiEmaAnalysis - PsiEMADashboard analysis result
 * @property {Object|null} dataAge - Data recency info
 * @property {string} searchStrategy - 'none' | 'brave' | 'duckduckgo'
 * @property {Object} routingFlags - Flags for downstream consumption
 * @property {string|null} error - Error message if preflight failed
 */

/**
 * Safe number formatting helper
 */
function safeFixed(val, decimals = 2) {
  const num = typeof val === 'number' ? val : parseFloat(val);
  return !isNaN(num) ? num.toFixed(decimals) : 'N/A';
}

// θ display: 2dp; any value that rounds to 0.00 → flag ~0°
function fmtTheta(theta) {
  if (theta == null || isNaN(theta)) return 'N/A';
  if (Math.abs(theta) < 0.005) return '~0°';
  return theta.toFixed(2) + '°';
}

/**
 * Format market cap into human-readable format (e.g., $2.5T, $150B)
 */
function formatMarketCap(marketCap) {
  if (!marketCap || typeof marketCap !== 'number') return 'N/A';
  
  if (marketCap >= 1e12) {
    return '$' + (marketCap / 1e12).toFixed(2) + 'T';
  } else if (marketCap >= 1e9) {
    return '$' + (marketCap / 1e9).toFixed(2) + 'B';
  } else if (marketCap >= 1e6) {
    return '$' + (marketCap / 1e6).toFixed(2) + 'M';
  } else {
    return '$' + marketCap.toFixed(0);
  }
}

/**
 * Main preflight router - runs before LLM call
 * 
 * @param {Object} options
 * @param {string} options.query - User's query text
 * @param {Array} options.attachments - Array of attachment metadata
 * @param {Object} options.docContext - Parsed document context (if any)
 * @param {Object} options.contextResult - Stage -1 output (entities from conversation history)
 * @returns {Promise<PreflightResult>}
 */
async function preflightRouter(options) {
  const { query = '', attachments = [], docContext = {}, contextResult = null } = options;
  
  // ========================================
  // BLOB DETECTION: Extract main query from large text
  // Prevents false positives like "Step 1:" → "STEP" ticker
  // ========================================
  const blobResult = extractMainQuery(query);
  const classificationQuery = blobResult.mainQuery; // Use for mode/ticker detection
  const fullQuery = blobResult.fullText || query;   // Use for LLM processing
  
  const result = {
    mode: 'general',
    ticker: null,
    stockData: null,
    psiEmaAnalysis: null,
    psiEmaIdentityContext: null,
    nyanIdentityContext: null,
    dataAge: null,
    searchStrategy: 'none',
    routingFlags: {
      usesPsiEMA: false,
      isPsiEmaIdentity: false,
      isNyanIdentity: false,
      isSeedMetric: false,
      usesFinancialPhysics: false,
      usesLegalAnalysis: false,
      usesForex: false,
      needsRealtimeSearch: false,
      hasAttachments: attachments.length > 0,
      hasDocContext: Object.keys(docContext).length > 0,
      isBlob: blobResult.isBlob
    },
    stockContext: null,
    forexData: null,
    forexContext: null,
    codeContext: null,
    error: null
  };
  
  try {
    // ========================================
    // MODE DETECTION (Priority Order)
    // Uses classificationQuery for detection (extracted main query for blobs)
    // ========================================
    
    // -2. DESIGN/CODE QUESTION: Questions about Nyanbook's internal architecture/implementation
    // Inject actual source code to prevent hallucination (H0 ground truth)
    // Guard: seed-metric CALCULATION intent takes priority over design/code explanation
    const designContext = getSystemContextForDesign(classificationQuery);
    if (designContext && !detectSeedMetricIntent(classificationQuery)) {
      logger.debug(`🔧 Preflight: Design question detected → injecting source code for: ${designContext.topics.join(', ')}`);
      result.mode = 'design';
      result.routingFlags.isDesignQuestion = true;
      result.codeContext = designContext.systemMessage;
      result.codeTopics = designContext.topics;
      return result;
    }
    
    // -1.5. NYAN IDENTITY: "Who are you?" / "What is nyanbook?" → answer from internal registry
    const isNyanIdentity = NYAN_IDENTITY_PATTERNS.some(p => p.test(classificationQuery.trim()));
    
    if (isNyanIdentity) {
      logger.debug(`🐱 Preflight: Nyan identity query detected → injecting registry v${REGISTRY_VERSION}`);
      result.mode = 'nyan-identity';
      result.routingFlags.isNyanIdentity = true;
      result.nyanIdentityContext = NYAN_IDENTITY_DOCUMENTATION;
      return result;
    }
    
    // -1. Ψ-EMA IDENTITY: "What is Ψ-EMA?" queries → inject actual documentation (H0 ground truth)
    const hasTicker = /\$[A-Z]{1,5}\b/.test(classificationQuery);
    const isPsiEmaIdentity = !hasTicker && PSI_EMA_IDENTITY_PATTERNS.some(p => p.test(classificationQuery.trim()));
    
    if (isPsiEmaIdentity) {
      logger.debug(`📚 Preflight: Ψ-EMA identity query detected → injecting documentation`);
      result.mode = 'psi-ema-identity';
      result.routingFlags.isPsiEmaIdentity = true;
      result.psiEmaIdentityContext = PSI_EMA_DOCUMENTATION;
      return result;
    }
    
    // 0a. CRYPTO CROSS-RATE: Intercept $BTCUSD / BTCUSD / ETHUSD BEFORE forex gate
    // Crypto pairs (XYZ + USD/USDT suffix) route to yfinance Ψ-EMA, not forex fetcher
    const cryptoCrossMatch = classificationQuery.match(/\$([A-Z]{2,6}USDT?)\b|\b([A-Z]{2,6}USDT?)\b/i);
    if (cryptoCrossMatch) {
      const rawTicker = (cryptoCrossMatch[1] || cryptoCrossMatch[2]).toUpperCase();
      const cryptoParts = rawTicker.match(/^([A-Z]{2,6})(USDT?)$/);
      if (cryptoParts) {
        result.ticker = `${cryptoParts[1]}-USD`;
        logger.debug(`₿ Preflight: Crypto cross-rate ${rawTicker} → ${result.ticker} (psi-ema)`);
      }
    }

    // 0. FOREX: Detect currency pair queries FIRST (before stock detection)
    // USD/JPY, EUR/USD, "yen rate", "dollar to euro", etc.
    // Guard: skip if already resolved as crypto cross-rate above
    const forexPair = detectForexPair(classificationQuery);
    if (!result.ticker && (forexPair || isForexQuery(classificationQuery))) {
      result.mode = 'forex';
      result.routingFlags.usesForex = true;
      
      if (forexPair) {
        logger.debug(`💱 Preflight: Detected forex pair ${forexPair.base}/${forexPair.quote}`);
        
        try {
          result.forexData = await fetchForexRate(forexPair.base, forexPair.quote);
          result.forexContext = buildForexContext(result.forexData);
          logger.debug(`💱 Preflight: Fetched ${forexPair.pair} rate: ${result.forexData.rate}`);
        } catch (forexErr) {
          logger.warn(`⚠️ Preflight: Forex fetch failed: ${forexErr.message}`);
          result.error = `Forex fetch failed: ${forexErr.message}`;
        }
      } else {
        logger.debug(`💱 Preflight: Forex query detected but no specific pair extracted`);
      }
    }
    // 1. SEED METRIC: Check FIRST before Ψ-EMA (city names like LA/NY shouldn't be tickers)
    // Web-first search for grounded real estate data - LLM training data is stale
    else if (detectSeedMetricIntent(classificationQuery)) {
      result.mode = 'seed-metric';
      result.routingFlags.isSeedMetric = true;
      result.searchStrategy = 'brave';
      
      // "Most recent available" = last full calendar year (real estate/income data lags ~1yr)
      const mostRecentYear = String(new Date().getFullYear() - 1);
      const defaultHistoricalYear = String(new Date().getFullYear() - 25);

      // Extract city names for targeted search (major world cities + common variants)
      const cities = [...new Set((classificationQuery.match(new RegExp(KNOWN_CITIES_REGEX.source, 'gi')) || []).map(c => c.toLowerCase()))];

      // Expand country names to their primary cities (e.g. "vietnam" → hanoi, ho chi minh)
      const detectedCountries = [];
      const countryRegex = new RegExp(COUNTRY_CITY_MAP_KEYS_PATTERN, 'gi');
      for (const match of classificationQuery.matchAll(countryRegex)) {
        const countryKey = match[0].toLowerCase();
        if (!detectedCountries.includes(countryKey)) detectedCountries.push(countryKey);
        for (const city of COUNTRY_CITY_MAP[countryKey] || []) {
          if (!cities.includes(city)) cities.push(city);
        }
      }

      // Extract ALL years from query: first = historical, last = current
      // User-specified current year wins; fall back to dynamic most-recent full year
      const allYears = [...classificationQuery.matchAll(/\b(19[5-9]\d|20[0-2]\d)s?\b/g)].map(m => m[1]);
      const historicalYear = allYears.length > 0 ? allYears[0] : defaultHistoricalYear;
      const currentYear = allYears.length > 1 ? allYears[allYears.length - 1] : mostRecentYear;
      const historicalDecade = `${historicalYear.slice(0, 3)}0s`;

      if (cities.length > 0) {
        result.seedMetricSearchQueries = cities.flatMap(city => {
          const q = buildSearchQueries({ city, currentYear, histYear: historicalYear, histDecade: historicalDecade });
          return [q.currentPrice, q.currentIncome, q.historicalPrice, q.historicalIncome];
        });
        // National-level fallback: gives LLM country-wide data if city searches miss
        for (const countryName of detectedCountries) {
          result.seedMetricSearchQueries.push(`${countryName} national average property price per sqm ${currentYear}`);
          result.seedMetricSearchQueries.push(`${countryName} minimum wage annual ${currentYear}`);
        }
        result.historicalDecade = historicalDecade;
        result.historicalYear = historicalYear;
        result.currentYear = currentYear;
        logger.debug(`🏠 Preflight: SEED_METRIC detected for cities: ${cities.join(', ')}, historical: ${historicalDecade}, current: ${currentYear}`);
        logger.debug(`🔍 Preflight: Will search for: ${result.seedMetricSearchQueries.slice(0, 3).join(' | ')}...`);
      } else {
        const fb = buildFallbackSearchQueries({ currentYear, histDecade: historicalDecade });
        result.seedMetricSearchQueries = [fb.currentPrice, fb.currentIncome, fb.historicalPrice, fb.historicalIncome];
        result.historicalDecade = historicalDecade;
        result.historicalYear = historicalYear;
        result.currentYear = currentYear;
        logger.debug(`🏠 Preflight: SEED_METRIC detected (no specific city), historical: ${historicalDecade}, current: ${currentYear}`);
      }
    }
    // 2. Ψ-EMA: Push-based 2/3 key detection (Lego-style Turing test)
    // Keys: VERB (analyze/diagnose) + ADJECTIVE (price/trend) + OBJECT (ticker)
    // If 2/3 keys match → unlock Ψ-EMA gate
    // OR trigger if keyword "psi-ema" or "ψ-ema" is present (quantum compass scavenge hunt)
    // SKIP if forex mode already triggered
    else if (result.mode !== 'forex') {
      const psiEmaDetection = detectPsiEMAKeys(classificationQuery);
      const hasExplicitModeKeyword = /\b(psi|ψ)[\s\-]?ema\b/i.test(classificationQuery);

      // Extract dynamic data period if specified: "1y daily", "5y weekly", "nd psi ema"
      // Default: null (fetcher uses 6mo/2y defaults)
      let customPeriod = null;
      const ndMatch = classificationQuery.match(/\b(\d+)([dwmy])\b/i);
      if (ndMatch) {
        customPeriod = ndMatch[1] + ndMatch[2].toLowerCase();
        logger.debug(`📊 Preflight: Detected custom data period: ${customPeriod}`);
      }
    
      // Context fallback: Bloomberg-spec — reuse inferred ticker if:
      // 1. We have a ticker from prior conversation, AND
      // 2. Current query has a price/market adjective (no "stock/shares" word needed —
      //    Ψ-EMA covers equities, forex, crypto, indices — anything YF resolves)
      const hasContextTicker = contextResult?.inferredTicker;
      const hasVerbOrAdjective = psiEmaDetection.keys.some(k => k.type === 'verb' || k.type === 'adjective');
      const hasVerb = psiEmaDetection.keys.some(k => k.type === 'verb');
      const hasAdjective = psiEmaDetection.keys.some(k => k.type === 'adjective');
      const contextFallbackApplies = hasContextTicker && hasAdjective && hasVerbOrAdjective;
      
      // ========================================
      // GEO-INTENT VETO: Check for geography context BEFORE AI-PUSH
      // Longevity > profit: SF = San Francisco, LA = Los Angeles, etc.
      // City abbreviation + any affordability word → Seed Metric, no "vs" required
      // ========================================
      const cityAbbreviations = /\b(la|ny|sf|dc|hk|kl)\b/i;
      const affordabilityPattern = /\b(price|prices|housing|property|rent|land|cost|income|salary|afford)\b/i;
      const hasCityAbbreviation = cityAbbreviations.test(classificationQuery);
      const hasAffordabilityWord = affordabilityPattern.test(classificationQuery);
      const hasGeoIntent = hasCityAbbreviation && hasAffordabilityWord;
      
      // TICKER-CONTEXT OVERRIDE: Dollar-prefixed ticker ($SF, $LA) = unambiguous instrument
      // "stock" alone kept as an override so "SF stock price" → Ψ-EMA if desired
      const hasExplicitStockCue = /\$[A-Z]{1,5}\b|\b(stock|stocks)\b/i.test(classificationQuery);
      
      // If geo-intent detected AND no explicit ticker cue AND no ticker already detected, force Seed Metric
      if (hasGeoIntent && !hasExplicitStockCue && !psiEmaDetection.ticker) {
        logger.debug(`🌍 GEO-VETO: City abbreviations + comparison detected → forcing Seed Metric mode`);
        result.mode = 'seed-metric';
        result.routingFlags.isSeedMetric = true;
        result.routingFlags.geoVetoApplied = true;
        result.searchStrategy = 'brave';
        
        // Extract cities from abbreviations for search (use global flag to get ALL matches)
        const detectedAbbrevs = classificationQuery.toLowerCase().match(/\b(la|ny|sf|dc|hk|kl)\b/gi) || [];
        const gvCities = [...new Set(detectedAbbrevs.map(abbr => CITY_EXPAND[abbr.toLowerCase()] || abbr.toLowerCase()))];

        // Expand country names (GEO-VETO path)
        const gvDetectedCountries = [];
        const gvCountryRegex = new RegExp(COUNTRY_CITY_MAP_KEYS_PATTERN, 'gi');
        for (const match of classificationQuery.matchAll(gvCountryRegex)) {
          const countryKey = match[0].toLowerCase();
          if (!gvDetectedCountries.includes(countryKey)) gvDetectedCountries.push(countryKey);
          for (const city of COUNTRY_CITY_MAP[countryKey] || []) {
            if (!gvCities.includes(city)) gvCities.push(city);
          }
        }

        // Detect ALL years: first = historical, last = current
        const gvMostRecentYear = String(new Date().getFullYear() - 1);
        const gvDefaultHistoricalYear = String(new Date().getFullYear() - 25);
        const gvAllYears = [...classificationQuery.matchAll(/\b(19[5-9]\d|20[0-2]\d)s?\b/g)].map(m => m[1]);
        const gvHistoricalYear = gvAllYears.length > 0 ? gvAllYears[0] : gvDefaultHistoricalYear;
        const gvCurrentYear = gvAllYears.length > 1 ? gvAllYears[gvAllYears.length - 1] : gvMostRecentYear;
        const gvHistoricalDecade = `${gvHistoricalYear.slice(0, 3)}0s`;

        if (gvCities.length > 0) {
          result.seedMetricSearchQueries = gvCities.flatMap(city => {
            const q = buildSearchQueries({ city, currentYear: gvCurrentYear, histYear: gvHistoricalYear, histDecade: gvHistoricalDecade });
            return [q.currentPrice, q.currentIncome, q.historicalPrice, q.historicalIncome];
          });
          for (const countryName of gvDetectedCountries) {
            result.seedMetricSearchQueries.push(`${countryName} national average property price per sqm ${gvCurrentYear}`);
            result.seedMetricSearchQueries.push(`${countryName} minimum wage annual ${gvCurrentYear}`);
          }
          result.historicalDecade = gvHistoricalDecade;
          result.historicalYear = gvHistoricalYear;
          result.currentYear = gvCurrentYear;
          logger.debug(`🏠 GEO-VETO: Seed Metric for cities: ${gvCities.join(', ')}, historical: ${gvHistoricalDecade}, current: ${gvCurrentYear}`);
        }
        
        // Skip rest of Ψ-EMA processing - return early handled by mode check below
      }
      
      // ========================================
      // BIDIRECTIONAL 2/3 KEY RESCUE (AI-PUSH)
      // Read → Interpret → Push → Retry
      // ========================================
      // Scenario 1: verb + adjective, no ticker → AI extracts ticker
      // Scenario 2: ticker + verb, no adjective → infer adjective (implied "price")
      // Scenario 3: ticker + adjective, no verb → infer verb (implied "analyze")
      // Scenario 4: ticker only + stock context → infer both
      
      // SKIP AI-PUSH if geo-intent already triggered Seed Metric
      if (result.mode === 'seed-metric') {
        logger.debug(`🌍 GEO-VETO: Skipping AI-PUSH (Seed Metric mode active)`);
      }
      
      let aiRescuedTicker = null;
      let aiInferredVerb = false;
      let aiInferredAdjective = false;
      const hasTicker = !!psiEmaDetection.ticker;
      const keyCount = psiEmaDetection.keys.length;
      
      // Scenario 1: Has verb + adjective but no ticker → try AI ticker extraction
      // BLOCKED if geo-intent detected
      if (!psiEmaDetection.shouldTrigger && hasVerb && hasAdjective && !hasTicker && result.mode !== 'seed-metric') {
        logger.debug(`🔧 AI-PUSH: verb + adjective detected, missing ticker → extracting...`);
        aiRescuedTicker = await smartDetectTicker(classificationQuery);
        if (aiRescuedTicker) {
          logger.info(`✅ AI-PUSH: Rescued ticker: ${aiRescuedTicker}`);
        }
      }
      
      // Scenario 2: Has ticker + verb, missing adjective → infer adjective
      if (!psiEmaDetection.shouldTrigger && hasTicker && hasVerb && !hasAdjective) {
        logger.debug(`🔧 AI-PUSH: ticker + verb detected, inferring adjective (implied: price/trend)`);
        aiInferredAdjective = true;
      }
      
      // Scenario 3: Has ticker + adjective, missing verb → infer verb
      if (!psiEmaDetection.shouldTrigger && hasTicker && hasAdjective && !hasVerb) {
        logger.debug(`🔧 AI-PUSH: ticker + adjective detected, inferring verb (implied: analyze)`);
        aiInferredVerb = true;
      }
      
      // Scenario 4: Has ticker only + explicit stock context → infer both
      if (!psiEmaDetection.shouldTrigger && hasTicker && !hasVerb && !hasAdjective && hasExplicitStockCue) {
        logger.debug(`🔧 AI-PUSH: ticker + stock keyword detected, inferring verb + adjective`);
        aiInferredVerb = true;
        aiInferredAdjective = true;
      }
      
      // Calculate effective key count after AI inference
      // Rule: 2/3 keys where one is a ticker (not 2 + ticker)
      const effectiveHasTicker = hasTicker || !!aiRescuedTicker;
      const effectiveHasVerb = hasVerb || aiInferredVerb;
      const effectiveHasAdjective = hasAdjective || aiInferredAdjective;
      const effectiveKeyCount = (effectiveHasTicker ? 1 : 0) + (effectiveHasVerb ? 1 : 0) + (effectiveHasAdjective ? 1 : 0);
      
      // GEO-VETO GUARD: Skip Ψ-EMA unlock entirely if Seed Metric mode was forced
      // Also unlock if ticker was pre-set by crypto cross-rate interception (0a above)
      const shouldUnlock = result.mode !== 'seed-metric' && 
        ((effectiveKeyCount >= 2 && effectiveHasTicker) || psiEmaDetection.shouldTrigger || hasExplicitModeKeyword || !!result.ticker);
      
      if (shouldUnlock) {
        logger.debug(`🔑 AI-PUSH: ${effectiveKeyCount}/3 keys [ticker=${effectiveHasTicker}, verb=${effectiveHasVerb}, adj=${effectiveHasAdjective}] OR keyword=${hasExplicitModeKeyword} → ✅ UNLOCK`);
      }
    
      // DEFERRED MODE: Only commit to psi-ema AFTER verifying ticker is valid
      // This prevents false positives like "NY" (city) being treated as ticker
      // SKIP entirely if Seed Metric mode was forced by geo-veto
      let tickerVerified = false;
      
      if ((shouldUnlock || contextFallbackApplies) && result.mode !== 'seed-metric') {
        // Use ticker from key detection, AI rescue, pre-set (crypto interception), or context
        result.ticker = psiEmaDetection.ticker || aiRescuedTicker || result.ticker || await smartDetectTicker(classificationQuery);
        
        // If no ticker from current query, use context-inferred ticker
        if (!result.ticker && contextResult?.inferredTicker) {
          result.ticker = contextResult.inferredTicker;
          logger.debug(`📜 Preflight: Using context-inferred ticker ${result.ticker}`);
        }
        
        // Normalize crypto cross-rate tickers to yfinance format before fetch
        // e.g. BTCUSD → BTC-USD, ETHUSD → ETH-USD, SOLUSDT → SOL-USD
        if (result.ticker) {
          const cryptoNorm = result.ticker.match(/^([A-Z]{2,6})(USDT?)$/);
          if (cryptoNorm) {
            const normalized = `${cryptoNorm[1]}-USD`;
            logger.debug(`🔄 Preflight: Crypto ticker normalized ${result.ticker} → ${normalized}`);
            result.ticker = normalized;
          }
        }

        if (result.ticker) {
          logger.debug(`🎯 Preflight: Attempting ticker verification for ${result.ticker}`);
          
          // Fetch stock data (exact periods: 3mo daily, 15mo weekly)
          try {
            result.stockData = await fetchStockPrices(result.ticker, customPeriod);
            result.dataAge = calculateDataAge(result.stockData?.endDate);
            
            // Use barCount from optimized fetch (exact data, no buffer)
            const dailyBars = result.stockData?.daily?.barCount || 0;
            const weeklyBars = result.stockData?.weekly?.barCount || 0;
            const weeklyUnavailableReason = result.stockData?.weekly?.unavailableReason;
            
            logger.debug(`📈 Preflight: Fetched ${dailyBars} daily bars + ${weeklyBars} weekly bars for ${result.ticker}`);
            
            // TICKER VERIFIED: Any bars > 0 means valid stock ticker (even if insufficient for full analysis)
            tickerVerified = dailyBars > 0;
            
            // Run Ψ-EMA analysis on BOTH timeframes if enough data
            // Daily: need 55 bars for EMA-55, Weekly: need 55 bars for EMA-55
            if (dailyBars >= 55) {
              try {
                // Daily analysis (primary) - fresh dashboard instance
                const dailyDashboard = new PsiEMADashboard();
                const dailyClosesRaw = result.stockData?.daily?.closes || result.stockData?.closes || [];
                // Filter out null/NaN values from yfinance (converts to null in stock-fetcher)
                const dailyCloses = dailyClosesRaw.filter(v => v != null && !isNaN(v));
                result.psiEmaAnalysis = dailyDashboard.analyze({ stocks: dailyCloses });
                result.psiEmaAnalysis.timeframe = 'daily';
                logger.debug(`📊 Preflight: Ψ-EMA daily analysis complete for ${result.ticker}`);
                
                // Weekly analysis - run if we have any data, fidelity grade handles quality
                // No hard gate: even 13 bars produces real θ, z, R (just lower fidelity)
                if (weeklyBars >= 13 && !weeklyUnavailableReason) {
                  const weeklyDashboard = new PsiEMADashboard();  // Fresh instance to avoid state mutation
                  const weeklyClosesRaw = result.stockData?.weekly?.closes || [];
                  // Filter out null/NaN values from yfinance
                  const weeklyCloses = weeklyClosesRaw.filter(v => v != null && !isNaN(v));
                  result.psiEmaAnalysisWeekly = weeklyDashboard.analyze({ stocks: weeklyCloses });
                  result.psiEmaAnalysisWeekly.timeframe = 'weekly';
                  const fidelityInfo = result.psiEmaAnalysisWeekly.fidelity?.breakdown || 'N/A';
                  logger.debug(`📊 Preflight: Ψ-EMA weekly analysis complete for ${result.ticker} (${fidelityInfo})`);
                } else if (weeklyUnavailableReason) {
                  logger.warn(`⚠️ Preflight: Weekly Ψ-EMA unavailable: ${weeklyUnavailableReason}`);
                  result.weeklyUnavailableReason = weeklyUnavailableReason;
                }
                
                // Build stock context for injection
                result.stockContext = buildStockContext(result);
                
                if (!result.stockContext) {
                  logger.warn(`⚠️ Preflight: buildStockContext returned null, falling back to limited`);
                  result.stockContext = buildLimitedStockContext(result, 'Analysis returned null (possible data quality issue)');
                }
              } catch (analysisErr) {
                logger.warn(`⚠️ Preflight: Ψ-EMA analysis failed: ${analysisErr.message}`);
                result.stockContext = buildLimitedStockContext(result, analysisErr.message);
              }
            } else if (dailyBars > 0) {
              logger.warn(`⚠️ Preflight: Insufficient data for ${result.ticker} (${dailyBars} bars, need 55 for Ψ-EMA)`);
              result.stockContext = buildLimitedStockContext(result, `Insufficient data (${dailyBars} days, need 55+ for EMA-55)`);
            } else {
              logger.warn(`❌ Preflight: No data returned for ${result.ticker}`);
              result.stockContext = buildFallbackStockContext(result.ticker);
            }
          } catch (fetchErr) {
            logger.warn(`⚠️ Preflight: Stock fetch failed for ${result.ticker}: ${fetchErr.message}`);
            result.error = `Stock fetch failed: ${fetchErr.message}`;
            // Don't set tickerVerified - fetch failed, ticker is invalid
          }
        }
        
        // COMMIT MODE: Only set psi-ema if ticker was verified with real data
        if (tickerVerified) {
          result.mode = 'psi-ema';
          result.routingFlags.usesPsiEMA = true;
          logger.info(`✅ Preflight: Ticker ${result.ticker} verified → mode=psi-ema`);
        } else if (result.ticker) {
          // Ticker pattern matched but no data — check if it's actually a city/country
          const _failedTicker = result.ticker;
          const _geoCheck = (classificationQuery + ' ' + _failedTicker).toLowerCase();
          const _cityHit = new RegExp(KNOWN_CITIES_REGEX.source, 'i').test(_geoCheck);
          const _countryHit = new RegExp(COUNTRY_CITY_MAP_KEYS_PATTERN, 'i').test(_geoCheck);

          if ((_cityHit || _countryHit) && !hasExplicitStockCue) {
            // GEOGRAPHIC GUARD: geographic entity failed YF → redirect to seed-metric
            logger.debug(`🌍 GEOGRAPHIC GUARD: "${_failedTicker}" failed YF + geo entity detected → seed-metric`);
            result.ticker = null;
            result.stockData = null;
            result.stockContext = null;
            result.mode = 'seed-metric';
            result.routingFlags.isSeedMetric = true;
            result.routingFlags.geoGuardApplied = true;
            result.searchStrategy = 'brave';

            // Build city search queries (same logic as primary seed-metric block)
            const _smCities = [...new Set((_geoCheck.match(new RegExp(KNOWN_CITIES_REGEX.source, 'gi')) || []).map(c => c.toLowerCase()))];
            const _smCountries = [];
            const _smCountryRegex = new RegExp(COUNTRY_CITY_MAP_KEYS_PATTERN, 'gi');
            for (const m of _geoCheck.matchAll(_smCountryRegex)) {
              const ck = m[0].toLowerCase();
              if (!_smCountries.includes(ck)) _smCountries.push(ck);
              for (const city of COUNTRY_CITY_MAP[ck] || []) {
                if (!_smCities.includes(city)) _smCities.push(city);
              }
            }
            const _smCurrentYear = String(new Date().getFullYear() - 1);
            const _smAllYears = [...classificationQuery.matchAll(/\b(19[5-9]\d|20[0-2]\d)s?\b/g)].map(m => m[1]);
            const _smHistoricalYear = _smAllYears[0] || String(new Date().getFullYear() - 25);
            const _smCurrentYearFinal = _smAllYears.length > 1 ? _smAllYears[_smAllYears.length - 1] : _smCurrentYear;
            const _smHistoricalDecade = `${_smHistoricalYear.slice(0, 3)}0s`;
            result.historicalDecade = _smHistoricalDecade;
            result.historicalYear = _smHistoricalYear;
            result.currentYear = _smCurrentYearFinal;

            if (_smCities.length > 0) {
              result.seedMetricSearchQueries = _smCities.flatMap(city => {
                const q = buildSearchQueries({ city, currentYear: _smCurrentYearFinal, histYear: _smHistoricalYear, histDecade: _smHistoricalDecade });
                return [q.currentPrice, q.currentIncome, q.historicalPrice, q.historicalIncome];
              });
              for (const cn of _smCountries) {
                result.seedMetricSearchQueries.push(`${cn} national average property price per sqm ${_smCurrentYearFinal}`);
                result.seedMetricSearchQueries.push(`${cn} minimum wage annual ${_smCurrentYearFinal}`);
              }
              logger.debug(`🌍 GEOGRAPHIC GUARD: Seed Metric for cities: ${_smCities.join(', ')}, historical: ${_smHistoricalDecade}`);
            } else {
              const fb = buildFallbackSearchQueries({ currentYear: _smCurrentYearFinal, histDecade: _smHistoricalDecade });
              result.seedMetricSearchQueries = [fb.currentPrice, fb.currentIncome, fb.historicalPrice, fb.historicalIncome];
            }
          } else {
            // Not a geographic entity — genuine invalid ticker
            logger.warn(`❌ Preflight: Ticker ${_failedTicker} invalid (no data) → mode=general`);
            result.ticker = null;
            result.stockData = null;
            result.stockContext = null;
            result.mode = 'general';
          }
        } else {
          // No ticker at all
          result.mode = 'general';
        }
      }
      // 3. Default: Groq-first (no search until audit rejects)
      // GUARD: Don't override seed-metric mode set by geo-veto
      else if (result.mode !== 'seed-metric') {
        result.mode = 'general';
      }
    }
    
    // ========================================
    // ATTACHMENT/DOCUMENT CONTEXT FLAGS
    // ========================================
    
    // Check for financial documents
    if (docContext.hasFinancialDoc || 
        attachments.some(a => a.name?.match(/\.(xlsx|xls)$/i))) {
      result.routingFlags.usesFinancialPhysics = true;
    }
    
    // Check for legal documents
    if (docContext.hasLegalDoc || 
        attachments.some(a => LEGAL_KEYWORDS_REGEX?.test(a.name || ''))) {
      result.routingFlags.usesLegalAnalysis = true;
    }

    // Check for chemistry / compound queries — fires on text too, not just attachments.
    // For vision attachments (image/*) the attachment-cascade handles DDG enrichment.
    // For text-only queries and text-only PDFs, we fetch it here and store on result
    // so buildSystemContext can inject it alongside the seed in one atomic block.
    if (CHEMISTRY_KEYWORDS_REGEX.test(classificationQuery)) {
      result.routingFlags.usesChemistryAnalysis = true;
      const hasImageAttachments = attachments.some(a => (a.mimeType || a.type || '').startsWith('image/'));
      if (!hasImageAttachments) {
        try {
          const chemResult = await processChemistryContent(null, classificationQuery);
          if (chemResult?.enrichedText) {
            result.chemistryEnrichment = chemResult.enrichedText;
            logger.debug(`🔬 Chemistry DDG enrichment fetched (text path, ${chemResult.stage})`);
          }
        } catch (err) {
          logger.warn(`⚠️ Chemistry DDG enrichment failed (non-fatal): ${err.message}`);
        }
      }
    }
    
    // Check for code files (HIGH PRIORITY - overrides general AND forex when code files uploaded)
    // Code audit from attachments takes precedence over ambient mode detection
    const codeDetection = detectCodeMode(attachments, [
      ...(docContext.extractedContent || []),
      { text: query, fileName: 'query.txt' } // Detect code pasted in query too
    ]);
    const codeFromAttachment = attachments.length > 0 && codeDetection.detected;
    const codeFromQuery = codeDetection.detected && codeDetection.fileName === 'query.txt';
    
    // Override if: (1) code from attachment OR (2) code pasted in query + mode is general/forex
    if (codeFromAttachment || (codeFromQuery && ['general', 'forex'].includes(result.mode))) {
      // Clear stale forex state when promoting to code-audit
      if (result.mode === 'forex') {
        result.ticker = null;
        result.forexPair = null;
        result.routingFlags.usesPsiEma = false;
        logger.debug(`🔄 Preflight: Clearing forex state for code-audit override`);
      }
      result.mode = 'code-audit';
      result.routingFlags.usesCodeAudit = true;
      result.codeAuditMeta = {
        fileName: codeDetection.fileName,
        language: codeDetection.language
      };
      logger.debug(`🔍 Preflight: CODE_AUDIT detected for ${codeDetection.fileName} (${codeDetection.language})`);
    }
    
  } catch (err) {
    console.error(`❌ Preflight router error: ${err.message}`);
    result.error = err.message;
    result.mode = 'general';
  }
  
  // ========================================
  // DDG DIALECTIC ENRICHMENT (applies to general mode)
  // Default-on: DDG-first for all general queries as external antithesis (H₀).
  // Opt-out: math/code/creative/greeting/translate/summarize queries skip search.
  // Realtime-intent patterns always force search regardless of opt-out.
  // ========================================
  if (result.mode === 'general' && shouldSearchDDG(classificationQuery)) {
    result.routingFlags.needsRealtimeSearch = true;
    result.searchStrategy = 'duckduckgo';
    const isRealtime = detectRealtimeIntent(classificationQuery);
    logger.debug(`🔍 Preflight: DDG enrichment enabled (realtime=${isRealtime}) → DDG→Brave cascade`);
  }
  
  logger.debug(`🚦 Preflight: mode=${result.mode}, ticker=${result.ticker || 'none'}, search=${result.searchStrategy}, realtime=${result.routingFlags.needsRealtimeSearch}`);
  return result;
}

/**
 * Build full Ψ-EMA stock context for system message injection
 * Maps PsiEMADashboard.analyze() output to LLM-readable format
 */
function buildStockContext(preflight) {
  const { ticker, stockData, psiEmaAnalysis, dataAge } = preflight;
  if (!stockData || !psiEmaAnalysis) return null;
  
  const ageFlag = dataAge?.flag || '⚠️';
  
  // Correctly map PsiEMADashboard output structure (vφ⁴: no composite signal):
  // - summary: aggregated signals (phaseSignal, anomalyLevel, regime)
  // - dimensions: detailed analysis (phase.current, anomaly.currentZ, convergence.currentR)
  // - fidelity: grade, percent
  const summary = psiEmaAnalysis.summary || {};
  const phase = psiEmaAnalysis.dimensions?.phase || {};
  const anomaly = psiEmaAnalysis.dimensions?.anomaly || {};
  const convergence = psiEmaAnalysis.dimensions?.convergence || {};
  const fidelity = psiEmaAnalysis.fidelity || {};
  const fundamentals = stockData.fundamentals || {};
  
  // Extract raw dimension values
  const phaseTheta = phase.current;   // θ angle in degrees
  const anomalyZ   = anomaly.current; // z-score
  const convergenceR = convergence.currentDisplay ?? convergence.current; // R ratio

  // vφ⁴: reading from deriveReading decision tree — source of truth for all labels
  const reading = psiEmaAnalysis.reading || {};
  const readingText  = reading.reading  || summary.reading      || 'N/A';
  const readingEmoji = reading.emoji    || summary.readingEmoji  || '⚪';

  // Canonical CSV signal labels — pure math, the scribe describes not prescribes
  // θ signal: IF(Theta<0,"(-) negative","(+) positive")
  const phaseSignal = (phaseTheta != null && !isNaN(phaseTheta) && phaseTheta < 0)
    ? '(-) negative' : '(+) positive';
  // z signal: IF(ABS(z)>φ²,"Anomaly","Low Anomaly")  — φ²=2.618
  const anomalyLevel = (anomalyZ != null && !isNaN(anomalyZ) && Math.abs(anomalyZ) > 2.618)
    ? 'Anomaly' : 'Low Anomaly';
  // R signal: reading label from deriveReading (same label shown in Assessment line)
  const regimeLabel = readingText !== 'N/A' ? readingText : 'N/A';
  
  // Build tetralemma alert if φ² crossed
  const tetralemmaAlert = psiEmaAnalysis.renewal?.tetralemma 
    ? `\n${psiEmaAnalysis.renewal.tetralemma.warning}\nTetralemma: (10)Bubble (01)Breakthrough (11)Both (00)Neither - Investigate fundamentals.`
    : '';
  
  // Build company header
  let companyHeader = '';
  const sectorIndustry = [fundamentals.sector, fundamentals.industry].filter(Boolean).join(' / ');
  const atomicUnits = fundamentals.atomicUnits || [];
  
  // Format atomic units (multi-line block) - Stock, Flow, Guard taxonomy
  let atomicSection = '';
  if (atomicUnits.length > 0) {
    const stockUnits = atomicUnits.filter(u => u.includes('(state)')).map(u => u.replace(' (state)', ''));
    const flowUnits = atomicUnits.filter(u => u.includes('(flow)')).map(u => u.replace(' (flow)', ''));
    const guardUnits = atomicUnits.filter(u => u.includes('(guard)')).map(u => u.replace(' (guard)', ''));
    const lines = [];
    if (stockUnits.length > 0) lines.push(`**Stock**: ${stockUnits.join(', ')}`);
    if (flowUnits.length > 0) lines.push(`**Flow**: ${flowUnits.join(', ')}`);
    if (guardUnits.length > 0) lines.push(`**Guard**: ${guardUnits.join(', ')}`);
    if (lines.length > 0) {
      atomicSection = `\n**Atomic Units**:\n${lines.join('\n')}`;
    }
  }
  
  companyHeader = `### ${stockData.name || ticker} (${ticker})${sectorIndustry ? ` — ${sectorIndustry}` : ''}`;

  // Format fundamentals (inline with D/E ratio)
  const fundParts = [];
  if (fundamentals.peRatio) fundParts.push(`P/E: ${safeFixed(fundamentals.peRatio)}`);
  if (fundamentals.forwardPE) fundParts.push(`Fwd P/E: ${safeFixed(fundamentals.forwardPE)}`);
  if (fundamentals.marketCap) fundParts.push(`MCap: ${formatMarketCap(fundamentals.marketCap)}`);
  if (fundamentals.debtToEquity != null) fundParts.push(`D/E: ${safeFixed(fundamentals.debtToEquity)}`);
  if (fundamentals.fiftyTwoWeekHigh && fundamentals.fiftyTwoWeekLow) {
    fundParts.push(`52W: $${safeFixed(fundamentals.fiftyTwoWeekLow)}-$${safeFixed(fundamentals.fiftyTwoWeekHigh)}`);
  }
  const fundamentalsLine = fundParts.length > 0 ? fundParts.join(' | ') : '';

  // Compact Ψ-EMA table: summary row for quick reading before the DAILY/WEEKLY detail block.
  // atomicSection before price — "what and how" of the company from sector/industry map.
  return `${companyHeader}
${atomicSection}
**Price**: ${stockData.currency || 'USD'} ${safeFixed(stockData.currentPrice)} (${ageFlag} ${dataAge?.timestamp})
${fundamentalsLine}

**Ψ-EMA** (θ=Cycle Position, z=Price Deviation, R=Momentum Ratio): alignment → conviction; conflict → caution.
| Dim | Value | Signal |
|-----|-------|--------|
| θ | ${fmtTheta(phaseTheta)} | ${phaseSignal} |
| z | ${safeFixed(anomalyZ)}σ | ${anomalyLevel} |
| R | ${convergenceR != null ? safeFixed(convergenceR) : 'N/A'} | ${regimeLabel} |

**Reading**: ${readingEmoji} ${readingText}${tetralemmaAlert}
`;
}

/**
 * Build limited context when Ψ-EMA analysis unavailable
 * Still provides price + fundamentals, but explains why wave analysis is missing
 * 
 * @param {Object} preflight - Preflight result
 * @param {string} reason - Reason for analysis failure (optional)
 */
function buildLimitedStockContext(preflight, reason = null) {
  const { ticker, stockData, dataAge } = preflight;
  const ageFlag = dataAge?.flag || '⚠️';
  const dataPoints = stockData?.closes?.length || 0;
  const fundamentals = stockData?.fundamentals || {};
  
  // Build fundamentals section if available
  let fundamentalsSection = '';
  if (Object.keys(fundamentals).length > 0) {
    const parts = [];
    if (fundamentals.peRatio != null) parts.push(`P/E: ${safeFixed(fundamentals.peRatio)}`);
    if (fundamentals.forwardPE != null) parts.push(`Forward P/E: ${safeFixed(fundamentals.forwardPE)}`);
    if (fundamentals.dividendYield != null) parts.push(`Dividend: ${safeFixed(fundamentals.dividendYield * 100)}%`);
    if (fundamentals.marketCap != null) parts.push(`Market Cap: ${formatMarketCap(fundamentals.marketCap)}`);
    if (fundamentals.sector) parts.push(`Sector: ${fundamentals.sector}`);
    if (parts.length > 0) {
      fundamentalsSection = `\n### Fundamentals:\n${parts.join(' | ')}`;
    }
  }
  
  // Determine the actual reason for limited context
  let reasonText = '';
  if (reason) {
    reasonText = `- **Reason**: ${reason}`;
  } else if (dataPoints < 55) {
    reasonText = `- **Reason**: Insufficient data (${dataPoints} days, need 55+ for EMA-55)`;
  } else {
    reasonText = `- **Reason**: Analysis computation error`;
  }
  
  return `
## Stock Data for ${ticker} (${stockData?.name || ticker})
**Data Source**: yfinance (VERIFIED - REAL PRICES)
**Current Price**: ${stockData?.currency || 'USD'} ${safeFixed(stockData?.currentPrice)}
**Data Timestamp**: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
${fundamentalsSection}

### ⚠️ Ψ-EMA Wave Analysis UNAVAILABLE
- **Data Points Available**: ${dataPoints} trading days
${reasonText}
- **Missing**: Phase θ, Anomaly z, Convergence R signals

The price and fundamentals above are verified.
`;
}

/**
 * Build fallback context when fetch fails
 */
function buildFallbackStockContext(ticker) {
  return `
## Stock Query: ${ticker}
Note: Unable to fetch real-time stock data for ${ticker}. Please provide general analysis based on your knowledge.
`;
}

/**
 * Build system messages from PreflightResult
 * Replaces scattered if/else blocks in index.js
 * 
 * NYAN Boot Optimization:
 * - First query: Full NYAN Protocol (~1500 tokens)
 * - Subsequent: Compressed NYAN reference (~200 tokens)
 * 
 * @param {PreflightResult} preflight
 * @param {string} nyanProtocolPrompt - The full NYAN protocol system prompt
 * @param {Object} options - Optional parameters
 * @param {boolean} options.isFirstQuery - If true, use full NYAN; else use compressed
 * @param {string} options.nyanCompressed - Compressed NYAN reference for subsequent queries
 * @returns {Array<{role: string, content: string}>}
 */
function buildSystemContext(preflight, nyanProtocolPrompt, options = {}) {
  const messages = [];
  const { isFirstQuery = true, nyanCompressed = null } = options;
  
  // Stage 0: NYAN Protocol
  // First query = full protocol (~1500 tokens)
  // Subsequent = compressed reference (~200 tokens) for token efficiency
  if (isFirstQuery || !nyanCompressed) {
    messages.push({ role: 'system', content: nyanProtocolPrompt });
    logger.debug('📜 NYAN: Full protocol injected (session boot)');
  } else {
    messages.push({ role: 'system', content: nyanCompressed });
    logger.debug('📜 NYAN: Compressed reference injected (session active)');
  }
  
  // Stage 1+: Extension seeds based on mode and flags
  if (preflight.routingFlags.usesFinancialPhysics) {
    messages.push({ role: 'system', content: getFinancialPhysicsSeed() });
  }
  
  if (preflight.routingFlags.usesLegalAnalysis) {
    messages.push({ role: 'system', content: getLegalAnalysisSeed() });
  }

  if (preflight.routingFlags.usesChemistryAnalysis) {
    const modelLabel = modelIdToLabel(getLLMBackend().model);
    messages.push({ role: 'system', content: getChemistryAnalysisSeed(modelLabel) });
    // DDG enrichment: injected here when fetched by preflightRouter (text/PDF path).
    // Vision path: attachment-cascade injects enrichment directly into the attachment context.
    if (preflight.chemistryEnrichment) {
      messages.push({ role: 'system', content: preflight.chemistryEnrichment });
    }
  }
  
  // Nyan identity context (H0 ground truth for "who are you" / "what is nyanbook" queries)
  if (preflight.routingFlags.isNyanIdentity && preflight.nyanIdentityContext) {
    messages.push({ role: 'system', content: preflight.nyanIdentityContext });
    logger.debug('🐱 Nyan identity registry injected (H0 ground truth)');
  }
  
  // Ψ-EMA identity context (H0 ground truth for "what is psi ema" queries)
  if (preflight.routingFlags.isPsiEmaIdentity && preflight.psiEmaIdentityContext) {
    messages.push({ role: 'system', content: preflight.psiEmaIdentityContext });
    logger.debug('📚 Ψ-EMA identity documentation injected (H0 ground truth)');
  }
  
  // Design/Architecture question context (H0 ground truth - actual source code)
  if (preflight.routingFlags.isDesignQuestion && preflight.codeContext) {
    messages.push({ role: 'system', content: preflight.codeContext });
    logger.debug(`🔧 Code context injected for topics: ${preflight.codeTopics?.join(', ') || 'unknown'}`);
  }
  
  // Ψ-EMA context
  if (preflight.routingFlags.usesPsiEMA) {
    messages.push({ role: 'system', content: getPsiEMAContext() });
    
    // Inject stock analysis if available
    if (preflight.stockContext) {
      messages.push({ role: 'system', content: preflight.stockContext });
    }
  }
  
  // Forex context - inject real exchange rate data to prevent hallucination
  if (preflight.routingFlags.usesForex && preflight.forexContext) {
    messages.push({ role: 'system', content: preflight.forexContext });
    logger.debug(`💱 Forex context injected: ${preflight.forexData?.pair || 'unknown'}`);
  }
  
  // Seed Metric proxy cascade - conditional injection (saves ~300 tokens when not triggered)
  if (preflight.routingFlags.isSeedMetric) {
    messages.push({ role: 'system', content: getSeedMetricProxy({
      historicalDecade: preflight.historicalDecade,
      historicalYear: preflight.historicalYear,
      currentYear: preflight.currentYear
    }) });
    logger.debug(`🏠 Seed Metric proxy cascade injected (scavenger hunt map)`);
  }
  
  return messages;
}

/**
 * Compound Query Detector
 * 
 * Detects multi-intent messages that should be split into separate pipeline runs.
 * e.g., "$SPY price trend? also what does this image say?" → 2 sub-queries
 * 
 * Returns null if query is single-intent.
 * Returns array of { query, label, hasAttachments } if compound.
 */
function detectCompoundQuery(query, hasPhotos = false, hasDocuments = false) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (trimmed.length < 15) return null;

  const SPLIT_PATTERNS = [
    /\.\s*(?:also|and also|additionally|plus|another thing|on another note|separately|by the way|btw)\s*[,:]?\s*/i,
    /[?!]\s*(?:also|and also|additionally|plus|another thing|on another note|separately|by the way|btw)\s*[,:]?\s*/i,
    /[?!]\s+(?:and\s+)?(?=(?:what|how|can|could|do|does|is|are|tell|show|explain|describe)\s)/i,
  ];

  const MAX_PARTS = 5;

  function labelPart(text, hasTicker, hasImageRef) {
    if (hasTicker) return 'Price & Trend Analysis';
    if (hasImageRef && hasPhotos) return 'Image Analysis';
    if (/\b(document|pdf|file|excel|spreadsheet)\b/i.test(text) && hasDocuments) return 'Document Analysis';
    if (isForexQuery(text) || detectForexPair(text)) return 'Forex Analysis';
    if (detectSeedMetricIntent(text)) return 'Real Estate Analysis';
    if (LEGAL_KEYWORDS_REGEX && LEGAL_KEYWORDS_REGEX.test(text)) return 'Legal Analysis';
    if (CHEMISTRY_KEYWORDS_REGEX && CHEMISTRY_KEYWORDS_REGEX.test(text)) return 'Chemistry Analysis';
    return 'General Query';
  }

  function makePart(text) {
    const hasTicker = /\$[A-Z]{1,5}\b/.test(text) || detectPsiEMAKeys(text).shouldTrigger;
    const hasImageRef = /\b(image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i.test(text);
    return {
      query: text,
      label: labelPart(text, hasTicker, hasImageRef),
      includePhotos: hasImageRef && hasPhotos,
      includeDocuments: /\b(document|pdf|file|excel|spreadsheet)\b/i.test(text) && hasDocuments,
      _hasTicker: hasTicker,
      _hasImageRef: hasImageRef
    };
  }

  function findSplit(text) {
    for (const pattern of SPLIT_PATTERNS) {
      const match = text.match(pattern);
      if (match && match.index > 10 && match.index < text.length - 10) {
        return { index: match.index, length: match[0].length };
      }
    }
    return null;
  }

  function findTickerImageSplit(text) {
    const hasTickerSignal = /\$[A-Z]{1,5}\b/.test(text) || detectPsiEMAKeys(text).shouldTrigger;
    const hasImageSignal = hasPhotos && /\b(image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i.test(text);
    if (!hasTickerSignal || !hasImageSignal) return null;

    const imageRefPatterns = [
      /[?.]?\s*(?:also\s+)?(?:and\s+)?(?:what|how|can|could|tell|show|explain|describe|analyze|look)\s.*\b(?:image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i,
      /\b(?:image|photo|picture|pic|screenshot|this|attached|uploaded)\b.*[?]/i,
    ];
    for (const pattern of imageRefPatterns) {
      const match = text.match(pattern);
      if (match && match.index > 5) {
        const idx = /^[?.\s]/.test(match[0]) ? match.index + 1 : match.index;
        return { index: idx, length: 0 };
      }
    }
    return null;
  }

  // Iteratively split remainder until no more breaks found or MAX_PARTS reached
  const parts = [];
  let remainder = trimmed;

  while (parts.length < MAX_PARTS - 1 && remainder.length >= 15) {
    const split = findSplit(remainder) || (parts.length === 0 ? findTickerImageSplit(remainder) : null);
    if (!split) break;

    const head = remainder.slice(0, split.index).replace(/[?.!,\s]+$/, '').trim();
    const tail = remainder.slice(split.index + split.length).trim();

    if (head.length < 5 || tail.length < 5) break;

    parts.push(makePart(head));
    remainder = tail;
  }

  if (parts.length === 0) return null;

  // Last piece is the final remainder
  parts.push(makePart(remainder));

  // Fallback: if no part got photos assigned but query has photos, give them to last part
  const anyPhotos = parts.some(p => p.includePhotos);
  if (!anyPhotos && hasPhotos) {
    const last = parts[parts.length - 1];
    last.includePhotos = true;
    if (last.label === 'General Query') last.label = 'Image Analysis';
  }

  // Strip internal helper fields before returning
  const subQueries = parts.map(({ query, label, includePhotos, includeDocuments }) =>
    ({ query, label, includePhotos, includeDocuments })
  );

  logger.debug(`🔀 COMPOUND QUERY DETECTED: Split into ${subQueries.length} sub-queries`);
  subQueries.forEach((sq, i) => {
    logger.debug(`   ${i + 1}. [${sq.label}] "${sq.query.slice(0, 60)}..." photos=${sq.includePhotos}`);
  });

  return subQueries;
}

module.exports = {
  preflightRouter,
  buildSystemContext,
  detectCompoundQuery,
  detectRealtimeIntent,
  detectAbstractTopic,
  shouldSearchDDG,
  classifyTemporalVolatility,
  safeFixed
};
