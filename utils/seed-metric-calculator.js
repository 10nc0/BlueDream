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

/**
 * Parse price per square meter from text
 * Handles: "$5,000/sqm", "5000 USD/m²", "¥50,000 per sqm", etc.
 * @param {string} text - Search result text
 * @param {string} city - City name for context
 * @returns {object|null} { value: number, currency: string, raw: string }
 */
function parsePricePerSqm(text, city = '') {
  if (!text) return null;
  
  const cityLower = city.toLowerCase();
  
  // Patterns for price per square meter (various formats)
  const patterns = [
    // $X,XXX/sqm or $X,XXX per sqm
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²|square\s*met)/gi,
    // X,XXX USD/sqm
    /([\d,]+(?:\.\d+)?)\s*(?:USD|usd|\$)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²)/gi,
    // ¥X,XXX/sqm (JPY)
    /[¥￥]\s*([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²)/gi,
    // X,XXX JPY/sqm
    /([\d,]+(?:\.\d+)?)\s*(?:JPY|jpy|yen)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²)/gi,
    // SGD X,XXX/sqm
    /(?:SGD|S\$)\s*([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²)/gi,
    // X,XXX SGD/sqm
    /([\d,]+(?:\.\d+)?)\s*SGD\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²)/gi,
    // Generic: X,XXX per square meter
    /([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:sq\s*m|sqm|m²|square\s*met)/gi,
    // psf to sqm conversion hint: $X,XXX psf (1 sqm ≈ 10.764 sqft)
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:psf|sq\s*ft|sqft)/gi,
  ];
  
  // Detect currency from city context
  let currency = 'USD';
  if (cityLower.includes('tokyo') || cityLower.includes('osaka')) currency = 'JPY';
  else if (cityLower.includes('singapore')) currency = 'SGD';
  else if (cityLower.includes('hong kong')) currency = 'HKD';
  else if (cityLower.includes('london')) currency = 'GBP';
  else if (cityLower.includes('paris') || cityLower.includes('berlin')) currency = 'EUR';
  
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const valueStr = match[1].replace(/,/g, '');
      const value = parseFloat(valueStr);
      if (value > 0 && value < 1000000) { // Sanity check
        // Check if this is psf (per sq ft) - convert to sqm
        const isPsf = /psf|sq\s*ft|sqft/i.test(match[0]);
        const finalValue = isPsf ? value * 10.764 : value;
        
        return {
          value: finalValue,
          currency,
          raw: match[0],
          isPsf
        };
      }
    }
  }
  
  return null;
}

/**
 * Parse median income from text
 * Handles: "$50,000 per year", "median income of $85,000", "¥6.5 million", etc.
 * @param {string} text - Search result text
 * @param {string} city - City name for context
 * @param {boolean} preferSingleEarner - If true, prefer "individual" over "household"
 * @returns {object|null} { value: number, currency: string, type: string, raw: string }
 */
function parseIncome(text, city = '', preferSingleEarner = true) {
  if (!text) return null;
  
  const cityLower = city.toLowerCase();
  
  // Detect currency from city context
  let currency = 'USD';
  if (cityLower.includes('tokyo') || cityLower.includes('osaka')) currency = 'JPY';
  else if (cityLower.includes('singapore')) currency = 'SGD';
  else if (cityLower.includes('hong kong')) currency = 'HKD';
  else if (cityLower.includes('london')) currency = 'GBP';
  else if (cityLower.includes('paris') || cityLower.includes('berlin')) currency = 'EUR';
  
  // Check for income type context
  const hasIndividual = /individual|personal|single[\s-]?earner|per\s*capita/i.test(text);
  const hasHousehold = /household|family|dual[\s-]?earner/i.test(text);
  const incomeType = hasIndividual ? 'single' : (hasHousehold ? 'household' : 'unknown');
  
  // Patterns for income (various formats)
  const patterns = [
    // $X,XXX or $X.X million
    /(?:median|average|mean)?\s*(?:individual|personal|household)?\s*income[^$]*\$\s*([\d,]+(?:\.\d+)?)\s*(?:million|mil|M)?/gi,
    // Standalone: $XX,XXX per year/annually
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:million|mil|M)?\s*(?:per\s*year|annually|\/year|\/yr|p\.a\.)/gi,
    // ¥X.X million (Japanese)
    /[¥￥]\s*([\d,]+(?:\.\d+)?)\s*(?:million|万|億)?/gi,
    // X.X million yen
    /([\d,]+(?:\.\d+)?)\s*million\s*(?:yen|JPY)/gi,
    // SGD X,XXX
    /(?:SGD|S\$)\s*([\d,]+(?:\.\d+)?)\s*(?:k|thousand|million)?/gi,
    // Generic: median income X,XXX
    /median\s*(?:individual|household)?\s*income[^\d]*([\d,]+(?:\.\d+)?)/gi,
  ];
  
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      let valueStr = match[1].replace(/,/g, '');
      let value = parseFloat(valueStr);
      
      // Handle "million" suffix
      if (/million|mil|M|億/i.test(match[0])) {
        value *= 1000000;
      } else if (/万/i.test(match[0])) {
        value *= 10000;
      } else if (/k|thousand/i.test(match[0])) {
        value *= 1000;
      }
      
      // Sanity check: income should be reasonable
      if (value > 0 && value < 100000000) {
        return {
          value,
          currency,
          type: incomeType,
          raw: match[0]
        };
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
      new RegExp(`${city}[^.]*(?:2023|2024|current|today|now)[^.]*`, 'gi'),
      new RegExp(`(?:2023|2024|current|today|now)[^.]*${city}[^.]*`, 'gi'),
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
  
  // Check for emoji regime readings with labels
  const hasRegimeEmoji = /[🟢🟡🔴]/.test(output);
  const hasRegimeLabel = /(?:OPTIMISM|EXTRACTION|FATALISM|Optimism|Extraction|Fatalism)/i.test(output);
  if (!hasRegimeEmoji) {
    issues.push('Missing regime emoji (🟢/🟡/🔴)');
  }
  if (!hasRegimeLabel) {
    issues.push('Missing regime label (Optimism/Extraction/Fatalism)');
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
