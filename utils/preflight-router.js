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
const { getPsiEMAContext, PsiEMADashboard } = require('./psi-EMA');
const { getFinancialPhysicsSeed } = require('./financial-physics');
const { getLegalAnalysisSeed, LEGAL_KEYWORDS_REGEX } = require('../prompts/legal-analysis');
const { detectForexPair, isForexQuery, fetchForexRate, buildForexContext } = require('./forex-fetcher');

const SEED_METRIC_KEYWORDS = [
  'seed metric', 'seed factor', 'p/i ratio', 'years to buy',
  'land price', 'property price', 'housing afford',
  'income ratio', 'how many years', 'salary to buy',
  'median income', 'average income', 'house price ratio'
];

function isSeedMetricQuery(query) {
  if (!query) return false;
  const lower = query.toLowerCase();
  return SEED_METRIC_KEYWORDS.some(kw => lower.includes(kw));
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
  
  const result = {
    mode: 'general',
    ticker: null,
    stockData: null,
    psiEmaAnalysis: null,
    dataAge: null,
    searchStrategy: 'none',
    routingFlags: {
      usesPsiEMA: false,
      isSeedMetric: false,
      usesFinancialPhysics: false,
      usesLegalAnalysis: false,
      usesForex: false,
      hasAttachments: attachments.length > 0,
      hasDocContext: Object.keys(docContext).length > 0
    },
    stockContext: null,
    forexData: null,
    forexContext: null,
    error: null
  };
  
  try {
    // ========================================
    // MODE DETECTION (Priority Order)
    // ========================================
    
    // 0. FOREX: Detect currency pair queries FIRST (before stock detection)
    // USD/JPY, EUR/USD, "yen rate", "dollar to euro", etc.
    const forexPair = detectForexPair(query);
    if (forexPair || isForexQuery(query)) {
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
    // 1. Ψ-EMA: Push-based 2/3 key detection (Lego-style Turing test)
    // Keys: VERB (analyze/diagnose) + ADJECTIVE (price/trend) + OBJECT (ticker)
    // If 2/3 keys match → unlock Ψ-EMA gate
    // SKIP if forex mode already triggered
    else if (result.mode !== 'forex') {
      const psiEmaDetection = detectPsiEMAKeys(query);
    
      // Context fallback: STRICT - only reuse inferred ticker if:
      // 1. We have a ticker from prior conversation, AND
      // 2. Current query has EXPLICIT stock keyword (stock/share/ticker/price), AND
      // 3. Current query has at least a verb OR adjective
      const hasContextTicker = contextResult?.inferredTicker;
      const hasExplicitStockKeyword = /\b(stock|stocks|ticker|share|shares|price|prices)\b/i.test(query);
      const hasVerbOrAdjective = psiEmaDetection.keys.some(k => k.type === 'verb' || k.type === 'adjective');
      const hasVerb = psiEmaDetection.keys.some(k => k.type === 'verb');
      const hasAdjective = psiEmaDetection.keys.some(k => k.type === 'adjective');
      const contextFallbackApplies = hasContextTicker && hasExplicitStockKeyword && hasVerbOrAdjective;
      
      // ========================================
      // BIDIRECTIONAL 2/3 KEY RESCUE (AI-PUSH)
      // Read → Interpret → Push → Retry
      // ========================================
      // Scenario 1: verb + adjective, no ticker → AI extracts ticker
      // Scenario 2: ticker + verb, no adjective → infer adjective (implied "price")
      // Scenario 3: ticker + adjective, no verb → infer verb (implied "analyze")
      // Scenario 4: ticker only + stock context → infer both
      
      let aiRescuedTicker = null;
      let aiInferredVerb = false;
      let aiInferredAdjective = false;
      const hasTicker = !!psiEmaDetection.ticker;
      const keyCount = psiEmaDetection.keys.length;
      
      // Scenario 1: Has verb + adjective but no ticker → try AI ticker extraction
      if (!psiEmaDetection.shouldTrigger && hasVerb && hasAdjective && !hasTicker) {
        console.log(`🔧 AI-PUSH: verb + adjective detected, missing ticker → extracting...`);
        aiRescuedTicker = await smartDetectTicker(query);
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
      const shouldUnlock = (effectiveKeyCount >= 2 && effectiveHasTicker) || psiEmaDetection.shouldTrigger;
      
      if (shouldUnlock) {
        console.log(`🔑 AI-PUSH: ${effectiveKeyCount}/3 keys [ticker=${effectiveHasTicker}, verb=${effectiveHasVerb}, adj=${effectiveHasAdjective}] → ✅ UNLOCK`);
      }
    
      if (shouldUnlock || contextFallbackApplies) {
        result.mode = 'psi-ema';
        result.routingFlags.usesPsiEMA = true;
        
        // Use ticker from key detection, AI rescue, or context
        result.ticker = psiEmaDetection.ticker || aiRescuedTicker || await smartDetectTicker(query);
        
        // If no ticker from current query, use context-inferred ticker
        if (!result.ticker && contextResult?.inferredTicker) {
          result.ticker = contextResult.inferredTicker;
          console.log(`📜 Preflight: Using context-inferred ticker ${result.ticker}`);
        }
        
        if (result.ticker) {
          console.log(`🎯 Preflight: Detected ticker ${result.ticker} for Ψ-EMA`);
          
          // Fetch stock data (exact periods: 3mo daily, 15mo weekly)
          try {
            result.stockData = await fetchStockPrices(result.ticker);
            result.dataAge = calculateDataAge(result.stockData?.endDate);
            
            // Use barCount from optimized fetch (exact data, no buffer)
            const dailyBars = result.stockData?.daily?.barCount || 0;
            const weeklyBars = result.stockData?.weekly?.barCount || 0;
            const weeklyUnavailableReason = result.stockData?.weekly?.unavailableReason;
            
            console.log(`📈 Preflight: Fetched ${dailyBars} daily bars + ${weeklyBars} weekly bars for ${result.ticker}`);
            
            // Run Ψ-EMA analysis on BOTH timeframes if enough data
            // Daily: need 55 bars for EMA-55, Weekly: need 55 bars for EMA-55
            if (dailyBars >= 55) {
              try {
                // Daily analysis (primary) - fresh dashboard instance
                const dailyDashboard = new PsiEMADashboard();
                const dailyCloses = result.stockData?.daily?.closes || result.stockData?.closes || [];
                result.psiEmaAnalysis = dailyDashboard.analyze({ stocks: dailyCloses });
                result.psiEmaAnalysis.timeframe = 'daily';
                console.log(`📊 Preflight: Ψ-EMA daily analysis complete for ${result.ticker}`);
                
                // Weekly analysis - run if we have any data, fidelity grade handles quality
                // No hard gate: even 13 bars produces real θ, z, R (just lower fidelity)
                if (weeklyBars >= 13 && !weeklyUnavailableReason) {
                  const weeklyDashboard = new PsiEMADashboard();  // Fresh instance to avoid state mutation
                  const weeklyCloses = result.stockData?.weekly?.closes || [];
                  result.psiEmaAnalysisWeekly = weeklyDashboard.analyze({ stocks: weeklyCloses });
                  result.psiEmaAnalysisWeekly.timeframe = 'weekly';
                  const fidelityGrade = result.psiEmaAnalysisWeekly.fidelity?.grade || '?';
                  console.log(`📊 Preflight: Ψ-EMA weekly analysis complete for ${result.ticker} (fidelity: ${fidelityGrade})`);
                } else if (weeklyUnavailableReason) {
                  console.log(`⚠️ Preflight: Weekly Ψ-EMA unavailable: ${weeklyUnavailableReason}`);
                  result.weeklyUnavailableReason = weeklyUnavailableReason;
                }
                
                // Build stock context for injection
                result.stockContext = buildStockContext(result);
                
                if (!result.stockContext) {
                  console.log(`⚠️ Preflight: buildStockContext returned null, falling back to limited`);
                  result.stockContext = buildLimitedStockContext(result);
                }
              } catch (analysisErr) {
                console.log(`⚠️ Preflight: Ψ-EMA analysis failed: ${analysisErr.message}`);
                result.stockContext = buildLimitedStockContext(result);
              }
            } else if (dailyBars > 0) {
              console.log(`⚠️ Preflight: Insufficient data for ${result.ticker} (${dailyBars} bars, need 55 for Ψ-EMA)`);
              result.stockContext = buildLimitedStockContext(result);
            } else {
              console.log(`❌ Preflight: No data returned for ${result.ticker}`);
              result.stockContext = buildFallbackStockContext(result.ticker);
            }
          } catch (fetchErr) {
            console.log(`⚠️ Preflight: Stock fetch failed for ${result.ticker}: ${fetchErr.message}`);
            result.error = `Stock fetch failed: ${fetchErr.message}`;
            result.stockContext = buildFallbackStockContext(result.ticker);
          }
        }
      }
      // 2. Seed Metric: MANDATORY web search for grounded real estate data
      // LLM training data is stale/wrong - must fetch actual $/m² from authoritative sources
      else if (isSeedMetricQuery(query)) {
        result.mode = 'seed-metric';
        result.routingFlags.isSeedMetric = true;
        result.searchStrategy = 'brave';
        
        // Extract city names for targeted search (major world cities + common variants)
        const cityPattern = /\b(tokyo|singapore|hong kong|hongkong|london|new york|nyc|sydney|paris|berlin|shanghai|beijing|seoul|taipei|osaka|mumbai|bombay|delhi|new delhi|bangkok|jakarta|manila|kuala lumpur|kl|ho chi minh|saigon|hanoi|san francisco|sf|los angeles|la|chicago|toronto|vancouver|melbourne|auckland|dubai|abu dhabi|munich|munich|frankfurt|amsterdam|madrid|barcelona|rome|milan|vienna|zurich|geneva|stockholm|copenhagen|oslo|helsinki|brussels|prague|warsaw|budapest|moscow|st petersburg|sao paulo|rio de janeiro|mexico city|buenos aires|bogota|lima|santiago|johannesburg|cape town|cairo|tel aviv|istanbul|athens|lisbon|dublin|edinburgh|manchester|birmingham|seattle|boston|washington dc|miami|dallas|houston|denver|phoenix|atlanta|detroit|philadelphia|minneapolis|portland|austin|san diego|honolulu|anchorage|montreal|calgary|ottawa|perth|brisbane|adelaide|wellington|christchurch|chengdu|shenzhen|guangzhou|hangzhou|nanjing|wuhan|xian|chongqing|tianjin|suzhou|qingdao|dalian|xiamen|fuzhou|ningbo|changsha|zhengzhou|jinan|shenyang|harbin|kunming|nanchang|hefei|taiyuan|shijiazhuang|lanzhou|urumqi|guiyang|nanning|haikou|lhasa|hohhot|yinchuan|xining)\b/gi;
        const cities = [...new Set((query.match(cityPattern) || []).map(c => c.toLowerCase()))];
        
        if (cities.length > 0) {
          // Build search queries for real estate $/m² + median income
          result.seedMetricSearchQueries = cities.flatMap(city => [
            `${city} residential property price per square meter 2024`,
            `${city} median individual income salary 2024`,
            `${city} housing price 1970s historical per sqm`
          ]);
          console.log(`🏠 Preflight: SEED_METRIC detected for cities: ${cities.join(', ')}`);
          console.log(`🔍 Preflight: Will search for: ${result.seedMetricSearchQueries.slice(0, 3).join(' | ')}...`);
        } else {
          // Generic search if no city specified
          result.seedMetricSearchQueries = [
            'residential property price per square meter comparison major cities 2024',
            'median income by country 2024'
          ];
          console.log(`🏠 Preflight: SEED_METRIC detected (no specific city)`);
        }
      }
      // 3. Default: Groq-first (no search until audit rejects)
      else {
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
    
  } catch (err) {
    console.error(`❌ Preflight router error: ${err.message}`);
    result.error = err.message;
    result.mode = 'general';
  }
  
  console.log(`🚦 Preflight: mode=${result.mode}, ticker=${result.ticker || 'none'}, search=${result.searchStrategy}`);
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
  
  // Correctly map PsiEMADashboard output structure:
  // - summary: aggregated signals (phaseSignal, anomalyLevel, regime, compositeSignal)
  // - dimensions: detailed analysis (phase.current, anomaly.currentZ, convergence.currentR)
  // - compositeSignal: action, confidence, emoji
  // - fidelity: grade, percent
  const summary = psiEmaAnalysis.summary || {};
  const phase = psiEmaAnalysis.dimensions?.phase || {};
  const anomaly = psiEmaAnalysis.dimensions?.anomaly || {};
  const convergence = psiEmaAnalysis.dimensions?.convergence || {};
  const composite = psiEmaAnalysis.compositeSignal || {};
  const fidelity = psiEmaAnalysis.fidelity || {};
  const fundamentals = stockData.fundamentals || {};
  
  // Extract values with correct property names from PsiEMADashboard output
  const phaseTheta = phase.current;  // theta angle in degrees (e.g., 359.76)
  const phaseSignal = phase.signal || summary.phaseSignal || 'N/A';
  const anomalyZ = anomaly.current;  // z-score (e.g., -0.44)
  const anomalyLevel = anomaly.alert?.level || summary.anomalyLevel || 'N/A';
  const convergenceR = convergence.current;  // R ratio (e.g., 1.2)
  const regimeLabel = typeof convergence.regime === 'string' 
    ? convergence.regime 
    : (convergence.regime?.label || summary.regime || 'N/A');
  
  // Composite signal
  const action = composite.action || summary.compositeSignal || 'HOLD';
  const confidence = composite.confidence ?? summary.compositeConfidence ?? 'N/A';
  
  // Build tetralemma alert if φ² crossed
  const tetralemmaAlert = psiEmaAnalysis.renewal?.tetralemma 
    ? `\n${psiEmaAnalysis.renewal.tetralemma.warning}\nTetralemma: (10)Bubble (01)Breakthrough (11)Both (00)Neither - Investigate fundamentals.`
    : '';
  
  // Build Robinhood-style company header
  let companyHeader = '';
  const sectorIndustry = [fundamentals.sector, fundamentals.industry].filter(Boolean).join(' · ');
  const companySummary = fundamentals.summary || '';
  const atomicUnits = fundamentals.atomicUnits || [];
  
  if (sectorIndustry || companySummary || atomicUnits.length > 0) {
    // Format atomic units with state/flow/guard distinction
    let atomicUnitsFormatted = '';
    if (atomicUnits.length > 0) {
      const stateUnits = atomicUnits.filter(u => u.includes('(state)')).map(u => u.replace(' (state)', ''));
      const flowUnits = atomicUnits.filter(u => u.includes('(flow)')).map(u => u.replace(' (flow)', ''));
      const guardUnits = atomicUnits.filter(u => u.includes('(guard)')).map(u => u.replace(' (guard)', ''));
      
      const parts = [];
      if (stateUnits.length > 0) parts.push(`**State**: ${stateUnits.join(', ')}`);
      if (flowUnits.length > 0) parts.push(`**Flow**: ${flowUnits.join(', ')}`);
      if (guardUnits.length > 0) parts.push(`**Guard**: ${guardUnits.join(', ')}`);
      
      if (parts.length > 0) {
        atomicUnitsFormatted = `\n**Atomic Units**:\n${parts.join('\n')}`;
      }
    }
    
    companyHeader = `
### ${stockData.name || ticker} (${ticker})
${sectorIndustry ? `**${sectorIndustry}**` : ''}
${companySummary ? `\n${companySummary}.` : ''}
${atomicUnitsFormatted}
`;
  }
  
  // Format fundamentals section if available
  let fundamentalsSection = '';
  if (Object.keys(fundamentals).length > 0) {
    const peRatio = fundamentals.peRatio ? `**P/E Ratio**: ${safeFixed(fundamentals.peRatio)}` : '';
    const forwardPE = fundamentals.forwardPE ? `**Forward P/E**: ${safeFixed(fundamentals.forwardPE)}` : '';
    const divYield = fundamentals.dividendYield != null ? `**Dividend Yield**: ${safeFixed(fundamentals.dividendYield)}%` : '';
    const nextEarnings = fundamentals.nextEarningsDate ? `**Next Earnings**: ${fundamentals.nextEarningsDate}` : '';
    const marketCap = fundamentals.marketCap ? `**Market Cap**: ${formatMarketCap(fundamentals.marketCap)}` : '';
    const fiftyTwoWeekHigh = fundamentals.fiftyTwoWeekHigh ? `**52W High**: ${safeFixed(fundamentals.fiftyTwoWeekHigh)}` : '';
    const fiftyTwoWeekLow = fundamentals.fiftyTwoWeekLow ? `**52W Low**: ${safeFixed(fundamentals.fiftyTwoWeekLow)}` : '';
    
    const fundParts = [peRatio, forwardPE, divYield, nextEarnings, marketCap, fiftyTwoWeekHigh, fiftyTwoWeekLow].filter(Boolean);
    if (fundParts.length > 0) {
      fundamentalsSection = `
### FUNDAMENTALS (SEC EDGAR):
${fundParts.map(p => `- ${p}`).join('\n')}`;
    }
  }
  
  // Build confidence line (compressed, substantive)
  const fidelityPct = fidelity.percent || 'N/A';
  const fidelityGrade = fidelity.grade || 'N/A';
  const confidenceLine = `**${fidelityPct}%** (${fidelityGrade}) → yfinance prices + SEC EDGAR fundamentals`;
  
  return `
## Ψ-EMA REAL-TIME ANALYSIS
${companyHeader}
**Ψ-EMA measures**: θ = where in cycle, z = how unusual the price is, R = whether trend can sustain. When all three align, conviction is higher; when they conflict, caution is warranted.

**Data Source**: yfinance (VERIFIED)
**Data Timestamp**: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
**Current Price**: ${stockData.currency || 'USD'} ${safeFixed(stockData.currentPrice)}

### THREE-DIMENSIONAL STATE:
| Dimension | Formula | Value | Signal |
|-----------|---------|-------|--------|
| **θ (Cycle Position)** | arctan(ΔEMA-55/ΔEMA-34) | ${safeFixed(phaseTheta)}° | ${phaseSignal} |
| **z (Price Deviation)** | (Price - Median) / MAD | ${safeFixed(anomalyZ)}σ | ${anomalyLevel} |
| **R (Momentum Ratio)** | z(t) / z(t-1) | ${convergenceR != null ? safeFixed(convergenceR) : 'N/A'} | ${regimeLabel} |

### COMPOSITE: ${action}
${tetralemmaAlert}

### CONFIDENCE: ${confidenceLine}
${fundamentalsSection}

**⚠️ INSTRUCTION**: Quote these EXACT computed values. End with "🔥 ~nyan".
`;
}

/**
 * Build limited context when insufficient data points for full Ψ-EMA
 * Still provides price + fundamentals, but explains missing wave analysis
 */
function buildLimitedStockContext(preflight) {
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
  
  return `
## Stock Data for ${ticker} (${stockData?.name || ticker})
**Data Source**: yfinance (VERIFIED - REAL PRICES)
**Current Price**: ${stockData?.currency || 'USD'} ${safeFixed(stockData?.currentPrice)}
**Data Timestamp**: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
${fundamentalsSection}

### ⚠️ Ψ-EMA Wave Analysis UNAVAILABLE
- **Data Points Available**: ${dataPoints} trading days
- **Required for Ψ-EMA**: 55+ trading days (for EMA-55 calculation)
- **Missing**: Phase θ, Anomaly z, Convergence R signals

The price and fundamentals above are verified. However, full wave function analysis (golden cross/death cross detection, momentum regime, φ-correction signals) cannot be computed with only ${dataPoints} days of data.

**End with "🔥 ~nyan" and mention data limitations.**
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
  
  return messages;
}

module.exports = {
  preflightRouter,
  buildSystemContext,
  buildStockContext,
  buildLimitedStockContext,
  buildFallbackStockContext,
  isSeedMetricQuery,
  safeFixed
};
