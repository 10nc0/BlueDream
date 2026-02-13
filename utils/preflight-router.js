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

const { detectStockTicker, detectPsiEMAKeys, smartDetectTicker, fetchStockPrices, calculateDataAge } = require('./stock-fetcher');
const { getPsiEMAContext, PsiEMADashboard, PSI_EMA_DOCUMENTATION } = require('./psi-EMA');
const { getFinancialPhysicsSeed } = require('./financial-physics');
const { getLegalAnalysisSeed, LEGAL_KEYWORDS_REGEX } = require('../prompts/legal-analysis');
const { detectForexPair, isForexQuery, fetchForexRate, buildForexContext } = require('./forex-fetcher');
const { getSeedMetricProxy, detectSeedMetricIntent } = require('../prompts/seed-metric');
const { detectCodeMode, getLanguageFromExtension } = require('../lib/mode-registry');
const { isDesignQuestion, getSystemContextForDesign } = require('./code-context');

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
  // Sports (EPL, NFL, NBA, etc.)
  /\b(epl|premier\s*league|nfl|nba|mlb|mls|champions\s*league|world\s*cup|la\s*liga|bundesliga|serie\s*a|ligue\s*1)\b/i,
  /\b(match|game|fixture|score|schedule|standings|results?)\s+(today|tonight|tomorrow|this\s*week|next\s*week|upcoming)\b/i,
  /\b(upcoming|next|today'?s?|tonight'?s?|this\s*week'?s?)\s+(match|game|fixture|schedule)\b/i,
  
  // News & Current Events
  /\b(latest|breaking|recent|current|today'?s?)\s+(news|headlines|events?|updates?|developments?)\b/i,
  /\bwhat\s+(?:is\s+)?happen(?:ing|ed)\s+(today|now|recently|this\s*week)\b/i,
  
  // Weather
  /\b(weather|forecast|temperature|rain|snow|sunny|cloudy)\s+(today|tomorrow|this\s*week|in\s+\w+)\b/i,
  /\b(today'?s?|tomorrow'?s?|current)\s+(weather|forecast|temperature)\b/i,
  
  // Time-sensitive queries
  /\b(when\s+is|what\s+time|schedule\s+for|upcoming)\b/i,
  /\b(live|real[\s\-]?time|right\s*now|currently)\b/i,
  
  // Explicit web search requests
  /\b(search|google|look\s*up|find\s+(?:me\s+)?(?:the\s+)?(?:latest|current|recent))\b/i,
  /\b(what\s+is\s+the\s+(?:latest|current|recent))\b/i,
];

/**
 * Detect if query needs real-time web search
 * @param {string} query
 * @returns {boolean}
 */
function detectRealtimeIntent(query) {
  if (!query || typeof query !== 'string') return false;
  return REALTIME_INTENT_PATTERNS.some(pattern => pattern.test(query));
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
  
  console.log(`📦 BLOB DETECTED: ${text.length} chars, ${sentences.length} sentences → extracted ${mainSentences.length} main sentences for classification`);
  
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
    dataAge: null,
    searchStrategy: 'none',
    routingFlags: {
      usesPsiEMA: false,
      isPsiEmaIdentity: false,
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
    const designContext = getSystemContextForDesign(classificationQuery);
    if (designContext) {
      console.log(`🔧 Preflight: Design question detected → injecting source code for: ${designContext.topics.join(', ')}`);
      result.mode = 'design';
      result.routingFlags.isDesignQuestion = true;
      result.codeContext = designContext.systemMessage;
      result.codeTopics = designContext.topics;
      return result;
    }
    
    // -1. Ψ-EMA IDENTITY: "What is Ψ-EMA?" queries → inject actual documentation (H0 ground truth)
    const hasTicker = /\$[A-Z]{1,5}\b/.test(classificationQuery);
    const isPsiEmaIdentity = !hasTicker && PSI_EMA_IDENTITY_PATTERNS.some(p => p.test(classificationQuery.trim()));
    
    if (isPsiEmaIdentity) {
      console.log(`📚 Preflight: Ψ-EMA identity query detected → injecting documentation`);
      result.mode = 'psi-ema-identity';
      result.routingFlags.isPsiEmaIdentity = true;
      result.psiEmaIdentityContext = PSI_EMA_DOCUMENTATION;
      return result;
    }
    
    // 0. FOREX: Detect currency pair queries FIRST (before stock detection)
    // USD/JPY, EUR/USD, "yen rate", "dollar to euro", etc.
    const forexPair = detectForexPair(classificationQuery);
    if (forexPair || isForexQuery(classificationQuery)) {
      result.mode = 'forex';
      result.routingFlags.usesForex = true;
      
      if (forexPair) {
        console.log(`💱 Preflight: Detected forex pair ${forexPair.base}/${forexPair.quote}`);
        
        try {
          result.forexData = await fetchForexRate(forexPair.base, forexPair.quote);
          result.forexContext = buildForexContext(result.forexData);
          console.log(`💱 Preflight: Fetched ${forexPair.pair} rate: ${result.forexData.rate}`);
        } catch (forexErr) {
          console.log(`⚠️ Preflight: Forex fetch failed: ${forexErr.message}`);
          result.error = `Forex fetch failed: ${forexErr.message}`;
        }
      } else {
        console.log(`💱 Preflight: Forex query detected but no specific pair extracted`);
      }
    }
    // 1. SEED METRIC: Check FIRST before Ψ-EMA (city names like LA/NY shouldn't be tickers)
    // Web-first search for grounded real estate data - LLM training data is stale
    else if (detectSeedMetricIntent(classificationQuery)) {
      result.mode = 'seed-metric';
      result.routingFlags.isSeedMetric = true;
      result.searchStrategy = 'brave';
      
      // Extract city names for targeted search (major world cities + common variants)
      const cityPattern = /\b(tokyo|singapore|hong kong|hongkong|london|new york|nyc|sydney|paris|berlin|shanghai|beijing|seoul|taipei|osaka|mumbai|bombay|delhi|new delhi|bangkok|jakarta|manila|kuala lumpur|kl|ho chi minh|saigon|hanoi|san francisco|sf|los angeles|la|chicago|toronto|vancouver|melbourne|auckland|dubai|abu dhabi|munich|munich|frankfurt|amsterdam|madrid|barcelona|rome|milan|vienna|zurich|geneva|stockholm|copenhagen|oslo|helsinki|brussels|prague|warsaw|budapest|moscow|st petersburg|sao paulo|rio de janeiro|mexico city|buenos aires|bogota|lima|santiago|johannesburg|cape town|cairo|tel aviv|istanbul|athens|lisbon|dublin|edinburgh|manchester|birmingham|seattle|boston|washington dc|miami|dallas|houston|denver|phoenix|atlanta|detroit|philadelphia|minneapolis|portland|austin|san diego|honolulu|anchorage|montreal|calgary|ottawa|perth|brisbane|adelaide|wellington|christchurch|chengdu|shenzhen|guangzhou|hangzhou|nanjing|wuhan|xian|chongqing|tianjin|suzhou|qingdao|dalian|xiamen|fuzhou|ningbo|changsha|zhengzhou|jinan|shenyang|harbin|kunming|nanchang|hefei|taiyuan|shijiazhuang|lanzhou|urumqi|guiyang|nanning|haikou|lhasa|hohhot|yinchuan|xining)\b/gi;
      const cities = [...new Set((classificationQuery.match(cityPattern) || []).map(c => c.toLowerCase()))];
      
      // Detect historical period from query (1970, 1980, 1990, etc.) → convert to decade
      const yearMatch = classificationQuery.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
      const historicalDecade = yearMatch ? `${yearMatch[1].slice(0, 3)}0s` : '1970s';
      
      if (cities.length > 0) {
        result.seedMetricSearchQueries = cities.flatMap(city => [
          `${city} residential property price per square meter 2024`,
          `${city} median individual income salary 2024`,
          `${city} housing price ${historicalDecade} historical per sqm`,
          `${city} median income ${historicalDecade} historical`
        ]);
        result.historicalDecade = historicalDecade;
        console.log(`🏠 Preflight: SEED_METRIC detected for cities: ${cities.join(', ')}, historical: ${historicalDecade}`);
        console.log(`🔍 Preflight: Will search for: ${result.seedMetricSearchQueries.slice(0, 3).join(' | ')}...`);
      } else {
        result.seedMetricSearchQueries = [
          'residential property price per square meter comparison major cities 2024',
          'median income by country 2024',
          `housing price ${historicalDecade} historical major cities`,
          `median income ${historicalDecade} historical`
        ];
        result.historicalDecade = historicalDecade;
        console.log(`🏠 Preflight: SEED_METRIC detected (no specific city), historical: ${historicalDecade}`);
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
        console.log(`📊 Preflight: Detected custom data period: ${customPeriod}`);
      }
    
      // Context fallback: STRICT - only reuse inferred ticker if:
      // 1. We have a ticker from prior conversation, AND
      // 2. Current query has EXPLICIT stock keyword (stock/share/ticker/price), AND
      // 3. Current query has at least a verb OR adjective
      const hasContextTicker = contextResult?.inferredTicker;
      const hasExplicitStockKeyword = /\b(stock|stocks|ticker|share|shares|price|prices)\b/i.test(classificationQuery);
      const hasVerbOrAdjective = psiEmaDetection.keys.some(k => k.type === 'verb' || k.type === 'adjective');
      const hasVerb = psiEmaDetection.keys.some(k => k.type === 'verb');
      const hasAdjective = psiEmaDetection.keys.some(k => k.type === 'adjective');
      const contextFallbackApplies = hasContextTicker && hasExplicitStockKeyword && hasVerbOrAdjective;
      
      // ========================================
      // GEO-INTENT VETO: Check for geography context BEFORE AI-PUSH
      // Prevents "LA vs NY price" from triggering ticker extraction
      // ========================================
      const cityAbbreviations = /\b(la|ny|sf|dc|hk|kl)\b/i;
      const geoComparisonPattern = /\bvs\b.*\b(price|land|housing|property|cost|rent|income|salary)\b|\b(price|land|housing|property|cost|rent|income|salary)\b.*\bvs\b/i;
      const hasCityAbbreviation = cityAbbreviations.test(classificationQuery);
      const hasGeoComparison = geoComparisonPattern.test(classificationQuery);
      const hasGeoIntent = hasCityAbbreviation && (hasGeoComparison || /\bvs\b/i.test(classificationQuery));
      
      // STOCK-CONTEXT OVERRIDE: Explicit stock keywords disable geo-veto
      // e.g., "$LA", "LA stock", "LA ticker", "LA shares" → genuine ticker query
      const hasExplicitStockCue = /\$[A-Z]{1,5}\b|\b(stock|stocks|ticker|tickers|share|shares)\b/i.test(classificationQuery);
      
      // If geo-intent detected AND no explicit stock cues AND no ticker already detected, force Seed Metric
      if (hasGeoIntent && !hasExplicitStockCue && !psiEmaDetection.ticker) {
        console.log(`🌍 GEO-VETO: City abbreviations + comparison detected → forcing Seed Metric mode`);
        result.mode = 'seed-metric';
        result.routingFlags.isSeedMetric = true;
        result.routingFlags.geoVetoApplied = true;
        result.searchStrategy = 'brave';
        
        // Extract cities from abbreviations for search (use global flag to get ALL matches)
        const cityMap = { 'la': 'los angeles', 'ny': 'new york', 'sf': 'san francisco', 'dc': 'washington dc', 'hk': 'hong kong', 'kl': 'kuala lumpur' };
        const detectedAbbrevs = classificationQuery.toLowerCase().match(/\b(la|ny|sf|dc|hk|kl)\b/gi) || [];
        const cities = [...new Set(detectedAbbrevs.map(abbr => cityMap[abbr.toLowerCase()] || abbr.toLowerCase()))];
        
        // Detect historical period
        const yearMatch = classificationQuery.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
        const historicalDecade = yearMatch ? `${yearMatch[1].slice(0, 3)}0s` : '1970s';
        
        if (cities.length > 0) {
          result.seedMetricSearchQueries = cities.flatMap(city => [
            `${city} residential property price per square meter 2024`,
            `${city} median individual income salary 2024`,
            `${city} housing price ${historicalDecade} historical per sqm`,
            `${city} median income ${historicalDecade} historical`
          ]);
          result.historicalDecade = historicalDecade;
          console.log(`🏠 GEO-VETO: Seed Metric for cities: ${cities.join(', ')}, historical: ${historicalDecade}`);
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
        console.log(`🌍 GEO-VETO: Skipping AI-PUSH (Seed Metric mode active)`);
      }
      
      let aiRescuedTicker = null;
      let aiInferredVerb = false;
      let aiInferredAdjective = false;
      const hasTicker = !!psiEmaDetection.ticker;
      const keyCount = psiEmaDetection.keys.length;
      
      // Scenario 1: Has verb + adjective but no ticker → try AI ticker extraction
      // BLOCKED if geo-intent detected
      if (!psiEmaDetection.shouldTrigger && hasVerb && hasAdjective && !hasTicker && result.mode !== 'seed-metric') {
        console.log(`🔧 AI-PUSH: verb + adjective detected, missing ticker → extracting...`);
        aiRescuedTicker = await smartDetectTicker(classificationQuery);
        if (aiRescuedTicker) {
          console.log(`✅ AI-PUSH: Rescued ticker: ${aiRescuedTicker}`);
        }
      }
      
      // Scenario 2: Has ticker + verb, missing adjective → infer adjective
      if (!psiEmaDetection.shouldTrigger && hasTicker && hasVerb && !hasAdjective) {
        console.log(`🔧 AI-PUSH: ticker + verb detected, inferring adjective (implied: price/trend)`);
        aiInferredAdjective = true;
      }
      
      // Scenario 3: Has ticker + adjective, missing verb → infer verb
      if (!psiEmaDetection.shouldTrigger && hasTicker && hasAdjective && !hasVerb) {
        console.log(`🔧 AI-PUSH: ticker + adjective detected, inferring verb (implied: analyze)`);
        aiInferredVerb = true;
      }
      
      // Scenario 4: Has ticker only + explicit stock context → infer both
      if (!psiEmaDetection.shouldTrigger && hasTicker && !hasVerb && !hasAdjective && hasExplicitStockKeyword) {
        console.log(`🔧 AI-PUSH: ticker + stock keyword detected, inferring verb + adjective`);
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
      const shouldUnlock = result.mode !== 'seed-metric' && 
        ((effectiveKeyCount >= 2 && effectiveHasTicker) || psiEmaDetection.shouldTrigger || hasExplicitModeKeyword);
      
      if (shouldUnlock) {
        console.log(`🔑 AI-PUSH: ${effectiveKeyCount}/3 keys [ticker=${effectiveHasTicker}, verb=${effectiveHasVerb}, adj=${effectiveHasAdjective}] OR keyword=${hasExplicitModeKeyword} → ✅ UNLOCK`);
      }
    
      // DEFERRED MODE: Only commit to psi-ema AFTER verifying ticker is valid
      // This prevents false positives like "NY" (city) being treated as ticker
      // SKIP entirely if Seed Metric mode was forced by geo-veto
      let tickerVerified = false;
      
      if ((shouldUnlock || contextFallbackApplies) && result.mode !== 'seed-metric') {
        // Use ticker from key detection, AI rescue, or context
        result.ticker = psiEmaDetection.ticker || aiRescuedTicker || await smartDetectTicker(classificationQuery);
        
        // If no ticker from current query, use context-inferred ticker
        if (!result.ticker && contextResult?.inferredTicker) {
          result.ticker = contextResult.inferredTicker;
          console.log(`📜 Preflight: Using context-inferred ticker ${result.ticker}`);
        }
        
        if (result.ticker) {
          console.log(`🎯 Preflight: Attempting ticker verification for ${result.ticker}`);
          
          // Fetch stock data (exact periods: 3mo daily, 15mo weekly)
          try {
            result.stockData = await fetchStockPrices(result.ticker, customPeriod);
            result.dataAge = calculateDataAge(result.stockData?.endDate);
            
            // Use barCount from optimized fetch (exact data, no buffer)
            const dailyBars = result.stockData?.daily?.barCount || 0;
            const weeklyBars = result.stockData?.weekly?.barCount || 0;
            const weeklyUnavailableReason = result.stockData?.weekly?.unavailableReason;
            
            console.log(`📈 Preflight: Fetched ${dailyBars} daily bars + ${weeklyBars} weekly bars for ${result.ticker}`);
            
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
                console.log(`📊 Preflight: Ψ-EMA daily analysis complete for ${result.ticker}`);
                
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
                  console.log(`📊 Preflight: Ψ-EMA weekly analysis complete for ${result.ticker} (${fidelityInfo})`);
                } else if (weeklyUnavailableReason) {
                  console.log(`⚠️ Preflight: Weekly Ψ-EMA unavailable: ${weeklyUnavailableReason}`);
                  result.weeklyUnavailableReason = weeklyUnavailableReason;
                }
                
                // Build stock context for injection
                result.stockContext = buildStockContext(result);
                
                if (!result.stockContext) {
                  console.log(`⚠️ Preflight: buildStockContext returned null, falling back to limited`);
                  result.stockContext = buildLimitedStockContext(result, 'Analysis returned null (possible data quality issue)');
                }
              } catch (analysisErr) {
                console.log(`⚠️ Preflight: Ψ-EMA analysis failed: ${analysisErr.message}`);
                result.stockContext = buildLimitedStockContext(result, analysisErr.message);
              }
            } else if (dailyBars > 0) {
              console.log(`⚠️ Preflight: Insufficient data for ${result.ticker} (${dailyBars} bars, need 55 for Ψ-EMA)`);
              result.stockContext = buildLimitedStockContext(result, `Insufficient data (${dailyBars} days, need 55+ for EMA-55)`);
            } else {
              console.log(`❌ Preflight: No data returned for ${result.ticker}`);
              result.stockContext = buildFallbackStockContext(result.ticker);
            }
          } catch (fetchErr) {
            console.log(`⚠️ Preflight: Stock fetch failed for ${result.ticker}: ${fetchErr.message}`);
            result.error = `Stock fetch failed: ${fetchErr.message}`;
            // Don't set tickerVerified - fetch failed, ticker is invalid
          }
        }
        
        // COMMIT MODE: Only set psi-ema if ticker was verified with real data
        if (tickerVerified) {
          result.mode = 'psi-ema';
          result.routingFlags.usesPsiEMA = true;
          console.log(`✅ Preflight: Ticker ${result.ticker} verified → mode=psi-ema`);
        } else if (result.ticker) {
          // Ticker pattern matched but no data (like "NY" for city) - clear and fall through
          console.log(`❌ Preflight: Ticker ${result.ticker} invalid (no data) → mode=general`);
          result.ticker = null;
          result.stockData = null;
          result.stockContext = null;
          result.mode = 'general';
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
        console.log(`🔄 Preflight: Clearing forex state for code-audit override`);
      }
      result.mode = 'code-audit';
      result.routingFlags.usesCodeAudit = true;
      result.codeAuditMeta = {
        fileName: codeDetection.fileName,
        language: codeDetection.language
      };
      console.log(`🔍 Preflight: CODE_AUDIT detected for ${codeDetection.fileName} (${codeDetection.language})`);
    }
    
  } catch (err) {
    console.error(`❌ Preflight router error: ${err.message}`);
    result.error = err.message;
    result.mode = 'general';
  }
  
  // ========================================
  // REAL-TIME INTENT DETECTION (applies to general mode)
  // Triggers DDG → Brave cascade for sports, news, weather, etc.
  // searchStrategy stays 'duckduckgo' (primary), cascade tracked via routingFlags
  // ========================================
  if (result.mode === 'general' && detectRealtimeIntent(classificationQuery)) {
    result.routingFlags.needsRealtimeSearch = true;
    result.searchStrategy = 'duckduckgo';
    console.log(`🔍 Preflight: Real-time intent detected → DDG→Brave cascade enabled`);
  }
  
  console.log(`🚦 Preflight: mode=${result.mode}, ticker=${result.ticker || 'none'}, search=${result.searchStrategy}, realtime=${result.routingFlags.needsRealtimeSearch}`);
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
  
  // Extract values with correct property names from PsiEMADashboard output
  const phaseTheta = phase.current;  // theta angle in degrees (e.g., 359.76)
  const phaseSignal = phase.signal || summary.phaseSignal || 'N/A';
  const anomalyZ = anomaly.current;  // z-score (e.g., -0.44)
  const anomalyLevel = anomaly.alert?.level || summary.anomalyLevel || 'N/A';
  const convergenceR = convergence.currentDisplay ?? convergence.current;  // R ratio - use currentDisplay (always available)
  // Derive regime label from actual R value when available (not from gated regime)
  let regimeLabel;
  if (convergenceR != null && !isNaN(convergenceR)) {
    // Derive meaningful signal from R value using φ-thresholds
    if (convergenceR < 0) regimeLabel = 'Reversal';
    else if (convergenceR < 0.382) regimeLabel = 'Weak';
    else if (convergenceR < 0.618) regimeLabel = 'Moderate';
    else if (convergenceR < 1.618) regimeLabel = 'Healthy';
    else if (convergenceR < 2.618) regimeLabel = 'Strong';
    else regimeLabel = 'Extreme';
  } else {
    regimeLabel = typeof convergence.regime === 'string' 
      ? convergence.regime 
      : (convergence.regime?.label || summary.regime || 'N/A');
  }
  
  // vφ⁴: φ-orbital reading from decision tree
  const reading = psiEmaAnalysis.reading || {};
  const readingText = reading.reading || summary.reading || 'N/A';
  const readingEmoji = reading.emoji || summary.readingEmoji || '⚪';
  
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
  
  // Return structured data
  return `${companyHeader}
${atomicSection}

**Price**: ${stockData.currency || 'USD'} ${safeFixed(stockData.currentPrice)} (${ageFlag} ${dataAge?.timestamp})
${fundamentalsLine}

**Ψ-EMA** (θ=Cycle Position, z=Price Deviation, R=Momentum Ratio): alignment → conviction; conflict → caution.
| Dim | Value | Signal |
|-----|-------|--------|
| θ | ${safeFixed(phaseTheta)}° | ${phaseSignal} |
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
    console.log('📜 NYAN: Full protocol injected (session boot)');
  } else {
    messages.push({ role: 'system', content: nyanCompressed });
    console.log('📜 NYAN: Compressed reference injected (session active)');
  }
  
  // Stage 1+: Extension seeds based on mode and flags
  if (preflight.routingFlags.usesFinancialPhysics) {
    messages.push({ role: 'system', content: getFinancialPhysicsSeed() });
  }
  
  if (preflight.routingFlags.usesLegalAnalysis) {
    messages.push({ role: 'system', content: getLegalAnalysisSeed() });
  }
  
  // Ψ-EMA identity context (H0 ground truth for "what is psi ema" queries)
  if (preflight.routingFlags.isPsiEmaIdentity && preflight.psiEmaIdentityContext) {
    messages.push({ role: 'system', content: preflight.psiEmaIdentityContext });
    console.log('📚 Ψ-EMA identity documentation injected (H0 ground truth)');
  }
  
  // Design/Architecture question context (H0 ground truth - actual source code)
  if (preflight.routingFlags.isDesignQuestion && preflight.codeContext) {
    messages.push({ role: 'system', content: preflight.codeContext });
    console.log(`🔧 Code context injected for topics: ${preflight.codeTopics?.join(', ') || 'unknown'}`);
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
    console.log(`💱 Forex context injected: ${preflight.forexData?.pair || 'unknown'}`);
  }
  
  // Seed Metric proxy cascade - conditional injection (saves ~300 tokens when not triggered)
  if (preflight.routingFlags.isSeedMetric) {
    messages.push({ role: 'system', content: getSeedMetricProxy() });
    console.log(`🏠 Seed Metric proxy cascade injected (scavenger hunt map)`);
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

  let splitIndex = -1;
  let splitLength = 0;

  for (const pattern of SPLIT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match.index > 10 && match.index < trimmed.length - 10) {
      splitIndex = match.index;
      splitLength = match[0].length;
      break;
    }
  }

  if (splitIndex === -1) {
    const hasTickerSignal = /\$[A-Z]{1,5}\b/.test(trimmed) || 
      detectPsiEMAKeys(trimmed).shouldTrigger;
    const hasImageSignal = hasPhotos && 
      /\b(image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i.test(trimmed);

    if (hasTickerSignal && hasImageSignal) {
      const imageRefPatterns = [
        /[?.]?\s*(?:also\s+)?(?:and\s+)?(?:what|how|can|could|tell|show|explain|describe|analyze|look)\s.*\b(?:image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i,
        /\b(?:image|photo|picture|pic|screenshot|this|attached|uploaded)\b.*[?]/i,
      ];

      for (const pattern of imageRefPatterns) {
        const match = trimmed.match(pattern);
        if (match && match.index > 5) {
          splitIndex = match.index;
          splitLength = 0;
          if (/^[?.\s]/.test(match[0])) {
            splitIndex += 1;
            splitLength = 0;
          }
          break;
        }
      }
    }
  }

  if (splitIndex === -1) return null;

  const part1Text = trimmed.slice(0, splitIndex).replace(/[?.!,\s]+$/, '').trim();
  const part2Text = trimmed.slice(splitIndex + splitLength).trim();

  if (part1Text.length < 5 || part2Text.length < 5) return null;

  const part1HasTicker = /\$[A-Z]{1,5}\b/.test(part1Text) || detectPsiEMAKeys(part1Text).shouldTrigger;
  const part2HasTicker = /\$[A-Z]{1,5}\b/.test(part2Text) || detectPsiEMAKeys(part2Text).shouldTrigger;
  const part1HasImageRef = /\b(image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i.test(part1Text);
  const part2HasImageRef = /\b(image|photo|picture|pic|screenshot|this|attached|uploaded)\b/i.test(part2Text);

  function labelPart(text, hasTicker, hasImageRef) {
    if (hasTicker) return 'Price & Trend Analysis';
    if (hasImageRef && hasPhotos) return 'Image Analysis';
    if (/\b(document|pdf|file|excel|spreadsheet)\b/i.test(text) && hasDocuments) return 'Document Analysis';
    if (isForexQuery(text) || detectForexPair(text)) return 'Forex Analysis';
    if (detectSeedMetricIntent(text)) return 'Real Estate Analysis';
    if (LEGAL_KEYWORDS_REGEX && LEGAL_KEYWORDS_REGEX.test(text)) return 'Legal Analysis';
    return 'General Query';
  }

  const subQueries = [
    {
      query: part1Text,
      label: labelPart(part1Text, part1HasTicker, part1HasImageRef),
      includePhotos: part1HasImageRef && hasPhotos,
      includeDocuments: /\b(document|pdf|file|excel|spreadsheet)\b/i.test(part1Text) && hasDocuments,
    },
    {
      query: part2Text,
      label: labelPart(part2Text, part2HasTicker, part2HasImageRef),
      includePhotos: part2HasImageRef && hasPhotos,
      includeDocuments: /\b(document|pdf|file|excel|spreadsheet)\b/i.test(part2Text) && hasDocuments,
    },
  ];

  if (!subQueries[0].includePhotos && !subQueries[1].includePhotos && hasPhotos) {
    subQueries[1].includePhotos = true;
    if (subQueries[1].label === 'General Query') {
      subQueries[1].label = 'Image Analysis';
    }
  }

  console.log(`🔀 COMPOUND QUERY DETECTED: Split into ${subQueries.length} sub-queries`);
  subQueries.forEach((sq, i) => {
    console.log(`   ${i + 1}. [${sq.label}] "${sq.query.slice(0, 60)}..." photos=${sq.includePhotos}`);
  });

  return subQueries;
}

module.exports = {
  preflightRouter,
  buildSystemContext,
  detectCompoundQuery,
  safeFixed
};
