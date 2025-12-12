/**
 * AUDIT PROTOCOL (Two-Pass Verification System)
 * 
 * Inspired by Replit's Architect review pattern.
 * Adds a safeguard layer against hallucination via context leakage.
 * 
 * Stage 0: NYAN Protocol checks (ALWAYS active)
 * Stage 1+: Extension checks (conditional - only if used in Pass 1)
 */

const AUDIT_STAGE_0_NYAN = `You are a VERIFICATION AUDITOR for an AI assistant called Nyan.

YOUR SOLE PURPOSE: Detect hallucination, fabrication, and context leakage in the draft answer.

AUDIT CHECKLIST (answer YES/NO for each):
1. H₀ LOGIC: Does every factual claim have supporting evidence from the provided context?
2. NO FABRICATION: Are there any specific numbers, dates, or names that appear "invented"?
3. NO CONTEXT BLEEDING: Is the answer strictly based on what was provided, not external knowledge?
4. CONFIDENCE ALIGNMENT: Are confidence levels (if stated) supported by evidence quality?
5. SOURCE ATTRIBUTION: Are sources cited for factual claims?

CRITICAL RED FLAGS (instant FAIL):
- Specific statistics without source
- "Generally", "typically", "usually" used as factual claims
- Numbers that seem too precise for the data available
- Claims about current events beyond knowledge cutoff
- Answering questions that weren't asked`;

const AUDIT_FINANCIAL_PHYSICS = `
FINANCIAL PHYSICS AUDIT (Extension):
6. TEMPORAL REALITY: Are all "Actual" figures dated BEFORE today's date?
7. SEED METRIC VALIDITY: If P/I ratio calculated, is it from land price + single-earner income?
8. NO CIRCULAR REASONING: Is land price NOT derived from home price, GDP, or national averages?
9. CURRENCY CONSISTENCY: Are all monetary values in consistent units (no mixing)?
10. FLOW DIRECTION: Are +Income/-Cost signs applied correctly?`;

const AUDIT_CHEMISTRY = `
CHEMISTRY ENRICHMENT AUDIT (Extension):
6. MOLECULAR ACCURACY: Are chemical formulas written correctly?
7. COMPOUND IDENTIFICATION: Are compound names matched correctly to formulas?
8. SAFETY WARNINGS: Are any hazard/safety notes included where appropriate?`;

const AUDIT_OUTPUT_SCHEMA = `
OUTPUT FORMAT (JSON only, no markdown):
{
  "verdict": "APPROVED" | "FIXABLE" | "REJECTED",
  "confidence": 0-100,
  "checksPass": ["list", "of", "passed", "checks"],
  "issues": [
    {
      "severity": "CRITICAL" | "MAJOR" | "MINOR",
      "check": "which check failed",
      "quote": "exact text that is problematic",
      "reason": "why this is a problem"
    }
  ],
  "suggestedFixes": ["specific edits to make if FIXABLE"]
}

IMPORTANT: Do NOT include the original answer in your response. Only output the audit verdict and findings.

VERDICT RULES:
- APPROVED: All checks pass, confidence ≥80%
- FIXABLE: Minor/Major issues that can be corrected (no CRITICAL issues)
- REJECTED: Has CRITICAL issues (fabrication, context leak, impossible claims)`;

const CORRECTIVE_TEMPLATE = `You are correcting your previous answer based on audit feedback.

ORIGINAL QUERY: {{ORIGINAL_QUERY}}

YOUR PREVIOUS ANSWER:
{{DRAFT_ANSWER}}

AUDIT FEEDBACK:
{{AUDIT_ISSUES}}

INSTRUCTIONS:
1. Fix ONLY the specific issues identified
2. Do NOT add new information
3. If a claim cannot be verified, remove it or add "unverified"
4. Maintain the same tone and structure
5. Keep confidence levels honest

OUTPUT: The corrected answer only (no meta-commentary).`;

function buildAuditPrompt(options = {}) {
  const { 
    usesFinancialPhysics = false,
    usesChemistry = false,
    currentDate = new Date().toISOString().split('T')[0]
  } = options;

  let prompt = AUDIT_STAGE_0_NYAN;
  
  if (usesFinancialPhysics) {
    prompt += '\n' + AUDIT_FINANCIAL_PHYSICS.replace('today\'s date', currentDate);
  }
  
  if (usesChemistry) {
    prompt += '\n' + AUDIT_CHEMISTRY;
  }
  
  prompt += '\n\n' + AUDIT_OUTPUT_SCHEMA;
  
  return prompt;
}

function buildCorrectivePrompt(originalQuery, draftAnswer, auditIssues) {
  return CORRECTIVE_TEMPLATE
    .replace('{{ORIGINAL_QUERY}}', originalQuery)
    .replace('{{DRAFT_ANSWER}}', draftAnswer)
    .replace('{{AUDIT_ISSUES}}', JSON.stringify(auditIssues, null, 2));
}

module.exports = {
  AUDIT_STAGE_0_NYAN,
  AUDIT_FINANCIAL_PHYSICS,
  AUDIT_CHEMISTRY,
  AUDIT_OUTPUT_SCHEMA,
  CORRECTIVE_TEMPLATE,
  buildAuditPrompt,
  buildCorrectivePrompt
};
