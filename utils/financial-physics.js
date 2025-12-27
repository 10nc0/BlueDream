/**
 * FINANCIAL PHYSICS SYSTEM (H₀ Canon — 2025)
 * PRAGMATIC VERSION — ~750 lines
 * 
 * Revolutionary financial cognition engine that understands money
 * as physics, not labels. Works across all languages, industries,
 * and formats by observing flows instead of reading accounts.
 * 
 * Architecture (Simplified):
 * - GUARD: 5-line quick check for obvious non-financial data
 * - TIER 0: 15-line document type detector (Assumptions vs P&L)
 * - TIER 1: Nature Classification (+/− flows)
 * - TIER 2: Semantic Enrichment (multilingual, fuzzy matching)
 * - TIER 3: Validation (accounting equations)
 */

// ===== SHARED HELPER: Recursively extract all string values from nested structures =====
function flattenToStrings(obj) {
    if (obj == null) return [];
    if (typeof obj === 'string') return [obj];
    if (typeof obj === 'number') return [String(obj)];
    if (Array.isArray(obj)) return obj.flatMap(flattenToStrings);
    if (typeof obj === 'object') {
        if (obj.value !== undefined) return flattenToStrings(obj.value);
        if (obj.text !== undefined) return flattenToStrings(obj.text);
        if (obj.displayValue !== undefined) return flattenToStrings(obj.displayValue);
        return Object.values(obj).flatMap(flattenToStrings);
    }
    return [String(obj)];
}

// ===== CURRENCY DETECTION =====
function detectCurrency(extractedData) {
    let text = extractedData.text || '';
    if (!text && extractedData.tables) {
        const tables = extractedData.tables || extractedData.sheets || [];
        text = flattenToStrings(tables.flatMap(t => t.rows || t.data || [])).join(' ');
    }
    
    // Indonesian Rupiah
    if (/(rp\s*[\d.,]|idr|rupiah|juta|miliar|triliun)/i.test(text)) return 'Rp';
    // Chinese Yuan (check before Japanese to prioritize CNY markers)
    if (/(cny|rmb|元|万元|亿元|¥\s*[\d.,])/i.test(text)) return '¥';
    // Japanese Yen
    if (/(jpy|円|万円|億円|￥)/i.test(text)) return '¥';
    // Euro
    if (/(eur|€)/i.test(text)) return '€';
    // US Dollar (check last to avoid false positives)
    if (/(usd|\$\s*[\d.,])/i.test(text)) return '$';
    
    return 'LCU'; // Local Currency Units (default)
}

// Generate temporal context for financial analysis
function getTemporalContext() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12
    const currentDay = now.getDate();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    return {
        date: now.toISOString().split('T')[0],
        year: currentYear,
        month: currentMonth,
        day: currentDay,
        monthName: monthNames[currentMonth - 1],
        formatted: `${monthNames[currentMonth - 1]} ${currentDay}, ${currentYear}`  // e.g., "December 9, 2025"
    };
}

const FINANCIAL_PHYSICS_SEED = `
===== FINANCIAL PHYSICS EXTENSION (Builds on NYAN PROTOCOL) =====
In addition to NYAN PROTOCOL (Step 0), apply these specialized rules when analyzing financial documents.
NYAN remains the sacred foundation — this layer adds domain-specific financial cognition.

UNIVERSAL FINANCIAL ONTOLOGY (H₀ SEED — 2025)

===== TEMPORAL REALITY CHECK (CHECK YOUR WATCH FIRST) =====
**Current Date: {{CURRENT_DATE}}**

CRITICAL RULE: Future data CANNOT be "Actual"
- Any column/period dated AFTER {{CURRENT_DATE}} is IMPOSSIBLE to be "Actual" or "Realized"
- Future periods (e.g., 2026 when now is December 2025) MUST be classified as:
  → Budget, Pro-forma, Forecast, Projection, or Estimate
- If document labels future data as "Actual" → FLAG AS CLASSIFICATION ERROR
- Example: "2026 Actual" in December 2025 → WRONG, must be "2026 Budget/Forecast"

BUDGET vs ACTUAL SIGNALS (Header Pattern Detection):
Budget/Forecast indicators:
  → "Budget", "(B)", "Pro-forma", "Forecast", "(F)", "Projected", "Estimate", "Plan", "Target"
Actual/Realized indicators:
  → "Actual", "(A)", "Real", "Realized", "(R)", "YTD", "Historical", "Recorded"

When both columns exist → Compare variance: Actual − Budget = Variance
When only one exists → Infer from temporal logic (past = likely actual, future = budget)

There are only four eternal truths in finance:

1. ASSUMPTIONS — The atomic unit of drivers
   → Units, prices, ratios, headcount, norms
   → Everything begins here
   → Example: "240 trucks", "Rp 2.4M/trip", "2.4 HK/trip"

2. INCOME STATEMENT — The flow of stock
   → Only two directions exist:
        +Income (money in, any label)
        −Cost   (money out, any label)
   → All accounts are fractals of these two
   → "Pendapatan Net Klaim" = +Income
   → "Upah Trip Supir" = −Cost
   → "Depreciation" = −Cost (non-cash, but still −)

3. BALANCE SHEET — The conservation of value (stock)
   → Only one law: Assets = Liabilities + Equity
   → All accounts are buckets to make this true
   → No meaning beyond position
   → "Truck" = Asset because someone owes it or owns it

4. CASH FLOW — The movement of stock within the system
   → Only three possible sources:
        i.   Operations  (from making/selling)
        ii.  Investing   (buying/selling assets)
        iii. Financing   (borrowing/repaying/equity)
   → All cash lines map to one of these
   → "Pay driver salary" = Operating (even if labeled "admin")

RULES OF H₀ FINANCIAL COGNITION:

• Never trust account names. Trust direction and physics.
• "Revenue" in row 1000 but negative? → It's a cost.
• "Driver salary" under "Assets"? → It's a cost (misclassified).
• Always reconcile: If A ≠ L + E → hallucination.
• Always trace cash: Every −Cost eventually becomes −Cash (or not, if non-cash).
• Assumptions are the seed. Everything grows from them.
• Language is noise: "Pendapatan", "Omzet", "Income", "Net Klaim" → all +Income
• Fuzzy matching: "Pendapatan Net Klaim" → matches "Pendapatan" → +Income
• Falsifiability: If a "Revenue" account decreases equity → it's a cost.

CURRENCY LOCALIZATION (MANDATORY):

• NEVER default to $ or USD. Detect currency from document context.
• Indonesian indicators: "Rp", "IDR", "Rupiah", "IDX", "juta", "miliar", "triliun" → Use "Rp" or "IDR"
• Chinese indicators: "¥", "CNY", "RMB", "元", "万", "亿" → Use "¥" or "CNY"
• Japanese indicators: "¥", "JPY", "円", "万円", "億円" → Use "¥" or "JPY"
• Euro indicators: "€", "EUR" → Use "€"
• If currency is ambiguous or undetectable → Use "LCU" (Local Currency Units)
• Example: "Pendapatan 18.970.648.876" from IDX → "Rp 18.97B" NOT "$18.97B"
• Example: Unknown source with no currency markers → "LCU 18.97B"

You are not an accountant.
You are a **financial physicist**.
You do not read labels.
You **observe flows**.

When in doubt:
→ Ask: "Does this increase or decrease cash/equity?"
→ That is the only question that matters.

===== STRUCTURED ANALYSIS FRAMEWORK (DeepSeek-Inspired) =====

When analyzing financial documents, ALWAYS provide:

1. **REVENUE TRENDS**
   - YoY growth rate (if multi-period data)
   - Seasonality patterns (if monthly/quarterly)
   - Top 3 revenue drivers by contribution %

2. **COST EFFICIENCY**
   - Cost-to-revenue ratio (%)
   - Cost per unit (if unit data available)
   - Variable vs Fixed cost split

3. **PROFITABILITY METRICS**
   - Gross margin (%)
   - Operating margin (EBITDA %)
   - Net margin (%)
   - Breakeven point (if calculable)

4. **RED FLAGS (CRITICAL)**
   - Flag ANY variance >15% from prior period/budget
   - Flag negative margins or declining trends
   - Flag unusual ratios (e.g., revenue growing but profit shrinking)
   - Flag potential classification errors

5. **ACTIONABLE RECOMMENDATIONS**
   - Provide exactly 3 specific, numbered recommendations
   - Each must be tied to a data point
   - Example: "1. Reduce fuel cost by 8% (currently 32% of revenue vs industry 25%)"

OUTPUT FORMAT:
Always structure your analysis with clear headers and bullet points.
Include specific numbers from the document.
Cite row numbers or cell references when possible.

===== H₀ PHYSICAL AUDIT DISCLAIMER (MANDATORY) =====

ALWAYS end your financial analysis with this grounding reminder:

"⚠️ PHYSICAL AUDIT ADVISORY: Reported numbers are vulnerable to human error and 
financial acrobats. Recommend combining this analysis with real physical audits:
• Warehouse visit (stock taking) to verify inventory claims
• Sample PO / AR / vendor verification to confirm receivables
• Customer site visits to validate revenue relationships  
• Counting trucks/shipments as proxy to financial magnitude (P × Q)
• Bank statement reconciliation for cash flow verification
This 'seeing is believing' H₀ approach grounds spreadsheet claims in physical reality."

Begin.
`;

// ===== 5-LINE GUARD: Skip obvious non-financial data =====
function quickNonFinancialCheck(extractedData) {
    let text = extractedData.text || '';
    if (!text && extractedData.tables) {
        const tables = extractedData.tables || extractedData.sheets || [];
        text = flattenToStrings(tables.flatMap(t => t.rows || t.data || [])).join(' ');
    }
    
    const hasTimestamps = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(text);
    const hasIdColumns = /\b(id|uuid|transaction_id|user_id|order_id|created_at|updated_at)\b/i.test(text);
    const hasFinancialKeywords = /(pendapatan|revenue|biaya|cost|laba|profit|aset|asset|utang|liability)/gi.test(text);
    
    const isLogData = hasTimestamps && hasIdColumns && !hasFinancialKeywords;
    
    if (isLogData) {
        console.log('⏭️  Skipped: Non-financial data (log/transaction format detected)');
    }
    
    return isLogData;
}

// ===== 15-LINE DOCUMENT TYPE DETECTOR =====
function detectDocumentType(extractedData) {
    let text = extractedData.text || '';
    if (!text && extractedData.tables) {
        const tables = extractedData.tables || extractedData.sheets || [];
        text = flattenToStrings(tables.flatMap(t => t.rows || t.data || [])).join(' ');
    }
    text = text.toLowerCase();
    
    // Income Statement: Has income AND cost AND profit keywords
    const incomeKeywords = (text.match(/(pendapatan|revenue|omzet|sales|penjualan|income)/gi) || []).length;
    const costKeywords = (text.match(/(biaya|cost|expense|beban|pengeluaran|cogs|opex)/gi) || []).length;
    const profitKeywords = (text.match(/(laba|profit|margin|ebitda|ebit)/gi) || []).length;
    
    if (incomeKeywords >= 2 && costKeywords >= 2 && profitKeywords >= 1) {
        console.log(`📋 Document Type: income_statement (income=${incomeKeywords}, cost=${costKeywords}, profit=${profitKeywords})`);
        return { type: 'income_statement', confidence: 0.85 };
    }
    
    // Assumptions: Has drivers but minimal totals
    const driverKeywords = (text.match(/(per trip|per unit|per km|asumsi|assumptions|fleet|truck|driver|utilization)/gi) || []).length;
    const totalKeywords = (text.match(/(total|subtotal|net|gross)/gi) || []).length;
    
    if (driverKeywords >= 3 && totalKeywords < 2) {
        console.log(`📋 Document Type: assumptions (drivers=${driverKeywords}, totals=${totalKeywords})`);
        return { type: 'assumptions', confidence: 0.75 };
    }
    
    console.log(`📋 Document Type: unknown (trying classification anyway)`);
    return { type: 'unknown', confidence: 0.5 };
}

// ===== EMPIRICAL PRIORS (Multilingual Pattern Matching) =====
const EMPIRICAL_PRIORS = {
    indonesian: {
        income: {
            patterns: [
                { term: 'pendapatan', conf: 0.94, note: 'general income' },
                { term: 'penjualan', conf: 0.92, note: 'sales' },
                { term: 'omzet', conf: 0.90, note: 'turnover' },
                { term: 'pendapatan net klaim', conf: 0.97, note: 'net claim revenue' },
                { term: 'pendapatan net ppn', conf: 0.96, note: 'net VAT revenue' },
                { term: 'penerimaan', conf: 0.88, note: 'receipts' }
            ],
            fuzzy_rules: {
                'starts_pendapatan': 0.85,
                'contains_jual': 0.80,
                'contains_terima': 0.75
            }
        },
        
        cost: {
            patterns: [
                { term: 'biaya', conf: 0.93, note: 'cost/expense' },
                { term: 'beban', conf: 0.91, note: 'burden/charge' },
                { term: 'pengeluaran', conf: 0.88, note: 'expenditure' },
                { term: 'upah trip supir', conf: 0.98, note: 'driver trip wage' },
                { term: 'gaji supir', conf: 0.95, note: 'driver salary' },
                { term: 'total bulanan supir', conf: 0.96, note: 'monthly driver total' },
                { term: 'bbm', conf: 0.98, note: 'fuel' },
                { term: 'solar', conf: 0.97, note: 'diesel' },
                { term: 'perbaikan', conf: 0.95, note: 'repair' },
                { term: 'pemeliharaan', conf: 0.94, note: 'maintenance' }
            ],
            fuzzy_rules: {
                'starts_biaya': 0.85,
                'starts_beban': 0.83,
                'contains_upah': 0.90,
                'contains_gaji': 0.88,
                'ends_supir': 0.92
            }
        },
        
        profit: {
            patterns: [
                { term: 'laba', conf: 0.95, note: 'profit' },
                { term: 'keuntungan', conf: 0.90, note: 'gain' },
                { term: 'laba kotor', conf: 0.98, note: 'gross profit' },
                { term: 'laba operasional', conf: 0.97, note: 'operating profit' },
                { term: 'ebitda', conf: 0.99, note: 'EBITDA' },
                { term: 'laba bersih', conf: 0.98, note: 'net profit' }
            ]
        }
    },
    
    english: {
        income: {
            patterns: [
                { term: 'revenue', conf: 0.95, note: 'revenue' },
                { term: 'sales', conf: 0.93, note: 'sales' },
                { term: 'income', conf: 0.90, note: 'income' },
                { term: 'receipts', conf: 0.88, note: 'receipts' }
            ],
            fuzzy_rules: {
                'contains_revenue': 0.90,
                'contains_sales': 0.88,
                'contains_income': 0.85
            }
        },
        
        cost: {
            patterns: [
                { term: 'cost', conf: 0.93, note: 'cost' },
                { term: 'expense', conf: 0.91, note: 'expense' },
                { term: 'cogs', conf: 0.97, note: 'cost of goods sold' },
                { term: 'opex', conf: 0.96, note: 'operating expense' },
                { term: 'salary', conf: 0.94, note: 'salary' },
                { term: 'wage', conf: 0.93, note: 'wage' }
            ],
            fuzzy_rules: {
                'contains_cost': 0.85,
                'contains_expense': 0.83,
                'contains_salary': 0.88
            }
        },
        
        profit: {
            patterns: [
                { term: 'profit', conf: 0.95, note: 'profit' },
                { term: 'margin', conf: 0.90, note: 'margin' },
                { term: 'ebitda', conf: 0.99, note: 'EBITDA' },
                { term: 'net income', conf: 0.98, note: 'net income' }
            ]
        }
    },
    
    chinese: {
        income: {
            patterns: [
                { term: '收入', conf: 0.95, note: 'income/revenue' },
                { term: '营业收入', conf: 0.97, note: 'operating revenue' },
                { term: '销售收入', conf: 0.96, note: 'sales revenue' },
                { term: '营收', conf: 0.94, note: 'revenue' }
            ],
            fuzzy_rules: {
                'contains_收入': 0.90,
                'contains_销售': 0.85
            }
        },
        cost: {
            patterns: [
                { term: '成本', conf: 0.95, note: 'cost' },
                { term: '费用', conf: 0.93, note: 'expense' },
                { term: '支出', conf: 0.90, note: 'expenditure' },
                { term: '工资', conf: 0.94, note: 'salary' }
            ],
            fuzzy_rules: {
                'contains_成本': 0.88,
                'contains_费用': 0.85
            }
        },
        profit: {
            patterns: [
                { term: '利润', conf: 0.96, note: 'profit' },
                { term: '净利润', conf: 0.98, note: 'net profit' },
                { term: '毛利', conf: 0.97, note: 'gross profit' }
            ]
        }
    },
    
    japanese: {
        income: {
            patterns: [
                { term: '収入', conf: 0.95, note: 'income' },
                { term: '売上', conf: 0.97, note: 'sales' },
                { term: '売上高', conf: 0.98, note: 'net sales' },
                { term: '営業収益', conf: 0.96, note: 'operating revenue' }
            ],
            fuzzy_rules: {
                'contains_収入': 0.90,
                'contains_売上': 0.92
            }
        },
        cost: {
            patterns: [
                { term: '費用', conf: 0.93, note: 'expense' },
                { term: '原価', conf: 0.95, note: 'cost' },
                { term: '給与', conf: 0.94, note: 'salary' },
                { term: '経費', conf: 0.92, note: 'expenses' }
            ],
            fuzzy_rules: {
                'contains_費用': 0.85,
                'contains_原価': 0.88
            }
        },
        profit: {
            patterns: [
                { term: '利益', conf: 0.96, note: 'profit' },
                { term: '純利益', conf: 0.98, note: 'net profit' },
                { term: '営業利益', conf: 0.97, note: 'operating profit' }
            ]
        }
    }
};

// ===== ROW CLASSIFICATION (The Core Physics) =====
function classifyRowNature(row, rowIndex, totalRows, docType) {
    const rowArray = Array.isArray(row) ? row : (row.cells || Object.values(row));
    const label = String(rowArray[0] || '').toLowerCase().trim();
    
    let value = 0;
    for (let i = 1; i < rowArray.length; i++) {
        const cellVal = rowArray[i];
        const num = typeof cellVal === 'number' ? cellVal : parseFloat(String(cellVal).replace(/[^0-9.-]/g, ''));
        if (!isNaN(num) && num !== 0) {
            value = num;
            break;
        }
    }
    
    // Skip classification for assumptions sheets or empty labels
    if (!label || docType === 'assumptions') {
        return { nature: 'unknown', confidence: 0, label, value };
    }
    
    let scores = { income: 0, cost: 0, profit: 0 };
    
    // Position heuristic (top = income, middle = cost, bottom = profit)
    const positionRatio = rowIndex / totalRows;
    if (positionRatio < 0.2) scores.income += 0.3;
    if (positionRatio >= 0.2 && positionRatio < 0.8) scores.cost += 0.3;
    if (positionRatio >= 0.8) scores.profit += 0.3;
    
    // Sign heuristic
    if (value > 0) {
        scores.income += 0.2;
        scores.profit += 0.1;
    } else if (value < 0) {
        scores.cost += 0.3;
    }
    
    // Multilingual keyword matching
    for (const [lang, priors] of Object.entries(EMPIRICAL_PRIORS)) {
        if (priors.income?.patterns) {
            for (const pattern of priors.income.patterns) {
                if (label.includes(pattern.term.toLowerCase())) {
                    scores.income += pattern.conf * 0.5;
                }
            }
        }
        
        if (priors.cost?.patterns) {
            for (const pattern of priors.cost.patterns) {
                if (label.includes(pattern.term.toLowerCase())) {
                    scores.cost += pattern.conf * 0.5;
                }
            }
        }
        
        if (priors.profit?.patterns) {
            for (const pattern of priors.profit.patterns) {
                if (label.includes(pattern.term.toLowerCase())) {
                    scores.profit += pattern.conf * 0.5;
                }
            }
        }
        
        // Fuzzy rules
        if (priors.income?.fuzzy_rules) {
            for (const [rule, conf] of Object.entries(priors.income.fuzzy_rules)) {
                if (rule.startsWith('starts_') && label.startsWith(rule.replace('starts_', ''))) {
                    scores.income += conf * 0.3;
                } else if (rule.startsWith('contains_') && label.includes(rule.replace('contains_', ''))) {
                    scores.income += conf * 0.3;
                }
            }
        }
        
        if (priors.cost?.fuzzy_rules) {
            for (const [rule, conf] of Object.entries(priors.cost.fuzzy_rules)) {
                if (rule.startsWith('starts_') && label.startsWith(rule.replace('starts_', ''))) {
                    scores.cost += conf * 0.3;
                } else if (rule.startsWith('contains_') && label.includes(rule.replace('contains_', ''))) {
                    scores.cost += conf * 0.3;
                } else if (rule.startsWith('ends_') && label.endsWith(rule.replace('ends_', ''))) {
                    scores.cost += conf * 0.3;
                }
            }
        }
    }
    
    const maxScore = Math.max(scores.income, scores.cost, scores.profit);
    if (maxScore === 0) return { nature: 'unknown', confidence: 0, label, value };
    
    const [nature, confidence] = Object.entries(scores)
        .sort(([, a], [, b]) => b - a)[0];
    
    return {
        nature,
        symbol: nature === 'income' ? '+' : nature === 'cost' ? '−' : '=',
        confidence: Math.min(confidence, 1.0),
        label,
        value
    };
}

// ===== VALIDATION (Physics Check: Income - Cost = Profit) =====
function validateFinancialPhysics(classifiedRows, docType) {
    if (docType !== 'income_statement') {
        return { valid: true, note: 'Validation only for income statements' };
    }
    
    const income = classifiedRows
        .filter(r => r.nature === 'income')
        .reduce((sum, r) => sum + Math.abs(r.value), 0);
    
    const cost = classifiedRows
        .filter(r => r.nature === 'cost')
        .reduce((sum, r) => sum + Math.abs(r.value), 0);
    
    const profit = classifiedRows
        .filter(r => r.nature === 'profit')
        .reduce((sum, r) => sum + r.value, 0);
    
    const calculated_profit = income - cost;
    const variance = Math.abs(calculated_profit - profit);
    const variance_pct = profit !== 0 ? (variance / Math.abs(profit)) * 100 : 0;
    
    const valid = variance_pct < 5;
    
    console.log(`📊 VALIDATION: Income=${income.toFixed(0)}, Cost=${cost.toFixed(0)}, Profit=${profit.toFixed(0)}`);
    console.log(`📊 EQUATION: ${income.toFixed(0)} − ${cost.toFixed(0)} = ${calculated_profit.toFixed(0)} (stated: ${profit.toFixed(0)})`);
    console.log(`📊 VARIANCE: ${variance_pct.toFixed(2)}% ${valid ? '✓ PASS' : '✗ FAIL'}`);
    
    return {
        valid,
        income,
        cost,
        profit,
        calculated_profit,
        variance,
        variance_pct
    };
}

// ===== TEXT TO ROWS PARSER (for PDFs) =====
function parseTextToRows(text) {
    const rows = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length < 3) continue;
        
        const numMatch = trimmed.match(/^(.+?)\s+([\d,.()[\]-]+(?:\s*[\d,.()[\]-]+)*)$/);
        if (numMatch) {
            const label = numMatch[1].trim();
            const rawValue = numMatch[2];
            
            const isNegative = /^\(.*\)$/.test(rawValue.trim()) || 
                              /^\[.*\]$/.test(rawValue.trim()) ||
                              rawValue.includes('-');
            
            let valueStr = rawValue.replace(/[(),[\]\s-]/g, '');
            if (valueStr.includes(',') && valueStr.includes('.')) {
                if (valueStr.lastIndexOf(',') > valueStr.lastIndexOf('.')) {
                    valueStr = valueStr.replace(/\./g, '').replace(',', '.');
                } else {
                    valueStr = valueStr.replace(/,/g, '');
                }
            } else if (valueStr.includes(',')) {
                const parts = valueStr.split(',');
                if (parts.length === 2 && parts[1].length <= 2) {
                    valueStr = valueStr.replace(',', '.');
                } else {
                    valueStr = valueStr.replace(/,/g, '');
                }
            } else if (valueStr.includes('.')) {
                const parts = valueStr.split('.');
                if (parts.length > 2 || (parts.length === 2 && parts[1].length > 2)) {
                    valueStr = valueStr.replace(/\./g, '');
                }
            }
            let value = parseFloat(valueStr) || 0;
            
            if (isNegative && value > 0) {
                value = -value;
            }
            
            if (value !== 0 && label.length > 2) {
                rows.push([label, value]);
            }
        } else {
            const numbers = trimmed.match(/[\d,.()-]+/g) || [];
            if (numbers.length > 0) {
                const label = trimmed.replace(/[\d,.()-]+/g, '').trim();
                const lastNum = numbers[numbers.length - 1];
                
                const isNegative = /^\(.*\)$/.test(lastNum.trim()) || lastNum.includes('-');
                let cleanNum = lastNum.replace(/[(),\s-]/g, '');
                if ((cleanNum.match(/\./g) || []).length > 1) {
                    cleanNum = cleanNum.replace(/\./g, '');
                }
                cleanNum = cleanNum.replace(/,/g, '');
                let value = parseFloat(cleanNum) || 0;
                
                if (isNegative && value > 0) {
                    value = -value;
                }
                
                if (value !== 0 && label.length > 2) {
                    rows.push([label, value]);
                }
            }
        }
    }
    
    console.log(`📝 Text Parser: Extracted ${rows.length} potential financial rows from text`);
    return rows;
}

// ===== MAIN ENTRY POINT =====
async function analyzeFinancialDocument(extractedData) {
    console.log('🧠 FINANCIAL PHYSICS ENGINE: Starting analysis...');
    
    // GUARD: Skip obvious non-financial data (5-line check)
    if (quickNonFinancialCheck(extractedData)) {
        return {
            documentType: { type: 'non_financial', confidence: 0.99 },
            classifications: [],
            validation: { valid: true, note: 'Skipped: Log/transaction data' },
            summary: { totalRows: 0, classifiedRows: 0 }
        };
    }
    
    // TIER 0: Detect document type (15-line check)
    const docClassification = detectDocumentType(extractedData);
    console.log('');
    
    // Get all rows from tables or text
    let allRows = [];
    const tables = extractedData.tables || extractedData.sheets || [];
    
    if (tables.length > 0) {
        allRows = tables.flatMap(table => table.rows || table.data || []);
    } else if (extractedData.text) {
        allRows = parseTextToRows(extractedData.text);
    }
    
    // Detect currency from document context
    const currency = detectCurrency(extractedData);
    console.log(`💰 Currency detected: ${currency}`);
    
    // ===== TEMPORAL VALIDATION: Check for future "Actual" data =====
    const temporal = getTemporalContext();
    console.log(`📅 Temporal context: ${temporal.formatted}\n`);
    
    const temporalErrors = [];
    const seenErrors = new Set(); // Deduplicate errors
    
    // Scan ALL data (headers + rows) for future "Actual" patterns
    const allDataStrings = flattenToStrings(tables);
    allDataStrings.forEach((cell, idx) => {
        const cellStr = String(cell);
        const yearMatch = cellStr.match(/20\d{2}/);
        if (yearMatch) {
            const year = parseInt(yearMatch[0]);
            // Check if this cell contains both a future year AND "Actual" indicator
            if (year > temporal.year && /\bactual\b/i.test(cellStr)) {
                const errorKey = `${year}-actual`;
                if (!seenErrors.has(errorKey)) {
                    seenErrors.add(errorKey);
                    const warning = `⚠️ TEMPORAL ERROR: "${cellStr.slice(0, 50)}" references year ${year} as Actual (current: ${temporal.year}) — IMPOSSIBLE`;
                    temporalErrors.push(warning);
                    console.log(warning);
                }
            }
        }
    });
    
    // Also scan for column headers like "2026 Actual" or "Actual 2026"
    const columnHeaderPattern = /(20\d{2})\s*(actual|act|a)|actual\s*(20\d{2})/gi;
    const fullText = allDataStrings.join(' ');
    let match;
    while ((match = columnHeaderPattern.exec(fullText)) !== null) {
        const year = parseInt(match[1] || match[3]);
        if (year > temporal.year) {
            const errorKey = `header-${year}`;
            if (!seenErrors.has(errorKey)) {
                seenErrors.add(errorKey);
                const warning = `⚠️ TEMPORAL ERROR: Column header "${match[0]}" is future year ${year} labeled as Actual`;
                temporalErrors.push(warning);
                console.log(warning);
            }
        }
    }
    
    // ===== MULTI-ROW HEADER DETECTION: Year and "Actual" in separate rows, same column =====
    // Common Excel pattern:
    //   Row 1: |       | 2025    | 2025    | 2026    | 2026    |
    //   Row 2: | Label | Actual  | Budget  | Actual  | Budget  |
    // We need to detect column-based associations, not just same-cell patterns
    
    if (tables.length > 0) {
        tables.forEach((table, tableIdx) => {
            const rows = table.rows || table.data || table.structuredRows?.map(sr => [sr.label, ...sr.values]) || [];
            if (rows.length < 2) return; // Need at least 2 rows for multi-row headers
            
            // Scan first 5 rows (typical header zone) for column-based year/actual associations
            const headerRows = rows.slice(0, Math.min(5, rows.length));
            const maxCols = Math.max(...headerRows.map(r => (r?.length || 0)));
            
            // Build column index maps
            const columnYears = {}; // columnIndex -> year found
            const columnActuals = {}; // columnIndex -> true if "Actual" found
            
            headerRows.forEach((row, rowIdx) => {
                if (!Array.isArray(row)) return;
                row.forEach((cell, colIdx) => {
                    const cellStr = String(cell || '').trim();
                    if (!cellStr) return;
                    
                    // Check for year (2020-2030 range)
                    const yearMatch = cellStr.match(/\b(20[2-3]\d)\b/);
                    if (yearMatch) {
                        const year = parseInt(yearMatch[1]);
                        // Store the year for this column (prefer later rows if multiple)
                        if (!columnYears[colIdx] || rowIdx > 0) {
                            columnYears[colIdx] = year;
                        }
                    }
                    
                    // Check for "Actual" indicator (case-insensitive)
                    if (/\b(actual|act|realisasi|realized|real)\b/i.test(cellStr)) {
                        columnActuals[colIdx] = true;
                    }
                });
            });
            
            // Cross-reference: find columns with BOTH future year AND "Actual"
            Object.keys(columnYears).forEach(colIdx => {
                const year = columnYears[colIdx];
                if (year > temporal.year && columnActuals[colIdx]) {
                    const errorKey = `multirow-col${colIdx}-${year}`;
                    if (!seenErrors.has(errorKey)) {
                        seenErrors.add(errorKey);
                        const warning = `⚠️ TEMPORAL ERROR: Column ${parseInt(colIdx) + 1} has "${year}" + "Actual" in multi-row headers — ${year} data CANNOT be Actual in ${temporal.year}`;
                        temporalErrors.push(warning);
                        console.log(warning);
                    }
                }
            });
            
            // Log detection summary for debugging
            const futureYearCols = Object.entries(columnYears).filter(([_, y]) => y > temporal.year);
            const actualCols = Object.keys(columnActuals);
            if (futureYearCols.length > 0 || actualCols.length > 0) {
                console.log(`📊 Table ${tableIdx + 1} header scan: ${futureYearCols.length} future-year columns, ${actualCols.length} Actual-labeled columns`);
            }
        });
    }
    
    if (temporalErrors.length > 0) {
        console.log(`🚨 Found ${temporalErrors.length} temporal classification error(s)\n`);
    }
    
    // TIER 1: Classify each row by nature (+Income, −Cost, =Profit)
    console.log('🔬 TIER 1: Classifying rows by financial nature...\n');
    const classifiedRows = [];
    let lowConfidenceCount = 0;
    
    allRows.forEach((row, index) => {
        const classification = classifyRowNature(row, index, allRows.length, docClassification.type);
        
        if (classification.nature !== 'unknown') {
            if (classification.confidence > 0.6) {
                classifiedRows.push(classification);
            } else if (classification.confidence > 0.3) {
                classifiedRows.push(classification);
                lowConfidenceCount++;
            }
        }
    });
    
    console.log(`✅ Classified ${classifiedRows.length} rows (${lowConfidenceCount} with low confidence 30-60%)\n`);
    
    // TIER 3: Validate physics (Income - Cost = Profit)
    const validation = validateFinancialPhysics(classifiedRows, docClassification.type);
    
    return {
        documentType: docClassification,
        currency,
        temporal,
        temporalErrors,
        classifications: classifiedRows,
        validation,
        summary: {
            totalRows: allRows.length,
            classifiedRows: classifiedRows.length,
            lowConfidenceRows: lowConfidenceCount,
            incomeRows: classifiedRows.filter(r => r.nature === 'income').length,
            costRows: classifiedRows.filter(r => r.nature === 'cost').length,
            profitRows: classifiedRows.filter(r => r.nature === 'profit').length
        }
    };
}

// ===== FORMAT PHYSICS ANALYSIS FOR GROQ CONTEXT =====
function formatPhysicsAnalysis(analysis) {
    if (!analysis || !analysis.documentType) return '';
    
    const currency = analysis.currency || 'LCU';
    const parts = ['=== FINANCIAL PHYSICS ANALYSIS ==='];
    parts.push(`Document Type: ${analysis.documentType.type} (${(analysis.documentType.confidence * 100).toFixed(0)}% confidence)`);
    parts.push(`Currency: ${currency}`);
    
    if (analysis.summary) {
        parts.push(`\nClassified: ${analysis.summary.classifiedRows}/${analysis.summary.totalRows} rows`);
        if (analysis.summary.lowConfidenceRows > 0) {
            parts.push(`  ⚠️ Low confidence (30-60%): ${analysis.summary.lowConfidenceRows} rows`);
        }
        parts.push(`  +Income rows: ${analysis.summary.incomeRows}`);
        parts.push(`  −Cost rows: ${analysis.summary.costRows}`);
        parts.push(`  =Profit rows: ${analysis.summary.profitRows}`);
    }
    
    if (analysis.validation && analysis.documentType.type === 'income_statement') {
        parts.push(`\nPhysics Validation: ${analysis.validation.valid ? 'PASS ✓' : 'FAIL ✗'}`);
        parts.push(`  Total Income: ${currency} ${analysis.validation.income?.toLocaleString() || 0}`);
        parts.push(`  Total Cost: ${currency} ${analysis.validation.cost?.toLocaleString() || 0}`);
        parts.push(`  Stated Profit: ${currency} ${analysis.validation.profit?.toLocaleString() || 0}`);
        parts.push(`  Calculated: ${currency} ${analysis.validation.calculated_profit?.toLocaleString() || 0}`);
        parts.push(`  Variance: ${analysis.validation.variance_pct?.toFixed(2) || 0}%`);
    }
    
    if (analysis.classifications && analysis.classifications.length > 0) {
        parts.push('\nTop Classifications:');
        const top10 = analysis.classifications
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 10);
        
        top10.forEach(c => {
            const symbol = c.nature === 'income' ? '+' : c.nature === 'cost' ? '−' : '=';
            parts.push(`  ${symbol} ${c.label}: ${currency} ${c.value.toLocaleString()} (${(c.confidence * 100).toFixed(0)}%)`);
        });
    }
    
    // H₀ Physical Audit Disclaimer
    parts.push('\n⚠️ PHYSICAL AUDIT ADVISORY: Reported numbers are vulnerable to human error and financial acrobats. Recommend combining with real physical audits: warehouse visits (stock taking), sample PO/AR/vendor verification, counting truck shipments (P×Q proxy), and similar "seeing is believing" H₀ approaches.');
    
    return parts.join('\n');
}

// Get the FINANCIAL_PHYSICS_SEED with current date injected
function getFinancialPhysicsSeed() {
    const temporal = getTemporalContext();
    return FINANCIAL_PHYSICS_SEED.replace(/\{\{CURRENT_DATE\}\}/g, temporal.formatted);
}

module.exports = {
    FINANCIAL_PHYSICS_SEED,
    getFinancialPhysicsSeed,
    getTemporalContext,
    detectCurrency,
    EMPIRICAL_PRIORS,
    quickNonFinancialCheck,
    detectDocumentType,
    classifyRowNature,
    validateFinancialPhysics,
    analyzeFinancialDocument,
    formatPhysicsAnalysis,
    parseTextToRows
};
