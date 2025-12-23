/**
 * Pipeline Orchestrator - Unified AI Request Processing
 * 
 * State Machine:
 * S-1: Context Extraction (8-message window - entities, not reasoning)
 * S0: Preflight (routing, mode detection, external data fetch)
 * S1: Context Build (inject system prompts based on mode)
 * S2: Reasoning (LLM call)
 * S3: Audit (verify output)
 * S4: Retry (search + regenerate if audit rejected)
 * S5: Personality (format final output)
 * S6: Output
 * 
 * GROQFIRST FLOW PATTERN (not a value, a flow):
 * - Try Groq FIRST for generation (S2)
 * - Run audit pass to verify output (S3)
 * - If audit PASSES → use Groq output (outcome = groqonly, not a default)
 * - If audit FAILS → retry with search augmentation (S4), then re-audit
 * - "groqonly" is a FLOW OUTCOME, never a hardcoded value
 * 
 * This separates concerns:
 * - NYAN Protocol = What to think (reasoning principles)
 * - Pipeline = How to process (state machine)
 * - Routing = Where to go (mode detection via preflight-router)
 * - Context = What was discussed (entity extraction from history)
 */

const { preflightRouter, buildSystemContext } = require('./preflight-router');
const { extractContext, extractContextWithMemory, mergeContextForTickerDetection, isSessionFirstQuery, markSessionNyanBooted } = require('./context-extractor');
const { NYAN_PROTOCOL_SYSTEM_PROMPT, NYAN_PROTOCOL_COMPRESSED } = require('../prompts/nyan-protocol');
const { runAuditPass } = require('./two-pass-verification');
const { isFalseDichotomy } = require('../prompts/audit-protocol');
const { detectPathogens, generateClinicalReport, generatePhysicalAuditDisclaimer } = require('./psi-EMA');
const { DataPackage, globalPackageStore, STAGE_IDS } = require('./data-package');

const PIPELINE_STEPS = {
  CONTEXT_EXTRACT: 'S-1',
  PREFLIGHT: 'S0',
  CONTEXT_BUILD: 'S1', 
  REASONING: 'S2',
  AUDIT: 'S3',
  RETRY: 'S4',
  PERSONALITY: 'S5',
  OUTPUT: 'S6'
};

class PipelineState {
  constructor(tenantId = null) {
    this.step = PIPELINE_STEPS.CONTEXT_EXTRACT;
    this.retryCount = 0;
    this.maxRetries = 1;
    this.mode = 'general';
    this.contextResult = null;  // Stage -1 output
    this.searchContext = null;
    this.didSearch = false;
    this.preflight = null;
    this.systemMessages = [];
    this.draftAnswer = null;
    this.auditResult = null;
    this.finalAnswer = null;
    this.error = null;
    this.dataPackage = new DataPackage(tenantId);
  }
  
  transition(nextStep) {
    console.log(`🔄 Pipeline: ${this.step} → ${nextStep}`);
    this.step = nextStep;
  }
  
  writeToPackage(stageId, data) {
    this.dataPackage.writeStage(stageId, data);
  }
  
  readFromPackage(stageId) {
    return this.dataPackage.readStage(stageId);
  }
}

class PipelineOrchestrator {
  constructor(config) {
    this.groqToken = config.groqToken;
    this.groqVisionToken = config.groqVisionToken;
    this.searchBrave = config.searchBrave;
    this.searchDuckDuckGo = config.searchDuckDuckGo;
    this.extractCoreQuestion = config.extractCoreQuestion;
    this.isIdentityQuery = config.isIdentityQuery;
    this.groqWithRetry = config.groqWithRetry;
  }
  
  async run(input) {
    const tenantId = input.clientIp || input.sessionId || 'anonymous';
    const state = new PipelineState(tenantId);
    
    // Track if this is first query for NYAN boot optimization (check early, before any exits)
    const isFirstQuery = input.sessionId ? isSessionFirstQuery(input.sessionId) : false;
    state.isFirstQuery = isFirstQuery;
    
    try {
      // ========================================
      // STAGE -1: Context Extraction with φ-Compressed Memory
      // Entity extraction + human-like episodic memory (5/8 ≈ 1/φ)
      // ========================================
      state.transition(PIPELINE_STEPS.CONTEXT_EXTRACT);
      
      // Use memory-enhanced extraction if sessionId provided
      if (input.sessionId) {
        state.contextResult = await extractContextWithMemory(
          input.sessionId,
          input.query,
          input.conversationHistory || [],
          input.attachmentHistory || [],
          input.currentAttachment || null
        );
        
        if (state.contextResult.hasMemory) {
          console.log(`📝 Stage -1: Memory active - summary: ${state.contextResult.memorySummary ? 'yes' : 'no'}, ` +
            `messages: ${state.contextResult.memoryStats?.messageCount || 0}`);
        }
      } else {
        // Fallback to basic entity extraction
        state.contextResult = extractContext(
          input.conversationHistory || [],
          input.attachmentHistory || [],
          8  // 8-message window
        );
      }
      
      // WRITE to DataPackage: Stage S-1 context extraction result
      state.writeToPackage(STAGE_IDS.CONTEXT_EXTRACT, {
        inferredTicker: state.contextResult.inferredTicker,
        hasFinancialContext: state.contextResult.hasFinancialContext,
        hasMemory: state.contextResult.hasMemory,
        attachmentContext: state.contextResult.attachmentContext?.name || null
      });
      
      if (state.contextResult.inferredTicker) {
        console.log(`📜 Stage -1: Context extracted - inferred ticker: ${state.contextResult.inferredTicker}`);
      } else if (state.contextResult.hasFinancialContext) {
        console.log(`📜 Stage -1: Financial context detected, no specific ticker`);
      }
      
      // Log memory-based context if available
      if (state.contextResult.attachmentContext) {
        console.log(`📎 Stage -1: Attachment side-door active - "${state.contextResult.attachmentContext.name}"`);
      }
      
      // Merge context with current query for enhanced detection
      const contextAwareQuery = mergeContextForTickerDetection(input.query, state.contextResult);
      
      // ========================================
      // STAGE 0: Preflight (mode detection, external data)
      // ========================================
      // Support pre-computed preflight (avoids duplicate calls when endpoint already ran it)
      if (input.preComputedPreflight) {
        state.preflight = input.preComputedPreflight;
        state.mode = state.preflight.mode;
        console.log(`📊 Preflight (pre-computed): mode=${state.mode}, ticker=${state.preflight.ticker || 'none'}`);
        
        // WRITE to DataPackage: Stage S0 preflight result (pre-computed path)
        state.writeToPackage(STAGE_IDS.PREFLIGHT, {
          mode: state.mode,
          ticker: state.preflight.ticker || null,
          stockContext: state.preflight.stockContext || null,
          hasPsiEma: !!state.preflight.psiEmaAnalysis,
          preComputed: true
        });
        
        // Still do seed-metric search if needed
        const safeDocContext = input.docContext || {};
        if (state.mode === 'seed-metric' && input.query && !safeDocContext.isClosedLoop) {
          console.log(`🌱 Seed Metric (pre-computed): MANDATORY web search for grounded data`);
          
          const searchQueries = state.preflight.seedMetricSearchQueries || [];
          const searchResults = [];
          
          if (searchQueries.length > 0) {
            for (const sq of searchQueries.slice(0, 4)) {
              const result = await this.searchBrave(sq, input.clientIp);
              if (result) {
                searchResults.push(`[${sq}]\n${result}`);
              } else {
                const ddgResult = await this.searchDuckDuckGo(sq);
                if (ddgResult) {
                  searchResults.push(`[${sq}]\n${ddgResult}`);
                }
              }
            }
            console.log(`🔍 Seed Metric: ${searchResults.length}/${searchQueries.length} searches returned data`);
          } else {
            const searchQuery = await this.extractCoreQuestion(input.query);
            const result = await this.searchBrave(searchQuery, input.clientIp);
            if (result) searchResults.push(result);
            else {
              const ddgResult = await this.searchDuckDuckGo(searchQuery);
              if (ddgResult) searchResults.push(ddgResult);
            }
          }
          
          if (searchResults.length > 0) {
            state.searchContext = `[REAL ESTATE & INCOME DATA FROM WEB SEARCH - USE THESE EXACT FIGURES]
${searchResults.join('\n\n')}

MANDATORY INSTRUCTIONS:
1. Use $/m² data above → MULTIPLY BY 700 for 700sqm price
2. CITE your sources explicitly (e.g., "According to [source name]...")
3. Do NOT hallucinate prices — only use figures from search results above
4. If search data is incomplete, flag which data is missing and use proxy with documented conversion`;
            state.didSearch = true;
          }
        }
      } else {
        // Pass context-aware query and context result to preflight
        await this.stepPreflight(state, { ...input, query: contextAwareQuery, contextResult: state.contextResult });
      }
      
      // FAST-PATH: Ψ-EMA mode but no ticker found → return "no data" message (saves tokens)
      if (state.mode === 'psi-ema' && !state.preflight.ticker) {
        console.log(`⚡ Fast-path: Ψ-EMA mode but no ticker - returning no-data message`);
        state.finalAnswer = `📊 **No Stock Data Available**\n\nI detected a financial analysis request, but couldn't identify a valid public stock ticker.\n\n**Tips:**\n• Use explicit ticker format: "$AAPL", "$NVDA", "$META"\n• Note: Some companies are private (e.g., Bloomberg LP) and have no public stock data\n• Commodities (gold, oil) and crypto require different analysis tools\n\n🔥 ~nyan`;
        state.auditResult = { verdict: 'BYPASS', confidence: 100, reason: 'No ticker - fast path' };
        state.transition(PIPELINE_STEPS.OUTPUT);
        
        // WRITE to DataPackage: Fast-path audit + output (S3 + S6)
        state.writeToPackage(STAGE_IDS.AUDIT, {
          verdict: 'BYPASS',
          confidence: 100,
          passed: true,
          auditMode: 'FAST_PATH'
        });
        state.writeToPackage(STAGE_IDS.OUTPUT, {
          mode: state.mode,
          outputLength: state.finalAnswer.length,
          didSearch: false,
          retryCount: 0,
          fastPath: true
        });
        
        // FINALIZE: Store in tenant's φ-8 window
        state.dataPackage.finalize();
        globalPackageStore.storePackage(state.dataPackage.tenantId, state.dataPackage);
        
        // Mark NYAN booted on fast-path success too (didn't need full NYAN, but next query should use compressed)
        if (input.sessionId && state.isFirstQuery) {
          markSessionNyanBooted(input.sessionId);
        }
        
        return {
          success: true,
          answer: state.finalAnswer,
          mode: state.mode,
          preflight: state.preflight,
          auditResult: state.auditResult,
          didSearch: false,
          retryCount: 0,
          fastPath: true,
          dataPackageId: state.dataPackage.id,
          dataPackageSummary: state.dataPackage.toCompressedSummary()
        };
      }
      
      await this.stepContextBuild(state, input);
      await this.stepReasoning(state, input);
      await this.stepAudit(state, input);
      
      if (state.auditResult?.verdict === 'REJECTED' && state.retryCount < state.maxRetries) {
        await this.stepRetry(state, input);
      }
      
      await this.stepOutput(state);
      
      // Mark NYAN as booted AFTER successful completion (not during context build)
      // This ensures retries within same request still get full NYAN
      if (input.sessionId && state.isFirstQuery) {
        markSessionNyanBooted(input.sessionId);
      }
      
      return {
        success: true,
        answer: state.finalAnswer,
        mode: state.mode,
        preflight: state.preflight,
        auditResult: state.auditResult,
        didSearch: state.didSearch,
        retryCount: state.retryCount,
        dataPackageId: state.dataPackage.id,
        dataPackageSummary: state.dataPackage.toCompressedSummary()
      };
    } catch (err) {
      console.error(`❌ Pipeline error at ${state.step}: ${err.message}`);
      return {
        success: false,
        error: err.message,
        step: state.step,
        dataPackageId: state.dataPackage?.id || null
      };
    }
  }
  
  async stepPreflight(state, input) {
    state.transition(PIPELINE_STEPS.PREFLIGHT);
    
    const { query, attachments, clientIp, contextResult } = input;
    const safeDocContext = input.docContext || {};
    
    state.preflight = await preflightRouter({
      query: query || '',
      attachments: attachments || [],
      docContext: safeDocContext,
      contextResult: contextResult || null  // Stage -1 output for context-aware routing
    });
    
    state.mode = state.preflight.mode;
    console.log(`📊 Preflight: mode=${state.mode}, ticker=${state.preflight.ticker || 'none'}`);
    
    // WRITE to DataPackage: Stage S0 preflight result
    state.writeToPackage(STAGE_IDS.PREFLIGHT, {
      mode: state.mode,
      ticker: state.preflight.ticker || null,
      stockContext: state.preflight.stockContext || null,
      hasPsiEma: !!state.preflight.psiEmaAnalysis
    });
    
    if (state.mode === 'seed-metric' && query && !safeDocContext.isClosedLoop) {
      console.log(`🌱 Seed Metric: MANDATORY web search for grounded real estate data`);
      
      // Use specific search queries from preflight (e.g., "tokyo residential price per square meter 2024")
      const searchQueries = state.preflight.seedMetricSearchQueries || [];
      const searchResults = [];
      
      if (searchQueries.length > 0) {
        // Run targeted searches for $/m² + income data (limit to 4 searches max)
        for (const sq of searchQueries.slice(0, 4)) {
          const result = await this.searchBrave(sq, clientIp);
          if (result) {
            searchResults.push(`[${sq}]\n${result}`);
          } else {
            const ddgResult = await this.searchDuckDuckGo(sq);
            if (ddgResult) {
              searchResults.push(`[${sq}]\n${ddgResult}`);
            }
          }
        }
        console.log(`🔍 Seed Metric: ${searchResults.length}/${searchQueries.length} searches returned data`);
      } else {
        // Fallback to generic search
        const searchQuery = await this.extractCoreQuestion(query);
        const result = await this.searchBrave(searchQuery, clientIp);
        if (result) searchResults.push(result);
        else {
          const ddgResult = await this.searchDuckDuckGo(searchQuery);
          if (ddgResult) searchResults.push(ddgResult);
        }
      }
      
      if (searchResults.length > 0) {
        state.searchContext = `[REAL ESTATE & INCOME DATA FROM WEB SEARCH - USE THESE EXACT FIGURES]
${searchResults.join('\n\n')}

MANDATORY INSTRUCTIONS:
1. Use $/m² data above → MULTIPLY BY 700 for 700sqm price
2. CITE your sources explicitly (e.g., "According to [source name]...")
3. Do NOT hallucinate prices — only use figures from search results above
4. If search data is incomplete, flag which data is missing and use proxy with documented conversion`;
        state.didSearch = true;
      }
    }
  }
  
  async stepContextBuild(state, input) {
    state.transition(PIPELINE_STEPS.CONTEXT_BUILD);
    
    // NYAN Boot Optimization: Full protocol on first query, compressed on subsequent
    // Saves ~1350 tokens per query after session boot
    // NOTE: isFirstQuery is set at start of run(), boot flag is set AFTER successful completion
    state.systemMessages = buildSystemContext(state.preflight, NYAN_PROTOCOL_SYSTEM_PROMPT, {
      isFirstQuery: state.isFirstQuery,
      nyanCompressed: NYAN_PROTOCOL_COMPRESSED
    });
    
    console.log(`📝 Context: ${state.systemMessages.length} system messages built (NYAN: ${state.isFirstQuery ? 'full' : 'compressed'})`);
  }
  
  async stepReasoning(state, input) {
    state.transition(PIPELINE_STEPS.REASONING);
    
    const { query, conversationHistory, extractedContent, temperature, maxTokens } = input;
    
    // Build final prompt with proper attachment preservation
    // Priority: Memory → Ψ-EMA → Attachments → Search → Query
    // Memory provides human-like context, Ψ-EMA injects wave analysis, Attachments are primary source
    let finalPrompt = query;
    const hasMemory = state.contextResult?.memoryPrompt?.length > 0;
    const hasAttachments = extractedContent && extractedContent.length > 0;
    const hasSearch = !!state.searchContext;
    const isPsiEma = state.mode === 'psi-ema' && state.preflight?.psiEmaAnalysis;
    
    // Prepend φ-compressed memory context if available (human-like recall)
    let memoryPrefix = '';
    if (hasMemory) {
      memoryPrefix = state.contextResult.memoryPrompt + '\n[CURRENT QUERY]\n';
      console.log(`📝 Memory injected: ${state.contextResult.memoryPrompt.length} chars`);
    }
    
    // Build Ψ-EMA instruction for user prompt (ensures LLM outputs wave analysis)
    let psiEmaInstruction = '';
    if (isPsiEma) {
      const analysis = state.preflight.psiEmaAnalysis;
      const analysisWeekly = state.preflight.psiEmaAnalysisWeekly;
      const weeklyUnavailableReason = state.preflight.weeklyUnavailableReason;
      const stockData = state.preflight.stockData || {};
      const ticker = state.preflight.ticker;
      
      // Daily timeframe data
      const phase = analysis.dimensions?.phase || {};
      const anomaly = analysis.dimensions?.anomaly || {};
      const convergence = analysis.dimensions?.convergence || {};
      const composite = analysis.compositeSignal || {};
      const fidelity = analysis.fidelity || {};
      
      // Weekly timeframe data (if available)
      const phaseW = analysisWeekly?.dimensions?.phase || {};
      const anomalyW = analysisWeekly?.dimensions?.anomaly || {};
      const convergenceW = analysisWeekly?.dimensions?.convergence || {};
      const compositeW = analysisWeekly?.compositeSignal || {};
      const fidelityW = analysisWeekly?.fidelity || {};
      
      // Extract EDGAR fundamentals
      const fundamentals = stockData.fundamentals || {};
      let edgarSection = '';
      if (Object.keys(fundamentals).length > 0) {
        edgarSection = `
[SEC EDGAR FUNDAMENTALS]`;
        if (fundamentals.peRatio) edgarSection += `\nP/E Ratio: ${fundamentals.peRatio.toFixed(2)}`;
        if (fundamentals.forwardPE) edgarSection += `\nForward P/E: ${fundamentals.forwardPE.toFixed(2)}`;
        if (fundamentals.marketCap) edgarSection += `\nMarket Cap: $${(fundamentals.marketCap / 1e9).toFixed(2)}B`;
        if (fundamentals.sector) edgarSection += `\nSector: ${fundamentals.sector}`;
        if (fundamentals.industry) edgarSection += `\nIndustry: ${fundamentals.industry}`;
        if (fundamentals.dividendYield) edgarSection += `\nDividend Yield: ${(fundamentals.dividendYield * 100).toFixed(2)}%`;
        if (fundamentals.bookValue) edgarSection += `\nBook Value: ${fundamentals.bookValue.toFixed(2)}`;
        if (fundamentals.fiftyTwoWeekHigh) edgarSection += `\n52-Week High: $${fundamentals.fiftyTwoWeekHigh.toFixed(2)}`;
        if (fundamentals.fiftyTwoWeekLow) edgarSection += `\n52-Week Low: $${fundamentals.fiftyTwoWeekLow.toFixed(2)}`;
        edgarSection += '\n';
      }
      
      // Format stock price with timestamp (human-readable: "Friday, 19 Dec, 2025")
      let priceTimestamp = 'N/A';
      if (stockData.endDate) {
        const priceDate = new Date(stockData.endDate);
        const weekday = priceDate.toLocaleDateString('en-GB', { weekday: 'long' });
        const day = priceDate.getDate();
        const month = priceDate.toLocaleDateString('en-GB', { month: 'short' });
        const year = priceDate.getFullYear();
        priceTimestamp = `${weekday}, ${day} ${month}, ${year}`; // "Friday, 19 Dec, 2025"
      }
      
      // Financial Microbiology: Clinical pathology report (Dec 23, 2025) - based on daily
      const pathogenResult = detectPathogens(analysis);
      const clinicalReport = generateClinicalReport(analysis, ticker, stockData.currentPrice, priceTimestamp);
      
      // Physical Audit Disclaimer: "See to believe" infrastructure verification (Dec 23, 2025)
      const physicalAuditDisclaimer = generatePhysicalAuditDisclaimer(analysis, ticker);
      
      // Build clinical section if pathogens detected or unhealthy
      let clinicalSection = '';
      if (!pathogenResult.healthy) {
        clinicalSection = `
[FINANCIAL MICROBIOLOGY - PATHOLOGY REPORT]
PATIENT: ${ticker}
DIAGNOSIS: ${clinicalReport.diagnosis.emoji} ${clinicalReport.diagnosis.primary}
VITAL SIGNS: R=${clinicalReport.vitalSigns.R_ratio.value}, z=${clinicalReport.vitalSigns.z_score.value}σ
MICROSCOPY: ${clinicalReport.pathology.microscopy}
PROGNOSIS: ${clinicalReport.prognosis}
TREATMENT: ${clinicalReport.treatment}

INSTRUCTION: Present this as a CLINICAL PATHOLOGY REPORT. Use medical/pharmaceutical language (pathogen, treatment, prognosis).
`;
      } else {
        clinicalSection = `
[FINANCIAL HEALTH STATUS]
DIAGNOSIS: ${clinicalReport.diagnosis.emoji} ${clinicalReport.diagnosis.primary}
STATUS: Patient shows healthy φ-convergence. Conservation laws intact.
`;
      }
      
      // Build dual-timeframe output (Daily + Weekly) with computation math
      const dailyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelity.grade] || '⚪';
      const weeklyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelityW.grade] || '⚪';
      
      // Helper to format number or N/A
      const fmt = (v, decimals = 2) => (v != null && !isNaN(v)) ? v.toFixed(decimals) : 'N/A';
      
      // Build weekly section with math
      let weeklySection = '';
      if (analysisWeekly) {
        weeklySection = `
**WEEKLY (7d candles, 13-month window)** [${weeklyGradeEmoji} ${fidelityW.grade || '?'} grade, ${fidelityW.percent || 'N/A'}% fidelity]
├─ θ (Phase) = **${fmt(phaseW.current)}°** → ${phaseW.signal || 'N/A'}
├─ z (Anomaly) = **${fmt(anomalyW.current)}σ** → ${anomalyW.alert?.level || 'N/A'}
└─ R (Convergence) = **${fmt(convergenceW.current)}** → ${convergenceW.regime?.label || convergenceW.regime || 'N/A'}
   Composite: ${compositeW.action || 'HOLD'} (${compositeW.confidence || 'N/A'}% confidence)`;
      } else {
        weeklySection = `
**WEEKLY (7d):** ⚠️ Unavailable (${weeklyUnavailableReason || 'Insufficient data <13 bars'})`;
      }
      
      psiEmaInstruction = `
═══════════════════════════════════════════════════════════════════════════════
STANDARD MARKET SNAPSHOT (Data: yfinance + SEC EDGAR)
═══════════════════════════════════════════════════════════════════════════════
**${ticker}** — ${stockData.currency || 'USD'} ${stockData.currentPrice?.toFixed(2) || 'N/A'} (as of ${priceTimestamp})
${fundamentals.fiftyTwoWeekHigh ? `52-Week Range: $${fundamentals.fiftyTwoWeekLow?.toFixed(2) || 'N/A'} – $${fundamentals.fiftyTwoWeekHigh?.toFixed(2) || 'N/A'}` : ''}
${fundamentals.peRatio ? `P/E Ratio: ${fundamentals.peRatio.toFixed(2)}` : ''}${fundamentals.forwardPE ? ` | Forward P/E: ${fundamentals.forwardPE.toFixed(2)}` : ''}
${fundamentals.marketCap ? `Market Cap: $${(fundamentals.marketCap / 1e9).toFixed(2)}B` : ''}
${fundamentals.sector ? `Sector: ${fundamentals.sector}${fundamentals.industry ? ` / ${fundamentals.industry}` : ''}` : ''}

═══════════════════════════════════════════════════════════════════════════════
Ψ-EMA TREND ANALYSIS
═══════════════════════════════════════════════════════════════════════════════
Ψ-EMA measures three things: **where** a stock is in its price cycle (θ phase), 
**how unusual** the current price is compared to recent history (z anomaly), 
and **whether the trend can sustain** (R convergence). When all three align, 
conviction is higher; when they conflict, caution is warranted.

**DAILY (1d candles, 3-month window)** [${dailyGradeEmoji} ${fidelity.grade || '?'} grade, ${fidelity.percent || 'N/A'}% fidelity]
├─ θ (Phase) = **${fmt(phase.current)}°** → ${phase.signal || 'N/A'}
├─ z (Anomaly) = **${fmt(anomaly.current)}σ** → ${anomaly.alert?.level || 'N/A'}
└─ R (Convergence) = **${fmt(convergence.current)}** → ${convergence.regime?.label || convergence.regime || 'N/A'}
   Composite: ${composite.action || 'HOLD'} (${composite.confidence || 'N/A'}% confidence)
${weeklySection}

${clinicalSection}
${physicalAuditDisclaimer}

═══════════════════════════════════════════════════════════════════════════════
CONFIDENCE GRADING (NYAN Protocol Analysis Hierarchy)
═══════════════════════════════════════════════════════════════════════════════
• 95% = EXACT DATA (yfinance prices, SEC EDGAR fundamentals verified)
• 80% = PROXY AVAILABLE (interpolated/estimated, flagged with *)
• <50% = INSUFFICIENT DATA (honest refusal)

INSTRUCTION: Present BOTH Standard Market Snapshot AND Ψ-EMA Diagnostics 
(clearly separating conventional metrics from experimental analysis). 
Include all computation math. End with 🔥 ~nyan.
`;
      console.log(`📊 Ψ-EMA dual-timeframe instruction injected for ${ticker} (daily + ${analysisWeekly ? 'weekly' : 'weekly unavailable'})`);
    }
    
    if (hasAttachments && hasSearch) {
      // BOTH: Combine attachments + search context (rare: retry during doc analysis)
      console.log(`📎 Combining attachments (${extractedContent.length}) + search context`);
      finalPrompt = `${memoryPrefix}UPLOADED ATTACHMENTS (PRIMARY SOURCE - analyze these first):
${extractedContent.join('\n\n')}

SUPPLEMENTARY WEB SEARCH (use to verify or add context, NOT to override attachments):
${state.searchContext}

User query: ${query || 'Analyze this content.'}`;
    } else if (hasAttachments) {
      // Attachments only (closed-loop document analysis)
      console.log(`📎 Attachment-only mode: ${extractedContent.length} items`);
      finalPrompt = `${memoryPrefix}Attachments analyzed:\n${extractedContent.join('\n\n')}\n\nUser query: ${query || 'Analyze this content.'}`;
    } else if (hasSearch) {
      // Search only (general queries with web augmentation)
      finalPrompt = `${memoryPrefix}REAL-TIME WEB SEARCH RESULTS (USE THIS DATA):
${state.searchContext}

INSTRUCTION: Extract relevant facts from search results. Do NOT mention knowledge cutoff.

User query: ${query}`;
    } else if (hasMemory) {
      // Memory only - human-like context for follow-up queries
      finalPrompt = `${memoryPrefix}${query}`;
    }
    // else: plain query (no memory, no attachments, no search)
    
    // Append Ψ-EMA instruction to ensure wave analysis is output
    // This goes at the END so it's the last thing the LLM sees before responding
    if (psiEmaInstruction) {
      finalPrompt = `${finalPrompt}\n\n${psiEmaInstruction}`;
    }
    
    const messages = [
      ...state.systemMessages,
      ...(conversationHistory || []),
      { role: 'user', content: finalPrompt }
    ];
    
    const response = await this.groqWithRetry({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      data: {
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: temperature || 0.15,
        max_tokens: maxTokens || 1500,
        top_p: 0.95
      },
      config: {
        headers: {
          'Authorization': `Bearer ${this.groqToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    }, 3, 'text');
    
    state.draftAnswer = response.data.choices[0]?.message?.content || 'No response generated.';
    console.log(`🧠 Reasoning: ${state.draftAnswer.length} chars generated`);
  }
  
  async stepAudit(state, input) {
    state.transition(PIPELINE_STEPS.AUDIT);
    
    const { query, extractedContent } = input;
    
    // Log attachment preservation for debugging
    const attachmentCount = extractedContent?.length || 0;
    if (attachmentCount > 0) {
      console.log(`📎 Audit: ${attachmentCount} attachment(s) preserved for STRICT verification`);
    }
    
    if (this.isIdentityQuery(query)) {
      console.log(`🐱 Identity query - bypassing audit`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Identity question' };
      return;
    }
    
    const hasNoDocuments = attachmentCount === 0;
    const isSeedMetric = state.draftAnswer.includes('~nyan');
    const isTetralemma = isFalseDichotomy(query);
    const auditMode = hasNoDocuments ? 'RESEARCH' : 'STRICT';
    
    try {
      state.auditResult = await runAuditPass(
        this.groqToken,
        state.draftAnswer,
        query,
        extractedContent?.join('\n') || null,
        {
          usesFinancialPhysics: state.preflight.routingFlags?.usesFinancialPhysics,
          usesChemistry: false,
          usesLegalAnalysis: state.preflight.routingFlags?.usesLegalAnalysis,
          usesPsiEMA: state.mode === 'psi-ema',
          isSeedMetric,
          isTetralemma,
          auditMode
        },
        12000
      );
      console.log(`🔍 Audit: ${state.auditResult.verdict} (${state.auditResult.confidence}%)`);
      
      // WRITE to DataPackage: Stage S3 audit result
      state.writeToPackage(STAGE_IDS.AUDIT, {
        verdict: state.auditResult.verdict,
        confidence: state.auditResult.confidence,
        passed: state.auditResult.verdict === 'ACCEPTED' || state.auditResult.verdict === 'BYPASS',
        auditMode
      });
    } catch (err) {
      console.log(`⚠️ Audit error: ${err.message}`);
      state.auditResult = { verdict: 'BYPASS', confidence: 70, reason: 'Audit failed' };
    }
  }
  
  async stepRetry(state, input) {
    state.transition(PIPELINE_STEPS.RETRY);
    state.retryCount++;
    
    const { query, clientIp } = input;
    
    if (state.mode === 'psi-ema') {
      console.log(`⏭️ Ψ-EMA: Skip retry (yfinance data pre-verified)`);
      return;
    }
    
    console.log(`🔄 Retry ${state.retryCount}: Searching for better data...`);
    
    const searchQuery = await this.extractCoreQuestion(query);
    state.searchContext = await this.searchBrave(searchQuery, clientIp);
    if (!state.searchContext) {
      state.searchContext = await this.searchDuckDuckGo(searchQuery);
    }
    
    if (state.searchContext) {
      state.didSearch = true;
      await this.stepReasoning(state, input);
      await this.stepAudit(state, input);
    }
  }
  
  async stepOutput(state) {
    state.transition(PIPELINE_STEPS.OUTPUT);
    
    if (state.auditResult?.fixedAnswer) {
      state.finalAnswer = state.auditResult.fixedAnswer;
    } else {
      state.finalAnswer = state.draftAnswer;
    }
    
    // Apply personality formatting (unified, single-pass)
    // Note: Personality layer strips FLUFF only, never alters actual DATA
    state.finalAnswer = this.applyPersonalityFormat(state.finalAnswer, state.mode);
    
    // WRITE to DataPackage: Stage S6 output (personality-formatted)
    state.writeToPackage(STAGE_IDS.OUTPUT, {
      mode: state.mode,
      outputLength: state.finalAnswer.length,
      didSearch: state.didSearch,
      retryCount: state.retryCount
    });
    
    // FINALIZE: Package is now read-only, store in tenant's φ-8 window
    state.dataPackage.finalize();
    globalPackageStore.storePackage(state.dataPackage.tenantId, state.dataPackage);
    
    console.log(`✅ Output: ${state.finalAnswer.length} chars, mode=${state.mode}`);
  }
  
  /**
   * PERSONALITY LAYER (S5) - Unified format enforcement
   * All formatting happens HERE, not scattered across prompts/contexts
   * This is the SINGLE source of truth for output formatting
   */
  applyPersonalityFormat(answer, mode) {
    if (!answer) return answer;
    
    let cleaned = answer;
    
    // INTRO FLUFF: Remove generic intro paragraphs (case-insensitive)
    const introFluffPatterns = [
      /^##?\s*Summary[^\n]*\n+[^\n]*(?:comprehensive|detailed|provides|uncertain)[^\n]*\n+/i,
      /^##?\s*Summary[^\n]*\n+[^\n]*following[^\n]*\n+/i,
      /^##?\s*Summary\s*\n+[^\n]+\n+/i,
      /^##?\s*Summary\s*\n+/i,
      /^##?\s*Introduction to[^\n]*\n+(?:[^\n]+\n+)?/i,
      /^(?:A |The )?(?:comprehensive|detailed|current) (?:analysis|view|overview|price trend) of[^\n]*\n+/i,
      /^The (?:following|current|NVDA|stock)[^\n]*(?:is|can be|provides)[^\n]*\n+/i,
      /^Here (?:is|are)[^\n]*analysis[^\n]*\n+/i,
      /^Let me provide[^\n]*\n+/i,
      /^I'll analyze[^\n]*\n+/i,
      /^This analysis provides[^\n]*\n+/i,
      /^To analyze[^\n]*\n+/i,
      /^As of my knowledge[^\n]*\n+/i,
    ];
    
    for (const pattern of introFluffPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // OUTRO FLUFF: Remove verbose confidence grading sections (95%/80%/<50% tiers)
    const outroFluffPatterns = [
      /###?\s*Confidence Grading\s*\n+(?:[\s\S]*?(?:\*\s*\*\*95%\*\*|\*\s*\*\*80%\*\*|\*\s*\*\*<50%\*\*)[\s\S]*?)+(?=\n*(?:🔥|$))/i,
      /The confidence (?:grading|levels?) (?:for this analysis )?(?:is|are) as follows:\s*\n+(?:\*[^\n]+\n+)+/i,
      /The current analysis has a confidence grade of[^\n]*\n+/i,
    ];
    
    for (const pattern of outroFluffPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // Ensure ~nyan signature exists (add if missing, don't duplicate)
    if (!cleaned.includes('~nyan')) {
      cleaned = cleaned.trimEnd() + '\n\n🔥 ~nyan';
    }
    
    return cleaned.trim();
  }
}

function createPipelineOrchestrator(config) {
  return new PipelineOrchestrator(config);
}

module.exports = {
  PipelineOrchestrator,
  PipelineState,
  PIPELINE_STEPS,
  createPipelineOrchestrator
};
