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
 * Main preflight router - runs before LLM call
 * 
 * @param {Object} options
 * @param {string} options.query - User's query text
 * @param {Array} options.attachments - Array of attachment metadata
 * @param {Object} options.docContext - Parsed document context (if any)
 * @returns {Promise<PreflightResult>}
 */
async function preflightRouter(options) {
  const { query = '', attachments = [], docContext = {} } = options;
  
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
    if (shouldTriggerPsiEMA(query, detectStockTicker)) {
      result.mode = 'psi-ema';
      result.routingFlags.usesPsiEMA = true;
      
      // Extract ticker (rule-based first, then AI fallback)
      result.ticker = await smartDetectTicker(query);
      
      if (result.ticker) {
        console.log(`🎯 Preflight: Detected ticker ${result.ticker} for Ψ-EMA`);
        
        // Fetch stock data
        try {
          result.stockData = await fetchStockPrices(result.ticker, 90);
          result.dataAge = calculateDataAge(result.stockData?.endDate);
          
          // Run Ψ-EMA analysis if enough data
          if (result.stockData?.closes?.length >= 55) {
            const dashboard = new PsiEMADashboard();
            result.psiEmaAnalysis = dashboard.analyze({ stocks: result.stockData.closes });
            console.log(`📊 Preflight: Ψ-EMA analysis complete for ${result.ticker}`);
            
            // Build stock context for injection
            result.stockContext = buildStockContext(result);
          } else if (result.stockData?.closes?.length > 0) {
            console.log(`⚠️ Preflight: Insufficient data for ${result.ticker} (${result.stockData.closes.length} points)`);
            result.stockContext = buildLimitedStockContext(result);
          }
        } catch (fetchErr) {
          console.log(`⚠️ Preflight: Stock fetch failed for ${result.ticker}: ${fetchErr.message}`);
          result.error = `Stock fetch failed: ${fetchErr.message}`;
          result.stockContext = buildFallbackStockContext(result.ticker);
        }
      }
    }
    // 2. Seed Metric: Needs web search for fresh land/income data
    else if (isSeedMetricQuery(query)) {
      result.mode = 'seed-metric';
      result.routingFlags.isSeedMetric = true;
      result.searchStrategy = 'brave';
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
 */
function buildStockContext(preflight) {
  const { ticker, stockData, psiEmaAnalysis, dataAge } = preflight;
  if (!stockData || !psiEmaAnalysis) return null;
  
  const ageFlag = dataAge?.flag || '⚠️';
  const phase = psiEmaAnalysis.dimensions?.phase;
  const anomaly = psiEmaAnalysis.dimensions?.anomaly;
  const convergence = psiEmaAnalysis.dimensions?.convergence;
  const composite = psiEmaAnalysis.compositeSignal;
  
  // Build tetralemma alert if φ² crossed
  const tetralemmaAlert = psiEmaAnalysis.renewal?.tetralemma 
    ? `\n${psiEmaAnalysis.renewal.tetralemma.warning}\nTetralemma: (10)Bubble (01)Breakthrough (11)Both (00)Neither - Investigate fundamentals.`
    : '';
  
  return `
## Ψ-EMA REAL-TIME ANALYSIS: ${ticker} (${stockData.name || ticker})
**Data Source**: yfinance (VERIFIED)
**Data Timestamp**: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
**Current Price**: ${stockData.currency || 'USD'} ${safeFixed(stockData.currentPrice)}
**Analysis Period**: ${stockData.periodDays || stockData.closes?.length} trading days

### THREE-DIMENSIONAL STATE:
**Phase θ (Cycle)**: ${safeFixed(phase?.theta)}° — ${phase?.signal || 'N/A'} (EMA-${phase?.fastPeriod || 34}/${phase?.slowPeriod || 55})
**Anomaly z (Deviation)**: ${safeFixed(anomaly?.z)}σ — ${anomaly?.alert || 'N/A'} (EMA-${anomaly?.fastPeriod || 21}/${anomaly?.slowPeriod || 34})
**Convergence R (Sustainability)**: ${safeFixed(convergence?.R)} — ${convergence?.regime || 'N/A'} (EMA-${convergence?.fastPeriod || 13}/${convergence?.slowPeriod || 21})

### COMPOSITE SIGNAL: ${composite?.action || 'HOLD'} (Strength: ${composite?.strength || 'N/A'})
${tetralemmaAlert}

### DATA FIDELITY:
${psiEmaAnalysis.fidelity ? `Grade ${psiEmaAnalysis.fidelity.grade} (${psiEmaAnalysis.fidelity.percent}% real data)` : 'N/A'}

**⚠️ IMPORTANT**: This analysis uses VERIFIED yfinance data through ${dataAge?.timestamp}. ${dataAge?.isStale ? 'Data is stale - use with caution.' : 'Data is fresh.'}
**End with "🔥 ~nyan" to indicate verified Ψ-EMA output.**
`;
}

/**
 * Build limited context when insufficient data points
 */
function buildLimitedStockContext(preflight) {
  const { ticker, stockData, dataAge } = preflight;
  const ageFlag = dataAge?.flag || '⚠️';
  
  return `
## Stock Data for ${ticker} (${stockData?.name || ticker})
Current Price: ${stockData?.currency || 'USD'} ${safeFixed(stockData?.currentPrice)}
Data Timestamp: ${ageFlag} ${dataAge?.timestamp} (${dataAge?.age})
Note: Only ${stockData?.closes?.length || 0} trading days of data available. Full Ψ-EMA analysis requires 55+ days for EMA-55 calculation.
**⚠️ IMPORTANT: This analysis is limited and is based on incomplete data. Do NOT rely on it for trading decisions.**
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
 * @param {PreflightResult} preflight
 * @param {string} nyanProtocolPrompt - The NYAN protocol system prompt
 * @returns {Array<{role: string, content: string}>}
 */
function buildSystemContext(preflight, nyanProtocolPrompt) {
  const messages = [];
  
  // Stage 0: NYAN Protocol (always first)
  messages.push({ role: 'system', content: nyanProtocolPrompt });
  
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
