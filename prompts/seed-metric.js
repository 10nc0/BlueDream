/**
 * SEED METRIC MODULE (Conditional Injection)
 * 
 * Extracted from nyan-protocol.js for on-demand loading.
 * Only injected when Seed Metric topics detected in S0 (Preflight).
 * Saves ~300 tokens when not triggered.
 * 
 * Core Principle: P/I ratio = Real Estate Price / Single-Earner Income
 * Goal: Acquire 700sqm/HH within 25yr fertility window (age 20-45)
 * 
 * Thresholds (φ-derived via fertility constraint):
 * - <10yr: Optimism
 * - 10-25yr: Extraction
 * - >25yr: Fatalism (beyond fertility window)
 */

const SEED_METRIC_TRIGGER_PATTERNS = [
  /seed\s*metric/i,
  /p\/?i\s*ratio/i,
  /price[\s-]*(?:to|vs?)[\s-]*income/i,
  /housing\s*affordability/i,
  /land\s*affordability/i,
  /\bland\s*price/i,              // "land price" direct match
  /\bproperty\s*price/i,          // "property price" direct match
  /real\s*estate.*(?:income|salary|wage)/i,
  /(?:income|salary|wage).*real\s*estate/i,
  /700\s*(?:sq\s*m|sqm|m²)/i,
  /fertility\s*window/i,
  /single[\s-]*earner/i,
  /housing.*(?:crisis|collapse|bubble)/i,
  /empire.*(?:collapse|fall|decline)/i,
  /extinction.*(?:human|species|civilization)/i,
  /city\s*comparison.*(?:price|income|housing)/i,
  /(?:price|income|housing).*city\s*comparison/i,
  /\b\w+\s+vs\.?\s+\w+.*(?:land|housing|property)/i,  // "X vs Y land/housing/property"
  /(?:50|fifty)\s*years?\s*ago/i,
  /historical.*(?:housing|land|price)/i
];

const SEED_METRIC_TOPIC_KEYWORDS = [
  'housing', 'land', 'housing affordability', 'land affordability',
  'fertility', 'empire', 'collapse', 'extinction', 'inequality',
  'city comparison', 'price to income', 'real estate price',
  'median income', 'single earner', 'dual earner', 'mortgage',
  '700sqm', '700 m²', 'residential', 'fatalism', 'optimism'
];

/**
 * Detect if query triggers Seed Metric mode
 * @param {string} query - User query
 * @returns {boolean} True if Seed Metric should be injected
 */
function detectSeedMetricIntent(query) {
  if (!query || typeof query !== 'string') return false;
  
  const lowerQuery = query.toLowerCase();
  
  for (const pattern of SEED_METRIC_TRIGGER_PATTERNS) {
    if (pattern.test(query)) {
      return true;
    }
  }
  
  let keywordMatches = 0;
  for (const keyword of SEED_METRIC_TOPIC_KEYWORDS) {
    if (lowerQuery.includes(keyword.toLowerCase())) {
      keywordMatches++;
      if (keywordMatches >= 2) return true;
    }
  }
  
  return false;
}

/**
 * Get Seed Metric proxy cascade for system prompt injection
 * This is the "scavenger hunt map" for finding real data
 * @returns {string} Seed Metric proxy block
 */
function getSeedMetricProxy() {
  return `
SEED METRIC BEST AVAILABLE PROXY (H₀): 
- IMPORTANT: Always use single-earner income (not dual-earner) + Always output real estate prices AS 700sqm equivalents
  * EXACT: Direct 700sqm/unit residential prices (3-room flat, 3-bed apartment, etc)
  * PROXY: Published $/m² → MULTIPLY BY 700 (this is non-negotiable, cuts all "no data" excuses)
  * FALLBACK: Exurban/rural < 90min commute $/m² → ×700
  * NEVER output $/m² alone; ALWAYS convert to 700sqm price
- P/I ratio = (Real Estate Price ÷ single-earner income) = ratio (core metric)
- INCOME PROXY CASCADE (ALWAYS single-earner, NO dual-earner):
  * Prefer median individual income
  * (Household income / 2) with "dual-earner" flag if used
  * Occupational wage survey as fallback
- Goal: Acquire 700sqm/HH residential real estate within 25yr fertility window (age 20-45)
- 50yr ago (40-60yr ok) AND most recent available data
- 2 cities if possible
- DO NOT USE GDP, Gini, national averages
- DECADE LABELING: When using decade-range data (e.g., 1960-1979 for "1970"), label the Period column as "1970s" or "~1970", NOT the exact year "1970" unless you have exact year data

═══════════════════════════════════════════════════════════════
MANDATORY OUTPUT FORMAT - DO NOT REFORMAT - THIS IS EMPIRIC DATA
═══════════════════════════════════════════════════════════════

You MUST output this exact table structure. This is non-negotiable:

| City | Period | 700sqm Price | Income | P/I | Years | Regime |
|------|--------|--------------|--------|-----|-------|--------|
| [city] | [then] | [price] | [income] | [ratio] | [yr] | [emoji] |
| [city] | [now]  | [price] | [income] | [ratio] | [yr] | [emoji] |

DUAL-THRESHOLD SYSTEM:
┌─────────────────────────────────────────────────────────────────┐
│ PRIMARY MODE ($/sqm available): 700sqm × $/sqm                  │
│   • 🟢 OPTIMISM: <10 years                                      │
│   • 🟡 EXTRACTION: 10-25 years                                  │
│   • 🔴 FATALISM: >25 years                                      │
├─────────────────────────────────────────────────────────────────┤
│ FALLBACK MODE (no $/sqm, raw price only): P/I ratio             │
│   • 🟢 OPTIMISM: P/I ≤3.5 (≈10yr @ 35% housing spend)           │
│   • 🔴 FATALISM: P/I >3.5                                       │
│   • Show "P/I X.X" in Years column when in fallback mode        │
└─────────────────────────────────────────────────────────────────┘
Priority: ALWAYS try $/sqm × 700 first. Only use raw P/I when $/sqm unavailable.

After table, add ONE line per city:
**[City]**: [old]yr → [new]yr = [emoji] [Regime] ([↑worsened/↓improved])

═══════════════════════════════════════════════════════════════
STRICT RULES:
1. DO NOT convert table to prose paragraphs
2. DO NOT add conversational filler before/after table
3. DO NOT soften regime readings - they are empiric thresholds
4. Regime emoji MUST appear in table AND summary line
5. Data quality notes go AFTER the structured output, not before
═══════════════════════════════════════════════════════════════
`;
}

/**
 * Get Seed Metric core definition (always included in base protocol)
 * This is the minimal definition, not the proxy cascade
 * @returns {string} Seed Metric core block
 */
function getSeedMetricCore() {
  return `SEED METRIC (Human Substrate): years to 700 m²/HH residential = Real Estate Price / Income (single-earner)
Thresholds: <10yr Optimism | 10-25yr Extraction | >25yr Fatalism (fertility window)
- For values >25yr: Even rough estimates matter (e.g., 100 vs 156 years = both deep fatalism)
- Calculate DIRECTIONAL CHANGE: improved (ratio↓) or worsened (ratio↑) ?`;
}

module.exports = {
  SEED_METRIC_TRIGGER_PATTERNS,
  SEED_METRIC_TOPIC_KEYWORDS,
  detectSeedMetricIntent,
  getSeedMetricProxy,
  getSeedMetricCore
};
