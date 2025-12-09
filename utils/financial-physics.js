/**
 * FINANCIAL PHYSICS SYSTEM (H₀ Canon — 2025)
 * 
 * Revolutionary financial cognition engine that understands money
 * as physics, not labels. Works across all languages, industries,
 * and formats by observing flows instead of reading accounts.
 * 
 * Architecture:
 * - TIER 0: Document Type (4 eternal statements)
 * - TIER 1: Nature Classification (+/− flows, A=L+E, cash movement)
 * - TIER 2: Semantic Enrichment (multilingual, fuzzy matching)
 * - TIER 3: Validation (accounting equations, falsification)
 * 
 * Deploy this at the top of any financial analysis workflow.
 */

const FINANCIAL_PHYSICS_SEED = `
UNIVERSAL FINANCIAL ONTOLOGY (H₀ SEED — 2025)

There are only four eternal truths in finance:

1. ASSUMPTIONS — The drivers
   → Units, prices, ratios, headcount, norms
   → Everything begins here
   → Example: "240 trucks", "Rp 2.4M/trip", "2.4 HK/trip"

2. INCOME STATEMENT — The flow of value
   → Only two directions exist:
        +Income (money in, any label)
        −Cost   (money out, any label)
   → All accounts are fractals of these two
   → "Pendapatan Net Klaim" = +Income
   → "Upah Trip Supir" = −Cost
   → "Depreciation" = −Cost (non-cash, but still −)

3. BALANCE SHEET — The conservation of value
   → Only one law: Assets = Liabilities + Equity
   → All accounts are buckets to make this true
   → No meaning beyond position
   → "Truck" = Asset because someone owes it or owns it

4. CASH FLOW — The movement of blood
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

Begin.
`;

// ===== TIER -1: IS THIS A FINANCIAL STATEMENT? =====
// Gate function to determine if Excel/PDF contains financial statements vs regular data
// Financial statements have: time-period columns, account hierarchy, specific keywords
// Non-financial data has: ID columns, timestamps, flat structure, log format

const FINANCIAL_STATEMENT_INDICATORS = {
    // Time-period column headers (x-axis = time)
    timePeriodPatterns: [
        // Months (full and abbreviated, multi-language)
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
        /\b(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b/i,
        // Quarters
        /\bq[1-4]\b/i,
        /\b(quarter|kuartal)\s*[1-4]\b/i,
        // Years (standalone, not part of timestamp)
        /\b20[1-3][0-9]\b/,
        /\bfy\s*20[1-3][0-9]\b/i,
        // Periods
        /\b(ytd|mtd|qtd)\b/i,
        /\b(budget|actual|forecast|proyeksi|anggaran)\b/i
    ],
    
    // Account hierarchy keywords (y-axis = accounts)
    accountKeywords: [
        // Income Statement
        'revenue', 'sales', 'income', 'pendapatan', 'penjualan', 'omzet',
        'cost', 'expense', 'biaya', 'beban', 'hpp', 'cogs',
        'profit', 'loss', 'laba', 'rugi', 'margin', 'ebitda', 'ebit',
        'gross profit', 'net income', 'operating income',
        // Balance Sheet
        'assets', 'aset', 'aktiva', 'liabilities', 'kewajiban', 'utang',
        'equity', 'ekuitas', 'modal', 'retained earnings', 'laba ditahan',
        'receivables', 'piutang', 'payables', 'hutang', 'inventory', 'persediaan',
        // Cash Flow
        'operating activities', 'investing activities', 'financing activities',
        'cash flow', 'arus kas', 'net change in cash'
    ],
    
    // Structural indicators
    structuralPatterns: [
        /\btotal\b/i,
        /\bsubtotal\b/i,
        /\bnet\b/i,
        /\bgross\b/i,
        /\b%\s*(of|dari)?\s*(revenue|sales|pendapatan)?\b/i
    ]
};

const NON_FINANCIAL_INDICATORS = {
    // ID/Log column patterns (indicates transactional data, not statements)
    idPatterns: [
        /\b(id|_id|uuid|guid)\b/i,
        /\b(created_at|updated_at|timestamp|datetime)\b/i,
        /\b(user_id|customer_id|order_id|transaction_id)\b/i,
        /\b(status|state|type|category)\b/i,
        /\b(event|action|log|entry)\b/i
    ],
    
    // Timestamp patterns (full datetime, not just year/month)
    timestampPatterns: [
        /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/,  // 2024-01-15 14:30
        /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/,  // 01/15/2024 14:30
        /\d{2}:\d{2}:\d{2}/  // HH:MM:SS
    ],
    
    // Flat structure indicators (no hierarchy)
    flatStructureKeywords: [
        'row', 'record', 'entry', 'item', 'line',
        'name', 'description', 'notes', 'comments',
        'email', 'phone', 'address', 'url', 'link'
    ]
};

function isFinancialStatement(extractedData) {
    console.log('🎯 TIER -1: Checking if this is a financial statement...');
    
    // Get all text content for analysis
    const tables = extractedData.tables || extractedData.sheets || [];
    let allText = '';
    let headers = [];
    let firstColumnLabels = [];
    
    if (tables.length > 0) {
        tables.forEach(table => {
            // Also check pre-extracted headers if available
            if (table.headers && Array.isArray(table.headers)) {
                headers.push(...table.headers.map(h => String(h || '').toLowerCase()));
            }
            
            const rows = table.rows || table.data || [];
            if (rows.length > 0) {
                // Extract headers (first row) if not already extracted
                if (headers.length === 0 && Array.isArray(rows[0])) {
                    headers.push(...rows[0].map(h => String(h || '').toLowerCase()));
                }
                // Extract first column labels (account names)
                rows.forEach(row => {
                    if (Array.isArray(row) && row[0]) {
                        firstColumnLabels.push(String(row[0]).toLowerCase());
                    }
                });
            }
            allText += rows.flatMap(r => Array.isArray(r) ? r : Object.values(r)).join(' ').toLowerCase() + ' ';
        });
    } else if (extractedData.text) {
        allText = extractedData.text.toLowerCase();
        // For PDFs, extract potential headers/labels from first lines
        const lines = allText.split('\n').slice(0, 50); // First 50 lines for detection
        firstColumnLabels = lines.filter(l => l.trim().length > 0);
    }
    
    const headerText = headers.join(' ');
    const labelsText = firstColumnLabels.join(' ');
    
    // Score financial statement indicators
    let financialScore = 0;
    let nonFinancialScore = 0;
    
    // Check for time-period columns in headers
    let timePeriodMatches = 0;
    FINANCIAL_STATEMENT_INDICATORS.timePeriodPatterns.forEach(pattern => {
        if (pattern.test(headerText)) {
            timePeriodMatches++;
        }
    });
    if (timePeriodMatches >= 2) {
        financialScore += 0.3;
        console.log(`   ✅ Time-period columns detected (${timePeriodMatches} patterns)`);
    } else if (timePeriodMatches === 1) {
        financialScore += 0.15;
    }
    
    // Check for account keywords in first column AND full text (for PDFs)
    let accountMatches = 0;
    const searchText = labelsText + ' ' + allText; // Check both labels and full content
    FINANCIAL_STATEMENT_INDICATORS.accountKeywords.forEach(keyword => {
        if (searchText.includes(keyword.toLowerCase())) {
            accountMatches++;
        }
    });
    if (accountMatches >= 8) {
        financialScore += 0.45;
        console.log(`   ✅ Account keywords detected (${accountMatches} matches)`);
    } else if (accountMatches >= 5) {
        financialScore += 0.35;
        console.log(`   ✅ Account keywords detected (${accountMatches} matches)`);
    } else if (accountMatches >= 2) {
        financialScore += 0.2;
    }
    
    // Also check time periods in full text (for PDFs without explicit headers)
    if (timePeriodMatches === 0) {
        FINANCIAL_STATEMENT_INDICATORS.timePeriodPatterns.forEach(pattern => {
            if (pattern.test(allText)) {
                timePeriodMatches++;
            }
        });
        if (timePeriodMatches >= 2) {
            financialScore += 0.25;
            console.log(`   ✅ Time-period patterns in text (${timePeriodMatches} patterns)`);
        }
    }
    
    // Check for structural patterns (totals, subtotals)
    let structuralMatches = 0;
    FINANCIAL_STATEMENT_INDICATORS.structuralPatterns.forEach(pattern => {
        if (pattern.test(allText)) {
            structuralMatches++;
        }
    });
    if (structuralMatches >= 2) {
        financialScore += 0.2;
        console.log(`   ✅ Hierarchical structure detected (${structuralMatches} patterns)`);
    }
    
    // Check for NON-financial indicators
    let idColumnMatches = 0;
    NON_FINANCIAL_INDICATORS.idPatterns.forEach(pattern => {
        if (pattern.test(headerText)) {
            idColumnMatches++;
        }
    });
    if (idColumnMatches >= 2) {
        nonFinancialScore += 0.4;
        console.log(`   ⚠️ ID/Log columns detected (${idColumnMatches} patterns) - likely transactional data`);
    }
    
    // Check for timestamps
    let timestampMatches = 0;
    NON_FINANCIAL_INDICATORS.timestampPatterns.forEach(pattern => {
        if (pattern.test(allText)) {
            timestampMatches++;
        }
    });
    if (timestampMatches >= 1) {
        nonFinancialScore += 0.25;
        console.log(`   ⚠️ Timestamps detected - likely log/transaction data`);
    }
    
    // Check for flat structure indicators
    let flatMatches = 0;
    NON_FINANCIAL_INDICATORS.flatStructureKeywords.forEach(keyword => {
        if (headerText.includes(keyword)) {
            flatMatches++;
        }
    });
    if (flatMatches >= 3) {
        nonFinancialScore += 0.2;
        console.log(`   ⚠️ Flat structure keywords in headers (${flatMatches} matches)`);
    }
    
    // Calculate net confidence
    const netScore = financialScore - nonFinancialScore;
    const isFinancial = netScore > 0.3;
    const confidence = Math.min(Math.max(netScore + 0.5, 0), 1); // Normalize to 0-1
    
    console.log(`   📊 Financial score: ${(financialScore * 100).toFixed(0)}%`);
    console.log(`   📊 Non-financial score: ${(nonFinancialScore * 100).toFixed(0)}%`);
    console.log(`   🎯 TIER -1 Result: ${isFinancial ? 'FINANCIAL STATEMENT' : 'REGULAR DATA'} (confidence: ${(confidence * 100).toFixed(0)}%)`);
    
    return {
        isFinancialStatement: isFinancial,
        confidence,
        scores: {
            financial: financialScore,
            nonFinancial: nonFinancialScore,
            net: netScore
        },
        details: {
            timePeriodMatches,
            accountMatches,
            structuralMatches,
            idColumnMatches,
            timestampMatches,
            flatMatches
        }
    };
}

const DOCUMENT_SIGNATURES = {
    assumptions: {
        name: 'Assumptions/Drivers',
        description: 'Input variables and unit economics that drive P&L',
        
        detection: {
            keywords: [
                'asumsi', 'assumptions', 'drivers', 'unit economics',
                'per trip', 'per unit', 'per km', 'per week',
                'utilization', 'occupancy', 'growth rate',
                'price per', 'cost per', 'headcount', 'fleet size'
            ],
            structure: [
                'small tables (< 50 rows)',
                'formula-heavy (Excel formulas)',
                'input → calculation → output',
                'no grand totals or final P&L'
            ],
            not_present: [
                'total revenue', 'net profit', 'total assets',
                'cash flow from operations'
            ]
        },
        
        confidence_threshold: 0.7
    },
    
    income_statement: {
        name: 'Income Statement (P&L)',
        description: 'Flow of value: money in vs money out',
        
        detection: {
            keywords: [
                'revenue', 'sales', 'income', 'pendapatan', 'penjualan', 'omzet',
                'cost', 'expense', 'biaya', 'beban', 'pengeluaran',
                'profit', 'loss', 'laba', 'rugi', 'margin',
                'gross profit', 'ebitda', 'ebit', 'net income'
            ],
            structure: [
                'hierarchical (revenue → costs → profit)',
                'positive numbers at top (income)',
                'negative or positive numbers middle (costs)',
                'result at bottom (profit/loss)',
                'subtotals → grand total'
            ],
            physics: [
                'conservation: income − cost = profit',
                'sign consistency: revenue positive, costs negative',
                'hierarchical flow: gross → operating → net'
            ]
        },
        
        validation: {
            equation: 'income − cost = profit',
            tolerance: 0.01
        },
        
        confidence_threshold: 0.85
    },
    
    balance_sheet: {
        name: 'Balance Sheet',
        description: 'Conservation of value: assets = liabilities + equity',
        
        detection: {
            keywords: [
                'assets', 'aset', 'aktiva', 'harta',
                'cash', 'kas', 'bank', 'receivables', 'piutang',
                'inventory', 'persediaan', 'equipment', 'peralatan',
                'liabilities', 'kewajiban', 'liabilitas', 'utang',
                'payables', 'hutang', 'loans', 'pinjaman',
                'equity', 'ekuitas', 'modal', 'capital',
                'retained earnings', 'laba ditahan'
            ],
            structure: [
                'two-sided or vertical sections',
                'assets section first/top',
                'liabilities + equity second/bottom',
                'both sides must balance'
            ],
            physics: [
                'conservation: assets = liabilities + equity',
                'residual: equity = assets − liabilities'
            ]
        },
        
        validation: {
            equation: 'assets = liabilities + equity',
            tolerance: 0.01
        },
        
        confidence_threshold: 0.90
    },
    
    cash_flow: {
        name: 'Cash Flow Statement',
        description: 'Movement of cash: operations, investing, financing',
        
        detection: {
            keywords: [
                'operating', 'operasi', 'operasional',
                'receipts', 'penerimaan', 'payments', 'pembayaran',
                'investing', 'investasi', 'capex', 'purchase of assets',
                'pembelian aset', 'sale of assets', 'penjualan aset',
                'financing', 'pendanaan', 'loans', 'pinjaman',
                'dividends', 'dividen', 'equity', 'ekuitas'
            ],
            structure: [
                'three distinct sections',
                'operating activities first',
                'investing activities second',
                'financing activities third',
                'net change in cash at bottom'
            ],
            physics: [
                'conservation: net_cf = operating + investing + financing',
                'reconciliation: ending_cash − beginning_cash = net_cf'
            ]
        },
        
        validation: {
            equation: 'net_cf = cf_operating + cf_investing + cf_financing',
            tolerance: 0.01
        },
        
        confidence_threshold: 0.85
    }
};

const FINANCIAL_NATURE = {
    income: {
        symbol: '+',
        nature: 'positive_cash_flow',
        description: 'Money flowing IN (any label, any language)',
        
        physics: {
            sign: 'positive (increases equity)',
            position: 'top of income statement',
            effect: 'increases assets or decreases liabilities',
            cash_impact: 'eventually +cash (if collected)'
        },
        
        detection_rules: {
            primary: [
                'appears before costs',
                'positive values (typically)',
                'increases when business grows',
                'top 20% of income statement rows'
            ],
            contextual: [
                'labeled with income-like terms (any language)',
                'largest absolute numbers in statement',
                'subtotals aggregate upward to total revenue'
            ],
            falsification: [
                'if value is negative AND not labeled "return/discount" → not income',
                'if appears below profit line → not income',
                'if decreases equity → not income'
            ]
        }
    },
    
    cost: {
        symbol: '−',
        nature: 'negative_cash_flow',
        description: 'Money flowing OUT (any label, any language)',
        
        physics: {
            sign: 'negative (decreases equity) or positive absolute',
            position: 'middle of income statement',
            effect: 'decreases assets or increases liabilities',
            cash_impact: 'eventually −cash (if paid)'
        },
        
        detection_rules: {
            primary: [
                'appears after revenue',
                'negative or positive values (absolute)',
                'increases when activity increases',
                'middle 60% of income statement rows'
            ],
            contextual: [
                'labeled with cost/expense terms',
                'hierarchical breakdown (subtotals)',
                'indented or grouped by category'
            ],
            falsification: [
                'if appears above revenue → not cost',
                'if increases equity → not cost'
            ]
        },
        
        subcategories: {
            direct: {
                name: 'Direct Cost / COGS',
                nature: 'variable',
                keywords: ['cogs', 'hpp', 'direct', 'variable'],
                physics: 'scales with revenue (volume-dependent)'
            },
            operating: {
                name: 'Operating Expense / OpEx',
                nature: 'semi_fixed',
                keywords: ['opex', 'operating', 'overhead', 'sg&a'],
                physics: 'relatively fixed (step function)'
            },
            depreciation: {
                name: 'Depreciation / Amortization',
                nature: 'non_cash',
                keywords: ['depreciation', 'depresiasi', 'amortization'],
                physics: 'accounting cost, no cash movement'
            },
            financial: {
                name: 'Interest / Tax',
                nature: 'financial',
                keywords: ['interest', 'bunga', 'tax', 'pajak'],
                physics: 'below operating line, financing cost'
            }
        }
    },
    
    profit: {
        symbol: '=',
        nature: 'residual',
        description: 'Result of income minus cost',
        
        physics: {
            formula: 'income − cost',
            sign: 'positive (profit) or negative (loss)',
            position: 'bottom of income statement',
            effect: 'net change in equity for period'
        },
        
        detection_rules: {
            primary: [
                'appears after all costs',
                'calculated value (not input)',
                'bottom 20% of income statement',
                'often bold or highlighted'
            ],
            validation: [
                'must equal: revenue − expenses',
                'gross profit = revenue − cogs',
                'ebitda = gross profit − opex',
                'net profit = ebitda − d&a − interest − tax'
            ]
        }
    },
    
    asset: {
        symbol: 'A',
        nature: 'resource_controlled',
        description: 'What you own or control',
        
        physics: {
            sign: 'positive (debit balance)',
            position: 'left or top of balance sheet',
            equation: 'A = L + E',
            types: ['current (<1 year)', 'fixed (>1 year)']
        }
    },
    
    liability: {
        symbol: 'L',
        nature: 'obligation_owed',
        description: 'What you owe',
        
        physics: {
            sign: 'positive (credit balance)',
            position: 'right or middle of balance sheet',
            equation: 'L = A − E',
            types: ['current (<1 year)', 'long-term (>1 year)']
        }
    },
    
    equity: {
        symbol: 'E',
        nature: 'residual_ownership',
        description: 'What you own after debts',
        
        physics: {
            formula: 'assets − liabilities',
            sign: 'positive (usually)',
            position: 'bottom right or last',
            components: ['capital', 'retained earnings', 'current profit']
        }
    }
};

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

async function identifyDocumentType(extractedData) {
    console.log('🔍 TIER 0: Identifying financial document type...');
    
    // Handle both structured tables (Excel) and raw text (PDF)
    const tables = extractedData.tables || extractedData.sheets || [];
    let allText = '';
    
    if (tables.length > 0) {
        allText = tables
            .flatMap(t => t.rows || t.data || [])
            .flatMap(r => Array.isArray(r) ? r : Object.values(r))
            .join(' ')
            .toLowerCase();
    } else if (extractedData.text) {
        allText = extractedData.text.toLowerCase();
        console.log(`📝 TIER 0: Analyzing ${allText.length} chars of PDF text`);
    }
    
    const scores = {};
    
    for (const [type, signature] of Object.entries(DOCUMENT_SIGNATURES)) {
        let score = 0;
        
        const keywords = signature.detection.keywords;
        const matches = keywords.filter(kw => allText.includes(kw.toLowerCase())).length;
        score += (matches / keywords.length) * 0.5;
        
        if (signature.detection.not_present) {
            const notPresent = signature.detection.not_present.filter(term => 
                !allText.includes(term.toLowerCase())
            ).length;
            score += (notPresent / signature.detection.not_present.length) * 0.3;
        }
        
        score += 0.2;
        
        scores[type] = Math.min(score, 1.0);
    }
    
    const [docType, confidence] = Object.entries(scores)
        .sort(([, a], [, b]) => b - a)[0];
    
    console.log(`✅ TIER 0: ${docType} (${(confidence * 100).toFixed(1)}%)`);
    
    return {
        type: docType,
        confidence,
        scores,
        signature: DOCUMENT_SIGNATURES[docType]
    };
}

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
    
    if (!label || docType !== 'income_statement') {
        return { nature: 'unknown', confidence: 0, label, value };
    }
    
    let scores = { income: 0, cost: 0, profit: 0 };
    
    const positionRatio = rowIndex / totalRows;
    if (positionRatio < 0.2) scores.income += 0.3;
    if (positionRatio >= 0.2 && positionRatio < 0.8) scores.cost += 0.3;
    if (positionRatio >= 0.8) scores.profit += 0.3;
    
    if (value > 0) {
        scores.income += 0.2;
        scores.profit += 0.1;
    } else if (value < 0) {
        scores.cost += 0.3;
    }
    
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
            
            // Detect negative markers: (1,200) or [1,200] or -1,200
            const isNegative = /^\(.*\)$/.test(rawValue.trim()) || 
                              /^\[.*\]$/.test(rawValue.trim()) ||
                              rawValue.includes('-');
            
            // Remove parentheses, brackets, dashes, spaces AND commas (thousand separators)
            // Keep periods only if they're decimal points (last occurrence with 1-2 digits after)
            let valueStr = rawValue.replace(/[(),[\]\s-]/g, '');
            // Handle thousand separators: remove commas, treat dots as thousands unless decimal
            if (valueStr.includes(',') && valueStr.includes('.')) {
                // European: 1.234.567,89 or US: 1,234,567.89
                if (valueStr.lastIndexOf(',') > valueStr.lastIndexOf('.')) {
                    // European format: dots are thousands, comma is decimal
                    valueStr = valueStr.replace(/\./g, '').replace(',', '.');
                } else {
                    // US format: commas are thousands, dot is decimal
                    valueStr = valueStr.replace(/,/g, '');
                }
            } else if (valueStr.includes(',')) {
                // Only commas: could be European decimal or US thousands
                const parts = valueStr.split(',');
                if (parts.length === 2 && parts[1].length <= 2) {
                    // European decimal: 1234,56
                    valueStr = valueStr.replace(',', '.');
                } else {
                    // US thousands: 1,234,567
                    valueStr = valueStr.replace(/,/g, '');
                }
            } else if (valueStr.includes('.')) {
                // Only dots: could be decimal or thousands
                const parts = valueStr.split('.');
                if (parts.length > 2 || (parts.length === 2 && parts[1].length > 2)) {
                    // Thousands separator: 1.234.567
                    valueStr = valueStr.replace(/\./g, '');
                }
                // else keep as decimal
            }
            let value = parseFloat(valueStr) || 0;
            
            // Apply negative sign for costs in parentheses
            if (isNegative && value > 0) {
                value = -value;
            }
            
            if (value !== 0 && label.length > 2) {
                rows.push([label, value]);
            }
        } else {
            // Fallback: find any numbers in the line
            const numbers = trimmed.match(/[\d,.()-]+/g) || [];
            if (numbers.length > 0) {
                const label = trimmed.replace(/[\d,.()-]+/g, '').trim();
                const lastNum = numbers[numbers.length - 1];
                
                const isNegative = /^\(.*\)$/.test(lastNum.trim()) || lastNum.includes('-');
                // Remove all thousand separators (commas and dots used as thousands)
                let cleanNum = lastNum.replace(/[(),\s-]/g, '');
                // If multiple dots or dots followed by 3+ digits, treat as thousands
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

async function analyzeFinancialDocument(extractedData) {
    console.log('🧠 FINANCIAL PHYSICS ENGINE: Starting analysis...\n');
    
    const docClassification = await identifyDocumentType(extractedData);
    console.log(`\n📋 Document Type: ${docClassification.type}`);
    console.log(`   Confidence: ${(docClassification.confidence * 100).toFixed(1)}%\n`);
    
    console.log('🔬 TIER 1: Classifying rows by financial nature...\n');
    
    // Handle both structured tables (Excel) and raw text (PDF)
    let allRows = [];
    const tables = extractedData.tables || extractedData.sheets || [];
    
    if (tables.length > 0) {
        allRows = tables.flatMap(table => table.rows || table.data || []);
    } else if (extractedData.text) {
        allRows = parseTextToRows(extractedData.text);
    }
    const classifiedRows = [];
    
    allRows.forEach((row, index) => {
        const classification = classifyRowNature(row, index, allRows.length, docClassification.type);
        
        if (classification.nature !== 'unknown' && classification.confidence > 0.6) {
            classifiedRows.push(classification);
            console.log(`   ${classification.symbol} ${classification.nature.toUpperCase()}: "${classification.label}" = ${classification.value.toFixed(0)} (${(classification.confidence * 100).toFixed(0)}%)`);
        }
    });
    
    console.log(`\n⚖️  TIER 3: Validating financial physics...\n`);
    const validation = validateFinancialPhysics(classifiedRows, docClassification.type);
    
    console.log(`\n✅ ANALYSIS COMPLETE\n`);
    console.log(`Document Type: ${docClassification.type}`);
    console.log(`Rows Classified: ${classifiedRows.length}`);
    console.log(`Physics Valid: ${validation.valid ? 'YES ✓' : 'NO ✗'}`);
    
    return {
        documentType: docClassification,
        classifications: classifiedRows,
        validation,
        physics_seed: FINANCIAL_PHYSICS_SEED
    };
}

function formatPhysicsAnalysis(analysis) {
    const parts = [];
    
    parts.push(`\n### 🧠 Financial Physics Analysis:`);
    parts.push(`**Document Type:** ${analysis.documentType.type} (${(analysis.documentType.confidence * 100).toFixed(1)}% confidence)`);
    
    if (analysis.classifications.length > 0) {
        parts.push(`\n**Classifications Found:**`);
        
        const byNature = {};
        for (const row of analysis.classifications) {
            if (!byNature[row.nature]) byNature[row.nature] = [];
            byNature[row.nature].push(row);
        }
        
        for (const [nature, rows] of Object.entries(byNature)) {
            const symbol = nature === 'income' ? '+' : nature === 'cost' ? '−' : '=';
            parts.push(`\n**${nature.toUpperCase()} (${symbol}):**`);
            rows.slice(0, 10).forEach(r => {
                parts.push(`  - ${r.label}: ${r.value.toLocaleString()} (${(r.confidence * 100).toFixed(0)}%)`);
            });
            if (rows.length > 10) {
                parts.push(`  - ... and ${rows.length - 10} more`);
            }
        }
    }
    
    if (analysis.validation && analysis.validation.income !== undefined) {
        parts.push(`\n**Physics Validation:**`);
        parts.push(`  Income: ${analysis.validation.income.toLocaleString()}`);
        parts.push(`  Cost: ${analysis.validation.cost.toLocaleString()}`);
        parts.push(`  Profit: ${analysis.validation.profit.toLocaleString()}`);
        parts.push(`  Equation Check: ${analysis.validation.valid ? '✓ PASS' : '✗ FAIL'} (variance: ${analysis.validation.variance_pct.toFixed(2)}%)`);
    }
    
    return parts.join('\n');
}

module.exports = {
    FINANCIAL_PHYSICS_SEED,
    DOCUMENT_SIGNATURES,
    FINANCIAL_NATURE,
    EMPIRICAL_PRIORS,
    identifyDocumentType,
    classifyRowNature,
    validateFinancialPhysics,
    analyzeFinancialDocument,
    formatPhysicsAnalysis,
    // TIER -1: Gate function to check if data is a financial statement
    isFinancialStatement
};
