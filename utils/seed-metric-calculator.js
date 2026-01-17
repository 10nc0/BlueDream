/**
 * SEED METRIC CALCULATOR
 * 
 * Direct calculation bypass for Seed Metric analysis.
 * Parses search results, applies proxy rules, builds table deterministically.
 * 
 * Proxy Rules (from seed-metric.js):
 * - PROXY: Published $/m² → MULTIPLY BY 700 (non-negotiable)
 * - INCOME: Single-earner (not household/dual)
 * - P/I Ratio: Price / Income = Years to afford
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
 * Parse raw home/property price (not per sqm) for P/I fallback mode
 * @param {string} text - Text to search
 * @param {string} city - City name for context
 * @returns {object|null} { value: number, currency: string, raw: string }
 */
function parseRawPrice(text, city = '') {
  if (!text) return null;
  
  // Detect currency from context
  let currency = 'USD';
  if (/€|EUR|euro/i.test(text)) currency = 'EUR';
  else if (/£|GBP|pound/i.test(text)) currency = 'GBP';
  else if (/¥|JPY|yen/i.test(text)) currency = 'JPY';
  else if (/SGD|S\$/i.test(text)) currency = 'SGD';
  else if (/HKD|HK\$/i.test(text)) currency = 'HKD';
  
  const patterns = [
    // "median home price $500,000" or "average house price €350,000"
    /(?:median|average|mean)\s*(?:home|house|property|housing)\s*price[^\d]*([€$£¥]?[\d,]+(?:\.\d+)?)\s*(?:k|thousand|million|M)?/gi,
    // "$500,000 median home price"
    /([€$£¥]?[\d,]+(?:\.\d+)?)\s*(?:k|thousand|million|M)?\s*(?:median|average)\s*(?:home|house|property)/gi,
    // "homes cost $X" or "house prices are $X"
    /(?:home|house)s?\s*(?:cost|price)[^\d]*([€$£¥]?[\d,]+(?:\.\d+)?)\s*(?:k|thousand|million|M)?/gi,
    // "priced at $X" in housing context
    /(?:housing|residential|property)[^.]*priced\s*(?:at|around)?\s*([€$£¥]?[\d,]+(?:\.\d+)?)\s*(?:k|thousand|million|M)?/gi,
  ];
  
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      let valueStr = match[1].replace(/[€$£¥,]/g, '');
      let value = parseFloat(valueStr);
      
      // Handle multipliers
      if (/million|M/i.test(match[0])) {
        value *= 1000000;
      } else if (/k|thousand/i.test(match[0])) {
        value *= 1000;
      }
      
      // Sanity check: home price should be reasonable (10K - 100M)
      if (value >= 10000 && value <= 100000000) {
        return {
          value,
          currency,
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
 * Falls back to raw price when $/sqm unavailable
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
      current: { pricePerSqm: null, income: null, rawPrice: null },
      historical: { pricePerSqm: null, income: null, rawPrice: null, decade: historicalDecade }
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
        // P/I fallback: try raw price if no $/sqm found
        if (!result.cities[city].current.pricePerSqm && !result.cities[city].current.rawPrice) {
          result.cities[city].current.rawPrice = parseRawPrice(segment, city);
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
        // P/I fallback: try raw price if no $/sqm found
        if (!result.cities[city].historical.pricePerSqm && !result.cities[city].historical.rawPrice) {
          result.cities[city].historical.rawPrice = parseRawPrice(segment, city);
        }
      }
    }
    
    // Fallback for current data: search entire context for this city
    const needsCurrentFallback = !result.cities[city].current.pricePerSqm || !result.cities[city].current.income;
    const needsHistoricalFallback = !result.cities[city].historical.pricePerSqm || !result.cities[city].historical.income;
    
    if (needsCurrentFallback || needsHistoricalFallback) {
      const cityMentions = searchContext.match(new RegExp(`[^.]*${city}[^.]*`, 'gi'));
      if (cityMentions) {
        const allCityText = cityMentions.join(' ');
        
        // Current data fallback
        if (needsCurrentFallback) {
          if (!result.cities[city].current.pricePerSqm) {
            result.cities[city].current.pricePerSqm = parsePricePerSqm(allCityText, city);
          }
          if (!result.cities[city].current.income) {
            result.cities[city].current.income = parseIncome(allCityText, city);
          }
          // P/I fallback: if still no $/sqm, try raw home price
          if (!result.cities[city].current.pricePerSqm && !result.cities[city].current.rawPrice) {
            result.cities[city].current.rawPrice = parseRawPrice(allCityText, city);
          }
        }
        
        // Historical data fallback (independent of current)
        if (needsHistoricalFallback) {
          if (!result.cities[city].historical.pricePerSqm) {
            result.cities[city].historical.pricePerSqm = parsePricePerSqm(allCityText, city);
          }
          if (!result.cities[city].historical.income) {
            result.cities[city].historical.income = parseIncome(allCityText, city);
          }
          // P/I fallback: if still no $/sqm, try raw home price
          if (!result.cities[city].historical.pricePerSqm && !result.cities[city].historical.rawPrice) {
            result.cities[city].historical.rawPrice = parseRawPrice(allCityText, city);
          }
        }
      }
    }
    
    // Determine which mode was used for each period
    const currHasSqm = !!result.cities[city].current.pricePerSqm?.value;
    const currHasRaw = !!result.cities[city].current.rawPrice?.value;
    const currMode = currHasSqm ? '700sqm' : (currHasRaw ? 'P/I' : 'N/A');
    
    const histHasSqm = !!result.cities[city].historical.pricePerSqm?.value;
    const histHasRaw = !!result.cities[city].historical.rawPrice?.value;
    const histMode = histHasSqm ? '700sqm' : (histHasRaw ? 'P/I' : 'N/A');
    
    result.parseLog.push(`${city} CURRENT: price/sqm=${result.cities[city].current.pricePerSqm?.value || 'N/A'}, rawPrice=${result.cities[city].current.rawPrice?.value || 'N/A'}, income=${result.cities[city].current.income?.value || 'N/A'}, mode=${currMode}`);
    result.parseLog.push(`${city} HISTORICAL: price/sqm=${result.cities[city].historical.pricePerSqm?.value || 'N/A'}, rawPrice=${result.cities[city].historical.rawPrice?.value || 'N/A'}, income=${result.cities[city].historical.income?.value || 'N/A'}, mode=${histMode}`);
  }
  
  return result;
}

/**
 * Calculate Seed Metric values and assign regime
 * Two modes:
 * - Primary (700sqm): Uses $/sqm × 700, thresholds 10/25 years (3-tier)
 * - Fallback (P/I): Uses raw price/income ratio, threshold 3.5 (2-tier binary)
 * 
 * @param {number} pricePerSqm - Price per square meter (null for P/I fallback mode)
 * @param {number} income - Annual income (single-earner)
 * @param {object} options - { rawPrice: number } for P/I fallback mode
 * @returns {object} { price700sqm, pi_ratio, years, regime, emoji, mode }
 */
function calculateSeedMetric(pricePerSqm, income, options = {}) {
  const { rawPrice } = options;
  
  // P/I fallback mode: when we have raw price but not $/sqm
  if (!pricePerSqm && rawPrice && income && income > 0) {
    const pi_ratio = rawPrice / income;
    // Binary threshold: P/I 3.5
    const regime = pi_ratio <= 3.5 ? 'Optimism' : 'Fatalism';
    const emoji = pi_ratio <= 3.5 ? '🟢' : '🔴';
    return { 
      price700sqm: null, 
      pi_ratio, 
      years: null, 
      regime, 
      emoji, 
      mode: 'P/I fallback (3.5 threshold)' 
    };
  }
  
  // Primary mode: 700sqm calculation
  if (!pricePerSqm || !income || income === 0) {
    return { price700sqm: null, pi_ratio: null, years: null, regime: 'N/A', emoji: '⚪', mode: 'N/A' };
  }
  
  const price700sqm = pricePerSqm * 700;
  const pi_ratio = price700sqm / income;
  const years = pi_ratio; // P/I ratio = years to afford
  
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
  
  return { price700sqm, pi_ratio, years, regime, emoji, mode: '700sqm (10/25yr thresholds)' };
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
  
  // Table header
  rows.push('| City | Period | 700sqm Price | Income | P/I | Years | Regime |');
  rows.push('|------|--------|--------------|--------|-----|-------|--------|');
  
  for (const [city, data] of Object.entries(parsedData.cities || {})) {
    const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);
    
    // Historical row - try 700sqm mode first, fallback to P/I mode
    const histPriceSqm = data.historical?.pricePerSqm?.value;
    const histRawPrice = data.historical?.rawPrice?.value; // For P/I fallback
    const histIncome = data.historical?.income?.value;
    const histCurrency = data.historical?.pricePerSqm?.currency || data.historical?.income?.currency || 'USD';
    const histMetric = calculateSeedMetric(histPriceSqm, histIncome, { rawPrice: histRawPrice });
    
    // Current row - try 700sqm mode first, fallback to P/I mode
    const currPriceSqm = data.current?.pricePerSqm?.value;
    const currRawPrice = data.current?.rawPrice?.value; // For P/I fallback
    const currIncome = data.current?.income?.value;
    const currCurrency = data.current?.pricePerSqm?.currency || data.current?.income?.currency || 'USD';
    const currMetric = calculateSeedMetric(currPriceSqm, currIncome, { rawPrice: currRawPrice });
    
    // Regime label: use emoji+regime even in P/I mode (years may be null)
    const histRegimeLabel = histMetric.regime !== 'N/A' ? `${histMetric.emoji} ${histMetric.regime}` : 'N/A';
    const currRegimeLabel = currMetric.regime !== 'N/A' ? `${currMetric.emoji} ${currMetric.regime}` : 'N/A';
    
    // Years display: show actual years or P/I indicator
    const histYearsDisplay = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 
                             (histMetric.pi_ratio ? `P/I ${histMetric.pi_ratio.toFixed(1)}` : 'N/A');
    const currYearsDisplay = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 
                             (currMetric.pi_ratio ? `P/I ${currMetric.pi_ratio.toFixed(1)}` : 'N/A');
    
    // Add historical row
    rows.push(`| ${cityTitle} | ${historicalDecade} | ${formatCurrency(histMetric.price700sqm, histCurrency)} | ${formatCurrency(histIncome, histCurrency)} | ${histMetric.pi_ratio?.toFixed(1) || 'N/A'} | ${histYearsDisplay} | ${histRegimeLabel} |`);
    
    // Add current row
    rows.push(`| ${cityTitle} | 2024 | ${formatCurrency(currMetric.price700sqm, currCurrency)} | ${formatCurrency(currIncome, currCurrency)} | ${currMetric.pi_ratio?.toFixed(1) || 'N/A'} | ${currYearsDisplay} | ${currRegimeLabel} |`);
    
    // Build summary line - handle both modes
    const histSummary = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 
                        (histMetric.pi_ratio ? `P/I ${histMetric.pi_ratio.toFixed(1)}` : 'N/A');
    const currSummary = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 
                        (currMetric.pi_ratio ? `P/I ${currMetric.pi_ratio.toFixed(1)}` : 'N/A');
    const direction = (currMetric.pi_ratio && histMetric.pi_ratio) 
      ? (currMetric.pi_ratio > histMetric.pi_ratio ? '↑worsened' : '↓improved')
      : '';
    summaries.push(`**${cityTitle}**: ${histSummary} → ${currSummary} = ${currMetric.emoji} ${currMetric.regime} (${direction})`);
  }
  
  // Combine table + summaries + legend
  const table = rows.join('\n');
  const summaryBlock = summaries.join('\n');
  
  // Legend explaining both threshold systems with 35% spend ratio derivation
  const legend = `
---
**Regime Thresholds** (φ-derived from 25yr fertility window):

**Primary (700sqm × $/m²)** — 3-tier when $/sqm data available:
- 🟢 **OPTIMISM**: <10 years — Housing accessible within early career
- 🟡 **EXTRACTION**: 10-25 years — Affordable but requires sustained effort  
- 🔴 **FATALISM**: >25 years — Exceeds fertility window; systemic barrier

**Fallback (raw P/I)** — 2-tier when only price/income available:
- 🟢 **OPTIMISM**: P/I ≤ 3.5
- 🔴 **FATALISM**: P/I > 3.5

*Note: P/I 3.5 ≈ 10 years at 35% housing spend (Years = P/I ÷ 0.35)*`;
  
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
  
  // Check for table header
  const hasTableHeader = /\|\s*City\s*\|\s*Period\s*\|.*\|\s*Regime\s*\|/i.test(output);
  if (!hasTableHeader) {
    issues.push('Missing table header');
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
  
  // Check for prose paragraphs (bad sign)
  const proseIndicators = output.match(/(?:Fast forward|Using the Seed Metric|we can calculate|However,|it's essential|In conclusion|assuming a)/gi);
  if (proseIndicators && proseIndicators.length >= 2) {
    issues.push('Contains prose paragraphs instead of table');
  }
  
  // Check paragraph count - if >3 paragraphs and no table header, reject
  const paragraphs = output.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length > 3 && !hasTableHeader) {
    issues.push('Too many paragraphs without table format');
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
  
  // 2. Mortgage duration confusion (P/I years ≠ mortgage term)
  if (/(?:time to pay off|pay off the mortgage|mortgage.*(?:5-7|10-12|8-10)\s*years)/i.test(output)) {
    issues.push('Confusing P/I years with mortgage duration');
  }
  
  // 3. P/I 3.5 threshold is VALID for fallback mode - do not reject
  // (Previously rejected, but 3.5 ≈ 10yr when accounting for housing spend ratio)
  
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
