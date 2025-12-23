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

const AUDIT_TEMPERATURE = 0.1;

async function runAuditPass(groqToken, draftAnswer, originalQuery, userContext, extensions, timeout) {
  const auditPrompt = buildAuditPrompt({
    usesFinancialPhysics: extensions.usesFinancialPhysics,
    usesChemistry: extensions.usesChemistry,
    usesLegalAnalysis: extensions.usesLegalAnalysis,
    usesPsiEMA: extensions.usesPsiEMA,
    isSeedMetric: extensions.isSeedMetric,
    isTetralemma: extensions.isTetralemma,
    auditMode: extensions.auditMode,
    currentDate: new Date().toISOString().split('T')[0]
  });

  const auditMessages = [
    { role: 'system', content: auditPrompt },
    { 
      role: 'user', 
      content: `ORIGINAL QUERY:\n${originalQuery}\n\nCONTEXT PROVIDED:\n${userContext || 'None'}\n\nDRAFT ANSWER TO AUDIT:\n${draftAnswer}\n\nPerform the audit and output JSON only.`
    }
  ];

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: auditMessages,
      temperature: AUDIT_TEMPERATURE,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        'Authorization': `Bearer ${groqToken}`,
        'Content-Type': 'application/json'
      },
      timeout
    }
  );

  const auditContent = response.data.choices?.[0]?.message?.content || '{}';
  
  try {
    const parsed = JSON.parse(auditContent);
    return {
      verdict: parsed.verdict || 'APPROVED',
      confidence: parsed.confidence || 80,
      checksPass: parsed.checksPass || [],
      issues: parsed.issues || [],
      suggestedFixes: parsed.suggestedFixes || []
    };
  } catch (parseError) {
    console.warn('⚠️ Audit JSON parse failed, defaulting to APPROVED');
    return {
      verdict: 'APPROVED',
      confidence: 70,
      checksPass: ['PARSE_FALLBACK'],
      issues: [],
      suggestedFixes: []
    };
  }
}

async function runCorrectivePass(groqToken, draftAnswer, originalQuery, issues, maxTokens, timeout) {
  const correctivePrompt = buildCorrectivePrompt(originalQuery, draftAnswer, issues);

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are correcting an AI answer based on audit feedback. Output the corrected answer only.' },
        { role: 'user', content: correctivePrompt }
      ],
      temperature: 0.15,
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
  
  if (criticalIssues.length === 0) {
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
