/**
 * Pipeline Orchestrator - Unified AI Request Processing
 * 
 * State Machine:
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
 */

const { preflightRouter, buildSystemContext } = require('./preflight-router');
const { NYAN_PROTOCOL_SYSTEM_PROMPT } = require('../prompts/nyan-protocol');
const { runAuditPass } = require('./two-pass-verification');
const { isFalseDichotomy } = require('../prompts/audit-protocol');

const PIPELINE_STEPS = {
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
    this.step = PIPELINE_STEPS.PREFLIGHT;
    this.retryCount = 0;
    this.maxRetries = 1;
    this.mode = 'general';
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
        await this.stepPreflight(state, input);
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
    
    const { query, attachments, clientIp } = input;
    const safeDocContext = input.docContext || {};
    
    state.preflight = await preflightRouter({
      query: query || '',
      attachments: attachments || [],
      docContext: safeDocContext
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
    
    let finalPrompt = query;
    if (state.searchContext) {
      finalPrompt = `REAL-TIME WEB SEARCH RESULTS (USE THIS DATA):
${state.searchContext}

INSTRUCTION: Extract relevant facts from search results. Do NOT mention knowledge cutoff.

User query: ${query}`;
    }
    
    if (extractedContent && extractedContent.length > 0) {
      finalPrompt = `Attachments analyzed:\n${extractedContent.join('\n\n')}\n\nUser query: ${query || 'Analyze this content.'}`;
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
    
    if (this.isIdentityQuery(query)) {
      console.log(`🐱 Identity query - bypassing audit`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Identity question' };
      return;
    }
    
    const hasNoDocuments = !extractedContent || extractedContent.length === 0;
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
