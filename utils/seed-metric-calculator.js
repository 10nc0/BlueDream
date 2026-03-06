/**
 * SEED METRIC CALCULATOR
 *
 * Direct calculation bypass for Seed Metric analysis.
 * Parses search results, applies proxy rules, builds table deterministically.
 *
 * Formula: Years = ($/sqm × 700) ÷ Single-Earner Income
 * NO P/I ratio — if $/sqm unavailable, show "N/A".
 *
 * Proxy Rules (from seed-metric.js):
 * - PRIMARY: Published $/m² → MULTIPLY BY 700 (non-negotiable)
 * - INCOME: Single-earner (not household/dual)
 * - Regime: <10yr 🟢 Optimism | 10-25yr 🟡 Extraction | >25yr 🔴 Fatalism
 */

// ─── Currency Registry ────────────────────────────────────────────────────────
// Single source of truth. To add a new currency: one entry here, nothing else.
// usdRate = 1 unit of this currency in USD (used only for sanity-check scaling).
// cities  = lowercase city/country keywords that imply this currency.
const CURRENCY_REGISTRY = {
  USD: { symbols: ['USD', '$'],                    usdRate: 1,          cities: [] },
  EUR: { symbols: ['EUR', '€'],                    usdRate: 0.92,       cities: ['paris', 'berlin', 'vienna', 'amsterdam', 'munich', 'rome', 'madrid', 'milan', 'brussels', 'lisbon', 'dublin', 'hamburg', 'frankfurt', 'europe', 'eurozone'] },
  GBP: { symbols: ['GBP', '£'],                    usdRate: 1.27,       cities: ['london', 'manchester', 'birmingham', 'edinburgh', 'uk', 'united kingdom'] },
  JPY: { symbols: ['JPY', 'yen', '¥', '￥'],       usdRate: 0.0067,     cities: ['tokyo', 'osaka', 'kyoto', 'japan'] },
  KRW: { symbols: ['KRW', 'won', '₩'],             usdRate: 0.00077,    cities: ['seoul', 'busan', 'incheon', 'daegu', 'daejeon', 'korea'] },
  SGD: { symbols: ['SGD', 'S$'],                   usdRate: 0.74,       cities: ['singapore'] },
  HKD: { symbols: ['HKD', 'HK$'],                  usdRate: 0.128,      cities: ['hong kong'] },
  AUD: { symbols: ['AUD', 'A$'],                   usdRate: 0.65,       cities: ['sydney', 'melbourne', 'brisbane', 'perth', 'australia'] },
  CAD: { symbols: ['CAD', 'C$'],                   usdRate: 0.74,       cities: ['toronto', 'vancouver', 'montreal', 'calgary', 'canada'] },
  CHF: { symbols: ['CHF', 'Fr'],                   usdRate: 1.12,       cities: ['zurich', 'geneva', 'switzerland'] },
  CNY: { symbols: ['CNY', 'RMB', 'yuan', '元'],    usdRate: 0.138,      cities: ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'china'] },
  INR: { symbols: ['INR', 'Rs', '₹'],              usdRate: 0.012,      cities: ['mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'india'] },
  IDR: { symbols: ['IDR', 'Rp'],                   usdRate: 0.000064,   cities: ['jakarta', 'surabaya', 'bali', 'indonesia'] },
  VND: { symbols: ['VND', 'dong', '₫'],            usdRate: 0.000040,   cities: ['hanoi', 'ho chi minh', 'saigon', 'vietnam'] },
  THB: { symbols: ['THB', 'baht', '฿'],            usdRate: 0.028,      cities: ['bangkok', 'phuket', 'thailand'] },
  MYR: { symbols: ['MYR', 'RM', 'ringgit'],        usdRate: 0.213,      cities: ['kuala lumpur', 'penang', 'malaysia'] },
  PHP: { symbols: ['PHP', '₱', 'peso'],            usdRate: 0.018,      cities: ['manila', 'cebu', 'philippines'] },
  AED: { symbols: ['AED', 'dirham'],               usdRate: 0.272,      cities: ['dubai', 'abu dhabi', 'uae'] },
  BRL: { symbols: ['BRL', 'R$'],                   usdRate: 0.196,      cities: ['sao paulo', 'rio', 'brazil'] },
  NZD: { symbols: ['NZD', 'NZ$'],                  usdRate: 0.61,       cities: ['auckland', 'wellington', 'new zealand'] },
  ZAR: { symbols: ['ZAR', 'R'],                    usdRate: 0.054,      cities: ['johannesburg', 'cape town', 'south africa'] },
  MXN: { symbols: ['MXN', 'MX$'],                 usdRate: 0.058,      cities: ['mexico city', 'guadalajara', 'mexico'] },
  TRY: { symbols: ['TRY', '₺'],                    usdRate: 0.031,      cities: ['istanbul', 'ankara', 'turkey'] },
};

// Build a flat symbol→code lookup (longest symbols checked first to avoid prefix collisions)
const _SYMBOL_MAP = (() => {
  const map = [];
  for (const [code, info] of Object.entries(CURRENCY_REGISTRY)) {
    for (const sym of info.symbols) {
      map.push({ sym, code });
    }
  }
  map.sort((a, b) => b.sym.length - a.sym.length);
  return map;
})();

/**
 * Detect currency from city name and/or text content.
 * Priority: city keyword match → explicit symbol in text → USD fallback.
 * Note: ¥ is shared by JPY/CNY — city context disambiguates; default JPY.
 */
function detectCurrency(city = '', text = '') {
  const cityLower = city.toLowerCase();
  for (const [code, info] of Object.entries(CURRENCY_REGISTRY)) {
    if (info.cities.some(c => cityLower.includes(c))) return code;
  }
  // Scan text for explicit currency symbols/codes (longest first)
  for (const { sym, code } of _SYMBOL_MAP) {
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\s|[^\\w])${escaped}(?:\\s|[^\\w]|$)`, 'i').test(text)) return code;
  }
  return 'USD';
}

/** Convert a native-currency value to USD equivalent (for sanity checks only). */
function usdEquiv(value, currency) {
  return value * (CURRENCY_REGISTRY[currency]?.usdRate ?? 1);
}

/** Parse numeric multiplier suffixes (million/billion/k and CJK units). */
function applyMultiplier(value, raw) {
  if (/billion|bn/i.test(raw))           return value * 1_000_000_000;
  if (/million|mil\b|\b[Mm]\b|億/i.test(raw)) return value * 1_000_000;
  if (/만|万/i.test(raw))                return value * 10_000;
  if (/\bk\b|thousand/i.test(raw))       return value * 1_000;
  return value;
}

// Regex fragments reused in both parsers
const _SQM  = '(?:sq\\s*m|sqm|m²|square\\s*met(?:er|re)s?)';
const _PSF  = '(?:psf|sq\\s*ft|sqft)';
const _NUM  = '([\\d,]+(?:\\.\\d+)?)';
const _MULT = '(?:\\s*(?:billion|bn|million|mil|M|k|thousand|만|万|億|억))?';
// All known symbols joined for use in patterns (escaped, longest first)
const _SYMS = _SYMBOL_MAP.map(e => e.sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

// ─── Price per sqm parser ─────────────────────────────────────────────────────
/**
 * Parse price per square meter from text.
 * Handles any currency via CURRENCY_REGISTRY.
 * @param {string} text
 * @param {string} city - city name for currency hint
 * @returns {{ value: number, currency: string, raw: string, isPsf: boolean }|null}
 */
function parsePricePerSqm(text, city = '') {
  if (!text) return null;

  const currency = detectCurrency(city, text);
  const { usdRate } = CURRENCY_REGISTRY[currency];

  // Pattern 1: symbol/code BEFORE number → per sqm   e.g. "₩10,500,000/sqm"
  // Pattern 2: number THEN optional symbol/code → per sqm  e.g. "10,500,000 KRW/sqm"
  // Pattern 3: psf (price per sq ft) with $ prefix    e.g. "$2,500 psf"
  // Pattern 4: context-driven — "price/cost per sqm … number"
  const patterns = [
    new RegExp(`(?:${_SYMS})\\s*${_NUM}${_MULT}\\s*(?:\\/|per)\\s*${_SQM}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS})?\\s*(?:\\/|per)\\s*${_SQM}`, 'gi'),
    new RegExp(`\\$\\s*${_NUM}${_MULT}\\s*(?:\\/|per)\\s*${_PSF}`, 'gi'),
    new RegExp(`(?:price|cost|average|median)\\s*(?:per|\\/)\\s*${_SQM}[^0-9]*${_NUM}`, 'gi'),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const valueStr = (match[1] || match[2] || '').replace(/,/g, '');
      if (!valueStr) continue;
      let value = applyMultiplier(parseFloat(valueStr), raw);
      if (!isFinite(value) || value <= 0) continue;
      const isPsf = /psf|sq\s*ft|sqft/i.test(raw);
      if (isPsf) value *= 10.764;
      // Sanity: $10–$150,000 per sqm in USD equivalent covers all world markets
      const usd = value * usdRate;
      if (usd >= 10 && usd <= 150_000) {
        return { value, currency, raw, isPsf };
      }
    }
  }
  return null;
}

// ─── Income parser ────────────────────────────────────────────────────────────
/**
 * Parse median/individual annual income from text.
 * Handles any currency via CURRENCY_REGISTRY.
 * @param {string} text
 * @param {string} city
 * @param {boolean} preferSingleEarner
 * @returns {{ value: number, currency: string, type: string, raw: string }|null}
 */
function parseIncome(text, city = '', preferSingleEarner = true) {
  if (!text) return null;

  const currency = detectCurrency(city, text);
  const { usdRate } = CURRENCY_REGISTRY[currency];

  const hasIndividual = /individual|personal|single[\s-]?earner|per\s*capita/i.test(text);
  const hasHousehold  = /household|family|dual[\s-]?earner/i.test(text);
  const incomeType    = hasIndividual ? 'single' : (hasHousehold ? 'household' : 'unknown');

  // Pattern 1: income/salary/wage keyword → symbol → number  e.g. "income: ₩42,000,000"
  // Pattern 2: symbol → number → per year suffix             e.g. "₩42,000,000 per year"
  // Pattern 3: number → code → per year suffix               e.g. "42,000,000 KRW/year"
  // Pattern 4: generic — number near income keywords (last resort)
  const _YEAR  = '(?:per\\s*year|annually|\\/year|\\/yr|p\\.a\\.|per\\s*annum)';
  const _INC   = '(?:income|salary|wage|earnings|pay)';
  const patterns = [
    new RegExp(`${_INC}[^\\d]{0,40}(?:${_SYMS})\\s*${_NUM}${_MULT}`, 'gi'),
    new RegExp(`(?:${_SYMS})\\s*${_NUM}${_MULT}\\s*${_YEAR}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS})?\\s*${_YEAR}`, 'gi'),
    new RegExp(`(?:median|average|mean)\\s*(?:individual|household)?\\s*${_INC}[^\\d]{0,30}${_NUM}${_MULT}`, 'gi'),
    new RegExp(`${_INC}\\s*(?:of|is|was|:)\\s*(?:${_SYMS})?\\s*${_NUM}${_MULT}`, 'gi'),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const valueStr = (match[1] || match[2] || '').replace(/,/g, '');
      if (!valueStr) continue;
      const value = applyMultiplier(parseFloat(valueStr), raw);
      if (!isFinite(value) || value <= 0) continue;
      // Sanity: $500–$1,000,000 annual income in USD equivalent
      const usd = value * usdRate;
      if (usd >= 500 && usd <= 1_000_000) {
        return { value, currency, type: incomeType, raw };
      }
    }
  }
  return null;
}

/**
 * Parse search results for Seed Metric data
 * Extracts price/sqm and income for each city/period
 * Uses ONLY $/sqm × 700 formula - NO raw price fallback
 * @param {string} searchContext - Combined search results text
 * @param {string[]} cities - City names to look for
 * @param {string} historicalDecade - e.g., "1970s"
 * @returns {object} { cities: { [city]: { current: {...}, historical: {...} } } }
 */
function parseSeedMetricData(searchContext, cities = [], historicalDecade = '1970s') {
  const result = { cities: {}, parseLog: [] };
  
  if (!searchContext) {
    result.parseLog.push('No search context provided');
    return result;
  }
  
  // Normalize city names
  const normalizedCities = cities.map(c => c.toLowerCase().trim());
  
  for (const city of normalizedCities) {
    result.cities[city] = {
      current: { pricePerSqm: null, income: null },
      historical: { pricePerSqm: null, income: null, decade: historicalDecade }
    };
    
    // Split search context by city mentions for better targeting
    const cityPatterns = [
      new RegExp(`${city}[^.]*(?:2023|2024|2025|2026|current|today|now|latest|recent)[^.]*`, 'gi'),
      new RegExp(`(?:2023|2024|2025|2026|current|today|now|latest|recent)[^.]*${city}[^.]*`, 'gi'),
    ];
    
    const historicalPatterns = [
      new RegExp(`${city}[^.]*(?:${historicalDecade}|1970|1980|historical|50\\s*years?\\s*ago)[^.]*`, 'gi'),
      new RegExp(`(?:${historicalDecade}|1970|1980|historical|50\\s*years?\\s*ago)[^.]*${city}[^.]*`, 'gi'),
    ];
    
    // Try to find current data
    for (const pattern of cityPatterns) {
      const matches = searchContext.match(pattern);
      if (matches) {
        const segment = matches.join(' ');
        if (!result.cities[city].current.pricePerSqm) {
          result.cities[city].current.pricePerSqm = parsePricePerSqm(segment, city);
        }
        if (!result.cities[city].current.income) {
          result.cities[city].current.income = parseIncome(segment, city);
        }
      }
    }
    
    // Try to find historical data
    for (const pattern of historicalPatterns) {
      const matches = searchContext.match(pattern);
      if (matches) {
        const segment = matches.join(' ');
        if (!result.cities[city].historical.pricePerSqm) {
          result.cities[city].historical.pricePerSqm = parsePricePerSqm(segment, city);
        }
        if (!result.cities[city].historical.income) {
          result.cities[city].historical.income = parseIncome(segment, city);
        }
      }
    }
    
    // Fallback: search entire context for this city
    if (!result.cities[city].current.pricePerSqm || !result.cities[city].current.income) {
      const cityMentions = searchContext.match(new RegExp(`[^.]*${city}[^.]*`, 'gi'));
      if (cityMentions) {
        const allCityText = cityMentions.join(' ');
        if (!result.cities[city].current.pricePerSqm) {
          result.cities[city].current.pricePerSqm = parsePricePerSqm(allCityText, city);
        }
        if (!result.cities[city].current.income) {
          result.cities[city].current.income = parseIncome(allCityText, city);
        }
      }
    }
    
    result.parseLog.push(`${city} CURRENT: price/sqm=${result.cities[city].current.pricePerSqm?.value || 'N/A'}, income=${result.cities[city].current.income?.value || 'N/A'}`);
    result.parseLog.push(`${city} HISTORICAL: price/sqm=${result.cities[city].historical.pricePerSqm?.value || 'N/A'}, income=${result.cities[city].historical.income?.value || 'N/A'}`);
  }
  
  return result;
}

/**
 * Calculate Seed Metric values and assign regime
 * PRIMARY: ($/sqm × 700) ÷ Single-Earner Income = Years
 * Thresholds: <10yr Optimism | 10-25yr Extraction | >25yr Fatalism
 * 
 * NO mortgage calculations, NO interest rates, NO down payments
 * NO P/I ratio — Years is the only output metric.
 * 
 * @param {number} pricePerSqm - Price per square meter
 * @param {number} income - Annual income (SINGLE-EARNER, not household)
 * @returns {object} { price700sqm, years, regime, emoji, isProxy }
 */
function calculateSeedMetric(pricePerSqm, income) {
  if (!pricePerSqm || !income || income === 0) {
    return { price700sqm: null, years: null, regime: 'N/A', emoji: '⚪', isProxy: false };
  }
  
  const price700sqm = pricePerSqm * 700;
  const years = price700sqm / income;
  
  // Regime assignment (φ-derived from 25yr fertility window) - 3-tier
  let regime, emoji;
  if (years < 10) {
    regime = 'Optimism';
    emoji = '🟢';
  } else if (years <= 25) {
    regime = 'Extraction';
    emoji = '🟡';
  } else {
    regime = 'Fatalism';
    emoji = '🔴';
  }
  
  return { price700sqm, years, regime, emoji, isProxy: false };
}

/**
 * Format currency value with appropriate symbol and scale
 * @param {number} value - Numeric value
 * @param {string} currency - Currency code
 * @returns {string} Formatted string
 */
function formatCurrency(value, currency = 'USD') {
  if (value == null || isNaN(value)) return 'N/A';
  
  const symbols = {
    USD: '$', JPY: '¥', SGD: 'S$', HKD: 'HK$', GBP: '£', EUR: '€'
  };
  const symbol = symbols[currency] || currency + ' ';
  
  // Format large numbers
  if (value >= 1000000) {
    return `${symbol}${(value / 1000000).toFixed(1)}M`;
  } else if (value >= 1000) {
    return `${symbol}${(value / 1000).toFixed(0)}K`;
  } else {
    return `${symbol}${value.toFixed(0)}`;
  }
}

/**
 * Build Seed Metric table from parsed data
 * @param {object} parsedData - Output from parseSeedMetricData()
 * @param {string} historicalDecade - e.g., "1970s"
 * @returns {string} Markdown table with regime readings
 */
function buildSeedMetricTable(parsedData, historicalDecade = '1970s') {
  const rows = [];
  const summaries = [];
  
  // Table header — $/sqm shown to force bottoms-up, NO P/I column
  rows.push('| City | Period | $/sqm | 700sqm Price | Income | Years | Regime |');
  rows.push('|------|--------|-------|--------------|--------|-------|--------|');
  
  for (const [city, data] of Object.entries(parsedData.cities || {})) {
    const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);
    
    // Historical row
    const histPriceSqm = data.historical?.pricePerSqm?.value;
    const histIncome = data.historical?.income?.value;
    const histCurrency = data.historical?.pricePerSqm?.currency || data.historical?.income?.currency || 'USD';
    const histMetric = calculateSeedMetric(histPriceSqm, histIncome);
    
    // Current row
    const currPriceSqm = data.current?.pricePerSqm?.value;
    const currIncome = data.current?.income?.value;
    const currCurrency = data.current?.pricePerSqm?.currency || data.current?.income?.currency || 'USD';
    const currMetric = calculateSeedMetric(currPriceSqm, currIncome);
    
    // Regime label with emoji
    const histRegimeLabel = histMetric.regime !== 'N/A' ? `${histMetric.emoji} ${histMetric.regime}` : 'N/A';
    const currRegimeLabel = currMetric.regime !== 'N/A' ? `${currMetric.emoji} ${currMetric.regime}` : 'N/A';
    
    // Years display (simple division, no mortgage)
    const histYearsDisplay = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 'N/A';
    const currYearsDisplay = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 'N/A';
    
    // Add historical row — show $/sqm source data
    const histSqmDisplay = histPriceSqm ? formatCurrency(histPriceSqm, histCurrency) : 'N/A';
    rows.push(`| ${cityTitle} | ${historicalDecade} | ${histSqmDisplay} | ${formatCurrency(histMetric.price700sqm, histCurrency)} | ${formatCurrency(histIncome, histCurrency)} | ${histYearsDisplay} | ${histRegimeLabel} |`);
    
    // Add current row — show $/sqm source data
    const currSqmDisplay = currPriceSqm ? formatCurrency(currPriceSqm, currCurrency) : 'N/A';
    rows.push(`| ${cityTitle} | 2024 | ${currSqmDisplay} | ${formatCurrency(currMetric.price700sqm, currCurrency)} | ${formatCurrency(currIncome, currCurrency)} | ${currYearsDisplay} | ${currRegimeLabel} |`);
    
    // Build summary line
    const histSummary = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 'N/A';
    const currSummary = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 'N/A';
    const direction = (currMetric.years && histMetric.years) 
      ? (currMetric.years > histMetric.years ? '↑worsened' : '↓improved')
      : '';
    summaries.push(`**${cityTitle}**: ${histSummary} → ${currSummary} = ${currMetric.emoji} ${currMetric.regime} (${direction})`);
  }
  
  // Combine table + summaries + legend
  const table = rows.join('\n');
  const summaryBlock = summaries.join('\n');
  
  // Legend: simple thresholds, NO mortgage complexity
  const legend = `
---
**Seed Metric Regime** (φ-derived from 25yr fertility window):

Formula: **Years = ($/sqm × 700) ÷ (Single-Earner Income)**
*(Simple division. NO mortgage. NO interest rates. NO down payments.)*
*($/sqm shown in table to force bottoms-up calculation)*

- 🟢 **OPTIMISM**: <10 years — Housing accessible within early career
- 🟡 **EXTRACTION**: 10-25 years — Affordable but requires sustained effort  
- 🔴 **FATALISM**: >25 years — Exceeds fertility window; systemic barrier`;
  
  return `${table}\n\n${summaryBlock}\n${legend}`;
}

/**
 * Validate Seed Metric output format
 * @param {string} output - LLM-generated output
 * @returns {object} { valid: boolean, issues: string[] }
 */
function validateSeedMetricOutput(output) {
  const issues = [];
  
  if (!output) {
    issues.push('Empty output');
    return { valid: false, issues };
  }
  
  // Check for table header (must have $/sqm column, NO P/I column)
  const hasTableHeader = /\|\s*City\s*\|\s*Period\s*\|.*\|\s*Regime\s*\|/i.test(output);
  if (!hasTableHeader) {
    issues.push('FORBIDDEN: Missing table header. Output MUST use | City | Period | $/sqm | 700sqm Price | Income | Years | Regime | format.');
  }
  
  // Check table row count — need at least 2 rows per city (historical + current)
  const tableRows = output.match(/^\|[^-][^|]*\|/gm);
  const dataRows = tableRows ? tableRows.filter(r => !/City|Period|Regime/i.test(r)).length : 0;
  if (hasTableHeader && dataRows < 2) {
    issues.push('FORBIDDEN: Table needs at least 2 data rows (historical + current). Must show ~50yr ago AND now.');
  }
  
  // Check that table rows contain historical period references
  if (hasTableHeader && dataRows >= 2) {
    const rowText = tableRows ? tableRows.join(' ') : '';
    const hasHistRow = /(?:197\d|198\d|~197|1970s|1980s)/i.test(rowText);
    const hasCurrRow = /(?:202\d|2025|2026|now|today|present)/i.test(rowText);
    if (!hasHistRow) {
      issues.push('Table missing historical period row (~1976/1970s). Must show ~50yr ago data.');
    }
    if (!hasCurrRow) {
      issues.push('Table missing current period row (2025/2026). Must show current data.');
    }
  }
  
  // Check for forbidden P/I column in table header
  const hasPIColumn = /\|\s*P\/I\s*\|/i.test(output);
  if (hasPIColumn) {
    issues.push('FORBIDDEN: Table has P/I column. Use $/sqm column instead. Years = ($/sqm × 700) ÷ Income.');
  }
  
  // Check for City column in table header (must be unified table, not split per city)
  const hasCityColumn = /\|\s*City\s*\|/i.test(output);
  if (hasTableHeader && !hasCityColumn) {
    issues.push('Missing City column in table header. Must use unified | City | Period | ... | format (not separate tables per city).');
  }
  
  // Check for split tables (separate table per city = wrong format)
  const tableHeaderCount = (output.match(/\|\s*(?:City\s*\|)?\s*Period\s*\|/gi) || []).length;
  if (tableHeaderCount > 1) {
    issues.push('FORBIDDEN: Multiple tables detected. Must use ONE unified table with City column, not separate tables per city.');
  }
  
  // Check for emoji regime readings with labels
  const hasRegimeEmoji = /[🟢🟡🔴]/.test(output);
  const hasRegimeLabel = /(?:OPTIMISM|EXTRACTION|FATALISM|Optimism|Extraction|Fatalism)/i.test(output);
  if (!hasRegimeEmoji) {
    issues.push('Missing regime emoji (🟢/🟡/🔴) — must appear in Regime column');
  }
  if (!hasRegimeLabel) {
    issues.push('Missing regime label (Optimism/Extraction/Fatalism)');
  }
  
  // Check for summary lines after table (e.g., **London**: 13.1yr → 101.2yr = 🔴 Fatalism)
  const hasSummaryLine = /\*\*[^*]+\*\*\s*:\s*[\d.]+\s*yr\s*→\s*[\d.]+\s*yr/i.test(output);
  if (hasTableHeader && !hasSummaryLine) {
    issues.push('Missing summary lines after table. Need: **[City]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)');
  }
  
  // REGIME MISMATCH DETECTION — parse table rows by column index
  // Table format: | City | Period | $/sqm | 700sqm Price | Income | Years | Regime |
  // Column indices: 0=City, 1=Period, 2=$/sqm, 3=700sqm, 4=Income, 5=Years, 6=Regime
  const allTableLines = output.split('\n').filter(line => /^\|/.test(line.trim()) && !/^[\s|:-]+$/.test(line.trim()));
  const dataLines = allTableLines.filter(line => !/City|Period|Regime.*\|.*\|.*\|/i.test(line) && !/^[\s|:-]+$/.test(line));
  for (const line of dataLines) {
    const cols = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cols.length >= 6) {
      const yearsCol = cols.length >= 7 ? cols[5] : cols[cols.length - 2];
      const regimeCol = cols.length >= 7 ? cols[6] : cols[cols.length - 1];
      const yearsNum = parseFloat(yearsCol.replace(/[,yr\s]/gi, ''));
      const regimeMatch = regimeCol.match(/(Optimism|Extraction|Fatalism)/i);
      if (!isNaN(yearsNum) && regimeMatch) {
        const regime = regimeMatch[1].toLowerCase();
        if (yearsNum < 10 && regime !== 'optimism') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🟢 Optimism (<10yr), not ${regimeMatch[1]}`);
        } else if (yearsNum >= 10 && yearsNum <= 25 && regime !== 'extraction') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🟡 Extraction (10-25yr), not ${regimeMatch[1]}`);
        } else if (yearsNum > 25 && regime !== 'fatalism') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🔴 Fatalism (>25yr), not ${regimeMatch[1]}`);
        }
      }
    }
  }
  
  // Check for 700sqm mention (not just "sqm" or wrong size)
  const has700sqm = /700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (!has700sqm) {
    issues.push('Missing 700sqm reference');
  }
  
  // Check for prose paragraphs (bad sign — output MUST be table, not prose)
  const proseIndicators = output.match(/(?:Fast forward|Using the Seed Metric|we can calculate|we can estimate|However,|it's essential|In conclusion|assuming a|Comparing the two|Assuming an|The median|approximately \d|50 years ago)/gi);
  if (proseIndicators && proseIndicators.length >= 2) {
    issues.push('FORBIDDEN: Contains prose paragraphs instead of table. Must use | City | Period | $/sqm | ... | Regime | format.');
  }
  
  // Check paragraph count - if >3 paragraphs and no table header, reject
  const paragraphs = output.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length > 3 && !hasTableHeader) {
    issues.push('FORBIDDEN: Too many paragraphs without table format. Output must be a markdown table.');
  }
  
  // Check for missing historical data (must have BOTH ~50yr ago AND now)
  const hasHistorical = /(?:197\d|198\d|~?\d{4}s?|50\s*(?:yr|year)s?\s*ago)/i.test(output);
  const hasCurrentData = /(?:202\d|today|now|current|present)/i.test(output);
  if (!hasHistorical && hasCurrentData) {
    issues.push('Missing historical (~50yr ago) data. Must show BOTH historical AND current periods.');
  }
  
  // Check for "no data" cop-out on historical $/sqm
  if (/(?:no data|no precise|unavailable|cannot find|don't have).*(?:\$\/sqm|historical|197\d)/i.test(output)) {
    issues.push('FORBIDDEN: "No data" cop-out. Must ESTIMATE historical $/sqm from proxy sources.');
  }
  
  // Check for wrong 700sqm interpretation (e.g., "3-room = 700sqm")
  const wrong700sqm = /(?:3-room|HDB|apartment|flat)[^.]*(?:approximately|about|around)?\s*700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (wrong700sqm) {
    issues.push('Wrong 700sqm interpretation (apartment ≠ 700sqm)');
  }
  
  // HALLUCINATION DETECTION - specific wrong patterns
  // 1. 700 sqft confusion (should be 700 m², not sqft)
  if (/700\s*(?:sqft|sq\s*ft|square\s*feet)/i.test(output)) {
    issues.push('Wrong unit: 700 sqft instead of 700 m² (10x error)');
  }
  
  // 2. Mortgage/interest rate calculations (FORBIDDEN - Years = ($/sqm × 700) ÷ Income)
  if (/(?:down\s*payment|interest\s*rate|mortgage|pay\s*off|amortiz|loan\s*term|\d+%\s*interest)/i.test(output)) {
    issues.push('FORBIDDEN: Contains mortgage/interest calculations. Years = Price ÷ Income (simple division)');
  }
  
  // 3. P/I 3.5 threshold (FORBIDDEN - removed fallback mode)
  if (/(?:P\/I|price[\s-]*to[\s-]*income).*3\.5|threshold.*3\.5/i.test(output)) {
    issues.push('FORBIDDEN: P/I 3.5 threshold. Use 10/25yr only.');
  }
  
  // 3b. Raw P/I ratio used without $/sqm (indicates bypassing the formula)
  const rawPIUsed = /(?:price[\s-]*to[\s-]*income|P\/I)\s*(?:ratio)?\s*(?:is|=|:)\s*[\d.]+/i.test(output);
  const hasSqmColumn = /\|\s*\$\/sqm\s*\|/i.test(output);
  if (rawPIUsed && !hasSqmColumn) {
    issues.push('Raw P/I ratio used without $/sqm source data. Must use ($/sqm × 700) ÷ income formula.');
  }
  
  // 4. Generic sqft mention without 700m² (likely wrong unit)
  if (/\d+\s*sqft/i.test(output) && !has700sqm) {
    issues.push('Uses sqft without proper 700m² reference');
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
}

module.exports = {
  parsePricePerSqm,
  parseIncome,
  parseSeedMetricData,
  calculateSeedMetric,
  formatCurrency,
  buildSeedMetricTable,
  validateSeedMetricOutput
};
