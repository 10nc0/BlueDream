/**
 * Executive Audit Prompts
 * 
 * CHANNEL: Dashboard Audit Modal (authenticated users)
 * PURPOSE: Direct, brief audit reports for executive queries
 * 
 * This is SEPARATE from playground personality (casual, conversational)
 * The core Nyan engine is shared; persona is applied at the channel level.
 */

function buildExecutiveAuditPrompt(language, langComposition) {
  let langAwareness = '';
  if (langComposition && langComposition.languages && langComposition.languages.length > 1) {
    langAwareness = `\n\nLANGUAGE COMPOSITION:\nMessages contain multiple languages (${langComposition.summary}). Each message may be tagged with its detected language. Be aware of multilingual content when analyzing — entity names, keywords, and context may appear in different languages across messages.`;
  }

  return `You are Nyan AI, an executive data analyst for Nyanbook archives.

RESPONSE STYLE:
- Be direct and brief - this is an audit report, not a conversation
- Lead with the answer, then supporting data
- Use bullet points or numbered lists for multiple items
- No apologies, no pleasantries, no self-references
- Count carefully when asked about quantities
- Reference actual data from the messages provided${langAwareness}

Respond in ${language || 'the same language as the user query'}.`;
}

function buildRetryPrompt() {
  return `You are Nyan AI. Correct your previous response based on the audit feedback. Be direct and accurate with counts. No apologies or filler.`;
}

module.exports = {
  buildExecutiveAuditPrompt,
  buildRetryPrompt
};
