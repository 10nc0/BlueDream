/**
 * AUDIT PASS UTILITIES
 * 
 * Provides verification infrastructure for the 7-stage pipeline.
 * Complexity: O(tokens) per LLM call, not O(1).
 * 
 * Exported Functions:
 * - runAuditPass(): Single LLM call to verify draft answer (used by pipeline-orchestrator)
 * - runCorrectivePass(): LLM call to fix issues if FIXABLE verdict
 * - formatAuditBadge(): Display helper for audit status
 * - buildRefusalMessage(): Construct rejection messages
 * 
 * Architecture Note (Dec 2025):
 * - Pipeline-orchestrator.js is the primary entry point (7-stage state machine)
 * - This module provides ONLY the audit LLM call, not full orchestration
 * - Personality formatting is handled by regex in pipeline-orchestrator.applyPersonalityFormat()
 */

const axios = require('axios');
const { buildAuditPrompt, buildCorrectivePrompt } = require('../prompts/audit-protocol');
const { getAuditBackend } = require('../config/constants');

const AUDIT_TEMPERATURE = 0.1;

async function runAuditPass(groqToken, draftAnswer, originalQuery, userContext, extensions, timeout) {
  // Accept unified timestamp from pipeline's queryTimestamp or fall back to current time
  const timestamps = extensions.timestamps || {};
  
  const auditPrompt = buildAuditPrompt({
    usesFinancialPhysics: extensions.usesFinancialPhysics,
    usesChemistry: extensions.usesChemistry,
    usesLegalAnalysis: extensions.usesLegalAnalysis,
    usesPsiEMA: extensions.usesPsiEMA,
    isSeedMetric: extensions.isSeedMetric,
    isTetralemma: extensions.isTetralemma,
    auditMode: extensions.auditMode,
    useDialectical: extensions.useDialectical,
    // Pass unified timestamps from pipeline state (single source of truth)
    currentDate: timestamps.isoDate || null,
    currentDateTime: timestamps.isoDateTime || null,
    currentYear: timestamps.year || null
  });

  // Build audit message based on dialectical structure or legacy format
  let auditContent;
  if (extensions.useDialectical && userContext && typeof userContext === 'object') {
    // Dialectical format: thesis/antithesis/synthesis structure
    auditContent = `═══════════════════════════════════════════════════════════════
(I) THESIS — Known Facts & Sources
═══════════════════════════════════════════════════════════════
${userContext.thesis || 'No external sources used (LLM knowledge only)'}

═══════════════════════════════════════════════════════════════
(II) ANTITHESIS — User Query
═══════════════════════════════════════════════════════════════
${userContext.antithesis || originalQuery}

═══════════════════════════════════════════════════════════════
(III) SYNTHESIS — Draft Answer to Audit
═══════════════════════════════════════════════════════════════
${draftAnswer}

Perform the dialectical audit and output JSON only.`;
  } else {
    // Legacy flat format
    auditContent = `ORIGINAL QUERY:\n${originalQuery}\n\nCONTEXT PROVIDED:\n${userContext || 'None'}\n\nDRAFT ANSWER TO AUDIT:\n${draftAnswer}\n\nPerform the audit and output JSON only.`;
  }

  const auditMessages = [
    { role: 'system', content: auditPrompt },
    { role: 'user', content: auditContent }
  ];

  try {
    const auditBackend = getAuditBackend();
    const isReasoner = auditBackend.model.includes('reasoner');

    const requestBody = {
      model: auditBackend.model,
      messages: auditMessages,
      max_tokens: 800,
      ...(isReasoner
        ? { temperature: 1 }
        : { temperature: AUDIT_TEMPERATURE, response_format: { type: 'json_object' } }
      )
    };

    const _auditStart = Date.now();
    const response = await axios.post(
      auditBackend.url,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${groqToken}`,
          'Content-Type': 'application/json'
        },
        timeout: timeout || auditBackend.timeouts.audit
      }
    );
    const _auditElapsed = ((Date.now() - _auditStart) / 1000).toFixed(1);
    console.log(`🧠 ${isReasoner ? 'DeepSeek R1' : 'Groq Llama'} audit responded in ${_auditElapsed}s`);

    let rawContent = response.data.choices?.[0]?.message?.content || '{}';

    if (isReasoner) {
      const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)```/) ||
                        rawContent.match(/(\{[\s\S]*\})/);
      rawContent = jsonMatch ? jsonMatch[1].trim() : rawContent;
    }

    const auditContent = rawContent;
    
    let parsed;
    try {
      parsed = JSON.parse(auditContent);
    } catch (parseError) {
      console.warn('⚠️ Audit JSON parse failed');
      return {
        verdict: 'REJECTED',
        confidence: 0,
        checksPass: [],
        issues: [{ severity: 'CRITICAL', reason: 'Failed to parse audit results' }],
        suggestedFixes: [],
        error: 'JSON_PARSE_ERROR'
      };
    }

    // Verdict Validation: Ensure verdict is one of the allowed types
    const allowedVerdicts = ['APPROVED', 'FIXABLE', 'REJECTED', 'BYPASS'];
    const verdict = (parsed.verdict || 'REJECTED').toUpperCase();
    
    if (!allowedVerdicts.includes(verdict)) {
      console.warn(`⚠️ Invalid audit verdict detected: "${verdict}" - falling back to REJECTED`);
      return {
        verdict: 'REJECTED',
        confidence: parsed.confidence || 0,
        checksPass: parsed.checksPass || [],
        issues: [...(parsed.issues || []), { severity: 'CRITICAL', reason: 'Invalid verification verdict returned' }],
        suggestedFixes: parsed.suggestedFixes || [],
        error: 'INVALID_VERDICT'
      };
    }

    return {
      verdict: verdict,
      confidence: parsed.confidence || 80,
      checksPass: parsed.checksPass || [],
      issues: parsed.issues || [],
      suggestedFixes: parsed.suggestedFixes || [],
      dialecticalAnalysis: parsed.dialecticalAnalysis || null
    };
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.message === 'aborted' || err.code === 'ECONNRESET') {
      console.error(`⏱️ Audit Pass Timeout/Reset - Bypassing verification`);
      return { 
        verdict: 'BYPASS', 
        confidence: 0, 
        reason: 'Audit timed out — second pass never ran', 
        issues: [{ severity: 'HIGH', reason: 'Verification timed out' }],
        error: 'AUDIT_TIMEOUT'
      };
    }
    console.error(`❌ Audit Pass Error: ${err.message}`);
    // Error Propagation: Skip safely with BYPASS instead of defaulting to APPROVED
    return { 
      verdict: 'BYPASS', 
      confidence: 0, 
      reason: `Audit network error: ${err.message}`, 
      issues: [{ severity: 'HIGH', reason: 'Verification service unavailable' }],
      error: 'AUDIT_NETWORK_ERROR'
    };
  }
}

async function runCorrectivePass(groqToken, draftAnswer, originalQuery, issues, maxTokens, timeout) {
  const correctivePrompt = buildCorrectivePrompt(originalQuery, draftAnswer, issues);

  const correctiveBackend = getAuditBackend();
  const isCorrectiveReasoner = correctiveBackend.model.includes('reasoner');
  const response = await axios.post(
    correctiveBackend.url,
    {
      model: correctiveBackend.model,
      messages: [
        { role: 'system', content: 'You are correcting an AI answer based on audit feedback. Output the corrected answer only.' },
        { role: 'user', content: correctivePrompt }
      ],
      temperature: isCorrectiveReasoner ? 1 : 0.15,
      max_tokens: maxTokens
    },
    {
      headers: {
        'Authorization': `Bearer ${groqToken}`,
        'Content-Type': 'application/json'
      },
      timeout
    }
  );

  return response.data.choices?.[0]?.message?.content || draftAnswer;
}

function buildRefusalMessage(issues) {
  const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
  
  // Issue Severity Handling: If no CRITICAL but HIGH issues exist, surface them for better feedback
  if (criticalIssues.length === 0) {
    const highIssues = issues.filter(i => i.severity === 'HIGH');
    if (highIssues.length > 0) {
      const highList = highIssues
        .slice(0, 2)
        .map(i => `• ${i.reason}`)
        .join('\n');
      
      return `🔴 **Verification Failed**\n\nI detected potential issues that prevented verification:\n${highList}\n\n🔥 nyan~`;
    }
    return "🔴 **Verification Failed**\n\nI couldn't verify my answer meets quality standards. Please rephrase your question or provide more context.\n\n🔥 nyan~";
  }

  const issueList = criticalIssues
    .slice(0, 3)
    .map(i => `• ${i.reason}`)
    .join('\n');

  return `🔴 **Verification Failed**

I detected issues that could lead to incorrect information:
${issueList}

**What you can do:**
- Provide more specific context or data
- Ask a more focused question
- Upload relevant documents for analysis

Refusing to answer is better than giving wrong information.
🔥 nyan~`;
}

function formatAuditBadge(badge, confidence) {
  const badges = {
    verified: `🟢 Verified (${confidence}% confidence)`,
    corrected: `🟡 Corrected (${confidence}% confidence)`,
    refused: `🔴 Refused`,
    unverified: `⚪ Unverified`,
    bypass: `⚪ Bypass`
  };
  return badges[badge] || badges.unverified;
}

module.exports = {
  runAuditPass,
  runCorrectivePass,
  buildRefusalMessage,
  formatAuditBadge
};
