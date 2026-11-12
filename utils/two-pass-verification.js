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

const logger = require('../lib/logger');
const axios = require('axios');
const { buildAuditPrompt, buildCorrectivePrompt } = require('../prompts/audit-protocol');
const { getAuditBackend, AI_MODELS } = require('../config/constants');
const { BRAND } = require('../config/brand');
const { completionMetadata } = require('../lib/llm-completion');

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'confidence', 'checksPass', 'issues', 'suggestedFixes', 'dialecticalAnalysis'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'FIXABLE', 'REJECTED'] },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    checksPass: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['severity', 'layer', 'check', 'quote', 'reason'],
      properties: {
        severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MAJOR', 'MINOR'] },
        layer: { type: 'string', enum: ['THESIS', 'ANTITHESIS', 'SYNTHESIS'] },
        check: { type: 'string' }, quote: { type: 'string' }, reason: { type: 'string' }
      }
    } },
    suggestedFixes: { type: 'array', items: { type: 'string' } },
    dialecticalAnalysis: {
      type: 'object', additionalProperties: false,
      required: ['thesisGrounding', 'antithesisResolution', 'synthesisIntegrity'],
      properties: {
        thesisGrounding: { type: 'string', enum: ['STRONG', 'WEAK', 'NONE'] },
        antithesisResolution: { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'NONE'] },
        synthesisIntegrity: { type: 'string', enum: ['SOUND', 'FLAWED'] }
      }
    }
  }
};


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
    { role: 'system', content: auditPrompt.replace(/[═─]{3,}/g, '---').replace(/\n{3,}/g, '\n\n') },
    { role: 'user', content: auditContent.replace(/[═─]{3,}/g, '---') }
  ];

  try {
    const auditBackend = getAuditBackend();
    const isReasoner = auditBackend.model.includes('reasoner');
    const isOpenRouter = auditBackend.url.includes('openrouter.ai');
    // Groq's GPT-OSS models currently return HTTP 400/json_validate_failed
    // when response_format=json_object is enabled. They do reliably follow
    // JSON-only instructions, so treat them like other text-JSON backends.
    const isGptOss = auditBackend.model.includes('gpt-oss');
    const isKimi = auditBackend.model.includes('kimi');
    const usesTextJson = isReasoner || isKimi || isGptOss;
    const _auditLabel = auditBackend.model;

    // Muse Ember supports response_format, so keep strict JSON mode.
    const requestBody = {
      model: auditBackend.model,
      messages: auditMessages,
      max_tokens: 800,
      // Keep the existing spend ceiling; max reasoning otherwise consumes it.
      ...(isOpenRouter ? { reasoning: { effort: 'minimal' } } : {}),
      ...(isReasoner
        ? { temperature: AI_MODELS.TEMPERATURE_DEEPSEEK }
        : usesTextJson
          ? { temperature: AI_MODELS.TEMPERATURE_PRECISE }
          : { temperature: AI_MODELS.TEMPERATURE_PRECISE, response_format: isOpenRouter
            ? { type: 'json_schema', json_schema: { name: 'answer_audit', strict: true, schema: AUDIT_SCHEMA } }
            : { type: 'json_object' } }
      ),
      ...(extensions.provider ? { provider: extensions.provider } : {})
    };

    const auditHeaders = {
      'Authorization': `Bearer ${groqToken}`,
      'Content-Type': 'application/json',
      ...(isOpenRouter ? {
        'HTTP-Referer': BRAND.openrouterReferer,
        'X-Title': BRAND.openrouterTitle
      } : {})
    };

    // Inner helper — make the actual audit HTTP call
    const _doAuditCall = async (url, body, headers, timeoutMs) => {
      const t0 = Date.now();
      const resp = await axios.post(url, body, { headers, timeout: timeoutMs });
      logger.debug(`🧠 ${_auditLabel} audit responded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return resp;
    };

    let response;
    let responseUsesTextJson = usesTextJson;
    try {
      response = await _doAuditCall(
        auditBackend.url, requestBody, auditHeaders,
        timeout || auditBackend.timeouts.audit
      );
      extensions.onProviderResponse?.({
        model: response.data?.model || auditBackend.model,
        usage: response.data?.usage || null
      });
      if (response.data?.usage) logger.debug(`AI audit usage ${JSON.stringify({
        promptTokens: response.data.usage.prompt_tokens, completionTokens: response.data.usage.completion_tokens
      })}`);
    } catch (primaryErr) {
      if (extensions.noFallback) throw primaryErr;
      // Fallback: if the primary backend (Kimi/OpenRouter) failed for any
      // non-timeout reason, retry once on Groq Llama so the audit still runs.
      // Timeouts propagate as-is (user already waiting long enough).
      const isTimeout = primaryErr.code === 'ECONNABORTED'
        || primaryErr.message?.includes('timeout')
        || primaryErr.code === 'ECONNRESET';
      if (isTimeout) throw primaryErr;   // let outer catch handle it

      const { resolveAIToken } = require('./groq-client');
      const fallbackToken = resolveAIToken('audit') || resolveAIToken('playground');
      const { getLLMBackend } = require('../config/constants');
      const fallbackBackend = getLLMBackend();   // Groq Llama drafter config

      if (!fallbackToken || fallbackBackend.url === auditBackend.url) throw primaryErr;

      logger.warn(`⚠️ Audit primary (${_auditLabel}) failed [${primaryErr.message}] — retrying on Groq Llama`);
      const fallbackUsesTextJson = fallbackBackend.model.includes('reasoner')
        || fallbackBackend.url.includes('openrouter.ai')
        || fallbackBackend.model.includes('gpt-oss');
      const fallbackBody = {
        model: fallbackBackend.model,
        messages: auditMessages,
        max_tokens: 800,
        temperature: AI_MODELS.TEMPERATURE_PRECISE,
        ...(!fallbackUsesTextJson ? { response_format: { type: 'json_object' } } : {})
      };
      const fallbackHeaders = {
        'Authorization': `Bearer ${fallbackToken}`,
        'Content-Type': 'application/json'
      };
      response = await _doAuditCall(
        fallbackBackend.url, fallbackBody, fallbackHeaders,
        timeout || fallbackBackend.timeouts.audit
      );
      extensions.onProviderResponse?.({
        model: response.data?.model || fallbackBackend.model,
        usage: response.data?.usage || null
      });
      responseUsesTextJson = fallbackUsesTextJson;
    }

    const metadata = completionMetadata(response.data);
    logger.debug(`AI audit completion ${JSON.stringify(metadata)}`);
    if (metadata.finishReason === 'length') {
      return {
        verdict: 'REJECTED', confidence: 0, checksPass: [], suggestedFixes: [],
        issues: [{ severity: 'CRITICAL', reason: 'Audit response was truncated' }],
        providerContractValid: false, error: 'AUDIT_TRUNCATED'
      };
    }
    let rawContent = response.data?.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      logger.warn('⚠️ Audit JSON response was empty');
      return {
        verdict: 'REJECTED',
        confidence: 0,
        checksPass: [],
        issues: [{ severity: 'CRITICAL', reason: 'Audit response was empty' }],
        suggestedFixes: [],
        providerContractValid: false,
        error: 'JSON_PARSE_ERROR'
      };
    }

    // For non-JSON-mode providers extract the
    // JSON block from the text — they may wrap it in markdown fences.
    if (responseUsesTextJson) {
      const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)```/i) ||
                        rawContent.match(/(\{[\s\S]*\})/);
      rawContent = jsonMatch ? jsonMatch[1].trim() : rawContent;
    }

    const auditContent = rawContent;
    
    let parsed;
    try {
      parsed = JSON.parse(auditContent);
    } catch (parseError) {
      logger.warn('⚠️ Audit JSON parse failed');
      return {
        verdict: 'REJECTED',
        confidence: 0,
        checksPass: [],
        issues: [{ severity: 'CRITICAL', reason: 'Failed to parse audit results' }],
        suggestedFixes: [],
        providerContractValid: false,
        error: 'JSON_PARSE_ERROR'
      };
    }

    // Verdict Validation: Ensure verdict is one of the allowed types
    const allowedVerdicts = ['APPROVED', 'FIXABLE', 'REJECTED'];
    const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.toUpperCase() : 'REJECTED';
    
    if (!allowedVerdicts.includes(verdict)) {
      logger.warn(`⚠️ Invalid audit verdict detected: "${verdict}" - falling back to REJECTED`);
      return {
        verdict: 'REJECTED',
        confidence: 0, checksPass: [],
        issues: [{ severity: 'CRITICAL', reason: 'Invalid verification verdict returned' }],
        suggestedFixes: [],
        providerContractValid: false,
        error: 'INVALID_VERDICT'
      };
    }

    const providerContractValid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      typeof parsed.verdict === 'string' && Number.isFinite(parsed.confidence) &&
      parsed.confidence >= 0 && parsed.confidence <= 100 &&
      Array.isArray(parsed.checksPass) && Array.isArray(parsed.issues) &&
      parsed.checksPass.every(check => typeof check === 'string') &&
      parsed.issues.every(issue => issue && typeof issue === 'object' &&
        ['CRITICAL', 'HIGH', 'MAJOR', 'MINOR'].includes(issue.severity) &&
        typeof issue.reason === 'string') &&
      Array.isArray(parsed.suggestedFixes) && parsed.suggestedFixes.every(fix => typeof fix === 'string');
    if (!providerContractValid) {
      return {
        verdict: 'REJECTED', confidence: 0, checksPass: [], suggestedFixes: [],
        issues: [{ severity: 'CRITICAL', reason: 'Invalid verification fields returned' }],
        providerContractValid: false, error: 'INVALID_AUDIT_FIELDS'
      };
    }
    return {
      verdict: verdict,
      confidence: parsed.confidence ?? 80,
      checksPass: parsed.checksPass || [],
      issues: parsed.issues || [],
      suggestedFixes: parsed.suggestedFixes || [],
      dialecticalAnalysis: parsed.dialecticalAnalysis || null,
      providerContractValid
    };
  } catch (err) {
    if (err.code === 'AI_CAPACITY') throw err;
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.message === 'aborted' || err.code === 'ECONNRESET') {
      logger.warn({ code: err.code || 'timeout' }, '⏱️ Audit Pass Timeout/Reset - Bypassing verification');
      return { 
        verdict: 'BYPASS', 
        confidence: null, 
        reason: 'Audit timed out — second pass never ran', 
        issues: [{ severity: 'HIGH', reason: 'Verification timed out' }],
        error: 'AUDIT_TIMEOUT'
      };
    }
    logger.error({ code: err.code || 'AUDIT_NETWORK_ERROR' }, '❌ Audit Pass Error');
    // Error Propagation: Skip safely with BYPASS instead of defaulting to APPROVED
    return { 
      verdict: 'BYPASS', 
      confidence: null, 
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
  const isCorrectiveOpenRouter = correctiveBackend.url.includes('openrouter.ai');
  const correctiveHeaders = {
    'Authorization': `Bearer ${groqToken}`,
    'Content-Type': 'application/json',
    ...(isCorrectiveOpenRouter ? {
      'HTTP-Referer': BRAND.openrouterReferer,
      'X-Title': BRAND.openrouterTitle
    } : {})
  };
  const response = await axios.post(
    correctiveBackend.url,
    {
      model: correctiveBackend.model,
      messages: [
        { role: 'system', content: 'You are correcting an AI answer based on audit feedback. Output the corrected answer only.' },
        { role: 'user', content: correctivePrompt }
      ],
      temperature: isCorrectiveReasoner ? AI_MODELS.TEMPERATURE_DEEPSEEK : AI_MODELS.TEMPERATURE_REASONING,
      max_tokens: maxTokens
    },
    { headers: correctiveHeaders, timeout }
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
  const confLabel = confidence !== null && confidence !== undefined ? `${confidence}%` : 'unverified';
  const badges = {
    verified: `🟢 Verified (${confLabel} confidence)`,
    corrected: `🟡 Corrected (${confLabel} confidence)`,
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
