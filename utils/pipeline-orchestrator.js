/**
 * Pipeline Orchestrator - Unified AI Request Processing
 * 
 * 8-STAGE STATE MACHINE (S-1 to S6):
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ S-1:  Context Extraction │ φ-8 message window, entity extraction        │
 * │ S-1.5 Query Digest       │ intent C|R, subject, context, lens, sessions │
 * │ S0:   Preflight          │ Mode detection, routing, data fetch           │
 * │ S1:   Context Build      │ Inject system prompts based on mode           │
 * │ S2:   Reasoning          │ LLM call (O(tokens), ~1500 tokens)            │
 * │ S3:   Audit              │ LLM call (O(tokens), ~800 tokens)             │
 * │ S4:   Retry              │ Search augmentation if audit rejected         │
 * │ S5:   Personality        │ Regex cleanup (O(n), NOT an LLM call)        │
 * │ S6:   Output             │ Finalize DataPackage, store in φ-8            │
 * └──────────────────────────────────────────────────────────────────────────┘
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
const { preflightRouter, buildSystemContext, classifyTemporalVolatility } = require('./preflight-router');
const { extractContext, extractContextWithMemory, mergeContextForTickerDetection, isSessionFirstQuery, markSessionNyanBooted } = require('./context-extractor');
const { NYAN_PROTOCOL_SYSTEM_PROMPT, NYAN_PROTOCOL_COMPRESSED, getNyanProtocolPrompt, getNyanProtocolCompressed } = require('../prompts/nyan-protocol');
const { modelIdToLabel } = require('../prompts/pharma-analysis');
const { injectSourceLine } = require('./source-ascriber');
const { runAuditPass } = require('./two-pass-verification');
const { isFalseDichotomy } = require('../prompts/audit-protocol');
const { detectPathogens, generateClinicalReport, generatePhysicalAuditDisclaimer } = require('./psi-EMA');
const { DataPackage, globalPackageStore, STAGE_IDS } = require('./data-package');
const { globalCheckpointStore, buildResumableSnapshot, applySnapshot } = require('./pipeline-checkpoint');
const { getLLMBackend, getAuditBackend, AI_MODELS } = require('../config/constants');
const { digestQuery } = require('./query-digest');
const { CITY_EXPAND, COUNTRY_TO_CITY, CITY_TO_COUNTRY, FRED_MSA_CODES, COUNTRY_ISO2, KNOWN_CITIES_REGEX, ISO2_TO_CURRENCY } = require('./geo-data');
const { fetchFredPerSqm, fetchFredPerSqmForYear } = require('../lib/tools/fred-series');
const { fetchWorldBankGni, fetchWorldBankGniLcu } = require('../lib/tools/world-bank');
const { MAX_CONTENT_CHARS } = require('./config-constants');
const { getAnchors: getUrlAnchors } = require('./url-anchor-store');

const PIPELINE_STEPS = {
  CONTEXT_EXTRACT: 'S-1',
  DIGEST: 'S-1.5',
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
const { buildSeedMetricTable, validateSeedMetricOutput, parseTFR, injectTFRColumn, rescueDroppedSuffix, rescueTotalPrice, rescueIncome, validateSeedMetricInvariants, emptyCityRecord } = require('./seed-metric-calculator');
const { cityToExpectedCurrency, CURRENCY_REGISTRY } = require('./geo-data');
const { buildCeilingMap } = require('../lib/tools/income-ceiling');
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
    this.digest = null;               // S-1.5 DigestResult
    this.sessionLens = {};            // Accumulated lens vector across queries in this session
    
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
    this.searchKernel = config.searchKernel;
    // Deprecated: individual provider functions (kept for one-release backward compat)
    this.searchBrave = config.searchBrave || null;
    this.searchDuckDuckGo = config.searchDuckDuckGo || null;
    this.searchCascade = config.searchCascade || null;
    this.searchCascadeMulti = config.searchCascadeMulti || null;
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
    if (this.searchKernel) {
      const { results } = await this.searchKernel.searchMulti({ queries, tier: 'premium', clientIp, delayMs });
      return results;
    }
    // Legacy fallback (deprecated — remove after searchKernel is wired everywhere)
    if (this.searchCascadeMulti) {
      const { results } = await this.searchCascadeMulti({ queries, strategy: 'brave-first', clientIp, delayMs });
      return results;
    }
    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const sq = queries[i];
      let result = this.searchBrave ? await this.searchBrave(sq, clientIp) : null;
      if (!result && this.searchDuckDuckGo) result = await this.searchDuckDuckGo(sq);
      if (result) results.push(`[${sq}]\n${result}`);
      if (i < queries.length - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
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
    // Accept session lens from caller (e.g. executeCompoundQuery threading across sub-queries)
    if (input.sessionLens && typeof input.sessionLens === 'object') {
      state.sessionLens = { ...input.sessionLens };
    }
    
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
                const visionSearch = this.searchKernel
                  ? await this.searchKernel.search({ query: keyTerms, tier: 'premium', clientIp: normalizedInput.clientIp })
                  : this.searchCascade
                    ? await this.searchCascade({ query: keyTerms, strategy: 'brave-first', clientIp: normalizedInput.clientIp })
                    : { result: null, provider: null };
                
                if (visionSearch.result) {
                  normalizedInput.extractedContent.push(
                    `\n### 🔍 Image Identification (Web Search):\n${visionSearch.result}`
                  );
                  state.didSearch = true;
                  state.searchProvider = state.searchProvider || visionSearch.provider;
                  logger.info(`✅ S-1: Vision search enrichment complete (${visionSearch.result.length} chars)`);
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
      // STAGE -1.5: Query Digest (intent, subject, context, lens, session lens)
      // Runs after S-1 so it has the normalised query; before S0 so routing can use it
      // ========================================
      if (!resumeFromStage) {
        state.transition(PIPELINE_STEPS.DIGEST);
        try {
          const groqToken = process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN || process.env.GROQ_API_KEY;
          state.digest = await digestQuery(normalizedInput.query, state.sessionLens, groqToken);
          // Persist updated session lens so multi-question loops compound within the turn
          if (state.digest.sessionLens) {
            state.sessionLens = state.digest.sessionLens;
          }
        } catch (digestErr) {
          logger.warn({ err: digestErr.message }, '⚠️ S-1.5 digest failed — pipeline continues without digest');
          state.digest = null;
        }
      }

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

      // ── Hoisted reference: income ceiling map (seed-metric mode only) ───────
      // Same architectural pattern as `state.queryTimestamp` (the "look at the
      // watch once at construction" reference). For any seed-metric run, the
      // structural income ceiling is a deterministic constant — fetch it ONCE
      // here at the top of the pipeline, immediately after preflight resolves
      // mode, regardless of which path got us here (fresh stepPreflight,
      // pre-computed preflight, or checkpoint resume). Stored as a Promise on
      // state so it overlaps with everything downstream (Phase 0 silos,
      // dog-walk extractions, fallback income); consumers `await
      // state.ceilingMapP` wherever they need it. 24h cache keeps the network
      // cost to once per worker per day.
      if (state.mode === 'seed-metric' && !state.ceilingMapP) {
        const allCurrencies = new Set(['USD', ...Object.keys(CURRENCY_REGISTRY || {})]);
        state.ceilingMapP = buildCeilingMap([...allCurrencies]).catch(err => {
          // Non-fatal: rescueIncome gracefully skips the structural guard when
          // its currency is missing from the map. Text-pattern + min-sanity
          // guards still apply. Log loudly so degraded mode is visible.
          logger.warn({ err: err.message, currencies: [...allCurrencies] }, '🛡️ buildCeilingMap failed — income ceiling guard running in degraded mode');
          return {};
        });
        logger.debug(`🛡️ Income ceiling map fetch kicked off at top of pipeline (${allCurrencies.size} currencies)`);
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
          dataPackageSummary: state.dataPackage.toCompressedSummary(),
          digest: state.digest || null,
          sessionLens: state.sessionLens || {}
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

      // EXPERT REFERRAL: both audit passes exhausted + still REJECTED
      // Discard the model's output (knowledge-cutoff admissions, raw URL redirects).
      // The search found the right sources — present them as expert pointers instead.
      // Sources footer attaches normally in stepOutput via injectSourceLine.
      if (state.auditResult?.verdict === 'REJECTED' && state.retryCount >= state.maxRetries) {
        logger.debug(`🔗 Expert referral: retries exhausted + still REJECTED — injecting referral stub`);
        state.draftAnswer = 'I searched and found these authoritative sources — they\'ll have the most up-to-date information:';
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
        searchProvider: state.searchProvider || null,
        didSearchRetry: state.didSearch && state.retryCount > 0,
        retryCount: state.retryCount,
        passCount: state.retryCount + 1,
        sourceUrls: state.seedMetricSourceUrls || [],
        dataPackageId: state.dataPackage.id,
        dataPackageSummary: state.dataPackage.toCompressedSummary(),
        digest: state.digest || null,
        sessionLens: state.sessionLens || {}
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
    const tenantId = input.clientIp || input.sessionId || 'anonymous';
    const safeDocContext = input.docContext || {};
    
    state.preflight = await preflightRouter({
      query: query || '',
      attachments: attachments || [],
      docContext: safeDocContext,
      contextResult: contextResult || null,  // Stage -1 output for context-aware routing
      digest: state.digest || null           // S-1.5 DigestResult for additive flag enrichment
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
      
      let searchQuery = await this.extractCoreQuestion(query, input.conversationHistory || input.history || [], getUrlAnchors(tenantId));
      // Geo-localised search: append digest geo context so results reflect the user's location
      if (state.preflight.digestGeo && searchQuery && !searchQuery.toLowerCase().includes(state.preflight.digestGeo.toLowerCase())) {
        searchQuery = `${searchQuery} ${state.preflight.digestGeo}`;
        logger.debug(`🌍 Geo search: appended "${state.preflight.digestGeo}" to search query`);
      }
      const cascadeResult = this.searchKernel
        ? await this.searchKernel.search({ query: searchQuery, tier: 'standard', clientIp })
        : this.searchCascade
          ? await this.searchCascade({ query: searchQuery, strategy: 'ddg-first', clientIp })
          : { result: null, provider: null };
      
      if (cascadeResult.result) {
        const _volRaw = classifyTemporalVolatility(input.query, state.preflight?.mode);
        // forceHighVolatility from digest (context.time='current') overrides mode-based classification
        const _vol = state.preflight?.routingFlags?.forceHighVolatility ? 'high' : _volRaw;
        state.searchVolatility = _vol; // reused by stepContextBuild — avoids double classification
        if (state.preflight?.routingFlags?.forceHighVolatility) {
          logger.debug(`⏱️ Volatility forced to HIGH (digest context.time=current, was: ${_volRaw})`);
        }
        const _volInstruction = _vol === 'high'
          ? 'Search results are your PRIMARY source for this query — training data is likely stale (changes in minutes/hours). Report quantitative facts (scores, prices, exact measurements) exactly as found and cite each one inline as [domain.com](full-url). For qualitative claims, synthesise across sources in your own words — no inline citations for prose.'
          : _vol === 'medium'
          ? 'Balance search results and training knowledge. Report specific scores, prices, and measurements directly from search with inline citations [domain.com](url). Synthesise qualitative analysis in your own words without inline citations.'
          : 'Training knowledge is RELIABLE for this topic — write an authoritative narrative. Do NOT add inline citations to any sentence. The footer handles all source attribution.';

        state.searchContext = `[REAL-TIME WEB SEARCH RESULTS — EVIDENCE LAYER]
${cascadeResult.result}

SYNTHESIS INSTRUCTIONS:
1. ${_volInstruction}
2. If the search results include recent dates or timestamps, incorporate them explicitly.
3. INLINE CITATIONS — only for HIGH/MEDIUM volatility and only for bare quantitative data (a match score, a price, an exact measurement). Format: [domain.com](full-url) — display text is ONLY the hostname, no https://, no www. (e.g. [espn.com](https://www.espn.com/...)). NEVER add source names, reference tags, or plain-text endnotes (e.g. "Britannica" or "Royal") after sentences — this is stitching. Qualitative narrative has NO inline citations.
4. Deliver a DIRECT answer in coherent prose. Do NOT redirect the user to another website. Only flag uncertainty if two sources give actively contradictory numbers.
5. Do NOT write a sources footer — the system injects canonical 📚 Sources attribution automatically.
6. Do NOT explain your data sources, search mechanics, or temporal volatility to the user — these are operational context, not user-facing output.`;
        state.searchSourceUrls = [...cascadeResult.result.matchAll(/^   Source:\s*(https?:\/\/\S+)/gm)].map(m => m[1]);
        state.didSearch = true;
        state.searchProvider = cascadeResult.provider;
        logger.info(`✅ Real-time search successful (provider=${state.searchProvider}), urls=${state.searchSourceUrls.length}, context injected`);

        // Firecrawl source enrichment: replace raw snippet text with clean Firecrawl markdown in-place.
        // state.searchSourceUrls is preserved unchanged — source-ascriber uses it for the 📚 Sources footer.
        if (state.searchSourceUrls.length > 0 && process.env.FIRECRAWL_API_KEY) {
          const { enrichUrls, substituteEnrichedSnippets } = require('./firecrawl-enricher');
          const enriched = await enrichUrls(state.searchSourceUrls, { timeoutMs: 6000 });
          if (enriched.size > 0) {
            const enrichedResult = substituteEnrichedSnippets(cascadeResult.result, enriched);
            // Use function replacement to avoid $ interpolation issues in markdown content
            state.searchContext = state.searchContext.replace(cascadeResult.result, () => enrichedResult);
            logger.info({ enriched: enriched.size }, '🕷️ Firecrawl: snippets replaced with enriched markdown in search context');
          }
        }
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
    const volatility = state.searchVolatility || ((state.didSearch && state.searchContext) ? classifyTemporalVolatility(input.query, state.preflight?.mode) : null);
    const temporalMessage = {
      role: 'system',
      content: buildTemporalContent(state.queryTimestamp, volatility)
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
      finalPrompt = `${memoryPrefix}${state.searchContext}

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
          temperature: temperature || AI_MODELS.TEMPERATURE_REASONING,
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
  
  // ── Phase 0: deterministic pre-fetch from structured APIs ─────────────────
  // Fills current price (FRED for US, Numbeo for others) and income (World Bank)
  // before the LLM tool-call loop runs. Falls through silently on any error.
  async stepSeedMetricDirectFetch(cities, parsedData, histYear, sourceUrls, clientIp) {
    const urlFetcherTool = require('../lib/tools/url-fetcher');

    function toNumbeoSlug(city) {
      return city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
    }

    function dedupPushUrl(arr, entry) {
      const entryUrl = typeof entry === 'string' ? entry : entry.url;
      if (!arr.some(u => (typeof u === 'string' ? u : u.url) === entryUrl)) {
        arr.push(entry);
      }
    }

    const pricePromises = cities.map(async city => {
      // Normalize city key: expand aliases so 'sf' → 'san francisco' for FRED lookup
      const cityKey = (CITY_EXPAND[city.trim().toLowerCase()] || city.trim()).toLowerCase();
      const msaCode = FRED_MSA_CODES[cityKey] || FRED_MSA_CODES[city.trim().toLowerCase()];

      if (msaCode) {
        try {
          const [fredCurrent, fredHistorical] = await Promise.all([
            fetchFredPerSqm(msaCode),
            fetchFredPerSqmForYear(msaCode, histYear)
          ]);

          if (!parsedData.cities[city]) {
            parsedData.cities[city] = emptyCityRecord();
          }

          if (fredCurrent && fredCurrent.value > 0 && !parsedData.cities[city].current.pricePerSqm) {
            const afterL3 = rescueTotalPrice(fredCurrent.value, '');
            if (afterL3 !== null) {
              parsedData.cities[city].current.pricePerSqm = { value: afterL3, currency: 'USD' };
              const fredUrl = `https://fred.stlouisfed.org/series/MEDLISPRIPERSQUFEE${msaCode}`;
              dedupPushUrl(sourceUrls, { title: `FRED MEDLISPRIPERSQUFEE${msaCode} — ${city} current price/sqft`, url: fredUrl });
              logger.debug(`📡 FRED: ${city} current $/sqm = ${afterL3}`);
            }
          }

          if (fredHistorical && fredHistorical.value > 0 && !parsedData.cities[city].historical.pricePerSqm) {
            const afterL3 = rescueTotalPrice(fredHistorical.value, '');
            if (afterL3 !== null) {
              parsedData.cities[city].historical.pricePerSqm = { value: afterL3, currency: 'USD' };
              // Store the actual FRED observation date so downstream code can surface the proxy-year
              // (e.g. targetYear=2000, FRED starts 2016 → observationDate='2016-01-01')
              parsedData.cities[city].historical.pricePerSqmObservationDate = fredHistorical.date || null;
              const fredUrl = `https://fred.stlouisfed.org/series/MEDLISPRIPERSQUFEE${msaCode}`;
              dedupPushUrl(sourceUrls, { title: `FRED MEDLISPRIPERSQUFEE${msaCode} — ${city} historical price/sqft`, url: fredUrl });
              const obsYear = fredHistorical.date ? fredHistorical.date.slice(0, 4) : histYear;
              logger.debug(`📡 FRED: ${city} historical (target:${histYear} obs:${obsYear}) $/sqm = ${afterL3}`);
            }
          }
        } catch (err) {
          logger.warn({ city, err: err.message }, '📡 FRED fetch failed, falling through');
        }
      } else {
        // Hoist so the BIS fallback below can use the LCU anchor detected during Numbeo fetch.
        let numbeoLcuValue = null;

        try {
          const numbeoSlug = toNumbeoSlug(cityKey);
          const numbeoUrl = `https://www.numbeo.com/property-investment/in/${numbeoSlug}`;
          const pageResult = await urlFetcherTool.execute(numbeoUrl);
          const pageText = typeof pageResult === 'string' ? pageResult : (pageResult && pageResult.text ? pageResult.text : null);
          if (pageText) {
            // Normalise HTML-encoded currency symbols to their Unicode equivalents.
            // Numbeo serves &#165; for ¥, &#163; for £, &#8364; for €, &#8361; for ₩, &#8377; for ₹, &#36; for $.
            const HTML_ENTITY_CURRENCY = { '&#165;': '¥', '&#163;': '£', '&#8364;': '€', '&#8361;': '₩', '&#8377;': '₹', '&#36;': '$' };
            const normText = pageText.replace(/&#\d+;/g, e => HTML_ENTITY_CURRENCY[e] || e);

            // Numbeo shows "Price per Square Feet" OR "Price per Square Met(er|re)" depending on locale.
            // Both patterns are accepted; sqft values are converted to sqm (× 10.7639).
            const SQM_PER_SQFT = 10.7639;
            const BUY_REGEX = /Price\s+per\s+Square\s+(Fe(?:et|et)|Met(?:er|re)).*?(?:to\s+Buy\s+)?.*?City\s+Cent(?:re|er)\s+(\$|[¥€£₩₹])\s*([\d,]+(?:\.\d+)?)/i;
            const matchBuy = normText.match(BUY_REGEX);
            if (matchBuy) {
              const isSqft = /fe/i.test(matchBuy[1]);
              let raw = parseFloat(matchBuy[3].replace(/,/g, ''));
              if (isSqft) raw = Math.round(raw * SQM_PER_SQFT);
              const sym = matchBuy[2];
              if (raw > 0 && isFinite(raw)) {
                if (!parsedData.cities[city]) {
                  parsedData.cities[city] = emptyCityRecord();
                }
                if (sym === '$') {
                  if (!parsedData.cities[city].current.pricePerSqm) {
                    const afterL3 = rescueTotalPrice(raw, normText.slice(0, 500));
                    if (afterL3 !== null) {
                      parsedData.cities[city].current.pricePerSqm = { value: afterL3, currency: 'USD' };
                      dedupPushUrl(sourceUrls, { title: `Numbeo Property Investment — ${city}`, url: numbeoUrl });
                      logger.debug(`📡 Numbeo: ${city} current $/sqm = ${afterL3}${isSqft ? ' (converted from sqft)' : ''}`);
                    }
                  }
                } else {
                  // Non-USD — store as LCU anchor for BIS index backcasting.
                  // Glyph-based map handles unambiguous symbols. ¥ is ambiguous
                  // (CNY in Beijing/Shanghai, JPY in Tokyo/Osaka) so we resolve
                  // it via the city's expected currency from the registry —
                  // anti-fragile vs hardcoded glyph→ISO assumptions.
                  const UNAMBIGUOUS = { '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR', '₣': 'CHF', '₪': 'ILS', '฿': 'THB', '₫': 'VND', '₱': 'PHP', '₦': 'NGN', '₺': 'TRY', '₴': 'UAH' };
                  let detectedCurrency = UNAMBIGUOUS[sym] || null;
                  if (sym === '¥') {
                    const expected = cityToExpectedCurrency(city);
                    detectedCurrency = (expected === 'CNY' || expected === 'JPY') ? expected : 'JPY';
                  }
                  if (detectedCurrency) {
                    numbeoLcuValue = { value: raw, currency: detectedCurrency, isSqft };
                    logger.debug(`📡 Numbeo: ${city} LCU price/sqm = ${sym}${raw} (${detectedCurrency}${isSqft ? ', converted from sqft — Phase 0 BIS anchor skipped' : ', BIS anchor'})`);
                  }
                }
              }
            }
          }
        } catch (err) {
          logger.warn({ city, err: err.message }, '📡 Numbeo fetch failed, falling through');
        }

        // Non-US historical price via authoritative structured source
        // (Singapore HDB, Japan BIS WS_SPP via bis-spp, UK Land Registry — returns null on failure)
        try {
          if (!parsedData.cities[city]) {
            parsedData.cities[city] = emptyCityRecord();
          }
          if (!parsedData.cities[city].historical.pricePerSqm) {
            const { fetchIntlHistoricalPrice } = require('../lib/tools/intl-historical-price');
            // Phase 0 BIS anchor: Numbeo USD path only. Numbeo LCU values (¥/€/£ from
            // English-locale pages) are always sqft-converted City Centre premiums — using
            // them as BIS anchors would create inconsistency with the broader residential
            // current price that dog-walking finds. Post-dog-walk BIS fill (below) uses
            // the dog-walked current LCU for a consistent historical computation instead.
            const currentPsmUsd = parsedData.cities[city]?.current?.pricePerSqm?.value ?? null;
            const phase0LcuAnchor = (numbeoLcuValue && !numbeoLcuValue.isSqft) ? numbeoLcuValue : null;
            const intlHist = await fetchIntlHistoricalPrice(
              cityKey, histYear, currentPsmUsd,
              phase0LcuAnchor ? phase0LcuAnchor.value : null,
              phase0LcuAnchor ? phase0LcuAnchor.currency : null
            );
            if (intlHist) {
              parsedData.cities[city].historical.pricePerSqm = { value: intlHist.value, currency: intlHist.currency };
              if (intlHist.sourceUrl) {
                dedupPushUrl(sourceUrls, {
                  title: `${city} historical price/sqm ${intlHist.date ? '(' + intlHist.date + ')' : ''}`,
                  url: intlHist.sourceUrl
                });
              }
              logger.debug({ city, year: histYear, value: intlHist.value, currency: intlHist.currency }, '📡 IntlHist: price/sqm');
            }
          }
        } catch (err) {
          logger.warn({ city, err: err.message }, '📡 IntlHistoricalPrice fetch failed, falling through');
        }
      }
    });

    const incomePromises = cities.map(async city => {
      // Normalize for country lookup: expand city alias if needed
      const cityNorm = (CITY_EXPAND[city.trim().toLowerCase()] || city.trim()).toLowerCase();
      const rawCountry = CITY_TO_COUNTRY[cityNorm] || CITY_TO_COUNTRY[city];
      if (!rawCountry) return;
      const iso2 = COUNTRY_ISO2[rawCountry.toLowerCase()];
      if (!iso2) return;

      // For non-US countries: fetch GNI in local currency units (NY.GNP.PCAP.CN)
      // so that income currency matches property price currency — no forex needed.
      // For the US: property prices are always in USD, so USD income (NY.GNP.PCAP.CD) is correct.
      const isUS = iso2 === 'US';
      const lcu = ISO2_TO_CURRENCY[iso2] || 'USD';
      const fetchFn = isUS
          ? (y) => fetchWorldBankGni(iso2, y)
          : (y) => fetchWorldBankGniLcu(iso2, y, lcu);
      const indicator = isUS ? 'NY.GNP.PCAP.CD' : 'NY.GNP.PCAP.CN';

      try {
        const [currentIncome, historicalIncome] = await Promise.all([
          fetchFn(undefined),
          fetchFn(histYear)
        ]);

        if (!parsedData.cities[city]) {
          parsedData.cities[city] = emptyCityRecord();
        }

        if (currentIncome && !parsedData.cities[city].current.income) {
          parsedData.cities[city].current.income = { value: currentIncome.value, currency: currentIncome.currency, type: 'single' };
        }
        if (historicalIncome && !parsedData.cities[city].historical.income) {
          parsedData.cities[city].historical.income = { value: historicalIncome.value, currency: historicalIncome.currency, type: 'single' };
        }

        const wbUrl = `https://data.worldbank.org/indicator/${indicator}?locations=${iso2}`;
        dedupPushUrl(sourceUrls, { title: `World Bank GNI per capita — ${rawCountry} (${indicator})`, url: wbUrl });
        logger.debug(`📡 WorldBank: ${rawCountry} [${lcu}] income current=${currentIncome?.value ?? 'N/A'} hist=${historicalIncome?.value ?? 'N/A'}`);
      } catch (err) {
        logger.warn({ city, err: err.message }, '📡 WorldBank fetch failed, falling through');
      }
    });

    await Promise.all([...pricePromises, ...incomePromises]);
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

  /**
   * _microExtractField — single-shot LLM number extraction over Brave search
   * text, with L2 (suffix-rescue) baked in. The L3 contamination guards
   * (rescueTotalPrice, rescueIncome) and the bucket-write logic stay at the
   * call site because they vary per location: the primary dog-walk handles
   * BOTH price and income paths; the income fallback handles only income.
   *
   * Returns:
   *   null — if the LLM returned no usable number (null/non-finite/<=0)
   *   { value, currency, type, rawValue, suffixRescued } otherwise, where
   *   `value` is post-suffix-rescue and `rawValue` is pre-rescue (for log).
   *
   * `text` is sliced to 3000 chars before being sent to the LLM (matches the
   * historical behavior of both call sites). Throws on JSON.parse failure or
   * groq HTTP failure — caller wraps in try/catch.
   */
  async _microExtractField({ text, query, prompt }) {
    // Defensive coercion: future callers may pass non-string `text` (e.g. a
    // search result wrapper). Guarantee `.slice` won't throw and the LLM
    // gets an empty string rather than "undefined" / "[object Object]".
    const body = typeof text === 'string' ? text : (text == null ? '' : String(text));
    const extractResponse = await this.groqWithRetry({
      url: this.llmUrl,
      data: {
        model: this.llmModel,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Search query: "${query}"\n\nSearch results:\n${body.slice(0, 3000)}` }
        ],
        temperature: AI_MODELS.TEMPERATURE_DETERMINISTIC,
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

    if (extracted.value == null || !isFinite(extracted.value) || extracted.value <= 0) {
      return null;
    }
    const currency = extracted.currency || 'USD';
    const rawValue = extracted.value;
    const value = rescueDroppedSuffix(rawValue, body);
    return {
      value,
      currency,
      type: extracted.type || null,
      rawValue,
      suffixRescued: value !== rawValue,
    };
  }

  async stepSeedMetricToolCall(state, input) {
    const { query, clientIp } = input;
    const currentYear = new Date().getFullYear();
    const histDecade = state.preflight?.historicalDecade || (String(currentYear - 25).slice(0, 3) + '0s');
    const histYear = state.preflight?.historicalYear || String(currentYear - 25);

    // ── Phase 0: extract cities and init parsedData before first LLM call ──
    // Reverse of CITY_EXPAND: long form → abbreviation ('new york'→'ny', 'san francisco'→'sf').
    // Used both here (preflight) and in the Round-1 belt-and-suspenders expansion below to ensure
    // all city keys are always in their canonical (abbreviated) form, preventing 'ny' + 'new york'
    // fragmentation when the preflight generates long-form queries and Round 1 uses abbreviations.
    const _cityContract = Object.fromEntries(Object.entries(CITY_EXPAND).map(([abbr, full]) => [full, abbr]));

    const cities = state.preflight?.seedMetricSearchQueries
      ? [...new Set(state.preflight.seedMetricSearchQueries.map(q => {
          const match = q.match(/^([a-z\s]+)\s+(?:residential|average|median|housing|apartment)/i);
          if (!match) return null;
          const raw = match[1].trim().toLowerCase();
          // Canonicalize: 'new york' → 'ny', 'san francisco' → 'sf'; unknown cities unchanged.
          return _cityContract[raw] || raw;
        }).filter(Boolean))]
      : [];
    const histDecadeNum = parseInt(histDecade) || (currentYear - 25);
    const sourceUrls = [];

    const parsedData = { cities: {}, parseLog: [] };
    for (const city of cities) {
      parsedData.cities[city] = emptyCityRecord(histDecade);
    }

    // Run Phase 0 (deterministic pre-fetch from FRED/Numbeo/World Bank) AND
    // resolve the hoisted ceiling map in parallel. The ceiling map Promise was
    // kicked off at the top of the pipeline (see `state.ceilingMapP` in run()),
    // so by the time we await it here it's almost always already resolved —
    // we just join the result. Lazy fallback covers any direct call path that
    // bypasses the run() hoist (e.g. unit tests calling stepSeedMetricToolCall
    // directly). 24h cache means lazy build is also free in steady state.
    if (!state.ceilingMapP) {
      const allCurrencies = new Set(['USD', ...Object.keys(CURRENCY_REGISTRY || {})]);
      state.ceilingMapP = buildCeilingMap([...allCurrencies]).catch(err => {
        logger.warn({ err: err.message }, '🛡️ buildCeilingMap (lazy) failed — degraded mode');
        return {};
      });
      logger.debug('🛡️ Income ceiling map fetch lazy-initialized inside stepSeedMetricToolCall (run() hoist was skipped)');
    }
    const [, ceilingMap] = await Promise.all([
      this.stepSeedMetricDirectFetch(cities, parsedData, histYear, sourceUrls, clientIp),
      state.ceilingMapP,
    ]);
    logger.debug({ currencies: Object.keys(ceilingMap).sort(), count: Object.keys(ceilingMap).length, usdSample: ceilingMap.USD }, '🛡️ Income ceiling map resolved');

    // Build a precise skip-hint per city so the LLM avoids redundant searches for already-filled
    // fields while still issuing Brave searches for any field that the pre-fetch missed.
    const alreadyFilled = [];
    const stillNeeded = [];
    for (const city of cities) {
      const d = parsedData.cities[city];
      if (d?.current?.pricePerSqm) alreadyFilled.push(`${city} current price/sqm`);
      else stillNeeded.push(`${city} current price/sqm`);
      if (d?.current?.income) alreadyFilled.push(`${city} current income`);
      else stillNeeded.push(`${city} current income`);
      if (d?.historical?.income) alreadyFilled.push(`${city} historical income`);
      else stillNeeded.push(`${city} historical income`);
      if (d?.historical?.pricePerSqm) {
        // FRED pre-filled the historical price; surface the actual observation date
        // so the LLM knows it is a proxy year when the series doesn't reach histYear.
        const obsDate = d.historical.pricePerSqmObservationDate
          ? d.historical.pricePerSqmObservationDate.slice(0, 4) : histYear;
        alreadyFilled.push(`${city} historical price/sqm (FRED obs year: ${obsDate})`);
      } else {
        stillNeeded.push(`${city} historical price/sqm (~${histYear})`);
      }
    }
    const skipHint = alreadyFilled.length > 0
      ? `\nAlready filled from structured APIs (skip these, do NOT re-search): ${alreadyFilled.join(', ')}.\nStill needed — search for these: ${stillNeeded.join(', ')}.`
      : '';

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
${buildGatherPromptBlock({ currentYear: String(currentYear), histYear, histDecade })}${skipHint}

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
          temperature: AI_MODELS.TEMPERATURE_PRECISE,
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

    // ── Belt-and-suspenders: expand cities from Round 1 actual queries ────────
    // The LLM may search for cities the preflight missed (e.g. 'NY' before the regex fix).
    // Scan every tool-call query, canonicalize what we find, and register any new cities.
    //
    // Canonical form = the CITY_EXPAND abbreviation key (e.g. 'ny', 'sf') when one exists,
    // otherwise the raw match string. This prevents alias fragmentation: preflight adds 'ny'
    // but the LLM searches for 'new york' — both must resolve to the same parsedData key.
    for (const tc of callsToRun) {
      let tcArgs;
      try { tcArgs = JSON.parse(tc.function.arguments); } catch { tcArgs = {}; }
      const tcQuery = (tcArgs.query || '').toLowerCase();
      const foundInQuery = (tcQuery.match(new RegExp(KNOWN_CITIES_REGEX.source, 'gi')) || []).map(c => c.toLowerCase());
      for (const found of foundInQuery) {
        // Abbreviation → keep as-is ('ny' stays 'ny')
        // Long form    → map back to abbreviation if one exists ('new york' → 'ny')
        // Unknown long → use as-is ('chicago' stays 'chicago')
        const canonical = CITY_EXPAND[found] ? found : (_cityContract[found] || found);
        if (!cities.includes(canonical)) {
          cities.push(canonical);
          parsedData.cities[canonical] = emptyCityRecord(histDecade);
          logger.debug(`🏙️ Round-1 city expansion: '${canonical}' added from query "${tcQuery.slice(0, 60)}"`);
        }
      }
    }

    // cities, parsedData, sourceUrls already initialized above (Phase 0)

    const microExtractPrompt = `You are a number extraction engine. You will receive ONE search result about a specific city.
Extract EXACTLY ONE number from it. Output ONLY valid JSON — no markdown, no backticks, no explanation.

Rules:
- If you find a residential property PURCHASE price per sqm or per m²: output {"value": <number>, "type": "pricePerSqm", "currency": "<ISO code>"}
- If you find a price per sqft (square foot): convert to per-sqm by multiplying by 10.764, then output {"value": <converted>, "type": "pricePerSqm", "currency": "<ISO code>"}
- If you can derive per-sqm from a total price AND the text also gives the floor area (e.g. "800sqm plot, $400K" → 400000÷800=500/sqm): output the derived value.
- If you find average/median individual annual income (or monthly × 12): output {"value": <number>, "type": "income", "currency": "<ISO code>"}
- Monthly rent is NOT purchase price — ignore it.
- Household/dual income is NOT single-earner — ignore it.
- GDP per capita is NOT income — ignore it.
- Property price, home value, median sale price is NOT income — ignore it.
- PRICE PLAUSIBILITY — null over hallucination:
  If the text only has a TOTAL property price (median home price, median sale price, average home value, asking price for a house) with NO explicit per-sqm, per-m², or per-sqft figure AND no floor area is stated in the text, you CANNOT derive per-sqm — output {"value": null}.
  Do NOT divide by an assumed floor area. If the area is not in the text, the division would be a guess.
  Valid: "Homes sell for $6,000/m²" → 6000. Valid: "$550/sqft" → 550×10.764=5920.
  Invalid: "Median home price $585,000" (no sqm or sqft rate, no area given) → null.
- INCOME PLAUSIBILITY: If the extracted income value exceeds 300,000 USD-equivalent for an "average" or "median" earner query, you have almost certainly grabbed a property price or executive compensation figure by mistake — output {"value": null} instead.
  Apply this limit using your knowledge of approximate exchange rates for the reported currency.
  High-denomination currencies (JPY, KRW, IDR, VND) have much higher raw number limits — do NOT reject ¥5M, ₩40M, or Rp500M just because the number looks large; those are typical wages in those currencies.
- If no usable number found: output {"value": null}
- null is always better than a guess. Every number must come from the search text.
- CRITICAL — always output the fully-expanded raw integer, never an abbreviated form.
  Expand suffixes BEFORE outputting the value:
    K or k  = ×1,000        (e.g. "Rp54K"   → 54000,   "RM8K"    → 8000)
    M or m  = ×1,000,000    (e.g. "Rp5.5M"  → 5500000, "RM57K"   → 57000)
    B or b  = ×1,000,000,000
    "thousand" = ×1,000 | "million" = ×1,000,000 | "billion" = ×1,000,000,000
  Examples: "Rp54,000/sqm" → 54000 | "Rp5.5M/sqm" → 5500000 | "RM57K/yr" → 57000
- TEMPORAL — the search query tells you the target time period. If the text mentions values
  for multiple years (e.g. "grew from X in 2003 to Y in 2025"), extract the value CLOSEST
  to the year or decade in the search query — NOT the most recent one.
  Example: query="Jakarta average income 2000s", text="rose from Rp18M in 2002 to Rp104M today"
  → extract 18000000 (nearest to 2000s), NOT 104000000 (current).
  Example: query="Jakarta average income 2026", text="rose from Rp18M in 2002 to Rp104M today"
  → extract 104000000 (nearest to 2026).`;

    const pendingExtractions = [];

    for (let i = 0; i < callsToRun.length; i++) {
      const tc = callsToRun[i];
      let args;
      try { args = JSON.parse(tc.function.arguments); }
      catch { args = { query: String(tc.function.arguments) }; }

      const searchQuery = args.query || '';
      logger.debug(`🦁 brave_search #${i + 1}: "${searchQuery}"`);

      let result = this.searchKernel
        ? (await this.searchKernel.search({ query: searchQuery, tier: 'premium', clientIp, format: 'json' })).result
        : this.searchBrave ? await this.searchBrave(searchQuery, clientIp, { format: 'json' }) : null;

      if (result === null) {
        logger.debug(`🦁 brave_search #${i + 1}: null result, retrying after 1500ms...`);
        await new Promise(r => setTimeout(r, 1500));
        result = this.searchKernel
          ? (await this.searchKernel.search({ query: searchQuery, tier: 'premium', clientIp, format: 'json' })).result
          : this.searchBrave ? await this.searchBrave(searchQuery, clientIp, { format: 'json' }) : null;
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
        if (expandedWordBoundary.test(queryLower) || cityWordBoundary.test(queryLower)) {
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
            const extracted = await this._microExtractField({
              text: braveText,
              query: searchQuery,
              prompt: microExtractPrompt,
            });

            if (!extracted) {
              logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${metricType} = null`);
              return;
            }

            const { currency, rawValue, suffixRescued } = extracted;
            let value = extracted.value;
            // L2: Regex rescue — re-scan Brave text for K/M/B suffix LLM may have dropped
            if (suffixRescued) {
              logger.debug(`🔧 Suffix rescue: ${rawValue} → ${value} ${currency} (${metricType})`);
            }
            const resolvedType = (extracted.type === 'pricePerSqm' || extracted.type === 'income')
              ? extracted.type : metricType;
            // L3: Total-price contamination guard — null over hallucination
            if (resolvedType === 'pricePerSqm') {
              const afterL3 = rescueTotalPrice(value, braveText);
              if (afterL3 !== value) {
                logger.debug(`🔧 L3 price guard: ${value} → ${afterL3 ?? 'null'} ${currency} (${matchedCity}/${period})`);
              }
              value = afterL3;
            } else if (resolvedType === 'income') {
              // L3: Income contamination guard — text-pattern + min-sanity +
              // structural ceiling (Monaco/Switz/Lux median × 1.5). Currency-
              // matched lookup via ceilingMap[currency] prevents FX mismatch.
              const afterL3 = rescueIncome(value, braveText, currency, ceilingMap);
              if (afterL3 !== value) {
                logger.debug(`🔧 L3 income guard: ${value} → ${afterL3 ?? 'null'} ${currency} (${matchedCity}/${period})`);
              }
              value = afterL3;
            }
            if (value == null) {
              logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${resolvedType} nulled by L3 guard`);
              return;
            }
            if (!parsedData.cities[matchedCity]) {
              parsedData.cities[matchedCity] = emptyCityRecord(histDecade);
            }
            const bucket = parsedData.cities[matchedCity][period];
            if (!bucket[resolvedType]) {
              bucket[resolvedType] = resolvedType === 'income'
                ? { value, currency, type: 'single' }
                : { value, currency };
              logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${resolvedType} = ${value} ${currency}`);
            } else {
              logger.debug(`👁️ Extract #${i + 1}: ${matchedCity}/${period}/${resolvedType} already filled, skipping`);
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
            const _incomeSearch = this.searchKernel
              ? await this.searchKernel.search({ query: fallbackQuery, tier: 'premium', clientIp: input.clientIp || '127.0.0.1' })
              : { result: this.searchBrave ? await this.searchBrave(fallbackQuery, input.clientIp || '127.0.0.1') : null };
            const braveResult = _incomeSearch.result;
            if (!braveResult?.trim()) return;

            const extracted = await this._microExtractField({
              text: braveResult,
              query: fallbackQuery,
              prompt: microExtractPrompt,
            });

            if (!extracted) {
              logger.debug(`🔄 Fallback miss: ${city}/${period}/income still null (${country})`);
              return;
            }

            const { currency, rawValue, suffixRescued } = extracted;
            let value = extracted.value;
            // L2: Regex rescue — re-scan Brave text for K/M/B suffix LLM may have dropped
            if (suffixRescued) {
              logger.debug(`🔧 Suffix rescue (fallback): ${rawValue} → ${value} ${currency} (income)`);
            }
            // L3: Income contamination guard (same as primary dog-walk site).
            const afterL3 = rescueIncome(value, braveResult, currency, ceilingMap);
            if (afterL3 !== value) {
              logger.debug(`🔧 L3 income guard (fallback): ${value} → ${afterL3 ?? 'null'} ${currency} (${city}/${period})`);
            }
            value = afterL3;
            if (value != null && !data[period].income) {
              data[period].income = { value, currency, type: 'single' };
              logger.debug(`🔄 Fallback hit: ${city}/${period}/income = ${value} ${currency} (via ${country})`);
            } else if (value == null) {
              logger.debug(`🔄 Fallback nulled by L3 guard: ${city}/${period}/income (via ${country})`);
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

    // ── Post-dog-walk BIS fill: for non-USD cities that still have no historical ──
    // Dog-walking may have set a current LCU price (e.g. ¥500K for Tokyo from Brave).
    // Use that as the BIS index anchor to backcast a consistent historical price.
    // Runs in two cases:
    //   (a) historical is empty (Brave failed to extract anything), or
    //   (b) historical was Brave-extracted but fails a sanity check — specifically
    //       historical/current > 1.0 in same currency (housing price per sqm rarely
    //       falls over 25 years; ratio >1.0 strongly indicates a Brave extraction
    //       error, e.g. a city-centre listing mis-tagged as "2000s historical").
    //   Phase 0 silo data (HDB, FRED, UK LR, IntlHist BIS) is left untouched —
    //   only same-currency dog-walked values are sanity-checked.
    for (const cityKey of cities) {
      const data = parsedData.cities[cityKey];
      if (!data) continue;
      const currentPsm = data.current?.pricePerSqm;
      if (!currentPsm || !currentPsm.value) continue;
      if (currentPsm.currency === 'USD') continue;

      const histPsm = data.historical?.pricePerSqm;
      if (histPsm?.value) {
        const sameCurrency = histPsm.currency === currentPsm.currency;
        const implausible  = sameCurrency && histPsm.value > currentPsm.value;
        if (!implausible) continue;
        logger.debug(`📡 BIS fill: ${cityKey} historical (${histPsm.value} ${histPsm.currency}) > current (${currentPsm.value} ${currentPsm.currency}) — discarding Brave value, attempting BIS backcast`);
        data.historical.pricePerSqm = null;
      }
      try {
        const { fetchBisPricePerSqm } = require('../lib/tools/bis-spp');
        const country = CITY_TO_COUNTRY[cityKey];
        const iso2 = country ? COUNTRY_ISO2[country.toLowerCase()] : null;
        if (!iso2) continue;
        const bisResult = await fetchBisPricePerSqm(iso2, cityKey, parseInt(histYear), null, {
          currentPsmLcu: currentPsm.value,
          lcuCurrency: currentPsm.currency,
        });
        if (bisResult) {
          data.historical.pricePerSqm = { value: bisResult.value, currency: bisResult.currency };
          if (bisResult.sourceUrl) {
            dedupPushUrl(sourceUrls, {
              title: `BIS ${country} residential property index — ${cityKey} historical`,
              url: bisResult.sourceUrl
            });
          }
          logger.debug(`📡 BIS fill (post-dogwalk): ${cityKey} historical = ${bisResult.value} ${bisResult.currency} (anchor: ${currentPsm.value} ${currentPsm.currency})`);
        }
      } catch (err) {
        logger.warn({ cityKey, err: err.message }, '📡 BIS fill (post-dogwalk) failed');
      }
    }

    // ── Cross-period invariant validation (final guard before table build) ───
    // Runs AFTER all data sources (Phase 0 silos, dog-walk Brave, fallback,
    // post-dog-walk BIS backcast). Mutates parsedData / tfrCapsule in place,
    // nulling fields that violate invariants (currency mismatch, temporal
    // income direction, TFR cross-period plausibility). Failing loudly via
    // log lines so anomalies are visible in production traces.
    try {
      const violations = validateSeedMetricInvariants(parsedData, tfrCapsule);
      if (violations.length > 0) {
        logger.warn({ violations }, `🛡️ Seed-metric invariant violations: ${violations.length}`);
        for (const v of violations) parsedData.parseLog.push(`INVARIANT: ${v}`);
      } else {
        logger.debug('🛡️ Seed-metric invariants: all clean');
      }
    } catch (err) {
      logger.warn({ err: err.message }, '🛡️ validateSeedMetricInvariants threw — skipping');
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
          temperature: AI_MODELS.TEMPERATURE_CREATIVE,
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
    const { fetchWbTFR } = require('../lib/tools/wb-tfr');

    const _tfrSearch = async (q) => this.searchKernel
      ? (await this.searchKernel.search({ query: q, tier: 'premium', clientIp })).result
      : (this.searchBrave ? await this.searchBrave(q, clientIp) : null);

    // Helper: try World Bank first, then Brave city search, then Brave country search.
    // World Bank is fast (~100 ms, cached per-country) and structured — no text parsing needed.
    // Brave searches add 1–2 s each and require regex extraction; they run only when WB misses.
    //
    // Precedence policy (deliberate):
    //   WB SP.DYN.TFRT.IN is prioritised because it is structured, reliable, and covers
    //   ~200 countries from 1960. Its ~2-year publication lag is acceptable — the seed-metric
    //   table is a decadal/generational comparison, not a real-time indicator. Brave searches
    //   act as a recency supplement for cities or years WB cannot resolve (MAX_LAG=4).
    const _fetchTFR = async (city, country, targetYear, label) => {
      const iso2 = country ? COUNTRY_ISO2[country.toLowerCase()] : null;

      // 1. World Bank structured API (primary)
      if (iso2) {
        try {
          const wbResult = await fetchWbTFR(iso2, targetYear);
          if (wbResult) {
            logger.debug(`🐣 TFR World Bank (primary): ${city} ${label} = ${wbResult.value} (${wbResult.year}, iso2=${iso2})`);
            return wbResult.value;
          }
        } catch (wbErr) {
          logger.warn({ city, err: wbErr.message }, '🐣 TFR World Bank primary failed');
        }
      }

      // 2. Brave city-specific search (first Brave fallback)
      const cityQuery = `"${city}" total fertility rate ${targetYear}`;
      logger.debug(`🐣 TFR Brave city search: "${cityQuery}"`);
      const cityResult = await _tfrSearch(cityQuery);
      const cityVal = parseTFR(cityResult, city, targetYear);
      if (cityVal) {
        logger.debug(`🐣 TFR Brave city hit: ${city} ${label} = ${cityVal}`);
        return cityVal;
      }

      // 3. Brave country-level search (second Brave fallback)
      if (country) {
        await new Promise(r => setTimeout(r, 1100));
        const countryQuery = `${country} total fertility rate ${targetYear}`;
        logger.debug(`🐣 TFR Brave country fallback: "${countryQuery}"`);
        const countryResult = await _tfrSearch(countryQuery);
        const countryVal = parseTFR(countryResult, country, targetYear);
        if (countryVal) {
          logger.debug(`🐣 TFR Brave country hit: ${city} ${label} = ${countryVal} (via ${country})`);
          return countryVal;
        }
      }

      // 4. Year-agnostic Brave search (catches preliminary / unlabelled data — e.g. SG 2025).
      // CURRENT-ONLY by design: the query string carries no year, so running it for both
      // periods would return the same first-match value for both — producing identical
      // TFR in the historical and current rows (the "TFR leak between years" bug).
      // For historical periods we MUST have a year-anchored hit; better to return null
      // and surface N/A than to import the latest figure as if it were 25 years old.
      //
      // KNOWN RESIDUAL: if a historical query returns a snippet anchored to a year inside
      // the decade window (e.g. "London TFR in 2008 was 1.6") AND the current year-agnostic
      // fallback retrieves the same snippet, both rows can show 1.6. To fully close this,
      // parseTFR would need to return matched-year metadata so this orchestrator could
      // dedup by source-year across periods. Out-of-scope for this fix; tracked as
      // follow-up "TFR cross-period dedup via matched-year metadata".
      if (label === 'current') {
        await new Promise(r => setTimeout(r, 1100));
        const agnosticTarget = country || city;
        const agnosticQuery = `${agnosticTarget} total fertility rate`;
        logger.debug(`🐣 TFR year-agnostic fallback: "${agnosticQuery}"`);
        const agnosticResult = await _tfrSearch(agnosticQuery);
        const agnosticVal = parseTFR(agnosticResult, agnosticTarget, '');
        if (agnosticVal) {
          logger.debug(`🐣 TFR year-agnostic hit: ${city} ${label} = ${agnosticVal}`);
          return agnosticVal;
        }
      }

      return null;
    };

    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      const cityKey = city.toLowerCase();
      const country = cityToCountry[cityKey] || null;
      tfrCapsule[cityKey] = { current: null, historical: null };

      try {
        const histTargetYear = historicalDecade.replace(/s$/, '');
        tfrCapsule[cityKey].current    = await _fetchTFR(city, country, currentYear, 'current');
        tfrCapsule[cityKey].historical = await _fetchTFR(city, country, histTargetYear, 'historical');

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
                temperature: AI_MODELS.TEMPERATURE_PRECISE,
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
    
    const searchQuery = await this.extractCoreQuestion(safeQuery, sanitizedHistory, getUrlAnchors(clientIp));
    const retrySearch = this.searchKernel
      ? await this.searchKernel.search({ query: searchQuery, tier: 'premium', clientIp })
      : this.searchCascade
        ? await this.searchCascade({ query: searchQuery, strategy: 'brave-first', clientIp })
        : { result: null, provider: null };
    
    if (retrySearch.result) {
      state.searchContext = retrySearch.result;
      state.searchProvider = retrySearch.provider;
      state.didSearch = true;
      // Extract URLs from retry search results and enrich with Firecrawl if configured
      const retryUrls = [...retrySearch.result.matchAll(/^   Source:\s*(https?:\/\/\S+)/gm)].map(m => m[1]);
      // Update source URLs from the retry search — the first-pass sources are stale (bad query)
      if (retryUrls.length > 0) state.searchSourceUrls = retryUrls;
      if (retryUrls.length > 0 && process.env.FIRECRAWL_API_KEY) {
        const { enrichUrls, substituteEnrichedSnippets } = require('./firecrawl-enricher');
        const enriched = await enrichUrls(retryUrls, { timeoutMs: 6000 });
        if (enriched.size > 0) {
          const enrichedResult = substituteEnrichedSnippets(retrySearch.result, enriched);
          state.searchContext = state.searchContext.replace(retrySearch.result, () => enrichedResult);
          logger.info({ enriched: enriched.size }, '🕷️ Firecrawl: retry snippets replaced with enriched markdown');
        }
      }
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
        didSearch: state.didSearch,
        searchProvider: state.searchProvider || null,
        searchSourceUrls: state.searchSourceUrls || [],
        seedMetricSourceUrls: state.seedMetricSourceUrls || []
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
