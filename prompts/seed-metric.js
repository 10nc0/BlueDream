/**
 * SEED METRIC MODULE (Conditional Injection)
 * 
 * Extracted from nyan-protocol.js for on-demand loading.
 * Only injected when Seed Metric topics detected in S0 (Preflight).
 * Saves ~300 tokens when not triggered.
 * 
 * Core Principle: Years = ($/sqm × 700) ÷ Single-Earner Income
 * Goal: Acquire 700sqm/HH within 25yr fertility window (age 20-45)
 * P/I ratio is NOT used — table shows $/sqm source data only.
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
  * If $/sqm unavailable → show "N/A" in table (do NOT substitute P/I ratio)
- FORMULA: Years = ($/sqm × 700) ÷ single-earner income (the ONLY metric)
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

| City | Period | $/sqm | 700sqm Price | Income | Years | Regime |
|------|--------|-------|--------------|--------|-------|--------|
| [city] | [then] | [$/sqm] | [$/sqm × 700] | [income] | [yr] | [emoji] [Regime] |
| [city] | [now]  | [$/sqm] | [$/sqm × 700] | [income] | [yr] | [emoji] [Regime] |

⚠️ EVERY ROW MUST show $/sqm. This is the source data. 700sqm Price = $/sqm × 700.
If $/sqm is unavailable, the row MUST show "N/A" — do NOT substitute P/I ratio.

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
║ CORRECT FORMULA: Years = ($/sqm × 700) ÷ (Single-Earner Income)  ║
║ Simple division. Nothing else. NO P/I column in table.            ║
║ If $/sqm unavailable → show "N/A", do NOT substitute P/I ratio.  ║
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
  return `SEED METRIC (Human Substrate): Years = ($/sqm × 700) ÷ Single-Earner Income
Thresholds: <10yr Optimism | 10-25yr Extraction | >25yr Fatalism (fertility window)
- ALWAYS use $/sqm × 700. If $/sqm unavailable, show "N/A" (no P/I substitution).
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
 * Round 2 extraction prompt — given all Brave search results, output a typed JSON schema.
 * The LLM handles suffix expansion, currency, annualization, and temporal selection.
 * @param {object} opts
 * @param {string[]} opts.cities - Lowercase city names being analysed
 * @param {string} opts.histDecade - e.g. "2000s"
 * @param {number} opts.currentYear - e.g. 2026
 * @returns {string} System prompt for the structured extraction call
 */
function getSeedMetricExtractionPrompt({ cities = [], histDecade = '2000s', currentYear = new Date().getFullYear() } = {}) {
  const histDecadeNum = parseInt(histDecade) || (currentYear - 25);
  const histDecadeEnd = histDecadeNum + 9;
  const citiesList = cities.join(', ') || 'the cities mentioned';
  return `You are a data extraction engine. Extract exactly two numbers per city per period from the search results below.

Output ONLY valid JSON — no markdown, no backticks, no explanation:

{
  "cities": {
    "<city_lowercase>": {
      "current":    { "pricePerSqm": <integer|null>, "currency": "<ISO code>", "income": <integer|null> },
      "historical": { "pricePerSqm": <integer|null>, "currency": "<ISO code>", "income": <integer|null> }
    }
  }
}

TARGET CITIES: ${citiesList}
HISTORICAL PERIOD: ${histDecade} — only accept values explicitly dated ${histDecadeNum}–${histDecadeEnd}
CURRENT PERIOD: most recent available

─── TWO INPUTS ONLY ───────────────────────────────────────────────────

INPUT 1 — pricePerSqm (purchase price per square meter, local currency)
  ACCEPT: source text explicitly says "X per sqm", "X/m²", "X per square meter"
  REJECT without exception: total listing price ("apartment for RM790,000"), rental price, P/I ratio
  No division, no inference. If not explicitly stated as per-sqm → null.

INPUT 2 — income (average annual income, individual earner, local currency)
  ACCEPT: average income / average wage / average salary (annual, or monthly × 12)
  REJECT: GDP per capita, household income, minimum wage, dual-earner figures
  Monthly figure → multiply by 12. Daily → multiply by 260. Annual → use as-is.

─── THREE HARD RULES ──────────────────────────────────────────────────

1. RAW INTEGER — expand all suffixes before outputting:
   K = ×1,000 | M = ×1,000,000 | B = ×1,000,000,000
   "Rp22.1M" → 22100000 | "RM8K" → 8000 | "THB 120K" → 120000

2. LOCAL CURRENCY (LCU) — one currency per city per period, not USD:
   Jakarta → IDR | Kuala Lumpur → MYR | Bangkok → THB | Tokyo → JPY | Seoul → KRW
   If source only gives USD for a non-USD city → null.

3. HISTORICAL PERIOD LOCK — for the historical slot, the value must be
   explicitly dated within ${histDecadeNum}–${histDecadeEnd}.
   Text: "grew from Rp18M in 2002 to Rp104M today" + histDecade=${histDecade} → 18000000
   Text: "average income is Rp104M" with no year stated → null for historical slot.
   null is always correct. Guessing is always wrong.`;
}

/**
 * Round 3 gap-fill prompt — single field extraction for one city/period/field.
 * @param {object} opts
 * @param {string} opts.field - "income" or "pricePerSqm"
 * @param {string} opts.city - City name
 * @param {string} opts.period - "current" or "historical"
 * @param {string} opts.yearToken - e.g. "2000s" or "2026"
 * @returns {string} System prompt for the targeted gap-fill extraction call
 */
function getSeedMetricGapFillPrompt({ field, city, period, yearToken }) {
  const isIncome = field === 'income';
  const target = isIncome
    ? `annual single-earner income for ${city} in ${yearToken}`
    : `residential property purchase price per sqm for ${city} in ${yearToken}`;
  const isDecade = /^\d{4}s$/.test(yearToken);
  const decadeNum = isDecade ? parseInt(yearToken) : null;
  const decadeRange = decadeNum ? `${decadeNum}–${decadeNum + 9}` : yearToken;

  return `Extract one number from the search result below.
Output ONLY valid JSON — no markdown: { "value": <integer or null>, "currency": "<ISO code or null>" }

Looking for: ${target}

Rules:
- value must be a raw integer — expand all suffixes (K=×1000, M=×1000000, B=×1000000000)
- currency must be the local currency (not USD unless the city is in the US)
${isIncome
  ? '- ACCEPT: average income / average wage / average salary for an individual earner (annual, or monthly×12, or daily×260)\n- REJECT: GDP per capita, household income, minimum wage, dual-earner figures'
  : '- ACCEPT: only if the text EXPLICITLY states a price per sqm / per m² / per square meter\n- REJECT: total property listing price, rental price — no division, no inference'}
${isDecade ? `- value must be explicitly dated within ${decadeRange} — undated figures or figures from outside this range → null` : '- use the most recent available figure'}
- null is correct when the text does not contain the target value. Do not guess.`;
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
  getSeedMetricExtractionPrompt,
  getSeedMetricGapFillPrompt
};
