/**
 * SEED METRIC MODULE (Conditional Injection)
 * 
 * Extracted from nyan-protocol.js for on-demand loading.
 * Only injected when Seed Metric topics detected in S0 (Preflight).
 * Saves ~300 tokens when not triggered.
 * 
 * Core Principle: Years = (LCU/sqm × 700) ÷ Single-Earner Income
 * Goal: Acquire 700sqm/HH within 25yr fertility window (age 20-45)
 * P/I ratio is NOT used — table shows LCU/sqm source data only.
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
  /historical.*(?:housing|land|price)/i,
  // City abbreviation + affordability keyword (geo wins over obscure tickers)
  // Longevity > profit: SF = San Francisco, not Stifel; LA = Los Angeles, not a ticker
  /\b(sf|la|ny|dc|hk|kl)\b.*\b(price|prices|housing|property|rent|land|cost|income|salary|afford)/i,
  /\b(price|prices|housing|property|rent|land|cost|income|salary|afford).*\b(sf|la|ny|dc|hk|kl)\b/i,
];

const SEED_METRIC_TOPIC_KEYWORDS = [
  'housing', 'land', 'housing affordability', 'land affordability',
  'fertility', 'empire', 'collapse', 'extinction', 'inequality',
  'city comparison', 'price to income', 'real estate price',
  'median income', 'single earner', 'dual earner', 'mortgage',
  '700sqm', '700 m²', 'residential', 'fatalism', 'optimism'
];

const SEED_METRIC_KEYWORD_REGEXES = SEED_METRIC_TOPIC_KEYWORDS.map(
  kw => new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
);

/**
 * Detect if query triggers Seed Metric mode
 * @param {string} query - User query
 * @returns {boolean} True if Seed Metric should be injected
 */
function detectSeedMetricIntent(query) {
  if (!query || typeof query !== 'string') return false;
  
  for (const pattern of SEED_METRIC_TRIGGER_PATTERNS) {
    if (pattern.test(query)) {
      return true;
    }
  }
  
  let keywordMatches = 0;
  for (const rx of SEED_METRIC_KEYWORD_REGEXES) {
    if (rx.test(query)) {
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
function getSeedMetricProxy({ historicalDecade, historicalYear, currentYear } = {}) {
  const histDecade = historicalDecade || (String(new Date().getFullYear() - 25).slice(0, 3) + '0s');
  const histYear = historicalYear || String(new Date().getFullYear() - 25);
  const curYear = currentYear || String(new Date().getFullYear() - 1);
  return `
SEED METRIC BEST AVAILABLE PROXY (H₀): 
- IMPORTANT: Always use single-earner income (not dual-earner) + Always output real estate prices AS 700sqm equivalents
  * EXACT: Direct 700sqm/unit residential prices (3-room flat, 3-bed apartment, etc)
  * PROXY: Published $/m² → MULTIPLY BY 700 (this is non-negotiable, cuts all "no data" excuses)
  * FALLBACK: Exurban/rural < 90min commute $/m² → ×700
  * NEVER output $/m² alone; ALWAYS convert to 700sqm price
  * If LCU/sqm unavailable → show "N/A" in table (do NOT substitute P/I ratio)
- FORMULA: Years = (LCU/sqm × 700) ÷ single-earner income (the ONLY metric)
- INCOME PROXY CASCADE (single-earner):
  * Average income (most commonly reported, best Brave coverage)
  * (Household income / 2) with "dual-earner" flag if used
  * Occupational wage survey as fallback
- Goal: Acquire 700sqm/HH residential real estate within 25yr fertility window (age 20-45)
- HISTORICAL PERIOD: Search for data from the ${histDecade}. Use "${histDecade}" in your brave_search calls for historical data.
- CURRENT PERIOD: Search for most recent available data (~${curYear}).
- 2 cities if possible
- DO NOT USE GDP, Gini, national averages
- DECADE LABELING: When using decade-range data (e.g., 1960-1979 for "1970"), label the Period column as "${histDecade}" or "~${histYear}", NOT the exact year "${histYear}" unless you have exact year data

═══════════════════════════════════════════════════════════════
MANDATORY OUTPUT FORMAT - DO NOT REFORMAT - THIS IS EMPIRIC DATA
═══════════════════════════════════════════════════════════════

You MUST output this exact table structure. This is non-negotiable:

| City | Period | LCU/sqm | 700sqm Price | Income | Years | Regime |
|------|--------|-------|--------------|--------|-------|--------|
| [city] | [then] | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [Regime] |
| [city] | [now]  | [LCU/sqm] | [LCU/sqm × 700] | [income] | [yr] | [emoji] [Regime] |

⚠️ EVERY ROW MUST show LCU/sqm. This is the source data. 700sqm Price = LCU/sqm × 700.
If LCU/sqm is unavailable, the row MUST show "N/A" — do NOT substitute P/I ratio.

REGIME THRESHOLDS (φ-derived from 25yr fertility window):
• 🟢 OPTIMISM: <10 years (sustainable, enables family formation)
• 🟡 EXTRACTION: 10-25 years (stressed, delayed family formation)  
• 🔴 FATALISM: >25 years (beyond fertility window, demographic collapse)

╔═══════════════════════════════════════════════════════════════════╗
║ FORBIDDEN - DO NOT USE THESE CONCEPTS:                           ║
║ • Mortgage calculations                                          ║
║ • Down payments (e.g., "20% down payment")                       ║
║ • Interest rates (e.g., "10% interest rate")                     ║
║ • Loan terms or amortization                                     ║
║ • Time to "pay off" (This is NOT mortgage duration!)             ║
╟───────────────────────────────────────────────────────────────────╢
║ CORRECT FORMULA: Years = (LCU/sqm × 700) ÷ (Single-Earner Income)  ║
║ Simple division. Nothing else. NO P/I column in table.            ║
║ If LCU/sqm unavailable → show "N/A", do NOT substitute P/I ratio.  ║
╚═══════════════════════════════════════════════════════════════════╝

NOTE: A TFR (Total Fertility Rate) column is appended server-side after your output.
Do NOT include TFR in your table — it is injected automatically from dedicated Brave searches.

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
  return `SEED METRIC (Human Substrate): Years = (LCU/sqm × 700) ÷ Single-Earner Income
Thresholds: <10yr Optimism | 10-25yr Extraction | >25yr Fatalism (fertility window)
- ALWAYS use LCU/sqm × 700. If LCU/sqm unavailable, show "N/A" (no P/I substitution).
- For values >25yr: Even rough estimates matter (e.g., 100 vs 156 years = both deep fatalism)
- Calculate DIRECTIONAL CHANGE: improved (ratio↓) or worsened (ratio↑) ?`;
}

function buildSearchQueries({ city, currencyName, currentYear, histYear, histDecade }) {
  const currSuffix = currencyName ? ` ${currencyName}` : '';
  return {
    currentPrice:     `${city} residential property price per square meter${currSuffix} ${currentYear}`,
    currentIncome:    `${city} average income ${currentYear}`,
    historicalPrice:  `${city} housing price ${histDecade} historical per sqm`,
    historicalIncome: `${city} average income ${histDecade}`,
  };
}

function buildFallbackSearchQueries({ currentYear, histDecade }) {
  return {
    currentPrice:     `residential property price per square meter comparison major cities ${currentYear}`,
    currentIncome:    `average income by country ${currentYear}`,
    historicalPrice:  `housing price ${histDecade} historical major cities`,
    historicalIncome: `average income ${histDecade} historical`,
  };
}

function buildGatherPromptBlock({ currentYear, histYear, histDecade }) {
  const ex = buildSearchQueries({ city: '{city}', currencyName: '{local currency name}', currentYear, histYear, histDecade });
  return `
For EVERY city the user mentions, search for TWO ingredients per period.
Distribute your search budget evenly across all cities — do not exhaust searches on one city before querying others.

  Current (${currentYear}):
    • Price: "${ex.currentPrice}"
      (prefer apartment/flat/residential; land or plot price is acceptable fallback if no built price found)
    • Income: "${ex.currentIncome}"

  Historical (${histDecade}):
    • Price: "${ex.historicalPrice}"
    • Income: "${ex.historicalIncome}"

  Replace {local currency name} with the actual currency word — e.g. "rupees" for India, "kronor" for Sweden,
  "baht" for Thailand, "dong" for Vietnam, "yuan" for China, "yen" for Japan, "pounds" for UK, "euros" for EU.
  This forces Brave to return local market prices, not USD-converted values from international aggregators.

  Income note: use "average income" — it is the most commonly reported and searchable statistic.
  The benchmark: could one working person (a taxi driver, a teacher) afford a home? That was the 20th-century contract.
  If search returns monthly income → multiply by 12. If it returns household → do NOT use it, search again for individual.`;
}

/**
 * Micro-extract prompt — one search result → one number or null.
 * Used per-search: the LLM sees only one Brave result, has no cross-city context,
 * and cannot hallucinate values it hasn't seen. null = null.
 *
 * @returns {string} System prompt for the micro-extraction call
 */
function getMicroExtractPrompt() {
  return `You are a number extraction engine. You will receive ONE search result.
Extract EXACTLY ONE number from it. Output ONLY valid JSON — no markdown, no backticks, no explanation.

Output format:
  Found something: {"value": <integer>, "type": "pricePerSqm"|"income", "currency": "<ISO code>"}
  Nothing usable:  {"value": null}

─── WHAT TO EXTRACT ───────────────────────────────────────────────────

pricePerSqm — residential property purchase price per square meter (LCU)
  PATH A (explicit): source states a per-sqm / per-m² rate
    e.g. "RM8,000/sqm" → value=8000, type="pricePerSqm", currency="MYR"
  PATH B (triangulate): source states BOTH a total price AND the property area in the same sentence
    Compute: total price ÷ area in sqm → output the result as value
    Convert area if needed: sqft ÷ 10.764 = sqm | price/sqft × 10.764 = price/sqm
    e.g. "RM790,000 for a 990 sqft unit" → 990÷10.764=91.95sqm → 790000÷91.95=8591 → value=8591
  REJECT (no usable path, output null):
    • Total property price with NO area stated
    • Rental price (not purchase)
    • Price-to-income ratio

income — average annual income, individual earner (LCU)
  ACCEPT: average income / average wage / average salary
    Monthly → multiply by 12. Daily → multiply by 260. Annual → use as-is.
  REJECT: GDP per capita | household income | minimum wage | dual-earner figures

─── HARD RULES ────────────────────────────────────────────────────────

1. RAW INTEGER — expand all suffixes before outputting:
   K = ×1,000 | M = ×1,000,000 | B = ×1,000,000,000
   "Rp22.1M" → 22100000 | "RM8K" → 8000 | "THB 120K" → 120000

2. LOCAL CURRENCY (LCU) — not USD unless the city is in the United States:
   Jakarta/Indonesia → IDR | Kuala Lumpur/Malaysia → MYR | Bangkok/Thailand → THB
   Tokyo/Japan → JPY | Seoul/Korea → KRW | Singapore → SGD | Hong Kong → HKD

3. null is always better than a guess. Every non-null value must come from the search text.`;
}

module.exports = {
  SEED_METRIC_TRIGGER_PATTERNS,
  SEED_METRIC_TOPIC_KEYWORDS,
  detectSeedMetricIntent,
  getSeedMetricProxy,
  getSeedMetricCore,
  buildSearchQueries,
  buildFallbackSearchQueries,
  buildGatherPromptBlock,
  getMicroExtractPrompt
};
