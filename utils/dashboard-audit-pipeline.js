/**
 * DASHBOARD AUDIT PIPELINE
 * 
 * 4-stage self-auditing pipeline for dashboard AI responses (Nyan AI)
 * Reduces hallucination by verifying counts before output
 * 
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ S0: Reason   │ Existing LLM call, capture context                  │
 * │ S1: Verify   │ Extract claims, tally instances, detect mismatches  │
 * │ S2: Retry    │ Re-prompt with hints (max 1 attempt, lower temp)    │
 * │ S3: Deliver  │ Deterministic fallback patch if retry fails         │
 * └────────────────────────────────────────────────────────────────────┘
 */

const { AI_MODELS } = require('../config/constants');
const { createCapsule, destroyCapsule } = require('./audit-capsule');
const logger = require('../lib/logger');

// ==================== S2: Retry ====================

function buildRetryHints(mismatches) {
  // Mismatches may be a mix of scope-tally shape ({entity, claimed, actual})
  // and tool-claim shape ({kind:'tool_claim', claim, citedSource,
  // nearestMatch}).  Render each kind in its own bullet so the retry prompt
  // tells the LLM precisely what went wrong on each line.
  const hints = mismatches.map(m => {
    if (m.kind === 'tool_claim') {
      const where = m.citedSource
        ? `the ${m.citedSource} result you cited`
        : `any of the tool results you were given`;
      const near = (m.nearestMatch !== null && m.nearestMatch !== undefined)
        ? ` Nearest value present: ${m.nearestMatch}.`
        : '';
      return `- Unsupported number "${m.claim?.raw ?? m.claim?.value}" (${m.claim?.kind}): not found in ${where}.${near}`;
    }
    return `- ${m.entity}: You claimed ${m.claimed}, but only ${m.actual} instance(s) shown in your response`;
  }).join('\n');
  
  return `
CORRECTION REQUIRED - VERIFICATION MISMATCH DETECTED:
${hints}

Please revise your response so every numeric claim matches what the source data actually shows. For tool-result citations, only quote numbers that literally appear in the cited tool result. If a number cannot be verified, remove it rather than guessing.
`;
}

async function retryWithHints(originalQuery, originalResponse, mismatches, llmCallFn, options = {}) {
  const hints = buildRetryHints(mismatches);
  
  const retryPrompt = `${originalQuery}

[SYSTEM AUDIT FEEDBACK]
Your previous response had count mismatches:
${hints}

Please provide a corrected response with accurate counts that match the instances you list.`;

  try {
    const retryOptions = {
      ...options,
      temperature: AI_MODELS.TEMPERATURE_PRECISE,
      isRetry: true
    };
    
    const retryResult = await llmCallFn(retryPrompt, retryOptions);
    return retryResult;
  } catch (error) {
    console.warn(`⚠️ Dashboard audit retry failed:`, error.message);
    return null;
  }
}

// ==================== Pipeline Orchestrator ====================

async function runDashboardAuditPipeline({
  query,
  initialResponse,
  contextMessages = [],
  entityAggregates = {},
  toolResults = [],
  llmCallFn = null,
  engine = 'unknown',
  maxRetries = 1,
  requestId = null,
  now = null,
  tz = null
}) {
  const startTime = Date.now();
  const capsuleId = requestId || `${engine}-${Date.now()}`;
  const capsule = createCapsule(capsuleId, engine);
  const pipelineLog = [];
  
  const flatAggregates = Object.fromEntries(
    Object.entries(entityAggregates).map(([k, v]) => [k, typeof v === 'object' ? v.count : v])
  );
  
  // Pass the rich aggregate form (with per-entity .messages[] timestamps from C3)
  // alongside the flat form. The verifier uses richAggregates to independently
  // re-derive scoped counts from the user query, catching cases where the
  // upstream chain's filtering didn't honor the query's date/action/sender
  // intent (cf. Task #169 regression class).
  capsule.hydrate({
    contextMessages,
    aggregates: flatAggregates,
    richAggregates: entityAggregates,
    query,
    now,
    tz,
    toolResults
  });
  
  pipelineLog.push(`S0: Received ${engine} response (${initialResponse.length} chars)`);
  pipelineLog.push(`S0: Capsule hydrated - ${contextMessages.length} messages, ${Object.keys(entityAggregates).length} aggregates, ${capsule.tallyByEntity.size} unique entities`);
  if (capsule.scopeApplied) {
    const s = capsule.scope;
    pipelineLog.push(`S0: Independent scope re-derived from query — date(${s.datePatterns.length}) action(${s.actionKeywords.length}) plate(${s.plates.length}) sender(${s.senders.length})`);
  }
  
  capsule.extractClaimsFromResponse(initialResponse);
  capsule.verify();
  
  // ── Cross-source verifier observability (Task #228) ───────────────────────
  // Single log line per query so prod can grep & dashboard easily.
  // claims_extracted counts numeric claims pulled from the response;
  // divergent counts those that failed the tool-result cross-check;
  // verified  = claims_extracted - divergent.
  // retried   = whether the existing S2 retry path will fire below.
  {
    const claimsExtracted = capsule.toolClaims.length;
    const divergent = capsule.corrections.filter(c => c.kind === 'tool_claim').length;
    const verified = Math.max(0, claimsExtracted - divergent);
    const willRetry = !!(llmCallFn && maxRetries > 0 && capsule.corrections.length > 0);
    logger.info(
      `🔍 Verifier: claims_extracted=${claimsExtracted}, verified=${verified}, divergent=${divergent}, retried=${willRetry}, tool_results=${toolResults.length}, engine=${engine}`
    );
  }
  
  const scopeViolations = capsule.corrections.filter(c => c.scopeFilterViolation).length;
  if (scopeViolations > 0) {
    pipelineLog.push(`S1: Verify - ${scopeViolations} scope_filter_violation(s) — verifier's independent scope disagreed with the LLM's working set`);
  }
  
  const capsuleStatus = capsule.getStatus();
  pipelineLog.push(`S1: Verify - ${capsuleStatus.claimCount} claims, ${capsule.corrections.length} mismatches, ${capsule.unverifiable.length} unverifiable`);
  
  if (!capsuleStatus.contextSize && !capsuleStatus.hasAggregates) {
    const hasClaims = capsuleStatus.claimCount > 0;
    // Tool-claim mismatches (Task #228) are independent of book context —
    // they survive the no-context branch and must surface here even when
    // entity-count verification is impossible.
    const toolMismatches = (capsule.corrections || []).filter(c => c.kind === 'tool_claim');
    const hasToolMismatch = toolMismatches.length > 0;
    pipelineLog.push(`S3: Deliver - No context available, ${hasClaims ? 'entity claims unverifiable' : 'no entity claims'}${hasToolMismatch ? `, ${toolMismatches.length} tool-claim mismatch(es) surfaced` : ''}`);
    destroyCapsule(capsuleId);
    return {
      text: initialResponse,
      corrected: false,
      corrections: toolMismatches,
      unverifiable: hasClaims ? capsule.claimsExtracted : [],
      needsHumanReview: hasClaims || hasToolMismatch,
      noContext: true,
      verified: hasToolMismatch ? false : null,
      confidence: {
        score: hasToolMismatch ? 20 : (hasClaims ? 50 : 100),
        rationale: hasToolMismatch
          ? `Tool-claim mismatch detected (${toolMismatches.length}) — number not found in cited source`
          : (hasClaims ? 'Claims detected but no context available to verify counts' : 'No verifiable claims detected in response')
      },
      pipelineLog,
      latencyMs: Date.now() - startTime
    };
  }
  
  if (capsule.verified === true) {
    pipelineLog.push(`S3: Deliver - All claims verified, no corrections needed`);
    destroyCapsule(capsuleId);
    return {
      text: initialResponse,
      corrected: false,
      corrections: [],
      verified: true,
      confidence: {
        score: 100,
        rationale: `Verified ${capsuleStatus.claimCount} claims against source data`
      },
      pipelineLog,
      latencyMs: Date.now() - startTime
    };
  }
  
  if (capsule.unverifiable.length > 0 && capsule.corrections.length === 0) {
    pipelineLog.push(`S3: Deliver - ${capsule.unverifiable.length} claims cannot be verified (entities not in context)`);
    destroyCapsule(capsuleId);
    return {
      text: initialResponse,
      corrected: false,
      corrections: [],
      unverifiable: capsule.unverifiable,
      needsHumanReview: true,
      verified: false,
      confidence: {
        score: Math.max(0, Math.floor(100 * (capsuleStatus.claimCount - capsule.unverifiable.length) / Math.max(1, capsuleStatus.claimCount))),
        rationale: `${capsule.unverifiable.length} claims were unverifiable against the provided context`
      },
      pipelineLog,
      latencyMs: Date.now() - startTime
    };
  }
  
  if (llmCallFn && maxRetries > 0 && capsule.corrections.length > 0) {
    pipelineLog.push(`S2: Retry - Attempting correction with hints`);
    
    const retryHints = capsule.getRetryHints();
    const retryResponse = await retryWithHints(
      query,
      initialResponse,
      capsule.corrections.map(c => c.kind === 'tool_claim'
        ? { kind: 'tool_claim', claim: c.claim, citedSource: c.citedSource, nearestMatch: c.nearestMatch }
        : { kind: 'scope_tally', entity: c.entity, claimed: c.claimedCount, actual: c.actual }),
      llmCallFn,
      { engine }
    );
    
    if (retryResponse) {
      const retryCapsule = createCapsule(`${capsuleId}-retry`, engine);
      retryCapsule.hydrate({
        contextMessages,
        aggregates: flatAggregates,
        richAggregates: entityAggregates,
        query,
        now,
        tz,
        toolResults
      });
      retryCapsule.extractClaimsFromResponse(retryResponse);
      retryCapsule.verify();
      
      if (retryCapsule.verified === true || retryCapsule.corrections.length < capsule.corrections.length) {
        pipelineLog.push(`S3: Deliver - Retry successful, ${retryCapsule.corrections.length} remaining mismatches`);
        
        if (retryCapsule.verified === true) {
          destroyCapsule(`${capsuleId}-retry`);
          destroyCapsule(capsuleId);
          return {
            text: retryResponse,
            corrected: true,
            correctionMethod: 'retry',
            corrections: capsule.corrections.map(m => ({
              entity: m.entity,
              from: m.claimedCount,
              to: m.actual
            })),
            verified: true,
            confidence: {
              score: 100,
              rationale: 'Counts corrected via AI retry and verified against source data'
            },
            pipelineLog,
            latencyMs: Date.now() - startTime
          };
        }
        
        const correctedRetryText = retryCapsule.applyCorrections(retryResponse);
        const retryCorrections = retryCapsule.corrections;
        
        pipelineLog.push(`S3: Deliver - Applied ${retryCorrections.length} deterministic corrections to retry`);
        destroyCapsule(`${capsuleId}-retry`);
        destroyCapsule(capsuleId);
        
        return {
          text: correctedRetryText,
          corrected: true,
          correctionMethod: 'retry+patch',
          corrections: retryCorrections,
          verified: true,
          confidence: {
            score: 100,
            rationale: 'Counts corrected via AI retry and deterministic patching'
          },
          pipelineLog,
          latencyMs: Date.now() - startTime
        };
      }
      destroyCapsule(`${capsuleId}-retry`);
    }
    
    pipelineLog.push(`S2: Retry - Failed or no improvement, falling back to deterministic patch`);
  }
  
  const correctedText = capsule.applyCorrections(initialResponse);
  const finalStatus = capsule.getStatus();
  
  if (!finalStatus.corrected && capsule.unverifiable.length > 0) {
    pipelineLog.push(`S3: Deliver - No correctable mismatches (all require human review)`);
    destroyCapsule(capsuleId);
    return {
      text: initialResponse,
      corrected: false,
      corrections: [],
      unverifiable: capsule.unverifiable,
      needsHumanReview: true,
      verified: false,
      pipelineLog,
      latencyMs: Date.now() - startTime
    };
  }
  
  pipelineLog.push(`S3: Deliver - Applied ${finalStatus.corrections.length} deterministic corrections`);
  destroyCapsule(capsuleId);
  
  return {
    text: correctedText,
    corrected: finalStatus.corrected,
    correctionMethod: 'patch',
    corrections: finalStatus.corrections,
    unverifiable: capsule.unverifiable,
    needsHumanReview: capsule.unverifiable.length > 0,
    verified: true,
    confidence: {
      score: 100,
      rationale: 'Counts verified and corrected via deterministic patching'
    },
    pipelineLog,
    latencyMs: Date.now() - startTime
  };
}

// ==================== Exports ====================

module.exports = {
  runDashboardAuditPipeline
};
