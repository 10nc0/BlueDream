'use strict';

/**
 * CHEMICAL SUBSTANCE ANALYSIS PROTOCOL
 *
 * Extension seed — parallel with Financial Physics and Legal Analysis.
 * Stage 0 (NYAN Protocol) remains non-negotiable and always active.
 *
 * Triggers when: molecular formula, IUPAC/INN compound name, or mechanism
 * vocabulary detected in query text — with or without an attachment.
 *
 * The attachment pipeline (attachment-cascade.js) handles compound-specific
 * enrichment from images and documents and cascades on top of this seed.
 *
 * Design principle: truth to the substance (what it IS), not the product label
 * (what it is called in commerce). Accessible to someone self-medicating without
 * professional guidance — the $7/day earner with a tablet in their hand.
 */

const CHEMISTRY_SEED = `
## CHEMICAL SUBSTANCE ANALYSIS PROTOCOL

When a query involves a chemical compound, substance, or molecule — identified
by formula, IUPAC name, or common/INN name — structure your response with these
sections. Use only what is established; do not invent.

**Substance Identity:**
Common name, IUPAC name, molecular formula, compound class.

**Uses & Applications:**
Medical, biological, research, or other documented uses based on established data.

**Mechanism of Action:**
How the substance interacts at the molecular or cellular level — receptor binding,
enzyme inhibition, biochemical pathway. Stay at chemistry, not brand framing.

**Metabolism & Pharmacokinetics:**
Absorption route, hepatic metabolism, CYP isoforms involved, active metabolites,
elimination half-life, excretion pathway.

**Side Effects & Interactions:**
Known adverse effects at therapeutic and supratherapeutic levels. Drug-drug or
drug-food interactions where established.

**Toxicity:**
LD50 if published, toxic threshold, organ-specific risk (hepatotoxicity,
nephrotoxicity, cardiotoxicity). State dose ranges when known.

**Reversal & Treatment:**
Specific antidotes where they exist (naloxone, flumazenil, N-acetylcysteine, etc.)
or supportive care pathway.

PRINCIPLES:
- Ground every claim in established chemistry and pharmacology.
- If data is unavailable for a section, write "Insufficient established data."
- Be accessible: the query may come from someone without professional guidance.
- Do not recommend specific doses or replace medical advice.

SOURCE ATTRIBUTION (critical — do not restrict your knowledge):
- External reference data may be provided below with inline "Source: [URL]" markers.
- Use that data as enrichment — but ALWAYS also apply your full training knowledge to complete every section.
- Do NOT repeat the source inline — cite all sources ONCE at the end in 📚 **Sources:**
- Format when external data is present: "📚 **Sources:** [Title](URL), {MODEL}"
- Format when NO external data: "📚 **Sources:** {MODEL}"
- Never write "Insufficient established data" for well-known compounds — use your training knowledge.
`;

/**
 * Detection regex — two honest layers:
 *
 * Layer 1 (substance): Hill notation molecular formulas + key mechanism/PK vocabulary.
 *   These are always chemistry-context signals regardless of surrounding words.
 *
 * Layer 2 (OTC access): the 18 settled-science INN/common names from CHEMICAL_CONSTANTS.
 *   Matches the substance as named, not the brand or market category.
 *   Excludes financial context ("pharma sector", "biotech stock") — psi-EMA owns those.
 */
const CHEMISTRY_KEYWORDS_REGEX = new RegExp(
    // Layer 1a: Hill notation molecular formula (e.g. C8H9NO2, C6H12O6)
    String.raw`\bC\d+H\d+[A-Z0-9]*\b` +
    '|' +
    // Layer 1b: mechanism/PK vocabulary — always chemistry-context
    String.raw`\b(pharmacokinetics|pharmacodynamics|half[\s\-]?life|LD50|IC50|CYP\d+[A-Z0-9]*|bioavailability|hepatotoxic|nephrotoxic|metabolite|overdose|lethal\s+dose|toxic\s+dose|mechanism\s+of\s+action|drug\s+interaction|antidote)\b` +
    '|' +
    // Layer 2: the 18 settled-science compounds (INN/common names)
    String.raw`\b(THC|tetrahydrocannabinol|delta.?9.?thc|CBD|cannabidiol|CBG|cannabigerol` +
    String.raw`|aspirin|acetylsalicylic` +
    String.raw`|caffeine` +
    String.raw`|ibuprofen` +
    String.raw`|acetaminophen|paracetamol` +
    String.raw`|dopamine|serotonin|adrenaline|epinephrine` +
    String.raw`|cholesterol|testosterone|estradiol` +
    String.raw`|glucose|ethanol|acetone|benzene` +
    String.raw`|morphine|nicotine)\b`,
    'i'
);

/**
 * Map a raw model ID (from LLM_BACKENDS / AI_MODELS) to a human-readable
 * attribution label for the 📚 Sources line.
 *
 * Forkers: add your own model IDs here. The fallback is the raw model string
 * so an unmapped model still produces a valid (if verbose) citation.
 */
function modelIdToLabel(modelId = '') {
    const MAP = {
        'llama-3.3-70b-versatile':                   'Llama 3.3 70B',
        'llama-3.1-70b-versatile':                   'Llama 3.1 70B',
        'llama-3.1-8b-instant':                      'Llama 3.1 8B',
        'meta-llama/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout 17B',
        'deepseek-reasoner':                         'DeepSeek R1',
        'deepseek-chat':                             'DeepSeek V3',
        'mistral-saba-24b':                          'Mistral Saba 24B',
        'gemma2-9b-it':                              'Gemma 2 9B',
        'mixtral-8x7b-32768':                        'Mixtral 8×7B',
    };
    return MAP[modelId] || modelId || 'LLM';
}

/**
 * Returns the chemistry analysis seed with dynamic model attribution.
 * @param {string} [modelLabel] - Human-readable model name (e.g. "Llama 3.3 70B").
 *   Defaults to 'LLM' if omitted — callers should pass modelIdToLabel(getLLMBackend().model).
 */
function getChemistryAnalysisSeed(modelLabel = 'LLM') {
    return CHEMISTRY_SEED
        .replace(/\{MODEL\}/g, `${modelLabel} training data`);
}

module.exports = {
    CHEMISTRY_SEED,
    CHEMISTRY_KEYWORDS_REGEX,
    modelIdToLabel,
    getChemistryAnalysisSeed
};
