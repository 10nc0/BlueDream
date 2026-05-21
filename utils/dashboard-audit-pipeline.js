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

// ==================== S2: Retry ====================

function buildRetryHints(mismatches) {
  const hints = mismatches.map(m => 
    `- ${m.entity}: You claimed ${m.claimed}, but only ${m.actual} instance(s) shown in your response`
  ).join('\n');
  
  return `
CORRECTION REQUIRED - COUNT MISMATCH DETECTED:
${hints}

Please revise your response to ensure the counts match the actual instances you list.
If you list 4 instances, say "4 kali", not "7 kali".
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
    tz
  });
  
  pipelineLog.push(`S0: Received ${engine} response (${initialResponse.length} chars)`);
  pipelineLog.push(`S0: Capsule hydrated - ${contextMessages.length} messages, ${Object.keys(entityAggregates).length} aggregates, ${capsule.tallyByEntity.size} unique entities`);
  if (capsule.scopeApplied) {
    const s = capsule.scope;
    pipelineLog.push(`S0: Independent scope re-derived from query — date(${s.datePatterns.length}) action(${s.actionKeywords.length}) plate(${s.plates.length}) sender(${s.senders.length})`);
  }
  
  capsule.extractClaimsFromResponse(initialResponse);
  capsule.verify();
  
  const scopeViolations = capsule.corrections.filter(c => c.scopeFilterViolation).length;
  if (scopeViolations > 0) {
    pipelineLog.push(`S1: Verify - ${scopeViolations} scope_filter_violation(s) — verifier's independent scope disagreed with the LLM's working set`);
  }
  
  const capsuleStatus = capsule.getStatus();
  pipelineLog.push(`S1: Verify - ${capsuleStatus.claimCount} claims, ${capsule.corrections.length} mismatches, ${capsule.unverifiable.length} unverifiable`);
  
  if (!capsuleStatus.contextSize && !capsuleStatus.hasAggregates) {
    const hasClaims = capsuleStatus.claimCount > 0;
    pipelineLog.push(`S3: Deliver - No context available, ${hasClaims ? 'claims exist but cannot verify' : 'no claims detected'}`);
    destroyCapsule(capsuleId);
    return {
      text: initialResponse,
      corrected: false,
      corrections: [],
      unverifiable: hasClaims ? capsule.claimsExtracted : [],
      needsHumanReview: hasClaims,
      noContext: true,
      verified: null,
      confidence: {
        score: hasClaims ? 50 : 100,
        rationale: hasClaims ? 'Claims detected but no context available to verify counts' : 'No verifiable claims detected in response'
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
      capsule.corrections.map(c => ({ entity: c.entity, claimed: c.claimedCount, actual: c.actual })),
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
        tz
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
