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

const { AttachmentIngestion } = require('./attachment-ingestion');
const { analyzeImageWithGroqVision, processChemistryContent, classifyScholasticDomain } = require('./attachment-cascade');
const { createQueryTimestamp, buildTemporalContent } = require('./time-format');
const { parseSeedMetricData, buildSeedMetricTable, validateSeedMetricOutput } = require('./seed-metric-calculator');

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
        console.log(`🔬 S-1: Processing ${photos.length} photo(s) with Groq Vision...`);
        for (const photo of photos.slice(0, 5)) { // Max 5 photos
          try {
            // Extract base64 and content type from data URL
            // Format: data:image/jpeg;base64,xxxx
            const photoData = photo.data || '';
            const photoName = photo.name || 'image';
            let base64 = '';
            let contentType = 'image/jpeg'; // Default fallback
            
            // Debug: log incoming data format
            console.log(`📷 S-1: Photo ${photoName} data length: ${photoData.length}, starts with: ${photoData.substring(0, 50)}...`);
            
            // Parse data URL to get actual content type (frontend may convert PNG to JPEG during resize)
            const dataUrlMatch = photoData.match(/^data:([^;]+);base64,(.+)$/s);
            if (dataUrlMatch) {
              contentType = dataUrlMatch[1]; // Actual MIME type from data URL
              base64 = dataUrlMatch[2];      // Raw base64 without prefix
              console.log(`📷 S-1: Regex matched - contentType: ${contentType}, base64 length: ${base64.length}`);
            } else if (photoData.includes('base64,')) {
              // Fallback: just extract base64 portion
              const parts = photoData.split('base64,');
              base64 = parts[1] || '';
              console.log(`📷 S-1: Fallback split - base64 length: ${base64.length}`);
            } else {
              console.log(`📷 S-1: No base64 marker found in photoData`);
            }
            
            // Sanitize base64: remove whitespace, newlines
            base64 = (base64 || '').replace(/[\s\r\n]/g, '');
            
            console.log(`📷 S-1: Photo ${photoName} detected as ${contentType} (${base64.length} chars after sanitize)`);
            
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
              console.log(`✅ S-1: Vision analysis complete for ${photoName}`);
              
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
            console.log(`🚫 S-1: Chemistry pipeline GATED — scholastic domain is "${scholasticCheck.domain}" (override: ${scholasticCheck.override || 'none'}), not chemistry`);
            gatedVisionDescriptions = chemicalVisionResults.map(r => r.description || '').filter(d => d.length > 0);
            chemicalVisionResults.length = 0; // Clear to skip chemistry and trigger vision search fallback
            chemistryGated = true;
            // Relabel extractedContent: replace wrong 🧪 Chemical Structure label with correct domain label
            const domainLabel = scholasticCheck.domain === 'pure-math' ? '📐 Mathematical Diagram' : '📐 Diagram';
            for (let i = 0; i < normalizedInput.extractedContent.length; i++) {
              if (typeof normalizedInput.extractedContent[i] === 'string' && normalizedInput.extractedContent[i].includes('🧪 Chemical Structure')) {
                normalizedInput.extractedContent[i] = normalizedInput.extractedContent[i].replace('🧪 Chemical Structure', domainLabel);
                console.log(`📝 S-1: Relabeled vision content from "🧪 Chemical Structure" to "${domainLabel}"`);
              }
            }
          }
        }
        
        // If chemical structures detected (and passed scholastic gate), run chemistry enrichment pipeline
        if (chemicalVisionResults.length > 0) {
          try {
            console.log(`🧪 S-1: Running chemistry enrichment for ${chemicalVisionResults.length} chemical structure(s)...`);
            const chemistryResult = await processChemistryContent(chemicalVisionResults);
            if (chemistryResult && chemistryResult.enrichedText) {
              normalizedInput.extractedContent.push(chemistryResult.enrichedText);
              console.log(`✅ S-1: Chemistry enrichment complete - ${chemistryResult.stage || 'unknown stage'}`);
              
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
                  console.log(`📋 S-1: Chemistry header saved for S6 output (${Math.round(confidence * 100)}%)`);
                } else {
                  console.log(`📋 S-1: Chemistry header SUPPRESSED (confidence=${Math.round(confidence * 100)}%, name="${ci.name}" generic=${isGenericName})`);
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
                console.log(`🔎 S-1: Vision search enrichment [${trigger}] — querying "${keyTerms}" (scholastic: ${scholastic.domain})`);
                let searchResult = await this.searchBrave(keyTerms, normalizedInput.clientIp);
                if (!searchResult) {
                  searchResult = await this.searchDuckDuckGo(keyTerms);
                }
                
                if (searchResult) {
                  normalizedInput.extractedContent.push(
                    `\n### 🔍 Image Identification (Web Search):\n${searchResult}`
                  );
                  state.didSearch = true;
                  console.log(`✅ S-1: Vision search enrichment complete (${searchResult.length} chars)`);
                } else {
                  console.log(`⚠️ S-1: Vision search returned no results for "${keyTerms}"`);
                }
              }
            }
          } catch (searchErr) {
            console.error(`❌ S-1: Vision search enrichment error: ${searchErr.message}`);
          }
        }
      } else {
        console.log(`⚠️ S-1: PLAYGROUND_GROQ_VISION_TOKEN not configured - skipping vision analysis`);
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
      console.log(`🖼️ S-1: Image content ready (vision=${visionSuccessCount}) - search retry will be skipped`);
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
        console.log(`📜 Stage -1: Context extracted - inferred ticker: ${state.contextResult.inferredTicker}`);
      } else if (state.contextResult.hasFinancialContext) {
        console.log(`📜 Stage -1: Financial context detected, no specific ticker`);
      }
      
      // Log memory-based context if available
      if (state.contextResult.attachmentContext) {
        console.log(`📎 Stage -1: Attachment side-door active - "${state.contextResult.attachmentContext.name}"`);
      }
      
      // Merge context with current query for enhanced detection
      const contextAwareQuery = mergeContextForTickerDetection(normalizedInput.query, state.contextResult);
      
      // ========================================
      // STAGE 0: Preflight (mode detection, external data)
      // ========================================
      // Support pre-computed preflight (avoids duplicate calls when endpoint already ran it)
      if (normalizedInput.preComputedPreflight) {
        state.preflight = normalizedInput.preComputedPreflight;
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
        
      // still do seed-metric search if needed
      const safeDocContext = normalizedInput.docContext || {};
      if (state.mode === 'seed-metric' && normalizedInput.query && !safeDocContext.isClosedLoop) {
        console.log(`🌱 Seed Metric (pre-computed): MANDATORY web search for grounded data`);
        
        const searchQueries = state.preflight.seedMetricSearchQueries || [];
        let searchResults = [];
        
        if (searchQueries.length > 0) {
          // Sequential search with rate limiting (350ms delay) to avoid Brave 429 errors
          searchResults = await this.searchWithRateLimit(searchQueries.slice(0, 6), normalizedInput.clientIp, 350);
          console.log(`🔍 Seed Metric: ${searchResults.length}/${searchQueries.length} searches returned data`);
        } else {
          const searchQuery = await this.extractCoreQuestion(normalizedInput.query);
          let result = await this.searchBrave(searchQuery, normalizedInput.clientIp);
          if (!result) {
            result = await this.searchDuckDuckGo(searchQuery);
          }
          if (result) searchResults.push(result);
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
        
        // FINALIZE: Store in tenant's φ-8 window
        state.dataPackage.finalize();
        globalPackageStore.storePackage(state.dataPackage.tenantId, state.dataPackage);
        
        return {
          success: true,
          answer: state.finalAnswer,
          mode: state.mode,
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
      
      await this.stepContextBuild(state, normalizedInput);
      await this.stepReasoning(state, normalizedInput);
      await this.stepAudit(state, normalizedInput);
      
      if (state.auditResult?.verdict === 'REJECTED' && state.retryCount < state.maxRetries) {
        await this.stepRetry(state, normalizedInput);
      }
      
      await this.stepOutput(state);
      
      // Mark NYAN as booted AFTER successful completion (not during context build)
      // This ensures retries within same request still get full NYAN
      if (normalizedInput.sessionId && state.isFirstQuery) {
        markSessionNyanBooted(normalizedInput.sessionId);
      }
      
      // Derive badge from audit verdict
      // APPROVED/ACCEPTED/BYPASS → verified, FIXABLE → corrected, REJECTED → unverified
      const badge = this.deriveBadge(state.auditResult);
      
      return {
        success: true,
        answer: state.finalAnswer,
        mode: state.mode,
        preflight: state.preflight,
        auditResult: state.auditResult,
        audit: { confidence: state.auditResult?.confidence || 0, reason: state.auditResult?.reason || '' },
        badge,
        didSearch: state.didSearch,
        didSearchRetry: state.didSearch && state.retryCount > 0,
        retryCount: state.retryCount,
        passCount: state.retryCount + 1,
        dataPackageId: state.dataPackage.id,
        dataPackageSummary: state.dataPackage.toCompressedSummary()
      };
    } catch (err) {
      console.error(`❌ Pipeline error at ${state.step}: ${err.message}`);
      return {
        success: false,
        error: err.message,
        step: state.step,
        badge: 'unverified',
        audit: { confidence: 0, reason: err.message },
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
      let searchResults = [];
      
      if (searchQueries.length > 0) {
        // Sequential search with rate limiting (350ms delay) to avoid Brave 429 errors
        searchResults = await this.searchWithRateLimit(searchQueries.slice(0, 6), clientIp, 350);
        console.log(`🔍 Seed Metric: ${searchResults.length}/${searchQueries.length} searches returned data`);
      } else {
        // Fallback to generic search
        const searchQuery = await this.extractCoreQuestion(query);
        let result = await this.searchBrave(searchQuery, clientIp);
        if (!result) {
          result = await this.searchDuckDuckGo(searchQuery);
        }
        if (result) searchResults.push(result);
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
    
    // ========================================
    // REAL-TIME CASCADE: DDG → Brave for sports, news, weather, etc.
    // Triggered by preflight.routingFlags.needsRealtimeSearch
    // ========================================
    if (state.preflight.routingFlags?.needsRealtimeSearch && query) {
      console.log(`🌐 Real-time cascade: DDG → Brave for general query`);
      
      const searchQuery = await this.extractCoreQuestion(query);
      let searchResult = null;
      
      // DDG first (free, no API key required)
      searchResult = await this.searchDuckDuckGo(searchQuery);
      
      // Brave fallback if DDG fails
      if (!searchResult) {
        console.log(`🦁 DDG returned no results, trying Brave...`);
        searchResult = await this.searchBrave(searchQuery, clientIp);
      }
      
      if (searchResult) {
        state.searchContext = `[REAL-TIME WEB SEARCH RESULTS - USE THIS DATA, NOT TRAINING DATA]
${searchResult}

MANDATORY INSTRUCTIONS:
1. Base your answer on the web search results above
2. If the search results are recent, explicitly mention dates
3. If search data conflicts with your training data, PREFER the web search results
4. If the search results don't fully answer the question, acknowledge what's missing`;
        state.didSearch = true;
        console.log(`✅ Real-time search successful, context injected`);
      } else {
        console.log(`⚠️ Real-time search failed - will rely on training data`);
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
    const nyanMessages = buildSystemContext(state.preflight, NYAN_PROTOCOL_SYSTEM_PROMPT, {
      isFirstQuery: state.isFirstQuery,
      nyanCompressed: NYAN_PROTOCOL_COMPRESSED
    });
    
    // Temporal awareness comes FIRST, then NYAN protocol
    state.systemMessages = [temporalMessage, ...nyanMessages];
    
    // WRITE to DataPackage: Stage S1 context build with temporal metadata
    state.writeToPackage(STAGE_IDS.CONTEXT_BUILD, {
      temporalTimestamp: state.queryTimestamp.isoUtc,
      nyanMode: state.isFirstQuery ? 'full' : 'compressed',
      systemMessageCount: state.systemMessages.length
    });
    
    console.log(`📝 Context: ${state.systemMessages.length} system messages built (temporal + NYAN: ${state.isFirstQuery ? 'full' : 'compressed'})`);
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
        console.log(`🦠 [psi-ema] Clinical report activated for ${ticker} (explicit=${!!hasExplicitPathogen}, detected=${!pathogenResult.healthy})`);
      }
      
      // Physical Audit Disclaimer: "See to believe" infrastructure verification (Dec 23, 2025)
      const physicalAuditDisclaimer = generatePhysicalAuditDisclaimer(analysis, ticker);
      
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
      
      // Derive z label from value
      let zLabel = 'Normal';
      if (zVal != null) {
        const absZ = Math.abs(zVal);
        if (absZ > 3) zLabel = 'Extreme';
        else if (absZ > 2) zLabel = 'High';
        else if (absZ > 1) zLabel = 'Elevated';
      }
      
      // Dynamic outlook based on reading type
      const outlookMap = {
        'False Breakout': 'Watch for mean reversion.',
        'Breathing': 'Trend continuing, momentum sustainable.',
        'Consolidation': 'Sideways movement, wait for breakout.',
        'Local Bottom': 'Potential reversal upward.',
        'Local Top': 'Potential reversal downward.',
        'Reversal': 'Momentum shifting, trend change likely.',
        'Continuation': 'Current trend persisting.',
        'Optimism': 'Positive momentum building.',
        'Fatalism': 'Negative momentum building.',
        'Bull Trend Signal': 'Strong upward momentum confirmed.',
        'Oversold': 'Price below fair value, bounce possible.'
      };
      const outlook = outlookMap[readingText] || 'Monitor for trend development.';
      
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
📊 **Assessment**: ${readingEmoji} ${readingText} — R=${fmtR} (${rLabel}), z=${fmtZ}σ (${zLabel}). ${outlook}
`;
      }
      
      // Build dual-timeframe output (Daily + Weekly) with computation math
      const dailyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelity.grade] || '⚪';
      const weeklyGradeEmoji = { 'A': '🟢', 'B': '🟡', 'C': '🟠', 'D': '🔴' }[fidelityW.grade] || '⚪';
      
      // Helper to format number or N/A
      const fmt = (v, decimals = 2) => (v != null && !isNaN(v)) ? v.toFixed(decimals) : 'N/A';
      
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
├─ θ (Phase) = **${fmt(phaseW.current)}°**
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
├─ θ (Phase) = **${fmt(phase.current)}°**
├─ z (Anomaly) = **${fmt(anomaly.current)}σ**
├─ R (Convergence) = **${fmt(convergence.currentDisplay ?? convergence.current)}**
└─ **Reading**: ${analysis.reading?.emoji || '⚪'} ${analysis.reading?.reading || 'N/A'}
${weeklySection}

${clinicalSection}
${physicalAuditDisclaimer}
`;
      console.log(`📊 Ψ-EMA dual-timeframe instruction injected for ${ticker} (daily + ${analysisWeekly ? 'weekly' : 'weekly unavailable'})`);
    }
    
    // Large attachment chunking: truncate extractedContent to avoid prompt overflow
    const MAX_ATTACHMENT_CHARS = 100000; // 100k chars threshold
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
      console.log(`📎 Combining attachments (${processedContent.length}) + search context`);
      finalPrompt = `${memoryPrefix}UPLOADED ATTACHMENTS (PRIMARY SOURCE - analyze these first):
${processedContent.join('\n\n')}

SUPPLEMENTARY WEB SEARCH (use to verify or add context, NOT to override attachments):
${state.searchContext}

User query: ${query || 'Analyze this content.'}`;
    } else if (hasAttachments) {
      // Attachments only (closed-loop document analysis)
      console.log(`📎 Attachment-only mode: ${processedContent.length} items`);
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
      console.log(`📊 Ψ-EMA: Direct structured output (bypassing LLM reformatting)`);
      state.draftAnswer = `${state.preflight.stockContext}\n${psiEmaInstruction}`;
      state.psiEmaDirectOutput = true; // Flag to skip audit but let output stage run
      console.log(`🧠 Direct output: ${state.draftAnswer.length} chars (no LLM call)`);
      return; // Exit stepReasoning - run() will continue to stepAudit/stepOutput
    }
    
    // For Seed Metric queries: Attempt direct calculation bypass if we have search data
    // Parse price/sqm and income from search results, apply proxy rules deterministically
    const isSeedMetric = state.mode === 'seed-metric';
    if (isSeedMetric && state.searchContext) {
      const cities = state.preflight?.seedMetricSearchQueries?.length > 0
        ? [...new Set(state.preflight.seedMetricSearchQueries.map(q => {
            const match = q.match(/^([a-z\s]+)\s+(?:residential|median|housing)/i);
            return match ? match[1].trim().toLowerCase() : null;
          }).filter(Boolean))]
        : [];
      
      const historicalDecade = state.preflight?.historicalDecade || '1970s';
      
      if (cities.length > 0) {
        console.log(`🏠 Seed Metric: Attempting direct calculation for cities: ${cities.join(', ')}`);
        const parsedData = parseSeedMetricData(state.searchContext, cities, historicalDecade);
        
        // Check if we got usable data (at least one city with current price/income)
        const hasUsableData = Object.values(parsedData.cities).some(c => 
          c.current?.pricePerSqm?.value && c.current?.income?.value
        );
        
        if (hasUsableData) {
          const directTable = buildSeedMetricTable(parsedData, historicalDecade);
          console.log(`🏠 Seed Metric: Direct calculation successful, bypassing LLM`);
          state.draftAnswer = directTable;
          state.seedMetricDirectOutput = true;
          console.log(`🧠 Direct output: ${state.draftAnswer.length} chars (no LLM formatting)`);
          console.log(`📊 Parse log: ${parsedData.parseLog.join(' | ')}`);
          return; // Exit stepReasoning - let stepAudit/stepOutput run
        } else {
          console.log(`⚠️ Seed Metric: Could not parse usable data, falling back to LLM`);
          console.log(`📊 Parse log: ${parsedData.parseLog.join(' | ')}`);
        }
      }
    }
    
    // Append Ψ-EMA instruction to ensure wave analysis is output (fallback if no direct output)
    if (psiEmaInstruction) {
      finalPrompt = `${finalPrompt}\n\n${psiEmaInstruction}`;
    }
    
    // Append Seed Metric instruction to enforce table format (prevents LLM reformatting)
    // isSeedMetric already defined above
    if (isSeedMetric) {
      const seedMetricInstruction = `
═══════════════════════════════════════════════════════════════
SEED METRIC OUTPUT FORMAT - MANDATORY (DO NOT REFORMAT TO PROSE)
═══════════════════════════════════════════════════════════════

You MUST output this exact table. This is non-negotiable empiric data:

| City | Period | 700sqm Price | Income | P/I | Years | Regime |
|------|--------|--------------|--------|-----|-------|--------|
[Fill each city with THEN and NOW rows]

PRIORITY ORDER:
1. PRIMARY: If $/m² available → use 700sqm price ($/m² × 700)
2. FALLBACK: If only raw price/income → use P/I ratio directly

CRITICAL PROXY RULES:
• 700 m² = family home lot (NOT 700 sqft - that's 10x smaller!)
• Convert price/m² × 700 to get 700sqm price
• Use SINGLE-EARNER income (not household/dual)
• Years = 700sqm Price ÷ Income (income years to afford, NOT mortgage term)

⚠️ HALLUCINATION GUARDS - DO NOT:
• Confuse 700 m² with 700 sqft (65 m²) - order of magnitude error
• Use "time to pay off mortgage" - that's mortgage TERM, not affordability
• Write prose paragraphs - TABLE ONLY

REGIME THRESHOLDS:
**Primary (700sqm)** — when $/sqm available:
• 🟢 OPTIMISM: <10 years
• 🟡 EXTRACTION: 10-25 years  
• 🔴 FATALISM: >25 years

**Fallback (raw P/I)** — when only price/income:
• 🟢 OPTIMISM: P/I ≤ 3.5
• 🔴 FATALISM: P/I > 3.5

After table, ONE summary line per city:
**[City]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)

OUTPUT: Table + summary lines + legend. NO PROSE.
═══════════════════════════════════════════════════════════════`;
      finalPrompt = `${finalPrompt}\n\n${seedMetricInstruction}`;
      console.log(`🏠 Seed Metric instruction appended (enforcing table format)`);
    }
    
    const messages = [
      ...state.systemMessages,
      ...sanitizedHistory,
      { role: 'user', content: finalPrompt }
    ];
    
    try {
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
    } catch (err) {
      // Groq API failure after all retries - propagate error, return early to skip audit on junk
      console.error(`❌ [stepReasoning] Groq API failed after 3 retries: ${err.message}`);
      state.error = `Groq API failed: ${err.message}`;
      // Throw to exit pipeline early - caught by run() which returns success:false
      throw new Error(`Groq API exhausted: ${err.message}`);
    }
  }
  
  async stepAudit(state, input) {
    state.transition(PIPELINE_STEPS.AUDIT);
    
    const { query, extractedContent } = input;
    
    // Ψ-EMA direct output: bypass audit (data already pre-verified from yfinance + SEC EDGAR)
    if (state.psiEmaDirectOutput) {
      console.log(`📊 Ψ-EMA direct output - bypassing audit (pre-verified data)`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Pre-verified yfinance + SEC EDGAR data' };
      return;
    }
    
    // Seed Metric direct output: bypass audit (data calculated with deterministic proxy rules)
    if (state.seedMetricDirectOutput) {
      console.log(`🏠 Seed Metric direct output - bypassing audit (proxy math applied)`);
      state.auditResult = { verdict: 'BYPASS', confidence: 95, reason: 'Deterministic $/sqm × 700 proxy calculation' };
      return;
    }
    
    // Seed Metric LLM output: validate format before audit
    // If format is wrong (prose instead of table), try to fix it
    if (state.mode === 'seed-metric' && state.draftAnswer) {
      const validation = validateSeedMetricOutput(state.draftAnswer);
      if (!validation.valid) {
        console.log(`⚠️ Seed Metric format validation FAILED: ${validation.issues.join(', ')}`);
        
        // Try to fix with a format-only prompt
        if (!state.seedMetricFormatRetried) {
          state.seedMetricFormatRetried = true;
          console.log(`🔧 Attempting Seed Metric format fix...`);
          
          try {
            const fixPrompt = `The following response has incorrect format. Fix it to use the EXACT table format shown below.

WRONG RESPONSE:
${state.draftAnswer.slice(0, 2000)}

REQUIRED FORMAT:
| City | Period | 700sqm Price | Income | P/I | Years | Regime |
|------|--------|--------------|--------|-----|-------|--------|
[rows with data]

**[City]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)

RULES:
- Convert price/m² to 700sqm (multiply by 700)
- Use 🟢 for <10yr, 🟡 for 10-25yr, 🔴 for >25yr
- NO prose paragraphs

Output ONLY the corrected table and summary lines:`;

            const response = await this.groqWithRetry({
              url: 'https://api.groq.com/openai/v1/chat/completions',
              data: {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: fixPrompt }],
                temperature: 0.1,
                max_tokens: 800
              },
              config: {
                headers: {
                  'Authorization': `Bearer ${this.groqToken}`,
                  'Content-Type': 'application/json'
                },
                timeout: 10000
              }
            }, 2, 'text');
            
            const fixedAnswer = response.data.choices[0]?.message?.content;
            if (fixedAnswer) {
              const reValidation = validateSeedMetricOutput(fixedAnswer);
              if (reValidation.valid) {
                console.log(`✅ Seed Metric format fix successful`);
                state.draftAnswer = fixedAnswer;
              } else {
                console.log(`❌ Seed Metric format fix still invalid: ${reValidation.issues.join(', ')}`);
                // FALLBACK: Try direct calculation as last resort
                if (state.searchContext && state.preflight?.seedMetricSearchQueries) {
                  console.log(`🔧 Attempting fallback to direct calculation...`);
                  const cities = [...new Set(state.preflight.seedMetricSearchQueries.map(q => {
                    const match = q.match(/^([a-z\s]+)\s+(?:residential|median|housing)/i);
                    return match ? match[1].trim().toLowerCase() : null;
                  }).filter(Boolean))];
                  
                  if (cities.length > 0) {
                    const parsedData = parseSeedMetricData(state.searchContext, cities, state.preflight.historicalDecade || '1970s');
                    const hasUsableData = Object.values(parsedData.cities).some(c => 
                      c.current?.pricePerSqm?.value || c.current?.income?.value
                    );
                    if (hasUsableData) {
                      state.draftAnswer = buildSeedMetricTable(parsedData, state.preflight.historicalDecade || '1970s');
                      console.log(`✅ Seed Metric fallback direct calculation successful`);
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.log(`⚠️ Seed Metric format fix failed: ${err.message}`);
          }
        }
      } else {
        console.log(`✅ Seed Metric format validation passed`);
      }
    }
    
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
    
    try {
      state.auditResult = await runAuditPass(
        this.groqToken,
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
        12000
      );
      console.log(`🔍 Audit: ${state.auditResult.verdict} (${state.auditResult.confidence}%)`);
      
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
      console.log(`⚠️ Audit error: ${err.message}`);
      state.auditResult = { verdict: 'BYPASS', confidence: 70, reason: 'Audit failed' };
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
      console.log(`⏭️ Identity mode: Skip retry (internal docs are ground truth)`);
      return;
    }
    
    if (state.mode === 'psi-ema') {
      console.log(`⏭️ Ψ-EMA: Skip retry (yfinance data pre-verified)`);
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
      console.log(`🖼️ Retry ${state.retryCount}: Image attachment - re-reasoning with vision context (no web search)`);
      await this.stepReasoning(state, reasoningInput);
      await this.stepAudit(state, reasoningInput);
      return;
    }
    
    console.log(`🔄 Retry ${state.retryCount}: Searching for better data...`);
    
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
      console.log(`📋 S6: Chemistry header prepended to output`);
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
    
    console.log(`✅ Output: ${state.finalAnswer.length} chars, mode=${state.mode}`);
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
    if (!answer) return answer;
    
    const { getPersonalityConfig, hasAnySignature } = require('../lib/mode-registry');
    const config = getPersonalityConfig(mode);
    
    let cleaned = answer;
    
    // Registry-driven: skip intro/outro stripping for modes that need it
    if (config.skipIntroOutro) {
      if (config.appendSignature && !hasAnySignature(cleaned)) {
        cleaned = cleaned.trimEnd() + '\n\n' + config.signatureText + ` [${signatureTs}]`;
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
    
    // OUTRO FLUFF: Remove verbose confidence grading sections (95%/80%/<50% tiers)
    const outroFluffPatterns = [
      /###?\s*Confidence Grading\s*\n+(?:[\s\S]*?(?:\*\s*\*\*95%\*\*|\*\s*\*\*80%\*\*|\*\s*\*\*<50%\*\*)[\s\S]*?)+(?=\n*(?:🔥|$))/i,
      /The confidence (?:grading|levels?) (?:for this analysis )?(?:is|are) as follows:\s*\n+(?:\*[^\n]+\n+)+/i,
      /The current analysis has a confidence grade of[^\n]*\n+/i,
    ];
    
    for (const pattern of outroFluffPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // Use unified timestamp from queryTimestamp (single source of truth)
    const signatureWithTs = `${config.signatureText} [${signatureTs}]`;

    // Use regex to detect any existing nyan signature and replace it with the timestamped version
    const anyNyanSigPattern = /🔥\s*(?:~nyan|nyan~)(?:\s*\[.*?\])?/i;

    if (anyNyanSigPattern.test(cleaned)) {
      cleaned = cleaned.replace(anyNyanSigPattern, signatureWithTs);
    } else {
      cleaned = cleaned.trimEnd() + '\n\n' + signatureWithTs;
    }

    return cleaned.trim();
  }

  deriveBadge(auditResult) {
    if (!auditResult || !auditResult.verdict) return 'unverified';
    
    const verdict = auditResult.verdict.toUpperCase();
    
    // API_FAILURE → unavailable (Groq API failed, fallback message shown)
    if (verdict === 'API_FAILURE') {
      return 'unavailable';
    }
    
    // APPROVED, ACCEPTED, BYPASS → verified (web search sourced, identity, or pre-verified data)
    if (verdict === 'APPROVED' || verdict === 'ACCEPTED' || verdict === 'BYPASS') {
      return 'verified';
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
      cleaned = cleaned.trimEnd() + '\n\n' + config.signatureText + ` [${ts}]`;
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
  const signatureWithTs = `${config.signatureText} [${ts}]`;
  
  // Use regex to detect any existing nyan signature and replace it with the timestamped version
  const anyNyanSigPattern = /🔥\s*(?:~nyan|nyan~)(?:\s*\[.*?\])?/i;
  
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
  
  console.log(`⚡ Fast personality: ${formatted.length} chars (regex, no LLM)`);
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
