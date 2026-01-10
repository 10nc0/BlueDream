/**
 * DASHBOARD AUDIT PIPELINE
 * 
 * 4-stage self-auditing pipeline for dashboard AI responses (Prometheus & Nyan AI)
 * Reduces hallucination by verifying counts before output
 * 
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ S0: Reason   │ Existing LLM call, capture context                  │
 * │ S1: Verify   │ Extract claims, tally instances, detect mismatches  │
 * │ S2: Retry    │ Re-prompt with hints (max 1 attempt, lower temp)    │
 * │ S3: Deliver  │ Deterministic fallback patch if retry fails         │
 * └────────────────────────────────────────────────────────────────────┘
 */

const { AUDIT } = require('../config/constants');
const { createCapsule, destroyCapsule } = require('./audit-capsule');

// ==================== Entity Extractors ====================

const ENTITY_PATTERNS = {
  indonesianPlate: /\b(B[A-Z])\s*(\d{4})\s*([A-Z]{2,3})\b/gi,
  genericCount: /(\d+)\s*(kali|times?|x)\b/gi
};

function extractPlates(text) {
  const plates = [];
  const regex = /\b(B[A-Z])\s*(\d{4})\s*([A-Z]{2,3})\b/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const normalized = `${match[1].toUpperCase()} ${match[2]} ${match[3].toUpperCase()}`;
    plates.push(normalized);
  }
  return plates;
}

function normalizeEntity(entity) {
  return entity.toUpperCase().replace(/\s+/g, ' ').trim();
}

// ==================== S1: Verify ====================

function extractClaimsFromResponse(responseText) {
  const claims = [];
  
  const lines = responseText.split('\n');
  for (const line of lines) {
    const plates = extractPlates(line);
    
    const countMatch = line.match(/\((\d+)\s*kali/i) || 
                       line.match(/(\d+)\s*kali\s*(perbaikan|repair)/i) ||
                       line.match(/:\s*(\d+)\s*(times?|kali)/i);
    
    if (plates.length > 0 && countMatch) {
      const claimedCount = parseInt(countMatch[1], 10);
      for (const plate of plates) {
        claims.push({
          entity: normalizeEntity(plate),
          claimedCount,
          line: line.trim()
        });
      }
    }
  }
  
  return claims;
}

function countEntityInContext(contextMessages, entity) {
  const normalized = normalizeEntity(entity);
  let count = 0;
  
  for (const msg of contextMessages) {
    const content = msg.content || msg.text || '';
    const escapedEntity = normalized.replace(/\s+/g, '\\s*');
    const regex = new RegExp(escapedEntity, 'gi');
    const matches = content.match(regex);
    if (matches) {
      count += matches.length;
    }
  }
  
  return count;
}

function countEntityInResponse(responseText, entity) {
  const normalized = normalizeEntity(entity);
  const escapedEntity = normalized.replace(/\s+/g, '\\s*');
  const regex = new RegExp(escapedEntity, 'gi');
  
  let count = 0;
  const lines = responseText.split('\n');
  for (const line of lines) {
    if (line.includes('[') || line.includes('2025-') || line.includes('2024-') || line.includes('2026-')) {
      const matches = line.match(regex);
      if (matches) {
        count += matches.length;
      }
    }
  }
  
  return count;
}

function verifyResponse(responseText, contextMessages = [], entityAggregates = {}) {
  const claims = extractClaimsFromResponse(responseText);
  const mismatches = [];
  const unverifiable = [];
  
  const hasContext = contextMessages.length > 0;
  const hasAggregates = Object.keys(entityAggregates).length > 0;
  
  if (!hasContext && !hasAggregates) {
    return {
      passed: true,
      claims,
      mismatches: [],
      unverifiable: claims.length > 0 ? claims : [],
      hasContext: false,
      hasAggregates: false
    };
  }
  
  for (const claim of claims) {
    let actualCount = 0;
    let verificationSource = null;
    
    if (hasAggregates && entityAggregates[claim.entity]) {
      actualCount = entityAggregates[claim.entity].count || entityAggregates[claim.entity];
      verificationSource = 'aggregates';
    } else if (hasContext) {
      actualCount = countEntityInContext(contextMessages, claim.entity);
      verificationSource = 'context';
    }
    
    if (claim.claimedCount !== actualCount) {
      if (actualCount === 0) {
        unverifiable.push({
          entity: claim.entity,
          claimed: claim.claimedCount,
          actual: 0,
          line: claim.line,
          reason: 'Entity not found in context - cannot verify'
        });
      } else {
        mismatches.push({
          entity: claim.entity,
          claimed: claim.claimedCount,
          actual: actualCount,
          line: claim.line,
          verificationSource
        });
      }
    }
  }
  
  return {
    passed: mismatches.length === 0 && unverifiable.length === 0,
    claims,
    mismatches,
    unverifiable,
    hasContext,
    hasAggregates
  };
}

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
      temperature: 0.1,
      isRetry: true
    };
    
    const retryResult = await llmCallFn(retryPrompt, retryOptions);
    return retryResult;
  } catch (error) {
    console.warn(`⚠️ Dashboard audit retry failed:`, error.message);
    return null;
  }
}

// ==================== S3: Deliver ====================

function applyDeterministicCorrections(responseText, mismatches) {
  let correctedText = responseText;
  const corrections = [];
  
  for (const mismatch of mismatches) {
    const patterns = [
      new RegExp(`\\(${mismatch.claimed}\\s*kali`, 'gi'),
      new RegExp(`${mismatch.claimed}\\s*kali\\s*(perbaikan|repair)`, 'gi'),
      new RegExp(`:\\s*${mismatch.claimed}\\s*(times?|kali)`, 'gi')
    ];
    
    for (const pattern of patterns) {
      const originalText = correctedText;
      correctedText = correctedText.replace(pattern, (match) => {
        return match.replace(String(mismatch.claimed), String(mismatch.actual));
      });
      
      if (correctedText !== originalText) {
        corrections.push({
          entity: mismatch.entity,
          from: mismatch.claimed,
          to: mismatch.actual
        });
        break;
      }
    }
  }
  
  return { correctedText, corrections };
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
  requestId = null
}) {
  const startTime = Date.now();
  const capsuleId = requestId || `${engine}-${Date.now()}`;
  const capsule = createCapsule(capsuleId, engine);
  const pipelineLog = [];
  
  const flatAggregates = Object.fromEntries(
    Object.entries(entityAggregates).map(([k, v]) => [k, typeof v === 'object' ? v.count : v])
  );
  
  capsule.hydrate({ contextMessages, aggregates: flatAggregates });
  
  pipelineLog.push(`S0: Received ${engine} response (${initialResponse.length} chars)`);
  pipelineLog.push(`S0: Capsule hydrated - ${contextMessages.length} messages, ${Object.keys(entityAggregates).length} aggregates, ${capsule.tallyByEntity.size} unique entities`);
  
  capsule.extractClaimsFromResponse(initialResponse);
  capsule.verify();
  
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
      retryCapsule.hydrate({ contextMessages, aggregates: flatAggregates });
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
            verified: false,
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
          verified: false,
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
    verified: false,
    pipelineLog,
    latencyMs: Date.now() - startTime
  };
}

// ==================== Exports ====================

module.exports = {
  runDashboardAuditPipeline,
  verifyResponse,
  extractClaimsFromResponse,
  countEntityInContext,
  countEntityInResponse,
  applyDeterministicCorrections,
  extractPlates,
  normalizeEntity,
  ENTITY_PATTERNS
};
