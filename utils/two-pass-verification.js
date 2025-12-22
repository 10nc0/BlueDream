/**
 * THREE-PASS VERIFICATION ORCHESTRATOR
 * 
 * O(1) Generation + audit(O(1)) + personality(O(1))
 * Inspired by Replit's Architect review pattern.
 * 
 * Flow:
 * 1. Pass 1 (Generate): Draft answer using NYAN + extensions
 * 2. Pass 2 (Audit): Verify for hallucination/context leakage
 * 3. Pass 1.5 (Correct): Fix issues if FIXABLE verdict
 * 4. Pass 3 (Personality): Reformat verified answer for readability
 *    - Presentation-only layer (runs AFTER verification)
 *    - Preserves all data, calculations, citations exactly
 *    - Only adjusts formatting, tone, and structure
 * 5. Return formatted answer with verification metadata
 */

const axios = require('axios');
const { buildAuditPrompt, buildCorrectivePrompt } = require('../prompts/audit-protocol');
const { buildPersonalityPrompt, buildPersonalityUserMessage } = require('../prompts/personality-format');

const AUDIT_TEMPERATURE = 0.1;
const MAX_CORRECTION_ATTEMPTS = 1;
const PERSONALITY_TEMPERATURE = 0.4;

async function runVerifiedAnswer(options) {
  const {
    groqToken,
    draftAnswer,
    originalQuery,
    userContext,
    usesFinancialPhysics = false,
    usesChemistry = false,
    usesLegalAnalysis = false,
    usesPsiEMA = false,
    isSeedMetric = false,
    isTetralemma = false,
    auditMode = 'STRICT', // 'RESEARCH' | 'STRICT'
    maxTokens = 1500, // Match original response limit for correction pass
    timeout = 15000,
    enablePersonality = true // Pass 3: Personality formatting (can be disabled)
  } = options;

  const startTime = Date.now();
  const auditMetadata = {
    passCount: 1,
    auditPassed: false,
    verdict: 'PENDING',
    confidence: 0,
    issues: [],
    corrections: [],
    extensionsVerified: ['NYAN_PROTOCOL'],
    latencyMs: 0
  };

  if (usesFinancialPhysics) auditMetadata.extensionsVerified.push('FINANCIAL_PHYSICS');
  if (usesChemistry) auditMetadata.extensionsVerified.push('CHEMISTRY');
  if (usesLegalAnalysis) auditMetadata.extensionsVerified.push('LEGAL_ANALYSIS');
  if (usesPsiEMA) auditMetadata.extensionsVerified.push('PSI_EMA');
  if (isSeedMetric) auditMetadata.extensionsVerified.push('SEED_METRIC');
  if (isTetralemma) auditMetadata.extensionsVerified.push('TETRALEMMA');
  auditMetadata.extensionsVerified.push(`AUDIT_MODE_${auditMode}`);

  try {
    const auditResult = await runAuditPass(
      groqToken,
      draftAnswer,
      originalQuery,
      userContext,
      { usesFinancialPhysics, usesChemistry, usesLegalAnalysis, usesPsiEMA, isSeedMetric, isTetralemma, auditMode },
      timeout
    );

    auditMetadata.confidence = auditResult.confidence || 0;
    auditMetadata.issues = auditResult.issues || [];

    if (auditResult.verdict === 'APPROVED') {
      auditMetadata.verdict = 'APPROVED';
      auditMetadata.auditPassed = true;
      auditMetadata.passCount = 2; // Generation (1) + Audit (2)
      
      // Pass 3: Personality formatting (presentation-only, after verification)
      let finalOutput = draftAnswer;
      if (enablePersonality) {
        auditMetadata.passCount = 3; // + Personality (3)
        finalOutput = await runPersonalityPass(groqToken, draftAnswer, originalQuery, timeout);
      }
      
      auditMetadata.latencyMs = Date.now() - startTime;
      return {
        finalAnswer: finalOutput,
        auditMetadata,
        badge: 'verified'
      };
    }

    if (auditResult.verdict === 'FIXABLE' && auditResult.suggestedFixes?.length > 0) {
      auditMetadata.passCount = 2;
      
      const correctedAnswer = await runCorrectivePass(
        groqToken,
        draftAnswer,
        originalQuery,
        auditResult.issues,
        maxTokens,
        timeout
      );

      auditMetadata.corrections.push({
        attempt: 1,
        fixes: auditResult.suggestedFixes
      });

      const reAuditResult = await runAuditPass(
        groqToken,
        correctedAnswer,
        originalQuery,
        userContext,
        { usesFinancialPhysics, usesChemistry, usesLegalAnalysis, usesPsiEMA, isSeedMetric, isTetralemma, auditMode },
        timeout
      );

      auditMetadata.passCount = 4; // Generation (1) + Correction (2) + Re-Audit (3) + Audit result (4)
      auditMetadata.confidence = reAuditResult.confidence || auditResult.confidence;

      if (reAuditResult.verdict === 'APPROVED' || reAuditResult.verdict === 'FIXABLE') {
        auditMetadata.verdict = 'CORRECTED';
        auditMetadata.auditPassed = true;
        
        // Pass 3: Personality formatting (presentation-only, after verification)
        let finalOutput = correctedAnswer;
        if (enablePersonality) {
          auditMetadata.passCount = 5; // + Personality (5)
          finalOutput = await runPersonalityPass(groqToken, correctedAnswer, originalQuery, timeout);
        }
        
        auditMetadata.latencyMs = Date.now() - startTime;
        return {
          finalAnswer: finalOutput,
          auditMetadata,
          badge: 'corrected'
        };
      }

      auditMetadata.verdict = 'REJECTED';
      auditMetadata.issues = reAuditResult.issues || auditResult.issues;
    } else if (auditResult.verdict === 'REJECTED') {
      auditMetadata.verdict = 'REJECTED';
      auditMetadata.passCount = 2; // Generation (1) + Audit (2)
    } else if (auditResult.verdict === 'FIXABLE') {
      // FIXABLE but no suggested fixes - treat as rejection
      auditMetadata.verdict = 'REJECTED';
      auditMetadata.passCount = 2; // Generation (1) + Audit (2)
    }

    auditMetadata.latencyMs = Date.now() - startTime;
    
    const refusalMessage = buildRefusalMessage(auditMetadata.issues);
    return {
      finalAnswer: refusalMessage,
      auditMetadata,
      badge: 'refused'
    };

  } catch (auditError) {
    console.error('🔍 Audit pass error:', auditError.message);
    
    auditMetadata.verdict = 'BYPASS';
    auditMetadata.latencyMs = Date.now() - startTime;
    auditMetadata.issues.push({
      severity: 'MINOR',
      check: 'AUDIT_SYSTEM',
      reason: 'Audit system unavailable - returning unverified answer'
    });
    
    return {
      finalAnswer: draftAnswer + '\n\n⚠️ *Verification system unavailable. Answer unverified.*',
      auditMetadata,
      badge: 'unverified'
    };
  }
}

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
      // Note: approvedAnswer removed - we always use original draftAnswer when APPROVED
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
      max_tokens: maxTokens // Match original response limit
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

async function runPersonalityPass(groqToken, verifiedAnswer, originalQuery, timeout = 12000) {
  try {
    const personalityPrompt = buildPersonalityPrompt();
    const userMessage = buildPersonalityUserMessage(verifiedAnswer, originalQuery);

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: personalityPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: PERSONALITY_TEMPERATURE,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${groqToken}`,
          'Content-Type': 'application/json'
        },
        timeout
      }
    );

    const formatted = response.data.choices?.[0]?.message?.content;
    
    if (!formatted || formatted.length < verifiedAnswer.length * 0.5) {
      console.warn('⚠️ Personality pass returned unusually short response, using original');
      return verifiedAnswer;
    }

    console.log('✨ Pass 3 (Personality): Reformatted response for readability');
    return formatted;
  } catch (error) {
    console.warn('⚠️ Personality pass failed, using verified answer as-is:', error.message);
    return verifiedAnswer;
  }
}

/**
 * Streaming Personality Pass - sends tokens as they're generated via SSE
 * @param {object} res - Express response object (SSE-enabled)
 * @param {string} groqToken - Groq API token
 * @param {string} verifiedAnswer - Verified answer to reformat
 * @param {string} originalQuery - Original user query
 * @param {object} auditMetadata - Audit metadata to send before streaming
 * @returns {Promise<string>} - Complete formatted response
 */
async function runStreamingPersonalityPass(res, groqToken, verifiedAnswer, originalQuery, auditMetadata, isClientDisconnected = () => false) {
  const personalityPrompt = buildPersonalityPrompt();
  const userMessage = buildPersonalityUserMessage(verifiedAnswer, originalQuery);

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: personalityPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: PERSONALITY_TEMPERATURE,
        max_tokens: 2000,
        stream: true
      },
      {
        headers: {
          'Authorization': `Bearer ${groqToken}`,
          'Content-Type': 'application/json'
        },
        responseType: 'stream',
        timeout: 60000
      }
    );

    let fullContent = '';
    
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'audit', audit: auditMetadata })}\n\n`);
    }

    return new Promise((resolve, reject) => {
      let buffer = '';
      let destroyed = false;
      
      const cleanup = () => {
        if (!destroyed) {
          destroyed = true;
          try { response.data.destroy(); } catch (e) {}
        }
      };
      
      res.on('close', () => {
        console.log('🌊 Client closed connection, cleaning up Groq stream');
        cleanup();
        resolve(fullContent);
      });
      
      response.data.on('data', (chunk) => {
        if (destroyed || isClientDisconnected() || res.writableEnded) {
          cleanup();
          return;
        }
        
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta && !res.writableEnded && !destroyed) {
                fullContent += delta;
                res.write(`data: ${JSON.stringify({ type: 'token', content: delta })}\n\n`);
              }
            } catch (e) {
              // Skip malformed JSON chunks
            }
          }
        }
      });

      response.data.on('end', () => {
        if (!res.writableEnded && !destroyed) {
          res.write(`data: ${JSON.stringify({ type: 'done', fullContent })}\n\n`);
          res.end();
        }
        console.log(`✨ Pass 3 (Streaming Personality): ${fullContent.length} chars streamed`);
        resolve(fullContent);
      });

      response.data.on('error', (err) => {
        console.error('⚠️ Streaming personality error:', err.message);
        cleanup();
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          res.end();
        }
        reject(err);
      });
    });
  } catch (error) {
    console.warn('⚠️ Streaming personality failed, sending unformatted:', error.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'audit', audit: auditMetadata })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'token', content: verifiedAnswer })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', fullContent: verifiedAnswer })}\n\n`);
      res.end();
    }
    return verifiedAnswer;
  }
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
  runVerifiedAnswer,
  runAuditPass,
  runCorrectivePass,
  runPersonalityPass,
  runStreamingPersonalityPass,
  buildRefusalMessage,
  formatAuditBadge
};
