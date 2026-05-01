/**
 * SEED METRIC CALCULATOR
 *
 * Deterministic math layer for Seed Metric analysis.
 * Receives structured data from per-search micro-extractions (agent swarm),
 * builds table, validates format.
 *
 * Formula: Years = (LCU/sqm × 700) ÷ Single-Earner Income
 * NO P/I ratio — if LCU/sqm unavailable, show "N/A".
 *
 * Proxy Rules (from seed-metric.js):
 * - PRIMARY: Published $/m² → MULTIPLY BY 700 (non-negotiable)
 * - INCOME: Single-earner (not household/dual)
 * - Regime: <10yr 🟢 Optimism | 10-25yr 🟡 Extraction | >25yr 🔴 Fatalism
 */

const { CURRENCY_REGISTRY, CITY_EXPAND } = require('./geo-data');
const { EMPTY_TABLE_ROW_REGEX } = require('./parse-helpers');

// ─── TFR (Total Fertility Rate) parser ──────────────────────────────────────────
function parseTFR(snippets, city = '', targetYear = '') {
  if (!snippets) return null;
  const text = typeof snippets === 'string' ? snippets : JSON.stringify(snippets);
  if (!text || text.length < 10) return null;

  const cityLower = city.toLowerCase().replace(/[^a-z\s]/g, '');
  const patterns = [
    /(?:total\s+)?fertility\s+rate[^.]{0,60}?(\d\.\d{1,2})/gi,
    /(?:TFR)[^.]{0,60}?(\d\.\d{1,2})/g,
    /(\d\.\d{1,2})\s*(?:births?\s+per\s+woman|children\s+per\s+woman)/gi,
    /(?:fertility\s+rate|TFR)\s*(?:of|is|was|:|=)\s*(\d\.\d{1,2})/gi,
    /(\d\.\d{1,2})\s*(?:total\s+)?fertility/gi,
  ];

  const targetYearNum = parseInt(targetYear) || 0;
  const targetDecadeBase = targetYearNum ? Math.floor(targetYearNum / 10) * 10 : 0;

  const candidates = [];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      const val = parseFloat(m[1]);
      if (val >= 0.5 && val <= 9.9) {
        const window = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200);
        const windowLower = window.toLowerCase();
        const nearCity = cityLower ? windowLower.includes(cityLower) : true;

        let yearProximity = 0;
        if (targetYearNum) {
          const yearsInWindow = [...window.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].map(y => parseInt(y[1]));
          const decadesInWindow = [...window.matchAll(/\b(19[5-9]\d|20[0-4]\d)s\b/g)].map(d => parseInt(d[1]));
          for (const y of yearsInWindow) {
            if (Math.abs(y - targetYearNum) <= 3) { yearProximity = 3; break; }
            if (Math.abs(y - targetYearNum) <= 10) yearProximity = Math.max(yearProximity, 2);
          }
          for (const d of decadesInWindow) {
            if (d === targetDecadeBase) yearProximity = Math.max(yearProximity, 2);
          }
        }

        candidates.push({ value: val, nearCity, yearProximity, index: m.index });
      }
    }
  }

  if (candidates.length === 0) return null;

  const cityMatches = candidates.filter(c => c.nearCity);
  const pool = cityMatches.length > 0 ? cityMatches : candidates;

  if (targetYearNum) {
    const maxProx = Math.max(...pool.map(c => c.yearProximity));
    if (maxProx > 0) {
      const yearBest = pool.filter(c => c.yearProximity === maxProx);
      return yearBest[0].value;
    }
  }

  return pool[0].value;
}

function injectTFRColumn(tableText, tfrCapsule) {
  if (!tableText || !tfrCapsule) return tableText;
  const lines = tableText.split('\n');
  const result = [];
  let headerInjected = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/\|\s*City\s*\|.*Period\s*\|.*Regime\s*\|/i.test(trimmed) && !/TFR/i.test(trimmed)) {
      result.push(trimmed + ' TFR |');
      headerInjected = true;
    } else if (/^\|[\s:-]+\|[\s:-]+\|/.test(trimmed) && headerInjected && result.length > 0 && /TFR/.test(result[result.length - 1])) {
      result.push(trimmed + '-----|');
    } else {
      const cols = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (headerInjected && cols.length >= 7 && /^\|/.test(trimmed) && !EMPTY_TABLE_ROW_REGEX.test(cols[0]) && !/City/i.test(cols[0])) {
        const cityCol = cols[0].toLowerCase().replace(/\*\*/g, '').trim();
        const periodCol = cols[1].trim();
        const isHistorical = /\d{4}s|~\d{4}|197|198|196|195|200|201/i.test(periodCol) && !/202[3-9]|2030/i.test(periodCol);
        const isCurrent = /202[0-9]|203[0-9]|now|today|present/i.test(periodCol);
        let tfrVal = 'N/A';
        for (const [key, data] of Object.entries(tfrCapsule)) {
          if (cityCol.includes(key.toLowerCase()) || key.toLowerCase().includes(cityCol)) {
            if (isCurrent && data.current != null) tfrVal = data.current.toFixed(1);
            else if (isHistorical && data.historical != null) tfrVal = data.historical.toFixed(1);
            break;
          }
        }
        result.push(trimmed + ` ${tfrVal} |`);
      } else {
        result.push(line);
      }
    }
  }
  return result.join('\n');
}

/**
 * Calculate Seed Metric from price and income
 * Formula: Years = (LCU/sqm × 700) ÷ Single-Earner Income
 * NO mortgage calculations, NO interest rates, NO down payments
 * NO P/I ratio — Years is the only output metric.
 * 
 * @param {number} pricePerSqm - Price per square meter
 * @param {number} income - Annual income (SINGLE-EARNER, not household)
 * @returns {object} { price700sqm, years, regime, emoji, isProxy }
 */
function calculateSeedMetric(pricePerSqm, income) {
  if (!pricePerSqm || !isFinite(pricePerSqm)) {
    return { price700sqm: null, years: null, regime: 'N/A', emoji: '⚪', isProxy: false };
  }
  const price700sqm = pricePerSqm * 700;
  if (!income || income === 0 || !isFinite(income)) {
    return { price700sqm, years: null, regime: 'N/A', emoji: '⚪', isProxy: false };
  }
  const years = price700sqm / income;
  
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
 * Format currency value with appropriate symbol and scale.
 * Symbols are derived from CURRENCY_REGISTRY so all currencies are supported.
 * Scale: T (trillion) → B (billion) → M (million) → K (thousand) → raw
 * @param {number} value - Numeric value
 * @param {string} currency - Currency code
 * @returns {string} Formatted string
 */
function formatCurrency(value, currency = 'USD') {
  if (value == null || isNaN(value)) return 'N/A';

  const regEntry = CURRENCY_REGISTRY[currency];
  const sym = (() => {
    if (!regEntry) return currency + ' ';
    const unicodeOrMixed = regEntry.symbols.find(s => s.length <= 3 && !/^[A-Za-z]+$/.test(s));
    if (unicodeOrMixed) return unicodeOrMixed;
    const shortAlpha = regEntry.symbols.find(s => s.length <= 2);
    if (shortAlpha) return shortAlpha;
    return regEntry.symbols[0] + ' ';
  })();

  if (value >= 1_000_000_000_000) {
    return `${sym}${(value / 1_000_000_000_000).toFixed(1)}Tr`;
  } else if (value >= 1_000_000_000) {
    return `${sym}${(value / 1_000_000_000).toFixed(1)}B`;
  } else if (value >= 1_000_000) {
    return `${sym}${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `${sym}${(value / 1_000).toFixed(0)}K`;
  } else {
    return `${sym}${value.toFixed(0)}`;
  }
}

/**
 * Build Seed Metric table from parsed data
 * @param {object} parsedData - Output from agent swarm extractions
 * @param {string} historicalDecade - e.g., "1970s"
 * @returns {string} Markdown table with regime readings
 */
function buildSeedMetricTable(parsedData, historicalDecade = String(new Date().getFullYear() - 50).slice(0, 3) + '0s', tfrCapsule = null) {
  const rows = [];
  const summaries = [];
  const hasTFR = tfrCapsule && Object.keys(tfrCapsule).length > 0;
  
  rows.push(hasTFR
    ? '| City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime | TFR |'
    : '| City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime |');
  rows.push(hasTFR
    ? '|------|--------|---------|-------------------|--------------|-------|--------|-----|'
    : '|------|--------|---------|-------------------|--------------|-------|--------|');
  
  for (const [city, data] of Object.entries(parsedData.cities || {})) {
    // Derive a proper display name: expand abbreviations via CITY_EXPAND ('la'→'los angeles'),
    // then title-case every word. Long-form keys like 'singapore' title-case directly.
    const cityTitle = (CITY_EXPAND[city] || city)
      .replace(/\b\w/g, c => c.toUpperCase())  // title-case every word
      .replace(/\bDc\b/g, 'DC');               // 'dc' key expands to '…washington dc' → fix to 'DC'
    
    const currPriceSqm = data.current?.pricePerSqm?.value;
    const currIncome = data.current?.income?.value;
    // Price and income currencies are tracked independently.
    // For US cities both are 'USD'. For non-US cities price is LCU (JPY/SGD/GBP/…)
    // and income is also LCU (from World Bank NY.GNP.PCAP.CN). When they match,
    // years is meaningful; when they differ (e.g. Numbeo returned a USD price but
    // income is in JPY) we refuse to divide and show N/A — no forex guessing.
    const currPriceCurrency = data.current?.pricePerSqm?.currency || 'USD';
    const currIncomeCurrency = data.current?.income?.currency || 'USD';
    const currCurrency = currPriceCurrency; // used for price/land columns only

    const rawHistPriceSqm = data.historical?.pricePerSqm?.value;
    const histPriceCurrency = data.historical?.pricePerSqm?.currency || 'USD';
    const histIncomeCurrency = data.historical?.income?.currency || 'USD';
    const histCurrency = histPriceCurrency; // used for price/land columns only
    // Temporal contamination guard — price: if historical price == current price exactly,
    // the same Brave page fed both period extractions. No real market has had zero
    // nominal price change over a 25-year span — treat historical as null.
    const histPriceSqm = (rawHistPriceSqm != null && rawHistPriceSqm === currPriceSqm) ? null : rawHistPriceSqm;
    // Temporal contamination guard — income: same logic.
    // No real city has had zero nominal income change over a 25-year span.
    const rawHistIncome = data.historical?.income?.value;
    const histIncome = (rawHistIncome != null && rawHistIncome === currIncome) ? null : rawHistIncome;
    // Only compute years when price and income are in the same currency.
    // Pass null income when they mismatch so calculateSeedMetric returns N/A years
    // but still computes price700sqm correctly.
    const currIncomeForCalc = (currPriceCurrency === currIncomeCurrency) ? currIncome : null;
    const histIncomeForCalc = (histPriceCurrency === histIncomeCurrency) ? histIncome : null;
    const histMetric = calculateSeedMetric(histPriceSqm, histIncomeForCalc);
    const currMetric = calculateSeedMetric(currPriceSqm, currIncomeForCalc);
    
    const histRegimeLabel = histMetric.regime !== 'N/A' ? `${histMetric.emoji} ${histMetric.regime}` : 'N/A';
    const currRegimeLabel = currMetric.regime !== 'N/A' ? `${currMetric.emoji} ${currMetric.regime}` : 'N/A';
    
    const histYearsDisplay = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 'N/A';
    const currYearsDisplay = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 'N/A';
    
    let histTFR = 'N/A', currTFR = 'N/A';
    if (hasTFR) {
      const cityLower = city.toLowerCase();
      for (const [tfrKey, tfrData] of Object.entries(tfrCapsule)) {
        if (cityLower.includes(tfrKey.toLowerCase()) || tfrKey.toLowerCase().includes(cityLower)) {
          if (tfrData.historical != null) histTFR = tfrData.historical.toFixed(1);
          if (tfrData.current != null) currTFR = tfrData.current.toFixed(1);
          break;
        }
      }
    }

    const histSqmDisplay = histPriceSqm ? formatCurrency(histPriceSqm, histCurrency) : 'N/A';
    const histRowBase = `| ${cityTitle} | ${historicalDecade} | ${histSqmDisplay} | ${formatCurrency(histMetric.price700sqm, histCurrency)} | ${formatCurrency(histIncome, histIncomeCurrency)} | ${histYearsDisplay} | ${histRegimeLabel} |`;
    rows.push(hasTFR ? `${histRowBase} ${histTFR} |` : histRowBase);
    
    const currSqmDisplay = currPriceSqm ? formatCurrency(currPriceSqm, currCurrency) : 'N/A';
    const currentPeriodLabel = String(new Date().getFullYear() - 1);
    const currRowBase = `| ${cityTitle} | ${currentPeriodLabel} | ${currSqmDisplay} | ${formatCurrency(currMetric.price700sqm, currCurrency)} | ${formatCurrency(currIncome, currIncomeCurrency)} | ${currYearsDisplay} | ${currRegimeLabel} |`;
    rows.push(hasTFR ? `${currRowBase} ${currTFR} |` : currRowBase);
    
    const histSummary = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 'N/A';
    const currSummary = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 'N/A';
    const direction = (currMetric.years && histMetric.years) 
      ? (currMetric.years > histMetric.years ? '↑worsened' : '↓improved')
      : '';
    summaries.push(`**${cityTitle}**: ${histSummary} → ${currSummary} = ${currMetric.emoji} ${currMetric.regime} (${direction})`);
  }
  
  const { reformatMarkdownTable } = require('./markdown-table-formatter');
  const alignedTable = reformatMarkdownTable(rows.join('\n'));
  const summaryBlock = summaries.join('\n');
  
  const legend = `\n---\nFormula: **Years = (LCU/sqm × 700) ÷ Average Single Earner Income (same LCU)**`;
  
  return `${alignedTable}\n\n${summaryBlock}\n${legend}`;
}

/**
 * Validate Seed Metric output format
 * @param {string} output - LLM-generated output
 * @returns {object} { valid: boolean, issues: string[] }
 */
function validateSeedMetricOutput(output, historicalDecade = String(new Date().getFullYear() - 50).slice(0, 3) + '0s') {
  const issues = [];

  if (!output) {
    issues.push('Empty output');
    return { valid: false, issues };
  }

  const decadeDigits = historicalDecade.replace(/[^0-9]/g, '').slice(0, 3);
  const histRegex = new RegExp(`(?:${decadeDigits}\\d|~?${decadeDigits}|${historicalDecade.replace(/s$/, '')}s?)`, 'i');

  const currRegex = /(?:202\d|203\d|now|today|present)/i;

  const hasTableHeader = /(?:\|\s*)?City\s*\|.*Period\s*\|.*Regime\s*\|?\s*(?:TFR\s*\|)?/i.test(output);
  if (!hasTableHeader) {
    issues.push('FORBIDDEN: Missing table header. Output MUST use | City | Period | $/sqm | 700sqm Price | Income | Years | Regime | format.');
  }

  const tableRows = output.match(/^(?:\|)?[^|\n-][^|\n]*(?:\|[^|\n]*){4,}\|?$/gm);
  const dataRows = tableRows ? tableRows.filter(r => !/City|Period|Regime/i.test(r)).length : 0;
  if (hasTableHeader && dataRows < 2) {
    issues.push('FORBIDDEN: Table needs at least 2 data rows (historical + current). Must show historical AND now.');
  }

  if (hasTableHeader && dataRows >= 2) {
    const rowText = tableRows ? tableRows.join(' ') : '';
    const hasHistRow = histRegex.test(rowText);
    const hasCurrRow = currRegex.test(rowText);
    if (!hasHistRow) {
      issues.push(`Table missing historical period row (${historicalDecade}). Must show historical data.`);
    }
    if (!hasCurrRow) {
      issues.push('Table missing current period row (202x). Must show current data.');
    }
  }
  
  const hasPIColumn = /\|\s*P\/I\s*\|/i.test(output);
  if (hasPIColumn) {
    issues.push('FORBIDDEN: Table has P/I column. Use $/sqm column instead. Years = ($/sqm × 700) ÷ Income.');
  }
  
  const hasCityColumn = /\|\s*City\s*\|/i.test(output);
  if (hasTableHeader && !hasCityColumn) {
    issues.push('Missing City column in table header. Must use unified | City | Period | ... | format (not separate tables per city).');
  }
  
  const tableHeaderCount = (output.match(/\|\s*(?:City\s*\|)?\s*Period\s*\|/gi) || []).length;
  if (tableHeaderCount > 1) {
    issues.push('FORBIDDEN: Multiple tables detected. Must use ONE unified table with City column, not separate tables per city.');
  }
  
  const hasAnyNumericRow = /[$¥£€]\s*[\d,]+/.test(output);
  const hasRegimeEmoji = /[🟢🟡🔴]/.test(output);
  const hasRegimeLabel = /(?:OPTIMISM|EXTRACTION|FATALISM|Optimism|Extraction|Fatalism)/i.test(output);
  if (hasAnyNumericRow && !hasRegimeEmoji) {
    issues.push('Missing regime emoji (🟢/🟡/🔴) — must appear in Regime column for rows with data');
  }
  if (hasAnyNumericRow && !hasRegimeLabel) {
    issues.push('Missing regime label (Optimism/Extraction/Fatalism)');
  }
  
  const hasSummaryLine = /\*\*[^*]+\*\*\s*:\s*(?:[\d.]+|[⚪⬜]?\s*N\/A)\s*yr\s*→\s*(?:[\d.]+|[⚪⬜]?\s*N\/A)\s*yr/i.test(output);
  if (hasTableHeader && !hasSummaryLine) {
    issues.push('Missing summary lines after table. Need: **[City]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)');
  }
  
  const allTableLines = output.split('\n').filter(line => {
    const t = line.trim();
    return t.includes('|') && !/^[\s|:-]+$/.test(t);
  });
  const dataLines = allTableLines.filter(line => !/City|Period|Regime/i.test(line) && !/^[\s|:-]+$/.test(line.trim()));
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
  
  const has700sqm = /700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (!has700sqm) {
    issues.push('Missing 700sqm reference');
  }
  
  const proseIndicators = output.match(/(?:Fast forward|Using the Seed Metric|we can calculate|we can estimate|However,|it's essential|In conclusion|assuming a|Comparing the two|Assuming an|The median|approximately \d|50 years ago)/gi);
  if (proseIndicators && proseIndicators.length >= 2) {
    issues.push('FORBIDDEN: Contains prose paragraphs instead of table. Must use | City | Period | $/sqm | ... | Regime | format.');
  }
  
  const paragraphs = output.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length > 3 && !hasTableHeader) {
    issues.push('FORBIDDEN: Too many paragraphs without table format. Output must be a markdown table.');
  }
  
  const hasHistorical = histRegex.test(output) || /~?\d{4}s?|50\s*(?:yr|year)s?\s*ago/i.test(output);
  const hasCurrentData = currRegex.test(output);
  if (!hasHistorical && hasCurrentData) {
    issues.push(`Missing historical (${historicalDecade}) data. Must show BOTH historical AND current periods.`);
  }

  const currentNoDataCopout = /(?:no data|no precise|unavailable|cannot find).*(?:current|2024|2025|today|present)/i;
  if (currentNoDataCopout.test(output)) {
    issues.push('FORBIDDEN: "No data" cop-out on current period. Must use live Brave search data.');
  }
  
  const wrong700sqm = /(?:3-room|HDB|apartment|flat)[^.]*(?:approximately|about|around)?\s*700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (wrong700sqm) {
    issues.push('Wrong 700sqm interpretation (apartment ≠ 700sqm)');
  }
  
  if (/700\s*(?:sqft|sq\s*ft|square\s*feet)/i.test(output)) {
    issues.push('Wrong unit: 700 sqft instead of 700 m² (10x error)');
  }
  
  if (/(?:down\s*payment|interest\s*rate|mortgage|pay\s*off|amortiz|loan\s*term|\d+%\s*interest)/i.test(output)) {
    issues.push('FORBIDDEN: Contains mortgage/interest calculations. Years = Price ÷ Income (simple division)');
  }
  
  if (/(?:P\/I|price[\s-]*to[\s-]*income).*3\.5|threshold.*3\.5/i.test(output)) {
    issues.push('FORBIDDEN: P/I 3.5 threshold. Use 10/25yr only.');
  }
  
  const rawPIUsed = /(?:price[\s-]*to[\s-]*income|P\/I)\s*(?:ratio)?\s*(?:is|=|:)\s*[\d.]+/i.test(output);
  const hasSqmColumn = /\|\s*\$\/sqm\s*\|/i.test(output);
  if (rawPIUsed && !hasSqmColumn) {
    issues.push('Raw P/I ratio used without $/sqm source data. Must use ($/sqm × 700) ÷ income formula.');
  }
  
  if (/\d+\s*sqft/i.test(output) && !has700sqm) {
    issues.push('Uses sqft without proper 700m² reference');
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
}

// ─── Suffix hardening helpers (used by pipeline-orchestrator micro-extraction) ──

/**
 * Apply K/M/B/CJK multiplier to a numeric value based on a suffix string.
 * Example: applyMultiplier(54, 'K') → 54000
 */
function applyMultiplier(value, raw) {
  if (!raw) return value;
  if (/billion|bn/i.test(raw))               return value * 1_000_000_000;
  if (/million|mil\b|\b[Mm]\b|億/i.test(raw)) return value * 1_000_000;
  if (/万|만/i.test(raw))                      return value * 10_000;
  if (/\bk\b|thousand/i.test(raw))            return value * 1_000;
  return value;
}

/**
 * Regex rescue: if the micro-extraction LLM returned a bare integer (dropping a
 * K/M/B suffix that was in the raw Brave text), detect and re-apply the suffix.
 * Example: LLM returns 54, raw text has "Rp54K/sqm" → returns 54000.
 */
function rescueDroppedSuffix(value, text) {
  if (!value || !text) return value;
  const baseStr = String(Math.round(value)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`${baseStr}(?:[.,]\\d+)?\\s*([KkMmBb]|million|billion|thousand)`, 'i'));
  if (!m) return value;
  const rescued = applyMultiplier(value, m[1]);
  return rescued;
}

/**
 * L3 rescue: detect and neutralise contaminated pricePerSqm extractions.
 *
 * Principle: null > hallucination. Only two exact transformations are allowed:
 *  1. Text explicitly labels the value as per-sqm/m² → trust it, return as-is.
 *  2. Text labels it as per-sqft (no sqm label)       → ×10.764 is exact math, apply it.
 *  3. Text has total-property-price language           → null. We do NOT divide by an assumed
 *                                                         floor area — that would be a guess.
 *                                                         Let the upstream search cascade find
 *                                                         a real per-sqm source instead.
 *  4. No signal either way                             → return value unchanged.
 *
 * @param {number}  value    - Extracted value (post suffix-rescue)
 * @param {string}  text     - Raw Brave result text used for extraction
 * @returns {number|null}    - Trusted per-sqm value, or null if contaminated
 */
/**
 * L3 rescue for income extractions: detect and neutralise contaminated income values.
 *
 * First-principled, anti-fragile guard. Mirrors `rescueTotalPrice` in spirit but
 * adapted for income's failure modes:
 *
 *  1. Text labels the value as a property/sale/asking price → null.
 *     (LLM may have grabbed a home value as "income" when the page mixed both.)
 *  2. Text labels the value as GDP / household / dual / combined / family income → null.
 *     (Single-earner annual wage is the only valid income type for the years calc.)
 *  3. Value exceeds the structural ceiling for its currency (Monaco/Switzerland/
 *     Luxembourg-anchored, median × 1.5) → null. Implausibly high incomes are
 *     almost always property prices in disguise.
 *  4. Value is suspiciously low (< 1000 in any currency) → null.
 *     (Even high-denomination LCU like ¥/₩/Rp wages exceed 1000 annually.)
 *  5. No red flags → return value unchanged.
 *
 * Synchronous by design — caller pre-fetches the ceiling map once via
 * `lib/tools/income-ceiling.js::buildCeilingMap([...currencies])` and passes
 * the whole map. Internal lookup `ceilingMap[currency]` ensures the value and
 * ceiling are always in the same units (no accidental USD-vs-LCU mismatch).
 * If a currency is missing from the map, the structural guard is skipped
 * (the text-pattern + min-sanity guards still apply).
 *
 * @param {number}      value         - Extracted income value (post suffix-rescue)
 * @param {string}      text          - Raw Brave result text used for extraction
 * @param {string}      currency      - ISO-4217 code (e.g. 'USD', 'JPY')
 * @param {object}      [ceilingMap]  - { [currencyCode]: lcuCeilingValue } from buildCeilingMap()
 * @returns {number|null}             - Trusted income value, or null if contaminated
 */
function rescueIncome(value, text, currency, ceilingMap = {}) {
  if (value == null || !isFinite(value) || value <= 0) return null;

  // Min sanity: even the lowest LCU wage (e.g. ₫50M VND ≈ $2K) exceeds 1000
  if (value < 1000) return null;

  if (text && text.length > 0) {
    // 1. Property / sale price language → null
    const propertyPriceRx = new RegExp([
      '(?:median|average|mean|typical)\\s+(?:home|house|apartment|condo|property|sale|listing|asking|sold|resale)s?\\s*(?:price|value|cost)',
      '(?:home|house|property|apartment|condo)\\s*(?:price|value)',
      '(?:asking|sold)\\s+for\\s+\\$?[\\d,.]+',
    ].join('|'), 'i');
    if (propertyPriceRx.test(text)) return null;

    // 2. Wrong income type (GDP / household / dual / combined / family) → null
    const wrongTypeRx = /\b(?:GDP\s+per\s+capita|household\s+income|dual\s+income|combined\s+income|family\s+income|two[-\s]+income)\b/i;
    if (wrongTypeRx.test(text)) return null;
  }

  // 3. Structural ceiling guard — currency-matched lookup prevents FX mismatch.
  //    Map keys are uppercased ISO-4217 codes; missing keys gracefully skip
  //    the ceiling check rather than reject (defensive: don't null on misuse).
  const code = currency ? String(currency).toUpperCase() : null;
  const ceiling = code && ceilingMap ? ceilingMap[code] : null;
  if (ceiling != null && isFinite(ceiling) && ceiling > 0 && value > ceiling) {
    return null;
  }

  return value;
}

/**
 * Validate cross-period & cross-field invariants for seed metric data.
 * Runs after Phase 0, dog-walking, and post-dog-walk BIS fill — last guard
 * before `buildSeedMetricTable`. Mutates `parsedData` in-place, nulling out
 * fields that violate any invariant. Returns a violations log for telemetry.
 *
 * Invariants:
 *   I1. Within-period currency consistency: pricePerSqm.currency === income.currency
 *       Otherwise the years calc (price/sqm × 700 ÷ income) is meaningless.
 *       Action: keep both, but flag in violations log; rendering layer shows N/A.
 *   I2. Temporal income direction: in same currency, historical income ≤ current income
 *       Nominal wages basically never decrease over 25 years.
 *       Action: null historical income (defer to N/A rather than show wrong number).
 *   I3. TFR cross-period plausibility: |currentTFR - historicalTFR| ≤ 5
 *       Even Korea's collapse from 4.5 (1970) → 0.7 (2024) is a 3.8 swing over 54 years.
 *       Over 25 years a swing > 5 is almost certainly a Brave extraction error.
 *       Action: null both TFR values for the city.
 *
 * (Price temporal direction is enforced earlier by the post-dog-walk BIS fill,
 *  which actively backcasts a corrected historical instead of just nulling.)
 *
 * @param {object} parsedData  - { cities: { [cityKey]: { current, historical } } }
 * @param {object|null} tfrCapsule - { [CityTitle]: { current, historical } } or null
 * @returns {string[]} - human-readable violation log entries
 */
function validateSeedMetricInvariants(parsedData, tfrCapsule = null) {
  const violations = [];
  if (!parsedData || !parsedData.cities) return violations;

  for (const [cityKey, data] of Object.entries(parsedData.cities)) {
    if (!data) continue;

    // I1: Within-period currency consistency. Normalize to uppercase ISO-4217
    // before comparing so 'usd' vs 'USD' (or any case-skew between Phase 0 silos
    // and dog-walk extraction) doesn't trigger a false mismatch.
    for (const period of ['current', 'historical']) {
      const psm = data[period]?.pricePerSqm;
      const inc = data[period]?.income;
      if (psm?.value && inc?.value && psm.currency && inc.currency) {
        const psmCur = String(psm.currency).toUpperCase();
        const incCur = String(inc.currency).toUpperCase();
        if (psmCur !== incCur) {
          violations.push(`I1 ${cityKey}/${period}: currency mismatch price=${psmCur} vs income=${incCur}`);
        }
      }
    }

    // I2: Temporal income direction (same currency, normalized to uppercase).
    const currInc = data.current?.income;
    const histInc = data.historical?.income;
    if (currInc?.value && histInc?.value && currInc.currency && histInc.currency) {
      const currCur = String(currInc.currency).toUpperCase();
      const histCur = String(histInc.currency).toUpperCase();
      if (currCur === histCur && histInc.value > currInc.value) {
        violations.push(`I2 ${cityKey}: historical income (${histInc.value} ${histCur}) > current (${currInc.value} ${currCur}) — nulling historical`);
        data.historical.income = null;
      }
    }

    // I3: TFR cross-period plausibility
    if (tfrCapsule) {
      const cityTitle = cityKey.charAt(0).toUpperCase() + cityKey.slice(1);
      const tfrEntry = tfrCapsule[cityTitle] || tfrCapsule[cityKey];
      if (tfrEntry && tfrEntry.current != null && tfrEntry.historical != null) {
        const swing = Math.abs(tfrEntry.current - tfrEntry.historical);
        if (swing > 5) {
          violations.push(`I3 ${cityKey}: TFR swing ${swing.toFixed(2)} (curr=${tfrEntry.current}, hist=${tfrEntry.historical}) exceeds 5.0 — nulling both`);
          tfrEntry.current = null;
          tfrEntry.historical = null;
        }
      }
    }
  }

  return violations;
}

function rescueTotalPrice(value, text) {
  if (!value || !text || value <= 0) return value;

  // 1. Explicit per-sqm label → trust the LLM value
  const perSqmRx = /per\s*(?:sqm|sq\.?\s*m(?:eter|re)?|m²)|\/\s*(?:sqm|m²)|per\s+square\s+met(?:er|re)|\bpsm\b/i;
  if (perSqmRx.test(text)) return value;

  // 2. Explicit per-sqft label (no sqm label) → ×10.764 is an exact unit conversion, not a guess
  const perSqftRx = /per\s*(?:sq\.?\s*f(?:oo|ee)?t|sqft)|\/\s*(?:sqft|sq\.?\s*ft)\b/i;
  if (perSqftRx.test(text)) return Math.round(value * 10.764);

  // 3. Total-property-price language → null. No assumed floor area.
  const totalPriceRx = new RegExp([
    // "median/average/mean/typical home/house/property price/value"
    '(?:median|average|mean|typical)\\s+(?:home|house|apartment|condo|property|sale|list(?:ing)?|asking|sold|resale)s?\\s*(?:price|value|cost)',
    // "home(s)/house/property price(s)/value(s) in/was/is/were/at/of"
    '(?:homes?|houses?|property)\\s*(?:prices?|values?)\\s*(?:in\\b|was\\b|is\\b|were\\b|of\\b|at\\b)',
    // "prices for homes/houses/properties in/of the [area]"
    'prices?\\s+(?:for\\s+)?(?:homes?|houses?|propert(?:y|ies))?\\s*(?:in|for|of)\\s+(?:the\\s+)?(?:city|metro|area|county|region|market)',
    // "homes/houses averaged/reached $..."
    '(?:homes?|houses?)\\s+(?:averaged?|reached|hit|climbed|fell|dropped|sold\\s+for)',
  ].join('|'), 'i');
  if (totalPriceRx.test(text)) return null;

  return value;
}

/**
 * emptyCityRecord — the canonical empty city record skeleton used throughout
 * seed-metric flow when initializing parsedData.cities[city]. Pass `histDecade`
 * (string like "1995-2005") to stamp the historical bucket with its decade
 * label; omit when the call site doesn't yet know which decade applies (e.g.
 * silo pre-fills before stepSeedMetricToolCall has resolved histDecade).
 *
 * Single source of truth: any future schema change (new field, new bucket)
 * is one edit here, not seven scattered through pipeline-orchestrator.
 */
function emptyCityRecord(histDecade) {
  const historical = { pricePerSqm: null, income: null };
  if (histDecade) historical.decade = histDecade;
  return {
    current: { pricePerSqm: null, income: null },
    historical,
  };
}

module.exports = {
  calculateSeedMetric,
  formatCurrency,
  buildSeedMetricTable,
  validateSeedMetricOutput,
  parseTFR,
  injectTFRColumn,
  applyMultiplier,
  rescueDroppedSuffix,
  rescueTotalPrice,
  rescueIncome,
  validateSeedMetricInvariants,
  emptyCityRecord,
};
