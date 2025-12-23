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
 * This separates concerns:
 * - NYAN Protocol = What to think (reasoning principles)
 * - Pipeline = How to process (state machine)
 * - Routing = Where to go (mode detection via preflight-router)
 * - Context = What was discussed (entity extraction from history)
 */

const { preflightRouter, buildSystemContext } = require('./preflight-router');
const { extractContext, extractContextWithMemory, mergeContextForTickerDetection } = require('./context-extractor');
const { NYAN_PROTOCOL_SYSTEM_PROMPT } = require('../prompts/nyan-protocol');
const { runAuditPass } = require('./two-pass-verification');
const { isFalseDichotomy } = require('../prompts/audit-protocol');

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
  constructor() {
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
  }
  
  transition(nextStep) {
    console.log(`🔄 Pipeline: ${this.step} → ${nextStep}`);
    this.step = nextStep;
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
    const state = new PipelineState();
    
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
        
        // Still do seed-metric search if needed
        const safeDocContext = input.docContext || {};
        if (state.mode === 'seed-metric' && input.query && !safeDocContext.isClosedLoop) {
          const searchQuery = await this.extractCoreQuestion(input.query);
          console.log(`🌱 Seed Metric: Search FIRST for fresh data`);
          state.searchContext = await this.searchBrave(searchQuery, input.clientIp);
          if (!state.searchContext) {
            state.searchContext = await this.searchDuckDuckGo(searchQuery);
          }
          state.didSearch = !!state.searchContext;
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
        
        return {
          success: true,
          answer: state.finalAnswer,
          mode: state.mode,
          preflight: state.preflight,
          auditResult: state.auditResult,
          didSearch: false,
          retryCount: 0,
          fastPath: true
        };
      }
      
      await this.stepContextBuild(state, input);
      await this.stepReasoning(state, input);
      await this.stepAudit(state, input);
      
      if (state.auditResult?.verdict === 'REJECTED' && state.retryCount < state.maxRetries) {
        await this.stepRetry(state, input);
      }
      
      await this.stepOutput(state);
      
      return {
        success: true,
        answer: state.finalAnswer,
        mode: state.mode,
        preflight: state.preflight,
        auditResult: state.auditResult,
        didSearch: state.didSearch,
        retryCount: state.retryCount
      };
    } catch (err) {
      console.error(`❌ Pipeline error at ${state.step}: ${err.message}`);
      return {
        success: false,
        error: err.message,
        step: state.step
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
    
    if (state.mode === 'seed-metric' && query && !safeDocContext.isClosedLoop) {
      const searchQuery = await this.extractCoreQuestion(query);
      console.log(`🌱 Seed Metric: Search FIRST for fresh data`);
      
      state.searchContext = await this.searchBrave(searchQuery, clientIp);
      if (!state.searchContext) {
        state.searchContext = await this.searchDuckDuckGo(searchQuery);
      }
      state.didSearch = !!state.searchContext;
    }
  }
  
  async stepContextBuild(state, input) {
    state.transition(PIPELINE_STEPS.CONTEXT_BUILD);
    
    state.systemMessages = buildSystemContext(state.preflight, NYAN_PROTOCOL_SYSTEM_PROMPT);
    console.log(`📝 Context: ${state.systemMessages.length} system messages built`);
  }
  
  async stepReasoning(state, input) {
    state.transition(PIPELINE_STEPS.REASONING);
    
    const { query, conversationHistory, extractedContent, temperature, maxTokens } = input;
    
    // Build final prompt with proper attachment preservation
    // Priority: Memory → Attachments → Search → Query
    // Memory provides human-like context, Attachments are primary source, Search supplements
    let finalPrompt = query;
    const hasMemory = state.contextResult?.memoryPrompt?.length > 0;
    const hasAttachments = extractedContent && extractedContent.length > 0;
    const hasSearch = !!state.searchContext;
    
    // Prepend φ-compressed memory context if available (human-like recall)
    let memoryPrefix = '';
    if (hasMemory) {
      memoryPrefix = state.contextResult.memoryPrompt + '\n[CURRENT QUERY]\n';
      console.log(`📝 Memory injected: ${state.contextResult.memoryPrompt.length} chars`);
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
    
    console.log(`✅ Output: ${state.finalAnswer.length} chars, mode=${state.mode}`);
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
