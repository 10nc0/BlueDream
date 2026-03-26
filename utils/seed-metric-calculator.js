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

const { CURRENCY_REGISTRY } = require('./geo-data');
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
  if (!pricePerSqm || !income || income === 0) {
    return { price700sqm: null, years: null, regime: 'N/A', emoji: '⚪', isProxy: false };
  }
  
  const price700sqm = pricePerSqm * 700;
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
    const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);
    
    const histPriceSqm = data.historical?.pricePerSqm?.value;
    const histIncome = data.historical?.income?.value;
    const histCurrency = data.historical?.pricePerSqm?.currency || data.historical?.income?.currency || 'USD';
    const histMetric = calculateSeedMetric(histPriceSqm, histIncome);
    
    const currPriceSqm = data.current?.pricePerSqm?.value;
    const currIncome = data.current?.income?.value;
    const currCurrency = data.current?.pricePerSqm?.currency || data.current?.income?.currency || 'USD';
    const currMetric = calculateSeedMetric(currPriceSqm, currIncome);
    
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
    const histRowBase = `| ${cityTitle} | ${historicalDecade} | ${histSqmDisplay} | ${formatCurrency(histMetric.price700sqm, histCurrency)} | ${formatCurrency(histIncome, histCurrency)} | ${histYearsDisplay} | ${histRegimeLabel} |`;
    rows.push(hasTFR ? `${histRowBase} ${histTFR} |` : histRowBase);
    
    const currSqmDisplay = currPriceSqm ? formatCurrency(currPriceSqm, currCurrency) : 'N/A';
    const currentPeriodLabel = String(new Date().getFullYear() - 1);
    const currRowBase = `| ${cityTitle} | ${currentPeriodLabel} | ${currSqmDisplay} | ${formatCurrency(currMetric.price700sqm, currCurrency)} | ${formatCurrency(currIncome, currCurrency)} | ${currYearsDisplay} | ${currRegimeLabel} |`;
    rows.push(hasTFR ? `${currRowBase} ${currTFR} |` : currRowBase);
    
    const histSummary = histMetric.years ? `${histMetric.years.toFixed(0)}yr` : 'N/A';
    const currSummary = currMetric.years ? `${currMetric.years.toFixed(0)}yr` : 'N/A';
    const direction = (currMetric.years && histMetric.years) 
      ? (currMetric.years > histMetric.years ? '↑worsened' : '↓improved')
      : '';
    summaries.push(`**${cityTitle}**: ${histSummary} → ${currSummary} = ${currMetric.emoji} ${currMetric.regime} (${direction})`);
  }
  
  const table = rows.join('\n');
  const summaryBlock = summaries.join('\n');
  
  const legend = `\n---\nFormula: **Years = (LCU/sqm × 700) ÷ Average Single Earner Income (same LCU)**`;
  
  return `${table}\n\n${summaryBlock}\n${legend}`;
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

module.exports = {
  calculateSeedMetric,
  formatCurrency,
  buildSeedMetricTable,
  validateSeedMetricOutput,
  parseTFR,
  injectTFRColumn
};
