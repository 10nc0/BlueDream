/**
 * Create Mode Seed — S-1.5 isCreateIntent
 *
 * Injected when digest.intent === 'C' (user asked to produce a document/artifact).
 * Constrains output FORMAT only — structure, columns, and sections are left entirely
 * to the LLM's own judgment based on the domain and document type.
 *
 * Rules:
 * - Under 60 words
 * - No templates, column names, or rigid structure hints
 * - No prose paragraphs, no ranges, no percentage estimates
 */

const CREATE_MODE_SEED = `You are producing a structured artifact, not a prose answer. Use the exact figures you have — no ranges, no percentage estimates, no narrative paragraphs. Choose the canonical structure for this document type yourself. Present every line item, section, or entry explicitly. If a figure is unknown, write "— (data unavailable)" rather than estimating.`;

module.exports = { CREATE_MODE_SEED };
