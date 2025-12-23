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

const { detectStockTicker, smartDetectTicker, fetchStockPrices, calculateDataAge } = require('./stock-fetcher');
const { shouldTriggerPsiEMA, getPsiEMAContext, PsiEMADashboard } = require('./psi-EMA');
const { getFinancialPhysicsSeed } = require('./financial-physics');
const { getLegalAnalysisSeed, LEGAL_KEYWORDS_REGEX } = require('../prompts/legal-analysis');

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
      hasAttachments: attachments.length > 0,
      hasDocContext: Object.keys(docContext).length > 0
    },
    stockContext: null,
    error: null
  };
  
  try {
    // ========================================
    // MODE DETECTION (Priority Order)
    // ========================================
    
    // 1. Ψ-EMA: Fourier/wave/financial analysis
    // Context fallback ONLY applies if current query EXPLICITLY mentions stock/ticker/share
    // This prevents "netflix price trend" (no stock keyword) from triggering psi-EMA
    const hasContextTicker = contextResult?.inferredTicker;
    const hasExplicitStockKeyword = /\b(stock|stocks|ticker|share|shares)\b/i.test(query);
    const contextFallbackApplies = hasContextTicker && hasExplicitStockKeyword;
    
    if (shouldTriggerPsiEMA(query, detectStockTicker) || contextFallbackApplies) {
      result.mode = 'psi-ema';
      result.routingFlags.usesPsiEMA = true;
      
      // Extract ticker (rule-based first, then AI fallback, then context fallback)
      result.ticker = await smartDetectTicker(query);
      
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
      
      // Extract city names for targeted search
      const cityPattern = /\b(tokyo|singapore|hong kong|london|new york|sydney|paris|berlin|shanghai|beijing|seoul|taipei|osaka|mumbai|delhi|bangkok|jakarta|manila|kuala lumpur|ho chi minh|hanoi|san francisco|los angeles|chicago|toronto|vancouver|melbourne|auckland)\b/gi;
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
  
  // Format fundamentals section if available
  let fundamentalsSection = '';
  if (Object.keys(fundamentals).length > 0) {
    const peRatio = fundamentals.peRatio ? `**P/E Ratio**: ${safeFixed(fundamentals.peRatio)}` : '';
    const forwardPE = fundamentals.forwardPE ? `**Forward P/E**: ${safeFixed(fundamentals.forwardPE)}` : '';
    const divYield = fundamentals.dividendYield != null ? `**Dividend Yield**: ${safeFixed(fundamentals.dividendYield)}%` : '';
    const nextEarnings = fundamentals.nextEarningsDate ? `**Next Earnings**: ${fundamentals.nextEarningsDate}` : '';
    const sector = fundamentals.sector ? `**Sector**: ${fundamentals.sector}` : '';
    const industry = fundamentals.industry ? `**Industry**: ${fundamentals.industry}` : '';
    const marketCap = fundamentals.marketCap ? `**Market Cap**: ${formatMarketCap(fundamentals.marketCap)}` : '';
    const fiftyTwoWeekHigh = fundamentals.fiftyTwoWeekHigh ? `**52W High**: ${safeFixed(fundamentals.fiftyTwoWeekHigh)}` : '';
    const fiftyTwoWeekLow = fundamentals.fiftyTwoWeekLow ? `**52W Low**: ${safeFixed(fundamentals.fiftyTwoWeekLow)}` : '';
    
    const fundParts = [peRatio, forwardPE, divYield, nextEarnings, sector, industry, marketCap, fiftyTwoWeekHigh, fiftyTwoWeekLow].filter(Boolean);
    if (fundParts.length > 0) {
      fundamentalsSection = `
### FUNDAMENTALS (SEC EDGAR):
${fundParts.map(p => `- ${p}`).join('\n')}`;
    }
  }
  
  return `
## Ψ-EMA REAL-TIME ANALYSIS: ${ticker} (${stockData.name || ticker})
**Data Source**: yfinance (VERIFIED - REAL PRICES)
**Data Timestamp**: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
**Current Price**: ${stockData.currency || 'USD'} ${safeFixed(stockData.currentPrice)}
**Analysis Period**: ${stockData.periodDays || stockData.closes?.length} trading days

### THREE-DIMENSIONAL STATE (computed from real closing prices):
**Phase θ (Cycle)**: ${safeFixed(phaseTheta)}° — ${phaseSignal} (EMA-34/EMA-55)
**Anomaly z (Deviation)**: ${safeFixed(anomalyZ)}σ — ${anomalyLevel} (EMA-21/EMA-34)
**Convergence R (Sustainability)**: ${safeFixed(convergenceR)} — ${regimeLabel} (EMA-13/EMA-21)

### COMPOSITE SIGNAL: ${action}
${tetralemmaAlert}

### DATA QUALITY TIER:
- **Fidelity**: ${fidelity.percent || 'N/A'}% real data (Grade ${fidelity.grade || 'N/A'})
- **Market Signal**: ${typeof confidence === 'number' ? confidence : 'N/A'}% (phase/anomaly/convergence alignment strength)

**UNIFIED CONFIDENCE**: Your response confidence will be graded by audit against NYAN's ANALYSIS HIERARCHY:
- 95% = EXACT DATA (real yfinance prices, SEC EDGAR fundamentals, verified sources)
- 80% = PROXY AVAILABLE (interpolated data, flagged, method documented)
- <50% = NOTHING (no data available, honest refusal)

${fundamentalsSection}

⚠️ IMPORTANT: Always include data timestamp in financial claims. Undated prices = unverifiable.

**⚠️ CRITICAL INSTRUCTION**: The values above are COMPUTED from REAL yfinance data. Quote these exact values in your response. Do NOT hallucinate different numbers. Data is fresh through ${dataAge?.timestamp}.
**End with "🔥 ~nyan" to indicate verified Ψ-EMA output.**
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
