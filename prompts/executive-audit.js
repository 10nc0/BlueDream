/**
 * Executive Audit Prompts
 *
 * CHANNEL: Dashboard Audit Modal (authenticated users)
 * PURPOSE: Direct, brief audit reports for executive queries
 *
 * This is SEPARATE from playground personality (casual, conversational).
 * The core Nyan engine is shared; persona is applied at the channel level.
 *
 * Temporal context is injected at prompt-build time so the LLM resolves
 * relative phrases ("kemarin", "bulan lalu", "last 3 months", "YTD", …)
 * against the SAME anchor — today's date in the tenant's timezone — that
 * the audit verifier (`utils/temporal-resolver` → `parseQueryScope`) uses
 * to re-derive its independent counting scope. Keeping both layers anchored
 * to one wall-clock prevents the verifier from going blind on relative-time
 * questions and matching its own "year YYYY"-only fallback.
 */

function buildExecutiveAuditPrompt(language, langComposition, temporalContext) {
  let langAwareness = '';
  if (langComposition && langComposition.languages && langComposition.languages.length > 1) {
    langAwareness = `\n\nLANGUAGE COMPOSITION:\nMessages contain multiple languages (${langComposition.summary}). Each message may be tagged with its detected language. Be aware of multilingual content when analyzing — entity names, keywords, and context may appear in different languages across messages.`;
  }

  let temporalLine = '';
  if (temporalContext && temporalContext.todayLocalISO) {
    temporalLine = `\n\nTEMPORAL CONTEXT:\nToday is ${temporalContext.todayLocalISO} (${temporalContext.tz}). When the user uses relative time phrases — "kemarin", "hari ini", "bulan lalu", "minggu lalu", "tahun lalu", "bulan ini", "last/past N {days,weeks,months,quarters,years}", "this/next {unit}", "YTD", "MTD", "QTD", "sejak X" — interpret them relative to that date in that timezone. Convert relative phrases to concrete date ranges before counting.`;
  }

  return `You are Nyan AI, an executive data analyst for Nyanbook archives.

RESPONSE STYLE:
- Be direct and brief - this is an audit report, not a conversation
- Lead with the answer, then supporting data
- Use bullet points or numbered lists for multiple items
- No apologies, no pleasantries, no self-references
- Count carefully when asked about quantities
- Reference actual data from the messages provided${langAwareness}${temporalLine}

Respond in ${language || 'the same language as the user query'}.`;
}

function buildRetryPrompt() {
  return `You are Nyan AI. Correct your previous response based on the audit feedback. Be direct and accurate with counts. No apologies or filler.`;
}

module.exports = {
  buildExecutiveAuditPrompt,
  buildRetryPrompt
};
