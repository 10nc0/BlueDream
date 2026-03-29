/**
 * Pipeline Orchestrator - Unified AI Request Processing
 * 
 * 7-STAGE STATE MACHINE (S-1 to S6):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ S-1: Context Extraction  │ φ-8 message window, entity extraction │
 * │ S0:  Preflight           │ Mode detection, routing, data fetch   │
 * │ S1:  Context Build       │ Inject system prompts based on mode   │
 * │ S2:  Reasoning           │ LLM call (O(tokens), ~1500 tokens)    │
 * │ S3:  Audit               │ LLM call (O(tokens), ~800 tokens)     │
 * │ S4:  Retry               │ Search augmentation if audit rejected │
 * │ S5:  Personality         │ Regex cleanup (O(n), NOT an LLM call) │
 * │ S6:  Output              │ Finalize DataPackage, store in φ-8    │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * COMPLEXITY ANALYSIS:
 * - Best case: 2 LLM calls (Reasoning + Audit)
 * - Worst case: 4 LLM calls (Reasoning + Audit + Retry + Re-Audit)
 * - Personality: Regex-based (applyPersonalityFormat), NOT an LLM call
 * 
 * GROQFIRST FLOW PATTERN:
 * - Try Groq FIRST for generation (S2)
 * - Run audit pass to verify output (S3)
 * - If audit PASSES → use Groq output
 * - If audit FAILS → retry with search augmentation (S4), then re-audit
 * 
 * SEPARATION OF CONCERNS:
 * - NYAN Protocol = What to think (reasoning principles)
 * - Pipeline = How to process (this state machine)
 * - Routing = Where to go (preflight-router.js)
 * - Context = What was discussed (context-extractor.js)
 * - Audit = Verification (two-pass-verification.js::runAuditPass)
 */

const logger = require('../lib/logger');
const { preflightRouter, buildSystemContext } = require('./preflight-router');
const { extractContext, extractContextWithMemory, mergeContextForTickerDetection, isSessionFirstQuery, markSessionNyanBooted } = require('./context-extractor');
const { NYAN_PROTOCOL_SYSTEM_PROMPT, NYAN_PROTOCOL_COMPRESSED, getNyanProtocolPrompt, getNyanProtocolCompressed } = require('../prompts/nyan-protocol');
const { modelIdToLabel } = require('../prompts/pharma-analysis');
const { injectSourceLine } = require('./source-ascriber');
const { runAuditPass } = require('./two-pass-verification');
const { isFalseDichotomy } = require('../prompts/audit-protocol');
const { detectPathogens, generateClinicalReport, generatePhysicalAuditDisclaimer } = require('./psi-EMA');
const { DataPackage, globalPackageStore, STAGE_IDS } = require('./data-package');
const { globalCheckpointStore, buildResumableSnapshot, applySnapshot } = require('./pipeline-checkpoint');
const { getLLMBackend, getAuditBackend } = require('../config/constants');
const { CITY_EXPAND, COUNTRY_TO_CITY, CITY_TO_COUNTRY } = require('./geo-data');
const { MAX_CONTENT_CHARS } = require('./config-constants');

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

const { AttachmentIngestion } = require('./attachment-ingestion');
const { analyzeImageWithGroqVision, processChemistryContent, classifyScholasticDomain } = require('./attachment-cascade');
const { createQueryTimestamp, buildTemporalContent } = require('./time-format');
const { buildSeedMetricTable, validateSeedMetricOutput, parseTFR, injectTFRColumn } = require('./seed-metric-calculator');
const { cleanMarkdownJson, EMPTY_TABLE_ROW_REGEX } = require('./parse-helpers');
const { buildGatherPromptBlock } = require('../prompts/seed-metric');

function extractVisionSearchTerms(visionDescription) {
  if (!visionDescription || visionDescription.length < 20) return null;
  
  const desc = visionDescription.toLowerCase();
  
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
    'or', 'if', 'while', 'this', 'that', 'these', 'those', 'it', 'its',
    'image', 'appears', 'shows', 'display', 'displayed', 'depicting',
    'contains', 'features', 'includes', 'also', 'which', 'what',
    'photo', 'picture', 'visual', 'seem', 'seems', 'likely', 'possibly',
    'appear', 'see', 'seen', 'look', 'looks', 'like'
  ]);
  
  const culturalCues = [];
  if (/chinese|中|汉|勾股/i.test(desc)) culturalCues.push('Chinese');
  if (/japanese|日本|和/i.test(desc)) culturalCues.push('Japanese');
  if (/arabic|arab|islam/i.test(desc)) culturalCues.push('Arabic');
  if (/indian|hindu|sanskrit/i.test(desc)) culturalCues.push('Indian');
  if (/greek|ancient greece/i.test(desc)) culturalCues.push('Greek');
  
  const domainCues = [];
  if (/theorem|proof|mathematical|geometry|geometric|pythagor|gougu/i.test(desc)) domainCues.push('mathematical proof');
  if (/diagram|schematic|blueprint/i.test(desc)) domainCues.push('diagram');
  if (/historical|ancient|traditional|classic/i.test(desc)) domainCues.push('historical');
  if (/grid|square|rectangle|triangle/i.test(desc)) domainCues.push('geometric');
  if (/character|text|writing|script|label/i.test(desc)) domainCues.push('annotated');
  
  const cleaned = desc
    .replace(/\*\*[^*]+\*\*/g, '')
    .replace(/^(the image|this image|the picture|this picture|the diagram|this diagram|it|the photo|this photo)\s+(shows?|displays?|depicts?|contains?|features?|presents?|illustrates?|represents?)\s+/i, '')
    .replace(/^(a|an|the)\s+(diagram|image|picture|photo|figure|illustration)\s+(of|showing|depicting|with)\s+/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const words = cleaned.split(' ')
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 20);
  
  const meaningful = [...new Set([...culturalCues, ...domainCues, ...words.slice(0, 6)])];
  
  if (meaningful.length < 2) return null;
  
  const query = meaningful.slice(0, 8).join(' ');
  return query.length > 10 ? query : null;
}

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
    this.hasImageAttachment = false;  // Set in S-1 for retry logic
    
    // UNIFIED TIMESTAMP: Single source of truth for the entire pipeline
    // Captured once at construction, shared by temporal awareness, audit, and signature
    this.queryTimestamp = createQueryTimestamp();
  }
  
  transition(nextStep) {
    logger.debug(`🔄 Pipeline: ${this.step} → ${nextStep}`);
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
    this.auditToken = config.auditToken || config.groqToken;
    this.groqVisionToken = config.groqVisionToken;
    this.searchBrave = config.searchBrave;
    this.searchDuckDuckGo = config.searchDuckDuckGo;
    this.extractCoreQuestion = config.extractCoreQuestion;
    this.isIdentityQuery = config.isIdentityQuery;
    this.groqWithRetry = config.groqWithRetry;
    const llm = getLLMBackend();
    this.llmUrl = llm.url;
    this.llmModel = llm.model;
    this.llmTimeouts = llm.timeouts;
  }
  
  /**
   * Sequential search with rate limiting for Brave API
   * Brave free tier has per-second burst limits, so we space out requests
   * @param {string[]} queries - Array of search queries
   * @param {string} clientIp - Client IP for Brave API
   * @param {number} delayMs - Delay between requests (default 350ms)
   * @returns {Promise<string[]>} Array of search results
   */
  async searchWithRateLimit(queries, clientIp, delayMs = 350) {
    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const sq = queries[i];
      let result = await this.searchBrave(sq, clientIp);
      if (!result) {
        result = await this.searchDuckDuckGo(sq);
      }
      if (result) {
        results.push(`[${sq}]\n${result}`);
      }
      // Add delay between requests (except after last one)
      if (i < queries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return results;
  }

  // Mandatory execute method for the orchestrator
  async execute(input) {
    return this.run(input);
  }

  async run(input) {
    const tenantId = input.clientIp || input.sessionId || 'anonymous';
    const state = new PipelineState(tenantId);
    
    // Normalize input: streaming endpoint uses 'message', non-streaming uses 'query'
    // Also normalize 'history' to 'conversationHistory'
    const normalizedInput = {
      ...input,
      query: input.query || input.message || 'Analyze content',
      conversationHistory: input.conversationHistory || input.history || [],
      extractedContent: input.extractedContent || []
    };

    const checkpointQuery = normalizedInput.query;
    const checkpoint = globalCheckpointStore.restore(checkpointQuery, tenantId);
    let resumeFromStage = null;

    if (checkpoint && checkpoint.snapshot) {
      applySnapshot(state, checkpoint.snapshot);
      resumeFromStage = checkpoint.stageId;
      logger.info(`♻️ Pipeline resuming from checkpoint after ${resumeFromStage}`);
    }

    // ========================================
    // STAGE -1: Context Extraction with φ-Compressed Memory
    // ========================================
    state.transition(PIPELINE_STEPS.CONTEXT_EXTRACT);

    // L1 Perception Ingestion (only if raw attachments provided)
    const rawAttachments = input.attachments || [];
    const perception = await AttachmentIngestion.ingest(rawAttachments, tenantId);

    // Merge ingested content - only overwrite if perception produced files
    // This preserves pre-processed extractedContent from routes (e.g., playground vision)
    if (perception.hasAttachments && perception.files.length > 0) {
      normalizedInput.extractedContent = perception.files;
      normalizedInput.extractedText = perception.extractedText;
    } else {
      // Preserve extractedText from input if provided (e.g., from route pre-processing)
      normalizedInput.extractedText = input.extractedText || '';
    }

    // Process photos through Groq Vision if present (before setting hasImageAttachment)
    const photos = input.photos || [];
    let visionSuccessCount = 0;
    const chemicalVisionResults = []; // Collect chemical observations for enrichment
    
    if (photos.length > 0) {
      const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN;
      if (PLAYGROUND_GROQ_VISION_TOKEN) {
        logger.debug(`🔬 S-1: Processing ${photos.length} photo(s) with Groq Vision...`);
        for (const photo of photos.slice(0, 5)) { // Max 5 photos
          try {
            // Extract base64 and content type from data URL
            // Format: data:image/jpeg;base64,xxxx
            const photoData = photo.data || '';
            const photoName = photo.name || 'image';
            let base64 = '';
            let contentType = 'image/jpeg'; // Default fallback
            
            // Debug: log incoming data format
            logger.debug(`📷 S-1: Photo ${photoName} data length: ${photoData.length}, starts with: ${photoData.substring(0, 50)}...`);
            
            // Parse data URL to get actual content type (frontend may convert PNG to JPEG during resize)
            const dataUrlMatch = photoData.match(/^data:([^;]+);base64,(.+)$/s);
            if (dataUrlMatch) {
              contentType = dataUrlMatch[1]; // Actual MIME type from data URL
              base64 = dataUrlMatch[2];      // Raw base64 without prefix
              logger.debug(`📷 S-1: Regex matched - contentType: ${contentType}, base64 length: ${base64.length}`);
            } else if (photoData.includes('base64,')) {
              // Fallback: just extract base64 portion
              const parts = photoData.split('base64,');
              base64 = parts[1] || '';
              logger.debug(`📷 S-1: Fallback split - base64 length: ${base64.length}`);
            } else {
              logger.debug(`📷 S-1: No base64 marker found in photoData`);
            }
            
            // Sanitize base64: remove whitespace, newlines
            base64 = (base64 || '').replace(/[\s\r\n]/g, '');
            
            logger.debug(`📷 S-1: Photo ${photoName} detected as ${contentType} (${base64.length} chars after sanitize)`);
            
            const visionResult = await analyzeImageWithGroqVision(
              base64, contentType, PLAYGROUND_GROQ_VISION_TOKEN, photoName
            );
            
            if (visionResult && visionResult.description) {
              const typeLabel = visionResult.contentType === 'chemical' ? '🧪 Chemical Structure' :
                               visionResult.contentType === 'chart' ? '📊 Chart/Graph' :
                               visionResult.contentType === 'diagram' ? '📐 Diagram' : '🖼️ Visual';
              const visionText = `**${photoName} (${typeLabel}):**\n${visionResult.description}`;
              // Use schema matching AttachmentIngestion output
              normalizedInput.extractedContent.push(visionText);
              visionSuccessCount++;
              logger.info(`✅ S-1: Vision analysis complete for ${photoName}`);
              
              // Collect chemical results for enrichment
              if (visionResult.contentType === 'chemical') {
                chemicalVisionResults.push(visionResult);
              }
            }
          } catch (visionError) {
            console.error(`❌ S-1: Vision analysis error: ${visionError.message}`);
          }
        }
        
        // Gate chemistry: re-check scholastic domain on all vision descriptions
        // If non-chemistry domain dominates (e.g., pure-math), skip chemistry pipeline entirely
        let chemistryGated = false;
        let gatedVisionDescriptions = [];
        if (chemicalVisionResults.length > 0) {
          const allVisionText = chemicalVisionResults.map(r => r.description || '').join(' ');
          const scholasticCheck = classifyScholasticDomain(allVisionText);
          if (scholasticCheck.domain !== 'chemistry' && scholasticCheck.domain !== 'general') {
            logger.debug(`🚫 S-1: Chemistry pipeline GATED — scholastic domain is "${scholasticCheck.domain}" (override: ${scholasticCheck.override || 'none'}), not chemistry`);
            gatedVisionDescriptions = chemicalVisionResults.map(r => r.description || '').filter(d => d.length > 0);
            chemicalVisionResults.length = 0; // Clear to skip chemistry and trigger vision search fallback
            chemistryGated = true;
            // Relabel extractedContent: replace wrong 🧪 Chemical Structure label with correct domain label
            const domainLabel = scholasticCheck.domain === 'pure-math' ? '📐 Mathematical Diagram' : '📐 Diagram';
            for (let i = 0; i < normalizedInput.extractedContent.length; i++) {
              if (typeof normalizedInput.extractedContent[i] === 'string' && normalizedInput.extractedContent[i].includes('🧪 Chemical Structure')) {
                normalizedInput.extractedContent[i] = normalizedInput.extractedContent[i].replace('🧪 Chemical Structure', domainLabel);
                logger.debug(`📝 S-1: Relabeled vision content from "🧪 Chemical Structure" to "${domainLabel}"`);
              }
            }
          }
        }
        
        // If chemical structures detected (and passed scholastic gate), run chemistry enrichment pipeline
        if (chemicalVisionResults.length > 0) {
          try {
            logger.debug(`🧪 S-1: Running chemistry enrichment for ${chemicalVisionResults.length} chemical structure(s)...`);
            const chemistryResult = await processChemistryContent(chemicalVisionResults);
            if (chemistryResult && chemistryResult.enrichedText) {
              normalizedInput.extractedContent.push(chemistryResult.enrichedText);
              logger.info(`✅ S-1: Chemistry enrichment complete - ${chemistryResult.stage || 'unknown stage'}`);
              
              if (chemistryResult.compoundInfo && chemistryResult.compoundInfo.name) {
                const ci = chemistryResult.compoundInfo;
                const confidence = ci.confidence || 0.5;
                const isGenericName = /^(unknown|unverified|unidentified|puzzle|grid|geometric|figure|pattern|n\/?a|not\s+applicable|none|no\s+data|scientific\s+data|image|diagram)/i.test(ci.name);
                
                if (confidence >= 0.7 && !isGenericName) {
                  let header = `### 🔬 Compound Identification\n**Name:** ${ci.name}`;
                  if (ci.canonicalFormula) header += `\n**Formula:** ${ci.canonicalFormula}`;
                  else if (chemistryResult.formula) header += `\n**Formula:** ${chemistryResult.formula}`;
                  header += `\n**Confidence:** ${Math.round(confidence * 100)}%`;
                  header += `\n**Source:** ${ci.source || 'DDG/Wikipedia'}`;
                  if (ci.note) header += `\n**Note:** ${ci.note}`;
                  state.chemistryHeader = header;
                  logger.debug(`📋 S-1: Chemistry header saved for S6 output (${Math.round(confidence * 100)}%)`);
                } else {
                  logger.debug(`📋 S-1: Chemistry header SUPPRESSED (confidence=${Math.round(confidence * 100)}%, name="${ci.name}" generic=${isGenericName})`);
                }
              }
            }
          } catch (chemError) {
            console.error(`❌ S-1: Chemistry enrichment error: ${chemError.message}`);
          }
        }
        
        // Vision Search Enrichment: search to identify non-chemistry images or failed-chemistry images
        const chemEnrichmentFailed = chemicalVisionResults.length > 0 && !state.chemistryHeader;
        const nonChemVisionDescs = normalizedInput.extractedContent
          .filter(text => typeof text === 'string' && 
            (text.includes('📐 Diagram') || text.includes('🖼️ Visual') || text.includes('📊 Chart')) &&
            !text.includes('🧪 Chemical Structure'));
        
        const needsVisionSearch = nonChemVisionDescs.length > 0 || chemEnrichmentFailed || chemistryGated;
        
        if (needsVisionSearch) {
          try {
            let visionDesc;
            let trigger;
            if (chemistryGated && gatedVisionDescriptions.length > 0) {
              trigger = 'chem-gated';
              visionDesc = gatedVisionDescriptions.join(' ');
            } else if (chemEnrichmentFailed && nonChemVisionDescs.length === 0) {
              trigger = 'chem-fallback';
              visionDesc = chemicalVisionResults
                .map(r => r.description || '')
                .filter(d => d.length > 0)
                .join(' ');
            } else {
              trigger = 'vision-identify';
              visionDesc = nonChemVisionDescs.join(' ');
            }
            
            if (visionDesc && visionDesc.length > 20) {
              const scholastic = classifyScholasticDomain(visionDesc);
              const keyTerms = extractVisionSearchTerms(visionDesc);
              
              if (keyTerms) {
                logger.debug(`🔎 S-1: Vision search enrichment [${trigger}] — querying "${keyTerms}" (scholastic: ${scholastic.domain})`);
                let searchResult = await this.searchBrave(keyTerms, normalizedInput.clientIp);
                if (!searchResult) {
                  searchResult = await this.searchDuckDuckGo(keyTerms);
                }
                
                if (searchResult) {
                  normalizedInput.extractedContent.push(
                    `\n### 🔍 Image Identification (Web Search):\n${searchResult}`
                  );
                  state.didSearch = true;
                  logger.info(`✅ S-1: Vision search enrichment complete (${searchResult.length} chars)`);
                } else {
                  logger.warn(`⚠️ S-1: Vision search returned no results for "${keyTerms}"`);
                }
              }
            }
          } catch (searchErr) {
            console.error(`❌ S-1: Vision search enrichment error: ${searchErr.message}`);
          }
        }
      } else {
        logger.warn(`⚠️ S-1: PLAYGROUND_GROQ_VISION_TOKEN not configured - skipping vision analysis`);
      }
    }

    // Detect image attachments - only set true if we have actual vision content
    // Check: successful vision processing, or raw image attachments
    state.hasImageAttachment = 
      visionSuccessCount > 0 ||
      rawAttachments.some(att => {
        const name = (att.name || att.fileName || '').toLowerCase();
        const mime = (att.mimeType || att.type || '').toLowerCase();
        return /\.(jpg|jpeg|png|gif|webp|bmp)$/.test(name) || mime.startsWith('image/');
      });
    if (state.hasImageAttachment) {
      logger.debug(`🖼️ S-1: Image content ready (vision=${visionSuccessCount}) - search retry will be skipped`);
    }

    // Track if this is first query for NYAN boot optimization
    const isFirstQuery = normalizedInput.sessionId ? isSessionFirstQuery(normalizedInput.sessionId) : false;
    state.isFirstQuery = isFirstQuery;

    try {
      // Use memory-enhanced extraction if sessionId provided
      if (normalizedInput.sessionId) {
        state.contextResult = await extractContextWithMemory(
          normalizedInput.sessionId,
          normalizedInput.query,
          normalizedInput.conversationHistory,
          normalizedInput.attachmentHistory || [],
          perception.hasAttachments ? perception.files[0] : null
        );
      } else {
        state.contextResult = extractContext(
          normalizedInput.conversationHistory,
          normalizedInput.attachmentHistory || [],
          8
        );
      }

      // If no file in memory but we just ingested one, record metadata (no mode decision)
      if (!state.contextResult.attachmentContext && perception.hasAttachments) {
        state.contextResult.attachmentContext = {
          name: perception.files[0].fileName
        };
      }

      // WRITE to DataPackage: Stage S-1 context extraction result (mode-agnostic)
      state.writeToPackage(STAGE_IDS.CONTEXT_EXTRACT, {
        inferredTicker: state.contextResult.inferredTicker,
        hasFinancialContext: state.contextResult.hasFinancialContext,
        hasMemory: state.contextResult.hasMemory,
        attachmentContext: state.contextResult.attachmentContext?.name || null,
        perceptionFiles: perception.files.length,
        extractedTextLength: perception.extractedText.length,
        hasImageAttachment: state.hasImageAttachment,
        extractedContent: normalizedInput.extractedContent // STORE ALL EXTRACTED DATA (including Vision results)
      });
      
      if (state.contextResult.inferredTicker) {
        logger.debug(`📜 Stage -1: Context extracted - inferred ticker: ${state.contextResult.inferredTicker}`);
      } else if (state.contextResult.hasFinancialContext) {
        logger.debug(`📜 Stage -1: Financial context detected, no specific ticker`);
      }
      
      // Log memory-based context if available
      if (state.contextResult.attachmentContext) {
        logger.debug(`📎 Stage -1: Attachment side-door active - "${state.contextResult.attachmentContext.name}"`);
      }
      
      // Merge context with current query for enhanced detection
      const contextAwareQuery = mergeContextForTickerDetection(normalizedInput.query, state.contextResult);
      
      // ========================================
      // STAGE 0: Preflight (mode detection, external data)
      // ========================================
      if (resumeFromStage && ['S0', 'S1', 'S2', 'S3'].includes(resumeFromStage)) {
        logger.debug(`⏩ Skipping S0 (preflight) — restored from checkpoint (mode=${state.mode})`);
      } else if (normalizedInput.preComputedPreflight) {
        state.preflight = normalizedInput.preComputedPreflight;
        state.mode = state.preflight.mode;
        logger.debug(`📊 Preflight (pre-computed): mode=${state.mode}, ticker=${state.preflight.ticker || 'none'}`);
        
        state.writeToPackage(STAGE_IDS.PREFLIGHT, {
          mode: state.mode,
          ticker: state.preflight.ticker || null,
          stockContext: state.preflight.stockContext || null,
          hasPsiEma: !!state.preflight.psiEmaAnalysis,
          preComputed: true
        });
        
      } else {
        await this.stepPreflight(state, { ...input, query: contextAwareQuery, contextResult: state.contextResult });
      }
      
      if (state.mode === 'psi-ema' && !state.preflight.ticker) {
        logger.debug(`⚡ Fast-path: Ψ-EMA mode but no ticker - returning no-data message`);
        state.finalAnswer = `📊 **No Stock Data Available**\n\nI detected a financial analysis request, but couldn't identify a valid public stock ticker.\n\n**Tips:**\n• Use explicit ticker format: "$AAPL", "$NVDA", "$META"\n• Note: Some companies are private (e.g., Bloomberg LP) and have no public stock data\n• Commodities (gold, oil) and crypto require different analysis tools\n\n🔥 ~nyan`;
        state.auditResult = { verdict: 'BYPASS', confidence: 100, reason: 'No ticker - fast path' };
        // transition to output but don't mark booted mid-way
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
        
        state.dataPackage.finalize();
        globalPackageStore.storePackage(state.dataPackage.tenantId, state.dataPackage);
        globalCheckpointStore.clear(checkpointQuery, tenantId);
        
        return {
          success: true,
          answer: state.finalAnswer,
          mode: state.mode,
          source: 'shortcut',
          preflight: state.preflight,
          auditResult: state.auditResult,
          audit: { confidence: 100, reason: 'No ticker - fast path' },
          badge: 'verified',
          didSearch: false,
          didSearchRetry: false,
          retryCount: 0,
          passCount: 1,
          fastPath: true,
          dataPackageId: state.dataPackage.id,
          dataPackageSummary: state.dataPackage.toCompressedSummary()
        };
      }
      
      if (!resumeFromStage || resumeFromStage === 'S0') {
        globalCheckpointStore.save(checkpointQuery, tenantId, 'S0', buildResumableSnapshot(state));
      }

      if (resumeFromStage && ['S1', 'S2', 'S3'].includes(resumeFromStage)) {
        logger.debug(`⏩ Skipping S1 (context build) — restored from checkpoint`);
      } else {
        await this.stepContextBuild(state, normalizedInput);
      }

      if (resumeFromStage && ['S2', 'S3'].includes(resumeFromStage)) {
        logger.debug(`⏩ Skipping S2 (reasoning) — restored from checkpoint`);
      } else {
        globalCheckpointStore.save(checkpointQuery, tenantId, 'S1', buildResumableSnapshot(state));
        await this.stepReasoning(state, normalizedInput);
        globalCheckpointStore.save(checkpointQuery, tenantId, 'S2', buildResumableSnapshot(state));
      }

      if (resumeFromStage === 'S3') {
        logger.debug(`⏩ Skipping S3 (audit) — restored from checkpoint`);
      } else {
        await this.stepAudit(state, normalizedInput);
        globalCheckpointStore.save(checkpointQuery, tenantId, 'S3', buildResumableSnapshot(state));
      }
      
      if (state.auditResult?.verdict === 'REJECTED' && state.retryCount < state.maxRetries) {
        await this.stepRetry(state, normalizedInput);
      }
      
      await this.stepOutput(state);
      
      // Mark NYAN as booted AFTER successful completion (not during context build)
      // This ensures retries within same request still get full NYAN
      if (normalizedInput.sessionId && state.isFirstQuery) {
        markSessionNyanBooted(normalizedInput.sessionId);
      }
      
      globalCheckpointStore.clear(checkpointQuery, tenantId);

      const badge = this.deriveBadge(state.auditResult);
      const source = this.deriveSource(state);
      
      return {
        success: true,
        answer: state.finalAnswer,
        mode: state.mode,
        source,
        preflight: state.preflight,
        auditResult: state.auditResult,
        audit: { confidence: state.auditResult?.confidence ?? null, reason: state.auditResult?.reason || '' },
        badge,
        didSearch: state.didSearch,
        didSearchRetry: state.didSearch && state.retryCount > 0,
        retryCount: state.retryCount,
        passCount: state.retryCount + 1,
        sourceUrls: state.seedMetricSourceUrls || [],
        dataPackageId: state.dataPackage.id,
        dataPackageSummary: state.dataPackage.toCompressedSummary()
      };
    } catch (err) {
      console.error(`❌ Pipeline error at ${state.step}: ${err.message}`);
      return {
        success: false,
        error: err.message,
        step: state.step,
        source: 'none',
        badge: 'unverified',
        audit: { confidence: null, reason: err.message },
        didSearch: false,
        didSearchRetry: false,
        passCount: 0,
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
    logger.debug(`📊 Preflight: mode=${state.mode}, ticker=${state.preflight.ticker || 'none'}`);
    
    // WRITE to DataPackage: Stage S0 preflight result
    state.writeToPackage(STAGE_IDS.PREFLIGHT, {
      mode: state.mode,
      ticker: state.preflight.ticker || null,
      stockContext: state.preflight.stockContext || null,
      hasPsiEma: !!state.preflight.psiEmaAnalysis
    });
    
    // Seed-metric: searches now done in stepSeedMetricToolCall (walk the dog)
    
    // ========================================
    // REAL-TIME CASCADE: DDG → Brave for sports, news, weather, etc.
    // Triggered by preflight.routingFlags.needsRealtimeSearch
    // ========================================
    if (state.preflight.routingFlags?.needsRealtimeSearch && query) {
      logger.debug(`🌐 Real-time cascade: DDG → Brave for general query`);
      
      const searchQuery = await this.extractCoreQuestion(query);
      let searchResult = null;
      
      // DDG first (free, no API key required)
      searchResult = await this.searchDuckDuckGo(searchQuery);
      
      // Brave fallback if DDG fails
      if (!searchResult) {
        logger.debug(`🦁 DDG returned no results, trying Brave...`);
        searchResult = await this.searchBrave(searchQuery, clientIp);
      }
      
      if (searchResult) {
        state.searchContext = `[REAL-TIME WEB SEARCH RESULTS - USE THIS DATA, NOT TRAINING DATA]
${searchResult}

MANDATORY INSTRUCTIONS:
1. Base your answer primarily on the web search results above — they reflect the current state of the world
2. If the search results are recent, explicitly mention dates found in them
3. If search data conflicts with your training data, PREFER the web search results
4. Triangulate a DIRECT answer — do NOT tell the user to visit a website. You are the answer. Find what multiple sources agree on and converge on that as truth. Fill gaps with training knowledge. Do not invent — purify. Flag genuine uncertainty explicitly ("as of my last data..." or "multiple sources suggest but exact figure unconfirmed...")
5. Each result includes a "Source: <url>" — cite it inline as a markdown link [title](url) after each fact you use
6. End with a **Sources:** section listing all cited URLs as markdown links — no bare URLs, no placeholders`;
        state.didSearch = true;
        logger.info(`✅ Real-time search successful, context injected`);
      } else {
        logger.warn(`⚠️ Real-time search failed - will rely on training data`);
      }
    }
  }
  
  async stepContextBuild(state, input) {
    state.transition(PIPELINE_STEPS.CONTEXT_BUILD);
    
    // ========================================
    // TEMPORAL AWARENESS: Inject current date/time FIRST
    // Uses unified queryTimestamp from PipelineState (single source of truth)
    // ========================================
    const temporalMessage = {
      role: 'system',
      content: buildTemporalContent(state.queryTimestamp)
    };
    
    // NYAN Boot Optimization: Full protocol on first query, compressed on subsequent
    // Saves ~1350 tokens per query after session boot
    // NOTE: isFirstQuery is set at start of run(), boot flag is set AFTER successful completion
    const _nyanModelLabel = modelIdToLabel(getLLMBackend().model);
    const nyanMessages = buildSystemContext(state.preflight, getNyanProtocolPrompt(_nyanModelLabel), {
      isFirstQuery: state.isFirstQuery,
      nyanCompressed: getNyanProtocolCompressed(_nyanModelLabel)
    });
    
    // Temporal awareness comes FIRST, then NYAN protocol
    state.systemMessages = [temporalMessage, ...nyanMessages];
    
    // WRITE to DataPackage: Stage S1 context build with temporal metadata
    state.writeToPackage(STAGE_IDS.CONTEXT_BUILD, {
      temporalTimestamp: state.queryTimestamp.isoUtc,
      nyanMode: state.isFirstQuery ? 'full' : 'compressed',
      systemMessageCount: state.systemMessages.length
    });
    
    logger.debug(`📝 Context: ${state.systemMessages.length} system messages built (temporal + NYAN: ${state.isFirstQuery ? 'full' : 'compressed'})`);
  }
  
  async stepReasoning(state, input) {
    state.transition(PIPELINE_STEPS.REASONING);
    
    const { query, conversationHistory, extractedContent, temperature, maxTokens } = input;
    
    // Sanitize conversation history to prevent Groq 400 errors
    // Strip non-standard properties (audit, etc.) - Groq only accepts role + content
    const sanitizedHistory = (conversationHistory || [])
      .filter(msg => msg && msg.content && msg.content.trim().length > 0)
      .map(msg => ({ role: msg.role, content: msg.content }));
    
    // Empty history warning: Log if all history was filtered out
    if (conversationHistory?.length > 0 && sanitizedHistory.length === 0) {
      console.warn(`⚠️ [stepReasoning] All ${conversationHistory.length} history messages were empty - sanitizedHistory=[]`);
    }
    
    // Build final prompt with proper attachment preservation
    // Priority: Memory → Ψ-EMA → Attachments → Search → Query
    // Memory provides human-like context, Ψ-EMA injects wave analysis, Attachments are primary source
    let finalPrompt = query || 'Analyze content';
    
    // S5 Personality Injection - Integrated with personality layer
    const isCodeReview = state.mode === 'code-audit';
    
    const hasMemory = state.contextResult?.memoryPrompt?.length > 0;
    const hasAttachments = extractedContent && extractedContent.length > 0;
    const hasSearch = !!state.searchContext;
    const isPsiEma = state.mode === 'psi-ema' && state.preflight?.psiEmaAnalysis;
    
    // Add code review guard if in code-audit mode (mode already set by preflight)
    if (isCodeReview && hasAttachments) {
        finalPrompt = `[CODE AUDIT PROTOCOL ACTIVE]\n${finalPrompt}`;
    }
    
    // Prepend φ-compressed memory context if available (human-like recall)
    let memoryPrefix = '';
    if (hasMemory) {
      memoryPrefix = state.contextResult.memoryPrompt + '\n[CURRENT QUERY]\n';
      logger.debug(`📝 Memory injected: ${state.contextResult.memoryPrompt.length} chars`);
    }
    
    // Build Ψ-EMA instruction for user prompt (ensures LLM outputs wave analysis)
    let psiEmaInstruction = '';
    let psiEmaLlmHint = '';  // LLM-path-only deliberation hint (not on bypass path)
    if (isPsiEma) {
      const analysis = state.preflight.psiEmaAnalysis;
      const analysisWeekly = state.preflight.psiEmaAnalysisWeekly;
      const weeklyUnavailableReason = state.preflight.weeklyUnavailableReason;
      const stockData = state.preflight.stockData || {};
      const ticker = state.preflight.ticker;
      
      // Daily timeframe data (vφ⁴: no composite signal - pure phase + z-score)
      const phase = analysis.dimensions?.phase || {};
      const anomaly = analysis.dimensions?.anomaly || {};
      const convergence = analysis.dimensions?.convergence || {};
      const fidelity = analysis.fidelity || {};
      
      // Weekly timeframe data (if available)
      const phaseW = analysisWeekly?.dimensions?.phase || {};
      const anomalyW = analysisWeekly?.dimensions?.anomaly || {};
      const convergenceW = analysisWeekly?.dimensions?.convergence || {};
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
        priceTimestamp = `Last US Market Close (ET): ${weekday}, ${day} ${month}, ${year}`; // "Last US Market Close (ET): Friday, 19 Dec, 2025"
      }
      
      // Financial Microbiology: Clinical pathology report (Dec 23, 2025) - based on daily
      const pathogenResult = detectPathogens(analysis);
      const clinicalReport = generateClinicalReport(analysis, ticker, stockData.currentPrice, priceTimestamp);
      
      // Auto-trigger clinical report when:
      // 1. Explicit pathogen parameter is provided in input, OR
      // 2. Pathogens are automatically detected via detectPathogens()
      // NOTE: Keep state.mode='psi-ema' for downstream routing, use separate flag for clinical report
      const hasExplicitPathogen = input.pathogen || input.pathogens || state.preflight?.pathogen;
      if (hasExplicitPathogen || !pathogenResult.healthy) {
        state.clinicalReportTriggered = true;
        state.useClinicalReport = true; // Flag for output formatting, preserves psi-ema routing
        logger.debug(`🦠 [psi-ema] Clinical report activated for ${ticker} (explicit=${!!hasExplicitPathogen}, detected=${!pathogenResult.healthy})`);
      }
      
      // Physical Audit Disclaimer: "See to believe" infrastructure verification (Dec 23, 2025)
      const physicalAuditDisclaimer = generatePhysicalAuditDisclaimer(analysis, ticker, fundamentals);

      // LLM deliberation hint (only reaches LLM path — never appears in bypass direct output)
      // Provides the form (state/flow/guard schema + pattern examples) and the content source
      // (Yahoo Finance business description). LLM pattern-matches the right units from the
      // actual business — no hardcoded sector template, no sankhara.
      const fSector = fundamentals?.sector || null;
      const fIndustry = fundamentals?.industry || null;
      const fSummary = fundamentals?.summary || null;
      if (fSector || fIndustry || fSummary) {
        const label = [fSector, fIndustry].filter(Boolean).join(' / ');
        const bizLine = fSummary ? `\nBusiness: "${fSummary}"` : '';
        // Hint tells the LLM to add atomic units in the canonical **Atomic Units**: block format,
        // immediately after the company name line — NOT inside the Physical Audit Advisory.
        // Physical Audit keeps its own "see to believe" bullets; units stay in the header.
        psiEmaLlmHint = `\n[HEADER NOTE] After the company name line, output an **Atomic Units**: block using this exact format:
**Atomic Units**:
**Stock**: <state units, comma-separated>
**Flow**: <flow units, comma-separated>
Infer 4 units specific to ${ticker}'s actual business (${label}).${bizLine}
Derive from the business description — not a generic sector template.
Do NOT add these units inside the H₀ Physical Audit Advisory section.`;
      }
      
      // Build assessment one-liner (pragmatic, no medical metaphor)
      const readingText = analysis.reading?.reading || analysis.summary?.reading || 'Unknown';
      const readingEmoji = analysis.reading?.emoji || '⚪';
      const rVal = convergence.currentDisplay ?? convergence.current;
      const zVal = anomaly.current;
      
      // Derive R label from value
      let rLabel = 'N/A';
      if (rVal != null && !isNaN(rVal)) {
        if (rVal < 0) rLabel = 'Reversal';
        else if (rVal < 0.382) rLabel = 'Weak';
        else if (rVal < 0.618) rLabel = 'Moderate';
        else if (rVal < 1.618) rLabel = 'Healthy';
        else if (rVal < 2.618) rLabel = 'Strong';
        else rLabel = 'Extreme';
      }
      
      // Canonical z label — IF(ABS(z)>φ²,"Anomaly","Low Anomaly") — φ²=2.618
      const zLabel = (zVal != null && !isNaN(zVal) && Math.abs(zVal) > 2.618) ? 'Anomaly' : 'Low Anomaly';
      
      // Format values for display
      const fmtR = (rVal != null && !isNaN(rVal)) ? rVal.toFixed(2) : 'N/A';
      const fmtZ = (zVal != null && !isNaN(zVal)) ? zVal.toFixed(2) : 'N/A';
      
      let clinicalSection;
      if (!pathogenResult.healthy) {
        // Pathogen detected - still flag it but less medical
        clinicalSection = `
⚠️ **Risk Alert**: ${clinicalReport.diagnosis.emoji} ${clinicalReport.diagnosis.primary}
📊 R=${fmtR} (${rLabel}), z=${fmtZ}σ (${zLabel})
💡 ${clinicalReport.prognosis}
`;
      } else {
        // Healthy - one-liner assessment
        clinicalSection = `
📊 **Assessment**: ${readingEmoji} ${readingText} — R=${fmtR} (${rLabel}), z=${fmtZ}σ (${zLabel}).
`;
      }
      
      // Build dual-timeframe output (Daily + Weekly) with computation math
      const dailyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelity.grade] || '⚪';
      const weeklyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelityW.grade] || '⚪';
      
      // Helper to format number or N/A
      const fmt = (v, decimals = 2) => (v != null && !isNaN(v)) ? v.toFixed(decimals) : 'N/A';
      // θ display: 2dp; any value that rounds to 0.00 → flag ~0°
      const fmtTheta = (theta) => {
        if (theta == null || isNaN(theta)) return 'N/A';
        if (Math.abs(theta) < 0.005) return '~0°';
        return theta.toFixed(2) + '°';
      };
      
      // Helper to get fidelity percentage (handles undefined, NaN, string 'N/A')
      const getFidelityPct = (f) => {
        if (f?.percent != null && !isNaN(Number(f.percent))) return Number(f.percent);
        if (f?.pctUsable != null && !isNaN(Number(f.pctUsable))) return Math.round(Number(f.pctUsable) * 100);
        return 0;
      };
      
      // Build weekly section (full tree format)
      let weeklySection = '';
      if (analysisWeekly) {
        const rWeekly = convergenceW.currentDisplay ?? convergenceW.current;
        const weeklyFidelityPct = getFidelityPct(fidelityW);
        weeklySection = `
**WEEKLY (7d candles, 13-month window)** [${weeklyGradeEmoji} ${fidelityW.grade || '?'} grade, ${weeklyFidelityPct}% fidelity]
├─ θ (Phase) = **${fmtTheta(phaseW.current)}**
├─ z (Anomaly) = **${fmt(anomalyW.current)}σ**
├─ R (Convergence) = **${fmt(rWeekly)}**
└─ **Reading**: ${analysisWeekly.reading?.emoji || '⚪'} ${analysisWeekly.reading?.reading || 'N/A'}`;
      } else {
        weeklySection = `
**WEEKLY (7d candles, 13-month window)**: ⚠️ ${weeklyUnavailableReason || 'Insufficient data'}`;
      }
      
      // Note: Fundamentals already in preflight context - don't duplicate here
      const dailyFidelityPct = getFidelityPct(fidelity);
      
      psiEmaInstruction = `
**Ψ-EMA** (θ=Cycle Position, z=Price Deviation, R=Momentum Ratio): alignment → conviction; conflict → caution.

**DAILY (1d candles, 3-month window)** [${dailyGradeEmoji} ${fidelity.grade || '?'} grade, ${dailyFidelityPct}% fidelity]
├─ θ (Phase) = **${fmtTheta(phase.current)}**
├─ z (Anomaly) = **${fmt(anomaly.current)}σ**
├─ R (Convergence) = **${fmt(convergence.currentDisplay ?? convergence.current)}**
└─ **Reading**: ${analysis.reading?.emoji || '⚪'} ${analysis.reading?.reading || 'N/A'}
${weeklySection}

${clinicalSection}
${physicalAuditDisclaimer}
`;
      logger.debug(`📊 Ψ-EMA dual-timeframe instruction injected for ${ticker} (daily + ${analysisWeekly ? 'weekly' : 'weekly unavailable'})`);
    }
    
    const MAX_ATTACHMENT_CHARS = MAX_CONTENT_CHARS;
    let processedContent = [];
    if (hasAttachments) {
      // Safely extract ONLY text content from items (filter out metadata, buffers, large objects)
      const getStringContent = (item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        // Skip binary buffers/streams - cannot be meaningfully included in prompt
        if (Buffer.isBuffer(item) || item instanceof ArrayBuffer || item?.type === 'Buffer') {
          return '[Binary data - skipped]';
        }
        // Handle objects: extract ONLY safe text fields, skip everything else
        if (typeof item === 'object') {
          // Skip objects with binary/file data entirely
          if (item.buffer || item.data || item.file || item.stream) {
            return `[Binary file: ${item.filename || item.name || 'unknown'}]`;
          }
          // Extract text content only (priority order)
          if (item.extractedText && typeof item.extractedText === 'string') {
            return item.extractedText.length > 50000 ? item.extractedText.slice(0, 50000) + '\n[... TEXT TRUNCATED ...]' : item.extractedText;
          }
          if (item.content && typeof item.content === 'string') {
            return item.content.length > 50000 ? item.content.slice(0, 50000) + '\n[... TEXT TRUNCATED ...]' : item.content;
          }
          if (item.text && typeof item.text === 'string') {
            return item.text.length > 50000 ? item.text.slice(0, 50000) + '\n[... TEXT TRUNCATED ...]' : item.text;
          }
          // Skip unknown objects entirely - don't stringify metadata blobs
          return `[Attachment: ${item.filename || item.name || item.type || 'unknown format'}]`;
        }
        return String(item);
      };
      
      const totalChars = extractedContent.reduce((sum, c) => sum + getStringContent(c).length, 0);
      if (totalChars > MAX_ATTACHMENT_CHARS) {
        console.warn(`⚠️ [stepReasoning] Attachments too large (${totalChars} chars) - truncating to ${MAX_ATTACHMENT_CHARS}`);
        let accumulated = 0;
        for (const item of extractedContent) {
          const content = getStringContent(item);
          if (accumulated + content.length > MAX_ATTACHMENT_CHARS) {
            const remaining = MAX_ATTACHMENT_CHARS - accumulated;
            if (remaining > 1000) {
              processedContent.push(content.slice(0, remaining) + '\n\n[... TRUNCATED - attachment too large ...]');
            }
            break;
          }
          processedContent.push(content);
          accumulated += content.length;
        }
      } else {
        // Convert all items to strings for consistent downstream handling
        processedContent = extractedContent.map(getStringContent);
      }
    }
    
    if (hasAttachments && hasSearch) {
      // BOTH: Combine attachments + search context (rare: retry during doc analysis)
      logger.debug(`📎 Combining attachments (${processedContent.length}) + search context`);
      finalPrompt = `${memoryPrefix}UPLOADED ATTACHMENTS (PRIMARY SOURCE - analyze these first):
${processedContent.join('\n\n')}

SUPPLEMENTARY WEB SEARCH (use to verify or add context, NOT to override attachments):
${state.searchContext}

User query: ${query || 'Analyze this content.'}`;
    } else if (hasAttachments) {
      // Attachments only (closed-loop document analysis)
      logger.debug(`📎 Attachment-only mode: ${processedContent.length} items`);
      finalPrompt = `${memoryPrefix}Attachments analyzed:\n${processedContent.join('\n\n')}\n\nUser query: ${query || 'Analyze this content.'}`;
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
    
    // For Ψ-EMA queries: Direct structured output (bypass LLM reformatting)
    // The preflight stockContext + psiEmaInstruction IS the response - no LLM reinterpretation needed
    // Set draftAnswer directly but DON'T return - let stepAudit/stepOutput run for signature
    if (psiEmaInstruction && isPsiEma && state.preflight?.stockContext) {
      logger.debug(`📊 Ψ-EMA: Direct structured output (bypassing LLM reformatting)`);
      state.draftAnswer = `${state.preflight.stockContext}\n${psiEmaInstruction}`;
      state.psiEmaDirectOutput = true; // Flag to skip audit but let output stage run
      logger.debug(`🧠 Direct output: ${state.draftAnswer.length} chars (no LLM call)`);
      return; // Exit stepReasoning - run() will continue to stepAudit/stepOutput
    }
    
    // ── SEED METRIC: walk the dog (LLM-driven tool-call search) ─────────────
    // LLM calls brave_search itself with city-specific queries, reads results,
    // triangulates, and outputs the canonical table — no hardcoded parsers.
    if (state.mode === 'seed-metric') {
      await this.stepSeedMetricToolCall(state, input);
      return; // stepAudit / stepOutput continue as normal
    }
    const isSeedMetric = false; // seed-metric exits above; keep flag for downstream
    
    // Append Ψ-EMA instruction to ensure wave analysis is output (fallback if no direct output)
    if (psiEmaInstruction) {
      finalPrompt = `${finalPrompt}\n\n${psiEmaInstruction}`;
      // LLM deliberation: inject atomic units inference hint (LLM path only — not in bypass direct output)
      if (psiEmaLlmHint) finalPrompt += psiEmaLlmHint;
    }
    
    
    const messages = [
      ...state.systemMessages,
      ...sanitizedHistory,
      { role: 'user', content: finalPrompt }
    ];
    
    try {
      const response = await this.groqWithRetry({
        url: this.llmUrl,
        data: {
          model: this.llmModel,
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
          timeout: this.llmTimeouts.reasoning
        }
      }, 3, 'text');
      
      state.draftAnswer = response.data.choices[0]?.message?.content || 'No response generated.';
      logger.debug(`🧠 Reasoning: ${state.draftAnswer.length} chars generated`);
    } catch (err) {
      // Groq API failure after all retries - propagate error, return early to skip audit on junk
      console.error(`❌ [stepReasoning] Groq API failed after 3 retries: ${err.message}`);
      state.error = `Groq API failed: ${err.message}`;
      // Throw to exit pipeline early - caught by run() which returns success:false
      throw new Error(`Groq API exhausted: ${err.message}`);
    }
  }
  
  // ── Walk the dog: LLM-driven seed metric via Groq tool calling ────────────
  // LLM decides what to search (city-aware, language-aware), executes Brave
  // searches itself, reads raw results, triangulates price/sqm from totals,
  // and produces the canonical seed-metric table.  No hardcoded parsers.
  /**
   * stepSeedMetricToolCall — "Walk the Dog" seed metric computation.
   *
   * Architecture: agent swarm (LLM eyes → server math → LLM voice).
   *   Round 1 (SEARCH): LLM emits brave_search tool_calls (up to 8 searches).
   *            LLM decides WHAT to search — city names, years, language.
   *   Per-search EXTRACT: Each Brave result gets its own micro LLM call (~50 token
   *            system prompt, no Nyan Protocol). LLM sees ONE result for ONE city —
   *            zero cross-city contamination. Returns {value, currency} JSON.
   *            Fires async during Brave rate-limit wait (net zero added latency).
   *   Server:  Collects all micro-extractions into parsedData → computes Years,
   *            Regime → builds table. Deterministic math.
   *   Coda:    LLM writes narrative interpretation (the "voice").
   *
   * Rate-limit: 1100ms between Brave calls (just under 1 req/s hard limit).
   *             Retry once on 429 after 1500ms backoff.
   */
  async stepSeedMetricToolCall(state, input) {
    const { query, clientIp } = input;
    const currentYear = new Date().getFullYear();
    const histDecade = state.preflight?.historicalDecade || (String(currentYear - 25).slice(0, 3) + '0s');
    const histYear = state.preflight?.historicalYear || String(currentYear - 25);

    // ── Groq tool definition for Brave Search ─────────────────────────────
    // The LLM calls this tool instead of us pre-fetching; it picks queries itself.
    const braveSearchTool = {
      type: 'function',
      function: {
        name: 'brave_search',
        description: 'Search the web for real-time real estate prices, housing statistics, income data, and wage information. Use specific, targeted queries.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Specific web search query (e.g., "Singapore residential price per sqm 2024" or "Los Angeles average income 2024")'
            }
          },
          required: ['query']
        }
      }
    };

    // ── Gate 1: Data gathering prompt (Round 1 — tool calls only) ──────────
    // Minimal surface area — just tells the LLM what ingredients to fetch.
    // No formula, no table rules, no regime yet. Less context = less guardrail resistance.
    const gatherPrompt = `${NYAN_PROTOCOL_COMPRESSED}

--- SEED METRIC: GATHER RAW INGREDIENTS ---
You have brave_search. Use it. Do NOT compute or output anything yet — just fetch numbers.
${buildGatherPromptBlock({ currentYear: String(currentYear), histYear, histDecade })}

Rules:
  • Search for ALL cities mentioned — skipping any city is not acceptable.
  • Only use values that appear in the search results. Do NOT estimate from training data.
  • If a search returns no usable number for an ingredient, the ingredient is N/A.
  • For every value you extract, note its source URL from the result.
  • Historical data is often missing — N/A is the correct answer, not a guess.`;

    const round1Messages = [
      { role: 'system', content: gatherPrompt },
      { role: 'user', content: query }
    ];

    logger.debug(`🐕 Seed Metric: Walking the dog — LLM-driven Brave tool calls`);

    let round1Response;
    try {
      round1Response = await this.groqWithRetry({
        url: this.llmUrl,
        data: {
          model: this.llmModel,
          messages: round1Messages,
          tools: [braveSearchTool],
          // 'required' forces the LLM to call at least one brave_search tool.
          // 'auto' lets it answer from training data — that's dogma, not live epistemics.
          tool_choice: 'required',
          temperature: 0.1,
          max_tokens: 800
        },
        config: {
          headers: {
            'Authorization': `Bearer ${this.groqToken}`,
            'Content-Type': 'application/json'
          },
          timeout: this.llmTimeouts.toolCall
        }
      }, 3, 'text');
    } catch (err) {
      console.error(`❌ stepSeedMetricToolCall round1 failed: ${err.message}`);
      throw err;
    }

    const round1Msg = round1Response.data.choices[0]?.message;
    const toolCalls  = round1Msg?.tool_calls || [];
    const finishReason = round1Response.data.choices[0]?.finish_reason;

    logger.debug(`🐕 Round 1: finish_reason=${finishReason}, tool_calls=${toolCalls.length}`);

    // LLM answered without needing tools → use directly
    if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
      state.draftAnswer = round1Msg?.content || '';
      state.didSearch = false;
      logger.debug(`🐕 Seed Metric: direct answer (no tool calls), ${state.draftAnswer.length} chars`);
      return;
    }

    // ── Execute tool calls + per-search micro-extraction (agent swarm) ────
    // For each Brave search: fetch result → fire tiny LLM to extract ONE number → slot into parsedData.
    // Each LLM call sees exactly ONE Brave result for ONE city/metric — zero cross-city contamination.
    // Speed: Groq Llama ~200-400ms per micro-extraction, fires during Brave rate-limit wait.
    const callsToRun = toolCalls.slice(0, 12);
    const sourceUrls = [];

    const cities = state.preflight?.seedMetricSearchQueries
      ? [...new Set(state.preflight.seedMetricSearchQueries.map(q => {
          const match = q.match(/^([a-z\s]+)\s+(?:residential|average|median|housing|apartment)/i);
          return match ? match[1].trim().toLowerCase() : null;
        }).filter(Boolean))]
      : [];
    const histDecadeNum = parseInt(histDecade) || (currentYear - 25);

    const parsedData = { cities: {}, parseLog: [] };
    for (const city of cities) {
      parsedData.cities[city] = {
        current: { pricePerSqm: null, income: null },
        historical: { pricePerSqm: null, income: null, decade: histDecade }
      };
    }

    const microExtractPrompt = `You are a number extraction engine. You will receive ONE search result about a specific city.
Extract EXACTLY ONE number from it. Output ONLY valid JSON — no markdown, no backticks, no explanation.

Rules:
- If you find a residential property PURCHASE price per sqm (or can derive it from total price ÷ area, or from price/sqft × 10.764): output {"value": <number>, "type": "pricePerSqm", "currency": "<ISO code>"}
- If you find average/median individual annual income (or monthly × 12): output {"value": <number>, "type": "income", "currency": "<ISO code>"}
- Monthly rent is NOT purchase price — ignore it.
- Household/dual income is NOT single-earner — ignore it.
- GDP per capita is NOT income — ignore it.
- If no usable number found: output {"value": null}
- null is always better than a guess. Every number must come from the search text.`;

    const pendingExtractions = [];

    for (let i = 0; i < callsToRun.length; i++) {
      const tc = callsToRun[i];
      let args;
      try { args = JSON.parse(tc.function.arguments); }
      catch { args = { query: String(tc.function.arguments) }; }

      const searchQuery = args.query || '';
      logger.debug(`🦁 brave_search #${i + 1}: "${searchQuery}"`);

      let result = await this.searchBrave(searchQuery, clientIp, { format: 'json' });

      if (result === null) {
        logger.debug(`🦁 brave_search #${i + 1}: null result, retrying after 1500ms...`);
        await new Promise(r => setTimeout(r, 1500));
        result = await this.searchBrave(searchQuery, clientIp, { format: 'json' });
      }

      let braveText = '';
      try {
        const parsed = JSON.parse(result || '[]');
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.description) braveText += item.description + '\n';
            if (item.title) braveText += item.title + '\n';
            if (item.url && item.title) sourceUrls.push({ title: item.title, url: item.url });
          }
        }
      } catch {
        braveText = String(result || '');
      }

      const queryLower = searchQuery.toLowerCase();
      let matchedCity = null;
      for (const city of cities) {
        const expanded = CITY_EXPAND[city] || city;
        const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedExpanded = expanded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cityWordBoundary = new RegExp(`(?:^|\\s|[^a-z])${escapedCity}(?:$|\\s|[^a-z])`, 'i');
        const expandedWordBoundary = new RegExp(`(?:^|\\s|[^a-z])${escapedExpanded}(?:$|\\s|[^a-z])`, 'i');
        if (expandedWordBoundary.test(queryLower) || (city.length > 2 && cityWordBoundary.test(queryLower))) {
          matchedCity = city;
          break;
        }
      }
      if (!matchedCity) {
        for (const [country, city] of Object.entries(COUNTRY_TO_CITY)) {
          if (cities.includes(city) && new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(queryLower)) {
            matchedCity = city;
            break;
          }
        }
      }
      const isIncome = /income|salary|wage|earnings/i.test(searchQuery);
      const metricType = isIncome ? 'income' : 'pricePerSqm';
      const histYearStart = histDecadeNum;
      const histYearEnd = histDecadeNum + 15;
      const queryYears = [...searchQuery.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => parseInt(m[1]));
      const hasHistoricalYear = queryYears.some(y => y >= histYearStart && y <= histYearEnd);
      const hasAnyOldYear = queryYears.some(y => y < currentYear - 5);
      const isHistorical = hasHistoricalYear || hasAnyOldYear || new RegExp(`${histDecade}|\\d{4}s|historical`, 'i').test(searchQuery);
      const period = isHistorical ? 'historical' : 'current';

      if (matchedCity && braveText.trim()) {
        const extractionPromise = (async () => {
          try {
            const extractResponse = await this.groqWithRetry({
              url: this.llmUrl,
              data: {
                model: this.llmModel,
                messages: [
                  { role: 'system', content: microExtractPrompt },
                  { role: 'user', content: `Search query: "${searchQuery}"\n\nSearch results:\n${braveText.slice(0, 3000)}` }
                ],
                temperature: 0,
                max_tokens: 100
              },
              config: {
                headers: {
                  'Authorization': `Bearer ${this.groqToken}`,
                  'Content-Type': 'application/json'
                },
                timeout: 10000
              }
            }, 1, 'text');

            let rawJson = extractResponse.data.choices[0]?.message?.content?.trim() || '';
            rawJson = cleanMarkdownJson(rawJson);
            const extracted = JSON.parse(rawJson);

            if (extracted.value != null && isFinite(extracted.value) && extracted.value > 0) {
              const currency = extracted.currency || 'USD';
              const resolvedType = (extracted.type === 'pricePerSqm' || extracted.type === 'income')
                ? extracted.type : metricType;
              if (!parsedData.cities[matchedCity]) {
                parsedData.cities[matchedCity] = {
                  current: { pricePerSqm: null, income: null },
                  historical: { pricePerSqm: null, income: null, decade: histDecade }
                };
              }
              const bucket = parsedData.cities[matchedCity][period];
              if (!bucket[resolvedType]) {
                if (resolvedType === 'income') {
                  bucket[resolvedType] = { value: extracted.value, currency, type: 'single' };
                } else {
                  bucket[resolvedType] = { value: extracted.value, currency };
                }
                logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${resolvedType} = ${extracted.value} ${currency}`);
              } else {
                logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${resolvedType} already filled, skipping`);
              }
            } else {
              logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${metricType} = null`);
            }
          } catch (err) {
            console.warn(`⚠️ Extract #${i + 1} failed: ${err.message}`);
          }
        })();

        pendingExtractions.push(extractionPromise);
      } else {
        logger.debug(`👁️ Extract #${i + 1}: no city match or empty result, skipping`);
      }

      if (i < callsToRun.length - 1) {
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    await Promise.all(pendingExtractions);

    const incomeFallbacks = [];
    for (const [city, data] of Object.entries(parsedData.cities)) {
      const country = CITY_TO_COUNTRY[city];
      if (!country) continue;

      for (const period of ['current', 'historical']) {
        if (data[period]?.income) continue;
        const yearToken = period === 'current' ? String(currentYear) : histDecade;
        const fallbackQuery = `${country} average income ${yearToken}`;
        logger.debug(`🔄 Income fallback: ${city}/${period} → "${fallbackQuery}"`);

        incomeFallbacks.push((async () => {
          try {
            await new Promise(r => setTimeout(r, 1100));
            const braveResult = await this.searchBrave(fallbackQuery, input.clientIp || '127.0.0.1');
            if (!braveResult?.trim()) return;

            const extractResponse = await this.groqWithRetry({
              url: this.llmUrl,
              data: {
                model: this.llmModel,
                messages: [
                  { role: 'system', content: microExtractPrompt },
                  { role: 'user', content: `Search query: "${fallbackQuery}"\n\nSearch results:\n${braveResult.slice(0, 3000)}` }
                ],
                temperature: 0,
                max_tokens: 100
              },
              config: {
                headers: {
                  'Authorization': `Bearer ${this.groqToken}`,
                  'Content-Type': 'application/json'
                },
                timeout: 10000
              }
            }, 1, 'text');

            let rawJson = extractResponse.data.choices[0]?.message?.content?.trim() || '';
            rawJson = cleanMarkdownJson(rawJson);
            const extracted = JSON.parse(rawJson);

            if (extracted.value != null && isFinite(extracted.value) && extracted.value > 0) {
              const currency = extracted.currency || 'USD';
              if (!data[period].income) {
                data[period].income = { value: extracted.value, currency, type: 'single' };
                logger.debug(`🔄 Fallback hit: ${city}/${period}/income = ${extracted.value} ${currency} (via ${country})`);
              }
            } else {
              logger.debug(`🔄 Fallback miss: ${city}/${period}/income still null (${country})`);
            }
          } catch (err) {
            console.warn(`⚠️ Income fallback failed for ${city}/${period}: ${err.message}`);
          }
        })());
      }
    }

    if (incomeFallbacks.length > 0) {
      await Promise.all(incomeFallbacks);
    }

    for (const [city, data] of Object.entries(parsedData.cities)) {
      const _cp = data.current?.pricePerSqm?.value, _ci = data.current?.income?.value;
      const _hp = data.historical?.pricePerSqm?.value, _hi = data.historical?.income?.value;
      const _cc = data.current?.pricePerSqm?.currency || data.current?.income?.currency || '?';
      const _hc = data.historical?.pricePerSqm?.currency || data.historical?.income?.currency || '?';
      parsedData.parseLog.push(`${city} CURRENT: price/sqm=${_cp ?? 'N/A'} (${_cc}), income=${_ci ?? 'N/A'}`);
      parsedData.parseLog.push(`${city} HISTORICAL: price/sqm=${_hp ?? 'N/A'} (${_hc}), income=${_hi ?? 'N/A'}`);
    }

    for (const line of parsedData.parseLog) {
      logger.debug(`📊 ${line}`);
    }

    // ── TFR: fetch and inject before building table ──────────────────────────
    let tfrCapsule = null;
    if (cities.length > 0) {
      try {
        const tfrCities = cities.map(c => c.charAt(0).toUpperCase() + c.slice(1));
        tfrCapsule = await this._fetchTFRData(tfrCities, histDecade, input.clientIp || '127.0.0.1', CITY_TO_COUNTRY);
        state.tfrCapsule = tfrCapsule;
        logger.debug(`🐣 TFR fetched for ${tfrCities.length} cities`);
      } catch (err) {
        console.warn(`⚠️ TFR fetch failed: ${err.message}`);
      }
    }

    // ── Server-side math: buildSeedMetricTable (deterministic) ───────────────
    const serverTable = buildSeedMetricTable(parsedData, histDecade, tfrCapsule);

    const seenUrls = new Set();
    const sourcesLines = [];
    for (const src of sourceUrls) {
      if (seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      sourcesLines.push(`- [${src.title}](${src.url})`);
    }
    const sourcesBlock = sourcesLines.length > 0
      ? `\n**Sources:**\n${sourcesLines.slice(0, 5).join('\n')}`
      : '';

    const fullOutput = `${serverTable}${sourcesBlock}`;

    state.didSearch = true;
    state.seedMetricDirectOutput = true;
    state.seedMetricSourceUrls = sourceUrls;
    logger.debug(`🐕 Seed Metric: ${callsToRun.length} Brave calls → LLM extract → server table (${fullOutput.length} chars)`);

    // ── Coda: LLM voice layer ────────────────────────────────────────────────
    let coda = '';
    try {
      const codaSystemPrompt = `${getNyanProtocolPrompt(modelIdToLabel(getLLMBackend().model))}

You are given a Seed Metric table (income = average single earner; price = built residential where available, land as fallback).
Write a coda: 2–3 sentences about what these specific numbers reveal about the people living in these specific cities.

Rules:
- Do NOT repeat numbers — the table already shows them.
- Say what the numbers imply but don't state: the human texture, historical irony, political contradiction, the lived reality of that ratio.
- The income anchor is average single earner — the 20th-century contract: one job, one home. A taxi driver. A teacher. Not two salaries, not inherited wealth.
- If price source was "land" (fallback), you may note that the land alone, before any building, already indicts.
- This must be unrepeatable — written only for these cities, this gap, this moment. Not a generic housing statement.
- No preamble, no "In conclusion", no sign-off. Just the coda.`;

      const codaResponse = await this.groqWithRetry({
        url: this.llmUrl,
        data: {
          model: this.llmModel,
          messages: [
            { role: 'system', content: codaSystemPrompt },
            { role: 'user', content: fullOutput }
          ],
          temperature: 0.7,
          max_tokens: 300
        },
        config: {
          headers: {
            'Authorization': `Bearer ${this.groqToken}`,
            'Content-Type': 'application/json'
          },
          timeout: this.llmTimeouts.toolCall
        }
      }, 2, 'text');

      coda = codaResponse.data.choices[0]?.message?.content?.trim() || '';
      logger.debug(`🐱 Seed Metric coda: ${coda.length} chars`);
    } catch (err) {
      console.warn(`⚠️ Seed Metric coda failed: ${err.message} — skipping coda`);
    }

    state.seedMetricCoda = coda;
    state.draftAnswer = this._insertSeedMetricCoda(fullOutput, coda);
  }

  async _fetchTFRData(cities, historicalDecade, clientIp, cityToCountry = {}) {
    const tfrCapsule = {};
    const currentYear = String(new Date().getFullYear() - 1);
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      const cityKey = city.toLowerCase();
      tfrCapsule[cityKey] = { current: null, historical: null };

      try {
        const currentQuery = `"${city}" total fertility rate ${currentYear}`;
        logger.debug(`🐣 TFR search: "${currentQuery}"`);
        const currentResult = await this.searchBrave(currentQuery, clientIp);
        tfrCapsule[cityKey].current = parseTFR(currentResult, city, currentYear);

        if (!tfrCapsule[cityKey].current && cityToCountry[cityKey]) {
          const country = cityToCountry[cityKey];
          await new Promise(r => setTimeout(r, 1100));
          const countryQuery = `${country} total fertility rate ${currentYear}`;
          logger.debug(`🐣 TFR country fallback: "${countryQuery}"`);
          const countryResult = await this.searchBrave(countryQuery, clientIp);
          tfrCapsule[cityKey].current = parseTFR(countryResult, country, currentYear);
          if (tfrCapsule[cityKey].current) {
            logger.debug(`🐣 TFR fallback hit: ${city} current = ${tfrCapsule[cityKey].current} (via ${country})`);
          }
        }

        await new Promise(r => setTimeout(r, 1100));

        const histQuery = `"${city}" total fertility rate ${historicalDecade}`;
        logger.debug(`🐣 TFR search: "${histQuery}"`);
        const histResult = await this.searchBrave(histQuery, clientIp);
        const histTargetYear = historicalDecade.replace(/s$/, '');
        tfrCapsule[cityKey].historical = parseTFR(histResult, city, histTargetYear);

        if (!tfrCapsule[cityKey].historical && cityToCountry[cityKey]) {
          const country = cityToCountry[cityKey];
          await new Promise(r => setTimeout(r, 1100));
          const countryHistQuery = `${country} total fertility rate ${historicalDecade}`;
          logger.debug(`🐣 TFR country fallback: "${countryHistQuery}"`);
          const countryHistResult = await this.searchBrave(countryHistQuery, clientIp);
          tfrCapsule[cityKey].historical = parseTFR(countryHistResult, country, histTargetYear);
          if (tfrCapsule[cityKey].historical) {
            logger.debug(`🐣 TFR fallback hit: ${city} historical = ${tfrCapsule[cityKey].historical} (via ${country})`);
          }
        }

        if (i < cities.length - 1) await new Promise(r => setTimeout(r, 1100));
      } catch (err) {
        console.warn(`⚠️ TFR fetch failed for ${city}: ${err.message}`);
      }
      logger.debug(`🐣 TFR ${city}: current=${tfrCapsule[cityKey].current}, historical=${tfrCapsule[cityKey].historical}`);
    }
    return tfrCapsule;
  }

  _extractCitiesFromTable(tableText) {
    const cities = [];
    const lines = tableText.split('\n');
    for (const line of lines) {
      if (!/^\|/.test(line.trim())) continue;
      const cols = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (cols.length < 7) continue;
      if (EMPTY_TABLE_ROW_REGEX.test(cols[0])) continue;
      if (/City/i.test(cols[0])) continue;
      const city = cols[0].replace(/\*\*/g, '').trim();
      if (city && !cities.includes(city.toLowerCase())) {
        cities.push(city.toLowerCase());
      }
    }
    return [...new Set(cities)];
  }

  _reattachSeedMetricSources(body, sourceUrls) {
    if (!sourceUrls || sourceUrls.length === 0) return body;
    if (/\*\*Sources:\*\*/i.test(body)) return body;
    const seenUrls = new Set();
    const lines = [];
    for (const src of sourceUrls) {
      if (seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      lines.push(`- [${src.title}](${src.url})`);
    }
    if (lines.length === 0) return body;
    return body.trimEnd() + `\n**Sources:**\n${lines.slice(0, 5).join('\n')}`;
  }

  _insertSeedMetricCoda(body, coda) {
    if (!coda) return body;
    const sourcesHeaderIdx = body.search(/\n\*\*Sources:\*\*/m);
    if (sourcesHeaderIdx !== -1) {
      return body.slice(0, sourcesHeaderIdx).trimEnd()
        + '\n\n' + coda
        + '\n\n' + body.slice(sourcesHeaderIdx).trimStart();
    }
    const sourcesIdx = body.search(/\n[-*] \[|^[-*] \[/m);
    if (sourcesIdx !== -1) {
      return body.slice(0, sourcesIdx).trimEnd()
        + '\n\n' + coda
        + '\n\n**Sources:**\n' + body.slice(sourcesIdx).trimStart();
    }
    return body + '\n\n' + coda;
  }

  // Helper: extract <!--SEED_META:{...}--> block from LLM output.
  // Returns { meta, text } — meta is the parsed JSON (or null), text has the block stripped.
  _extractSeedMetricMeta(text) {
    const metaMatch = text.match(/<!--SEED_META:(\{[\s\S]*?\})-->/);
    let meta = null;
    if (metaMatch) {
      try { meta = JSON.parse(metaMatch[1]); } catch (_) { /* malformed — ignore */ }
    }
    const stripped = text.replace(/\s*<!--SEED_META:[\s\S]*?-->\s*/g, '\n').trim();
    return { meta, text: stripped };
  }

  // Helper: deterministic regime recompute — LLM often mislabels 10–25yr as FATALISM.
  // Parses every markdown table row, extracts Years integer, overwrites Regime cell.
  _normalizeSeedMetricRegimes(text) {
    const regime = (yr) => {
      if (isNaN(yr)) return null;
      if (yr < 10)  return '🟢 OPTIMISM';
      if (yr <= 25) return '🟡 EXTRACTION';
      return '🔴 FATALISM';
    };
    // Match data rows: 7 or 8 pipe-delimited cells (8 when TFR column present)
    return text.replace(/^\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|(?:([^|\n]+)\|)?$/gm,
      (row, c1, c2, c3, c4, c5, c6, c7, c8) => {
        if (EMPTY_TABLE_ROW_REGEX.test(c1)) return row;
        if (/^\s*years\s*$/i.test(c6)) return row;
        const yearsVal = parseInt(c6.replace(/[^0-9]/g, ''), 10);
        const correctRegime = regime(yearsVal);
        if (!correctRegime) return row;
        const tfrSuffix = c8 !== undefined ? `${c8}|` : '';
        return `|${c1}|${c2}|${c3}|${c4}|${c5}|${c6}| ${correctRegime} |${tfrSuffix}`;
      }
    );
  }

  async stepAudit(state, input) {
    state.transition(PIPELINE_STEPS.AUDIT);
    
    const { query, extractedContent } = input;
    
    // Ψ-EMA direct output: bypass audit (data already pre-verified from yfinance + SEC EDGAR)
    if (state.psiEmaDirectOutput) {
      logger.debug(`📊 Ψ-EMA direct output - bypassing audit (pre-verified data)`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Pre-verified yfinance + SEC EDGAR data' };
      return;
    }
    
    // Seed Metric direct output: bypass audit (data calculated with deterministic proxy rules)
    if (state.seedMetricDirectOutput) {
      logger.debug(`🏠 Seed Metric direct output - bypassing audit (proxy math applied)`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Deterministic $/sqm × 700 proxy calculation' };
      return;
    }
    
    // Seed Metric LLM output: validate format before audit
    // If format is wrong (prose instead of table), try to fix it
    if (state.mode === 'seed-metric' && state.draftAnswer) {
      const smHistDecade = state.preflight?.historicalDecade || (String(new Date().getFullYear() - 25).slice(0, 3) + '0s');
      const validation = validateSeedMetricOutput(state.draftAnswer, smHistDecade);
      if (!validation.valid) {
        logger.warn(`⚠️ Seed Metric format validation FAILED: ${validation.issues.join(', ')}`);

        // Try to fix with a format-only prompt
        if (!state.seedMetricFormatRetried) {
          state.seedMetricFormatRetried = true;
          logger.debug(`🔧 Attempting Seed Metric format fix...`);

          try {
            const histYear = state.preflight?.historicalYear || String(new Date().getFullYear() - 25);
            const currYear = state.preflight?.currentYear || String(new Date().getFullYear() - 1);

            const fixPrompt = `The following response has incorrect format. Fix it to use the EXACT table format shown below.

WRONG RESPONSE:
${state.draftAnswer.slice(0, 2000)}

REQUIRED FORMAT — ONE unified markdown table (NOT separate tables per city):
| City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime |
|------|--------|---------|-------------------|--------------|-------|--------|
| [CityA] | ${histYear} | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [label] |
| [CityA] | ${currYear} | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [label] |
| [CityB] | ${histYear} | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [label] |
| [CityB] | ${currYear} | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [label] |

**[CityA]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)
**[CityB]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)

CRITICAL RULES:
- ONE table with City column — NOT separate tables per city
- MUST have rows for BOTH historical (${histYear}) AND current (${currYear}) — 4 rows minimum for 2 cities
- Regime column MUST have emoji + label: 🟢 Optimism (<10yr) | 🟡 Extraction (10-25yr) | 🔴 Fatalism (>25yr)
- REGIME MUST MATCH YEARS: e.g., 13.1yr = 🟡 Extraction (NOT Optimism!)
- 700sqm Land Price = LCU/sqm × 700 | Years = 700sqm Land Price ÷ Income (same LCU)
- After table: summary line per city with directional change
- NO P/I column, NO prose paragraphs, use ⚪ N/A in table cells if historical data truly unavailable

Output ONLY the corrected table and summary lines:`;

            const response = await this.groqWithRetry({
              url: this.llmUrl,
              data: {
                model: this.llmModel,
                messages: [{ role: 'user', content: fixPrompt }],
                temperature: 0.1,
                max_tokens: 800
              },
              config: {
                headers: {
                  'Authorization': `Bearer ${this.groqToken}`,
                  'Content-Type': 'application/json'
                },
                timeout: this.llmTimeouts.audit
              }
            }, 2, 'text');
            
            const fixedAnswerRaw = response.data.choices[0]?.message?.content;
            const fixedAnswer = fixedAnswerRaw
              ? fixedAnswerRaw
                  .replace(/\|\s*\$\/sqm\s*\|/g, '| LCU/sqm |')
                  .replace(/\|\s*700sqm Price\s*\|/g, '| 700sqm Land Price |')
                  .replace(/\|\s*700sqm \(LCU\)\s*\|/g, '| 700sqm Land Price |')
                  .replace(/\|\s*Land Price\s*\|/g, '| 700sqm Land Price |')
                  .replace(/\|\s*Income\s*\|/gi, '| Income (LCU) |')
              : fixedAnswerRaw;
            if (fixedAnswer) {
              const reValidation = validateSeedMetricOutput(fixedAnswer, smHistDecade);
              if (reValidation.valid) {
                logger.info(`✅ Seed Metric format fix successful`);
                let fixedNormalized = this._normalizeSeedMetricRegimes(fixedAnswer);
                if (state.tfrCapsule) {
                  fixedNormalized = injectTFRColumn(fixedNormalized, state.tfrCapsule);
                }
                const fixedWithSources = this._reattachSeedMetricSources(fixedNormalized, state.seedMetricSourceUrls);
                state.draftAnswer = this._insertSeedMetricCoda(fixedWithSources, state.seedMetricCoda || '');
              } else {
                logger.warn(`❌ Seed Metric format fix still invalid: ${reValidation.issues.join(', ')} — keeping original`);
              }
            }
          } catch (err) {
            logger.warn(`⚠️ Seed Metric format fix failed: ${err.message}`);
          }
        }
      } else {
        logger.info(`✅ Seed Metric format validation passed`);
      }
    }
    
    // Log attachment preservation for debugging
    const attachmentCount = extractedContent?.length || 0;
    if (attachmentCount > 0) {
      logger.debug(`📎 Audit: ${attachmentCount} attachment(s) preserved for STRICT verification`);
    }
    
    if (this.isIdentityQuery(query)) {
      logger.debug(`🐱 Identity query - bypassing audit`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Identity question' };
      return;
    }
    
    const hasNoDocuments = attachmentCount === 0;
    const isSeedMetricMode = state.mode === 'seed-metric'; // Use mode, not ~nyan signature
    const isTetralemma = isFalseDichotomy(query);
    const auditMode = hasNoDocuments ? 'RESEARCH' : 'STRICT';
    
    // Build DIALECTICAL context structure for audit pass
    // (I) Thesis = Known facts & sources (built here where all data is available)
    // (II) Antithesis = User query  
    // (III) Synthesis = Draft answer
    const thesisParts = [];
    
    // Extracted content from documents (passed via input)
    if (extractedContent?.length > 0) {
      const contentPreview = extractedContent.slice(0, 3).map(c => 
        typeof c === 'string' ? c.slice(0, 1500) : JSON.stringify(c).slice(0, 500)
      ).join('\n---\n');
      thesisParts.push(`📎 UPLOADED DOCUMENTS:\n${contentPreview.slice(0, 5000)}`);
    }
    
    // Web search results (populated by preflight or retry)
    if (state.searchContext && state.didSearch) {
      thesisParts.push(`🔍 WEB SEARCH RESULTS:\n${state.searchContext.slice(0, 3000)}`);
    }
    
    // Conversation memory context
    if (state.contextResult?.hasMemory) {
      const memoryPreview = (input.conversationHistory || [])
        .slice(-3)
        .filter(m => m?.content)
        .map(m => `${m.role}: ${String(m.content).slice(0, 200)}...`)
        .join('\n');
      if (memoryPreview) {
        thesisParts.push(`💭 CONVERSATION MEMORY:\n${memoryPreview}`);
      }
    }
    
    // Ψ-EMA pre-verified data
    if (state.preflight?.psiEmaAnalysis) {
      thesisParts.push(`📊 Ψ-EMA DATA: Pre-verified yfinance stock data injected`);
    }
    
    // Stock context from preflight
    if (state.preflight?.stockContext) {
      thesisParts.push(`📈 STOCK CONTEXT: Real-time market data available`);
    }
    
    // Build dialectical structure for audit
    const dialecticalContext = {
      thesis: thesisParts.length > 0 ? thesisParts.join('\n\n') : 'No external sources used (LLM knowledge only)',
      antithesis: query,
      synthesis: state.draftAnswer
    };
    
    // Notify the stream about who is auditing (humane disclosure while client waits)
    if (input.onStageChange) {
      input.onStageChange({ type: 'thinking', stage: `Auditing with Llama...` });
    }

    try {
      state.auditResult = await runAuditPass(
        this.auditToken,
        state.draftAnswer,
        query,
        dialecticalContext,
        {
          usesFinancialPhysics: state.preflight.routingFlags?.usesFinancialPhysics,
          usesChemistry: false,
          usesLegalAnalysis: state.preflight.routingFlags?.usesLegalAnalysis,
          usesPsiEMA: state.mode === 'psi-ema',
          isSeedMetric: isSeedMetricMode,
          isTetralemma,
          auditMode,
          useDialectical: true,
          // Unified timestamp from pipeline state (single source of truth)
          timestamps: state.queryTimestamp
        },
        this.llmTimeouts.audit
      );
      const _auditLabel = 'Llama';
      const _confStr = state.auditResult.confidence !== null && state.auditResult.confidence !== undefined
        ? `${state.auditResult.confidence}%` : 'unverified';
      logger.debug(`🔍 Audit [${_auditLabel}]: ${state.auditResult.verdict} (${_confStr})`);
      
      // WRITE to DataPackage: Stage S3 audit MARKERS only (read-only mode)
      // Audit cannot write corrections - only marks issues for retry stage to fix
      state.writeToPackage(STAGE_IDS.AUDIT, {
        verdict: state.auditResult.verdict,
        confidence: state.auditResult.confidence,
        passed: state.auditResult.verdict === 'ACCEPTED' || state.auditResult.verdict === 'BYPASS',
        auditMode,
        markers: state.auditResult.issues || [],
        correctionNeeded: state.auditResult.verdict === 'REJECTED'
      });
    } catch (err) {
      logger.warn(`⚠️ Audit error: ${err.message}`);
      state.auditResult = { verdict: 'BYPASS', confidence: null, reason: 'Audit failed — second pass never ran' };
    }
  }
  
  async stepRetry(state, input) {
    state.transition(PIPELINE_STEPS.RETRY);
    state.retryCount++;
    
    const { query, clientIp, conversationHistory } = input;
    
    // Ensure query is valid before processing
    const safeQuery = query || input.query || input.message || 'general query';
    
    // Sanitize conversation history to prevent Groq 400 errors
    const rawHistory = conversationHistory || input.history || [];
    const sanitizedHistory = rawHistory
      .filter(msg => msg && msg.content && msg.content.trim().length > 0);
    
    // Empty history warning: Log if all history was filtered out
    if (rawHistory.length > 0 && sanitizedHistory.length === 0) {
      console.warn(`⚠️ [stepRetry] All ${rawHistory.length} history messages were empty - sanitizedHistory=[]`);
    }
    
    // SKIP SEARCH RETRY for identity modes - internal documentation is the ground truth
    const isIdentityMode = state.mode && state.mode.includes('identity');
    if (isIdentityMode) {
      logger.debug(`⏭️ Identity mode: Skip retry (internal docs are ground truth)`);
      return;
    }
    
    if (state.mode === 'psi-ema') {
      logger.debug(`⏭️ Ψ-EMA: Skip retry (yfinance data pre-verified)`);
      return;
    }
    
    // Prepare reasoning input with sanitized history
    const reasoningInput = { 
      ...input, 
      conversationHistory: sanitizedHistory,
      query: safeQuery,
      clientIp: clientIp || input.clientIp || '127.0.0.1',
      extractedContent: input.extractedContent || []
    };
    
    // Check for image attachments via multiple sources for robustness
    let hasImage = state.hasImageAttachment;
    if (!hasImage) {
      // Fallback 1: check DataPackage S-1 data for persisted flag
      const s1Data = state.readFromPackage(STAGE_IDS.CONTEXT_EXTRACT);
      hasImage = s1Data?.hasImageAttachment || false;
    }
    if (!hasImage) {
      // Fallback 2: check extractedContent for image markers
      const extractedContent = input.extractedContent || [];
      hasImage = extractedContent.some(f => 
        f?.fileType === 'image' || 
        f?.type === 'image-vision' ||
        (typeof f === 'string' && /visual content analysis|image|chemical structure/i.test(f))
      );
    }
    
    if (hasImage) {
      // Image attachments: skip web search, re-run reasoning with vision context only
      logger.debug(`🖼️ Retry ${state.retryCount}: Image attachment - re-reasoning with vision context (no web search)`);
      await this.stepReasoning(state, reasoningInput);
      await this.stepAudit(state, reasoningInput);
      return;
    }
    
    logger.debug(`🔄 Retry ${state.retryCount}: Searching for better data...`);
    
    const searchQuery = await this.extractCoreQuestion(safeQuery);
    state.searchContext = await this.searchBrave(searchQuery, clientIp);
    if (!state.searchContext) {
      state.searchContext = await this.searchDuckDuckGo(searchQuery);
    }
    
    if (state.searchContext) {
      state.didSearch = true;
      await this.stepReasoning(state, reasoningInput);
      await this.stepAudit(state, reasoningInput);
    }
  }
  
  async stepOutput(state) {
    // Stage 5: Personality (Regex-based formatting)
    state.transition(PIPELINE_STEPS.PERSONALITY);
    const isCodeAudit = state.mode === 'code-audit';
    
    // Applying personality layer before S6 Output
    const draft = state.auditResult?.fixedAnswer || state.draftAnswer;
    
    // Ensure Verdict is preserved by passing mode and unified timestamp to formatter
    state.finalAnswer = this.applyPersonalityFormat(draft, state.mode, state.queryTimestamp.signatureFormat);
    
    if (isCodeAudit && !state.finalAnswer.includes('Verdict')) {
        console.warn('⚠️ Personality: Verdict alignment check');
    }

    // SOURCE ATTRIBUTION — delegated to source-ascriber (single canonical point)
    if (!state.fastPath) {
      state.finalAnswer = injectSourceLine(state.finalAnswer, {
        psiEmaDirectOutput:  state.psiEmaDirectOutput,
        seedMetricDirectOutput: state.seedMetricDirectOutput,
        mode:    state.mode,
        didSearch: state.didSearch
      });
    }
    
    // WRITE to DataPackage: Stage S5 personality result
    state.writeToPackage(STAGE_IDS.PERSONALITY, {
      outputLength: state.finalAnswer.length,
      isCodeAudit,
      mode: state.mode
    });

    // Stage 6: Output finalization
    state.transition(PIPELINE_STEPS.OUTPUT);
    
    // Prepend chemistry compound header if available (source/confidence visible to user)
    if (state.chemistryHeader) {
      state.finalAnswer = state.chemistryHeader + '\n\n---\n\n' + state.finalAnswer;
      logger.debug(`📋 S6: Chemistry header prepended to output`);
    }
    
    // WRITE to DataPackage: Stage S6 output (personality-formatted)
    state.writeToPackage(STAGE_IDS.OUTPUT, {
      mode: state.mode,
      outputLength: state.finalAnswer.length,
      didSearch: state.didSearch,
      retryCount: state.retryCount,
      verdictPreserved: isCodeAudit
    });
    
    // FINALIZE: Store in tenant's φ-8 window
    state.dataPackage.finalize();
    globalPackageStore.storePackage(state.dataPackage.tenantId, state.dataPackage);
    
    logger.info(`✅ Output: ${state.finalAnswer.length} chars, mode=${state.mode}`);
  }
  
  /**
   * PERSONALITY LAYER (S5) - Unified format enforcement
   * All formatting happens HERE, not scattered across prompts/contexts
   * Uses MODE REGISTRY for per-mode formatting rules
   * @param {string} answer - Draft answer to format
   * @param {string} mode - Query mode (general, psi-ema, etc.)
   * @param {string} signatureTs - Pre-formatted timestamp from unified queryTimestamp
   */
  applyPersonalityFormat(answer, mode, signatureTs) {
    return applyPersonalityFormat(answer, mode, signatureTs);
  }

  deriveSource(state) {
    if (state.psiEmaDirectOutput) return 'atomic:psi-ema';
    if (state.seedMetricDirectOutput) return 'atomic:seed-metric';
    if (state.mode === 'forex') return 'atomic:forex';
    if (state.fastPath) return 'shortcut';
    return 'llm';
  }

  deriveBadge(auditResult) {
    if (!auditResult || !auditResult.verdict) return 'unverified';
    
    const verdict = auditResult.verdict.toUpperCase();
    
    // API_FAILURE → unavailable (Groq API failed, fallback message shown)
    if (verdict === 'API_FAILURE') {
      return 'unavailable';
    }
    
    // APPROVED, ACCEPTED → verified (second pass ran and passed)
    if (verdict === 'APPROVED' || verdict === 'ACCEPTED') {
      return 'verified';
    }

    // BYPASS → two kinds:
    //   intentional (pre-verified data: confidence > 0) → verified
    //   failure (timed out / error: confidence === null) → bypass (grey, ungrounded)
    if (verdict === 'BYPASS') {
      return (auditResult.confidence !== null && auditResult.confidence !== undefined)
        ? 'verified'
        : 'bypass';
    }
    
    // FIXABLE → corrected (issues were auto-fixed)
    if (verdict === 'FIXABLE') {
      return 'corrected';
    }
    
    // REJECTED → unverified (couldn't verify)
    return 'unverified';
  }
}

function createPipelineOrchestrator(config) {
  return new PipelineOrchestrator(config);
}

/**
 * STANDALONE PERSONALITY FORMAT (exported for use outside pipeline)
 * Regex-based cleanup: O(n) string operations, NOT an LLM call
 * Use this instead of runStreamingPersonalityPass() to save 1 LLM call
 * @param {string} answer - Answer to format
 * @param {string} mode - Query mode
 * @param {string} signatureTs - Optional pre-formatted timestamp (generates if not provided)
 */
function applyPersonalityFormat(answer, mode = 'general', signatureTs = null) {
  if (!answer) return answer;
  
  const { getPersonalityConfig, hasAnySignature } = require('../lib/mode-registry');
  const { formatSignatureTimestamp } = require('./time-format');
  const config = getPersonalityConfig(mode);
  
  // Use provided timestamp or generate one (for backwards compatibility)
  const ts = signatureTs || formatSignatureTimestamp(new Date());
  
  let cleaned = answer;
  
  // Registry-driven: skip intro/outro stripping for modes that need it
  if (config.skipIntroOutro) {
    if (config.appendSignature && !hasAnySignature(cleaned)) {
      cleaned = cleaned.trimEnd() + '\n\n' + config.signatureText + `\n[${ts}]`;
    }
    return cleaned.trim();
  }
  
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
  
  const outroFluffPatterns = [
    /###?\s*Confidence Grading\s*\n+(?:[\s\S]*?(?:\*\s*\*\*95%\*\*|\*\s*\*\*80%\*\*|\*\s*\*\*<50%\*\*)[\s\S]*?)+(?=\n*(?:🔥|$))/i,
    /The confidence (?:grading|levels?) (?:for this analysis )?(?:is|are) as follows:\s*\n+(?:\*[^\n]+\n+)+/i,
    /The current analysis has a confidence grade of[^\n]*\n+/i,
  ];
  
  for (const pattern of outroFluffPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Use provided or generated timestamp
  const signatureWithTs = `${config.signatureText}\n[${ts}]`;
  
  // Use regex to detect any existing nyan signature and replace it with the timestamped version
  // Catches 🔥 (canonical) and 🐱 (LLM hallucinated cat emoji variant)
  const anyNyanSigPattern = /(?:🔥|🐱)\s*(?:~nyan|nyan~)(?:\s*\[.*?\])?/i;
  
  if (anyNyanSigPattern.test(cleaned)) {
    cleaned = cleaned.replace(anyNyanSigPattern, signatureWithTs);
  } else {
    cleaned = cleaned.trimEnd() + '\n\n' + signatureWithTs;
  }
  
  return cleaned.trim();
}

/**
 * FAST STREAMING PERSONALITY (replaces runStreamingPersonalityPass)
 * Uses regex cleanup + chunked SSE output instead of LLM streaming
 * Saves 1 LLM call (~800 tokens) per request
 * 
 * @param {object} res - Express response object (SSE-enabled)
 * @param {string} answer - Answer to format and stream
 * @param {object} auditMetadata - Audit metadata to send before streaming
 * @param {number} chunkSize - Characters per chunk (default: 50 for natural feel)
 * @param {number} chunkDelay - Milliseconds between chunks (default: 10ms)
 */
async function fastStreamPersonality(res, answer, auditMetadata, chunkSize = 50, chunkDelay = 10) {
  const formatted = applyPersonalityFormat(answer);
  
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: 'thinking', stage: 'Formatting...' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'audit', audit: auditMetadata })}\n\n`);
  }
  
  for (let i = 0; i < formatted.length; i += chunkSize) {
    if (res.writableEnded) break;
    const chunk = formatted.slice(i, i + chunkSize);
    res.write(`data: ${JSON.stringify({ type: 'token', content: chunk })}\n\n`);
    if (chunkDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, chunkDelay));
    }
  }
  
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: 'done', fullContent: formatted })}\n\n`);
    res.end();
  }
  
  logger.debug(`⚡ Fast personality: ${formatted.length} chars (regex, no LLM)`);
  return formatted;
}

module.exports = {
  PipelineOrchestrator,
  PipelineState,
  PIPELINE_STEPS,
  createPipelineOrchestrator,
  applyPersonalityFormat,
  fastStreamPersonality
};
