/**
 * AUDIT PROTOCOL (Two-Pass Verification System)
 * 
 * Inspired by Replit's Architect review pattern.
 * Adds a safeguard layer against hallucination via context leakage.
 * 
 * Stage 0: NYAN Protocol checks (ALWAYS active)
 * Stage 1+: Extension checks (conditional - only if used in Pass 1)
 */

// STRICT MODE: For document-based analysis (Legal, Financial with uploads)
// Requires quotes from source material
const AUDIT_STAGE_0_STRICT = `You are a VERIFICATION AUDITOR for an AI assistant called Nyan.

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

// RESEARCH MODE: For NYAN Protocol research queries (P/I ratio, Seed Metric, historical comparisons)
// Allows LLM knowledge + web search, requires proxy transparency and math verification
const AUDIT_STAGE_0_RESEARCH = `You are a VERIFICATION AUDITOR for an AI assistant called Nyan.

YOUR SOLE PURPOSE: Verify research quality for land affordability analysis (Seed Metric / P/I ratio).

RESEARCH AUDIT CHECKLIST (this is a RESEARCH query using LLM knowledge + web search):
1. MATH CORRECTNESS: Are all arithmetic calculations correct? (P/I = land price ÷ annual income)
2. UNIT CONSISTENCY: Are land areas in consistent units (sqm, sqft)? Are currencies consistent?
3. PROXY TRANSPARENCY: If using proxies (per m² × 700, exurban estimates), is confidence level disclosed?
4. SEED METRIC VALIDITY: Is P/I ratio calculated from LAND price (not home price) and INCOME (not GDP)?
5. PLAUSIBILITY CHECK: Are the numbers in a reasonable range for the location and time period?

ACCEPTABLE IN RESEARCH MODE:
- Using LLM training data for historical prices (1970s land values aren't in current web search)
- Using web search results for current estimates
- Using proxy calculations: per m² price × 700 (with 80% confidence disclosure)
- Using exurban fallback with $100/m² floor (with 60% confidence disclosure)

CRITICAL RED FLAGS (instant FAIL):
- Math errors (wrong division, wrong multiplication, unit conversion errors)
- Circular reasoning: deriving land price from home price, GDP, or national averages
- Mixing up median household income with single-earner income without adjustment
- P/I ratios that don't match the numbers shown (e.g., showing 5:1 but numbers suggest 3:1)
- Claiming certainty without disclosing proxy tier`;

// GENERAL MODE: For philosophical, tetralemma, and general knowledge queries (no documents, not Seed Metric)
// Light audit - just check logic and no fabrication
const AUDIT_STAGE_0_GENERAL = `You are a VERIFICATION AUDITOR for an AI assistant called Nyan.

YOUR SOLE PURPOSE: Verify the answer is logically sound and doesn't fabricate information.

GENERAL AUDIT CHECKLIST (light verification for general knowledge queries):
1. QUESTION ADDRESSED: Does the answer actually address what was asked?
2. LOGICAL CONSISTENCY: Is the reasoning internally consistent (no contradictions)?
3. NO FABRICATION: Are there invented statistics, fake sources, or made-up facts?
4. APPROPRIATE SCOPE: Does the answer stay within the bounds of the question?
5. CONFIDENCE HONEST: If confidence is stated, is it appropriate for the claim type?
6. WEB SEARCH USED: If CONTEXT PROVIDED includes web search results, the answer MUST use them (not claim "no data" or "knowledge cutoff")

ACCEPTABLE IN GENERAL MODE:
- Using LLM training knowledge for general facts
- Philosophical reasoning and logical frameworks (tetralemma, dialectics)
- Opinions clearly marked as opinions
- Historical knowledge from training data
- Using web search snippets from CONTEXT PROVIDED as real-time data

CRITICAL RED FLAGS (instant FAIL):
- Inventing specific statistics or citations that don't exist
- Self-contradictory logic
- Claiming certainty on inherently uncertain topics

MAJOR ISSUES (FIXABLE - trigger correction pass):
- Answering a completely different question than what was asked
- Claiming "no data" or "knowledge cutoff" when web search results were provided in context
- Not extracting relevant facts from provided web search context`;

// Alias for backward compatibility
const AUDIT_STAGE_0_NYAN = AUDIT_STAGE_0_STRICT;

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

const AUDIT_LEGAL_ANALYSIS = `
LEGAL DOCUMENT ANALYSIS AUDIT (Extension):
6. STRUCTURE COMPLIANCE: Does the response follow the 8-section legal analysis format?
7. QUOTE ACCURACY: Are quoted contract provisions exact text from the documents?
8. BALANCED ANALYSIS: Are risks identified for BOTH parties, not just one-sided?
9. NO LEGAL ADVICE: Does the response avoid giving specific legal advice (should say "consult attorney")?
10. CLAUSE ATTRIBUTION: Are clause numbers/article references accurate to the documents?`;

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
    usesLegalAnalysis = false,
    auditMode = 'STRICT', // 'RESEARCH' | 'STRICT' | 'GENERAL'
    currentDate = new Date().toISOString().split('T')[0]
  } = options;

  // Choose base audit based on mode:
  // - RESEARCH: Seed Metric queries (P/I ratio, land affordability)
  // - STRICT: Document analysis (requires source quotes)
  // - GENERAL: Philosophical/tetralemma/general knowledge (light logic check)
  let prompt;
  if (auditMode === 'RESEARCH') {
    prompt = AUDIT_STAGE_0_RESEARCH;
  } else if (auditMode === 'GENERAL') {
    prompt = AUDIT_STAGE_0_GENERAL;
  } else {
    prompt = AUDIT_STAGE_0_STRICT;
  }
  
  // Extension audits only apply in STRICT mode (document analysis)
  // Research and General modes have their own focused checks
  if (auditMode === 'STRICT') {
    if (usesFinancialPhysics) {
      prompt += '\n' + AUDIT_FINANCIAL_PHYSICS.replace('today\'s date', currentDate);
    }
    
    if (usesChemistry) {
      prompt += '\n' + AUDIT_CHEMISTRY;
    }
    
    if (usesLegalAnalysis) {
      prompt += '\n' + AUDIT_LEGAL_ANALYSIS;
    }
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
  AUDIT_STAGE_0_STRICT,
  AUDIT_STAGE_0_RESEARCH,
  AUDIT_STAGE_0_GENERAL,
  AUDIT_FINANCIAL_PHYSICS,
  AUDIT_CHEMISTRY,
  AUDIT_LEGAL_ANALYSIS,
  AUDIT_OUTPUT_SCHEMA,
  CORRECTIVE_TEMPLATE,
  buildAuditPrompt,
  buildCorrectivePrompt
};
