const axios = require('axios');

const H0_TAXONOMY = {
    _meta: {
        philosophy: 'H(0) empirical priors - falsifiable by document context, not H(1) dogma',
        version: '2025.12.09',
        note: 'Seed knowledge from Indonesian financial documents - confidence is evidence strength, not certainty'
    },
    
    REVENUE: {
        category: 'Revenue',
        universalConcept: 'Income from operations',
        priors: [
            { term: 'Pendapatan', lang: 'id', confidence: 0.95, evidence: 'Indonesian P&L convention' },
            { term: 'Pendapatan Net', lang: 'id', confidence: 0.95, evidence: 'Net revenue after adjustments' },
            { term: 'Pendapatan Net Klaim', lang: 'id', confidence: 0.92, evidence: 'Net revenue after claims' },
            { term: 'Penjualan', lang: 'id', confidence: 0.90, evidence: 'Sales/revenue synonym' },
            { term: 'Omzet', lang: 'id', confidence: 0.88, evidence: 'Turnover/revenue Dutch loanword' },
            { term: 'Target Rp', lang: 'id', confidence: 0.75, evidence: 'Revenue target (context needed)' },
            { term: '收入', lang: 'zh', confidence: 0.95, evidence: 'Chinese revenue' },
            { term: '营收', lang: 'zh', confidence: 0.95, evidence: 'Chinese operating revenue' },
            { term: '売上', lang: 'ja', confidence: 0.95, evidence: 'Japanese sales/revenue' },
            { term: '매출', lang: 'ko', confidence: 0.95, evidence: 'Korean revenue' },
            { term: 'Ingresos', lang: 'es', confidence: 0.95, evidence: 'Spanish revenue' },
            { term: 'Revenus', lang: 'fr', confidence: 0.95, evidence: 'French revenue' },
            { term: 'Umsatz', lang: 'de', confidence: 0.95, evidence: 'German revenue/turnover' },
            { term: 'إيرادات', lang: 'ar', confidence: 0.95, evidence: 'Arabic revenue' },
            { term: 'Receita', lang: 'pt', confidence: 0.95, evidence: 'Portuguese revenue' },
            { term: 'รายได้', lang: 'th', confidence: 0.95, evidence: 'Thai revenue' }
        ],
        stemPatterns: [/^pendapatan/i, /^penjualan/i, /^omzet/i, /^revenue/i, /^sales/i, /^income/i]
    },
    
    DIRECT_COST: {
        category: 'Direct Costs',
        universalConcept: 'Cost of goods/services sold',
        priors: [
            { term: 'Upah Trip Supir', lang: 'id', confidence: 0.92, evidence: 'Driver trip compensation - direct labor' },
            { term: 'Upah Trip', lang: 'id', confidence: 0.90, evidence: 'Trip-based wages' },
            { term: 'Uang Makan Supir', lang: 'id', confidence: 0.88, evidence: 'Driver meal allowance' },
            { term: 'Uang Asam Trip', lang: 'id', confidence: 0.85, evidence: 'Trip acidic/misc allowance' },
            { term: 'Biaya BBM', lang: 'id', confidence: 0.92, evidence: 'Fuel cost - direct operational' },
            { term: 'Pemakaian BBM', lang: 'id', confidence: 0.90, evidence: 'Fuel consumption' },
            { term: 'By Pemakaian Ban', lang: 'id', confidence: 0.88, evidence: 'Tire usage cost' },
            { term: 'Pemeliharaan Alat Angkutan', lang: 'id', confidence: 0.85, evidence: 'Vehicle maintenance' },
            { term: 'HPP', lang: 'id', confidence: 0.95, evidence: 'Cost of goods sold (Harga Pokok Penjualan)' },
            { term: 'Gaji Supir Batangan', lang: 'id', confidence: 0.88, evidence: 'Fixed driver salary' },
            { term: 'Gaji Supir Serap', lang: 'id', confidence: 0.88, evidence: 'Variable driver salary' },
            { term: 'Insentif Supir', lang: 'id', confidence: 0.85, evidence: 'Driver incentives' },
            { term: 'By Bonus Trip', lang: 'id', confidence: 0.82, evidence: 'Trip bonus cost' },
            { term: 'Uang Standby', lang: 'id', confidence: 0.80, evidence: 'Standby allowance' },
            { term: '成本', lang: 'zh', confidence: 0.92, evidence: 'Chinese COGS/cost' },
            { term: '原価', lang: 'ja', confidence: 0.92, evidence: 'Japanese cost' },
            { term: '원가', lang: 'ko', confidence: 0.92, evidence: 'Korean cost' }
        ],
        stemPatterns: [/^upah/i, /^biaya\s*bbm/i, /^pemakaian/i, /^gaji\s*supir/i, /^hpp/i, /^cost\s*of/i, /^direct\s*cost/i]
    },
    
    OPERATING_EXPENSE: {
        category: 'Operating Expenses',
        universalConcept: 'General & administrative expenses',
        priors: [
            { term: 'Biaya Operasional', lang: 'id', confidence: 0.95, evidence: 'Operating expenses header' },
            { term: 'Asuransi Ongkos Angkut', lang: 'id', confidence: 0.85, evidence: 'Freight insurance' },
            { term: 'Retribusi Angkutan', lang: 'id', confidence: 0.85, evidence: 'Transport levy/fee' },
            { term: 'Perjalanan Dinas', lang: 'id', confidence: 0.88, evidence: 'Business travel' },
            { term: 'Pajak Kendaraan', lang: 'id', confidence: 0.90, evidence: 'Vehicle tax' },
            { term: 'Asuransi Alat Angkutan', lang: 'id', confidence: 0.88, evidence: 'Vehicle insurance' },
            { term: 'Tilang & Ganti Rugi', lang: 'id', confidence: 0.82, evidence: 'Fines and claims' },
            { term: 'Lain-Lain Angkutan', lang: 'id', confidence: 0.75, evidence: 'Other transport costs' },
            { term: 'Sewa Truck', lang: 'id', confidence: 0.85, evidence: 'Truck rental' },
            { term: 'Penyusutan', lang: 'id', confidence: 0.92, evidence: 'Depreciation' },
            { term: 'Beban', lang: 'id', confidence: 0.88, evidence: 'Expense/burden' },
            { term: 'Biaya', lang: 'id', confidence: 0.85, evidence: 'Cost/expense' },
            { term: '费用', lang: 'zh', confidence: 0.90, evidence: 'Chinese expense' },
            { term: '費用', lang: 'ja', confidence: 0.90, evidence: 'Japanese expense' },
            { term: '비용', lang: 'ko', confidence: 0.90, evidence: 'Korean expense' },
            { term: 'Gastos', lang: 'es', confidence: 0.90, evidence: 'Spanish expense' },
            { term: 'Charges', lang: 'fr', confidence: 0.90, evidence: 'French expense' },
            { term: 'Kosten', lang: 'de', confidence: 0.90, evidence: 'German expense' }
        ],
        stemPatterns: [/^biaya/i, /^beban/i, /^asuransi/i, /^pajak/i, /^sewa/i, /^penyusutan/i, /^expense/i, /^operating/i]
    },
    
    HO_COST: {
        category: 'Head Office Costs',
        universalConcept: 'Corporate overhead expenses',
        priors: [
            { term: 'Biaya Gaji dan Tunjangan HO', lang: 'id', confidence: 0.95, evidence: 'HO salary & allowances' },
            { term: 'Biaya Kantor HO', lang: 'id', confidence: 0.95, evidence: 'HO office expenses' },
            { term: 'Gaji Pegawai', lang: 'id', confidence: 0.90, evidence: 'Employee salary' },
            { term: 'Tunjangan Hari Raya', lang: 'id', confidence: 0.92, evidence: 'THR - holiday bonus' },
            { term: 'THR', lang: 'id', confidence: 0.92, evidence: 'Holiday allowance abbreviation' },
            { term: 'Tunjangan Perumahan', lang: 'id', confidence: 0.88, evidence: 'Housing allowance' },
            { term: 'Tunjangan Staf', lang: 'id', confidence: 0.88, evidence: 'Staff allowance' },
            { term: 'Tunjangan PPh 21', lang: 'id', confidence: 0.90, evidence: 'Income tax allowance' },
            { term: 'Jamsostek', lang: 'id', confidence: 0.92, evidence: 'Social security (BPJS)' },
            { term: 'BPJS', lang: 'id', confidence: 0.92, evidence: 'Indonesian social security' },
            { term: 'Tunjangan Beras', lang: 'id', confidence: 0.85, evidence: 'Rice allowance' },
            { term: 'Tunjangan Transport', lang: 'id', confidence: 0.88, evidence: 'Transport allowance' },
            { term: 'Premi & Lembur', lang: 'id', confidence: 0.85, evidence: 'Premium & overtime' },
            { term: 'Bonus / Insentif', lang: 'id', confidence: 0.85, evidence: 'Bonus/incentive' },
            { term: 'Pesangon & Pensiun', lang: 'id', confidence: 0.90, evidence: 'Severance & pension' },
            { term: 'Admin Bank', lang: 'id', confidence: 0.82, evidence: 'Bank fees' },
            { term: 'Listrik', lang: 'id', confidence: 0.88, evidence: 'Electricity' },
            { term: 'Telephone & Fax', lang: 'id', confidence: 0.85, evidence: 'Communication' },
            { term: 'Stationery & Materai', lang: 'id', confidence: 0.82, evidence: 'Office supplies' },
            { term: 'Jasa Profesi', lang: 'id', confidence: 0.85, evidence: 'Professional services' },
            { term: 'Biaya Sewa Poll', lang: 'id', confidence: 0.80, evidence: 'Depot/poll rental' },
            { term: 'Penyusutan Kantor', lang: 'id', confidence: 0.90, evidence: 'Office depreciation' }
        ],
        stemPatterns: [/^tunjangan/i, /^gaji\s*(pegawai|karyawan)/i, /^biaya\s*(kantor|gaji)/i, /^jamsostek/i, /^bpjs/i, /\bHO\b/i]
    },
    
    PROFIT_METRICS: {
        category: 'Profit & Metrics',
        universalConcept: 'Performance indicators',
        priors: [
            { term: 'Gross Profit', lang: 'en', confidence: 0.95, evidence: 'Standard GP' },
            { term: 'Gross Profit Setelah Ban & Perbaikan', lang: 'id', confidence: 0.92, evidence: 'GP after tire & repair' },
            { term: 'Gross Profit Setelah Biaya Operasional', lang: 'id', confidence: 0.92, evidence: 'GP after opex' },
            { term: 'Laba Operasional', lang: 'id', confidence: 0.95, evidence: 'Operating profit' },
            { term: 'EBIT', lang: 'en', confidence: 0.98, evidence: 'Earnings before interest & tax' },
            { term: 'EBITDA', lang: 'en', confidence: 0.98, evidence: 'Standard EBITDA' },
            { term: 'Laba sebelum PPh Badan', lang: 'id', confidence: 0.92, evidence: 'Pretax income' },
            { term: 'Pretax Inc', lang: 'en', confidence: 0.92, evidence: 'Pretax income abbrev' },
            { term: 'GP%', lang: 'en', confidence: 0.90, evidence: 'Gross profit margin' },
            { term: 'Laba', lang: 'id', confidence: 0.90, evidence: 'Profit' },
            { term: 'Rugi', lang: 'id', confidence: 0.88, evidence: 'Loss' },
            { term: 'Margin', lang: 'en', confidence: 0.85, evidence: 'Profit margin' },
            { term: '利润', lang: 'zh', confidence: 0.95, evidence: 'Chinese profit' },
            { term: '利益', lang: 'ja', confidence: 0.95, evidence: 'Japanese profit' },
            { term: '이익', lang: 'ko', confidence: 0.95, evidence: 'Korean profit' }
        ],
        stemPatterns: [/^(gross\s*)?profit/i, /^laba/i, /^ebit(da)?$/i, /^margin/i, /gp\s*%/i]
    },
    
    ASSET_LIABILITY: {
        category: 'Assets & Liabilities',
        universalConcept: 'Balance sheet items',
        priors: [
            { term: 'HK Aktif', lang: 'id', confidence: 0.85, evidence: 'Active working days/assets' },
            { term: 'Capex', lang: 'en', confidence: 0.95, evidence: 'Capital expenditure' },
            { term: 'Aset', lang: 'id', confidence: 0.92, evidence: 'Asset' },
            { term: 'Aktiva', lang: 'id', confidence: 0.92, evidence: 'Asset (Dutch loanword)' },
            { term: 'Utang', lang: 'id', confidence: 0.92, evidence: 'Debt/liability' },
            { term: 'Bunga Leasing', lang: 'id', confidence: 0.88, evidence: 'Lease interest' },
            { term: '资产', lang: 'zh', confidence: 0.92, evidence: 'Chinese asset' },
            { term: '負債', lang: 'ja', confidence: 0.92, evidence: 'Japanese liability' }
        ],
        stemPatterns: [/^aset/i, /^aktiva/i, /^capex/i, /^utang/i, /^asset/i, /^liability/i]
    },
    
    OPERATIONAL_METRICS: {
        category: 'Operational Metrics',
        universalConcept: 'Non-financial KPIs',
        priors: [
            { term: 'Total unit', lang: 'id', confidence: 0.88, evidence: 'Fleet count' },
            { term: 'Rasio Supir / Unit', lang: 'id', confidence: 0.85, evidence: 'Driver ratio' },
            { term: 'Total Supir', lang: 'id', confidence: 0.88, evidence: 'Driver headcount' },
            { term: 'HK 1 tahun', lang: 'id', confidence: 0.82, evidence: 'Working days per year' },
            { term: 'HK Libur', lang: 'id', confidence: 0.80, evidence: 'Holiday days' },
            { term: 'Total HK unit', lang: 'id', confidence: 0.82, evidence: 'Total working days per unit' },
            { term: 'Norma Trip', lang: 'id', confidence: 0.78, evidence: 'Trip norm/standard' },
            { term: 'Target Trip', lang: 'id', confidence: 0.80, evidence: 'Trip target' },
            { term: 'Target Km', lang: 'id', confidence: 0.80, evidence: 'KM target' },
            { term: 'Ton / Trip', lang: 'id', confidence: 0.82, evidence: 'Tonnage per trip' },
            { term: 'Km / HK', lang: 'id', confidence: 0.82, evidence: 'KM per working day' },
            { term: 'CE', lang: 'id', confidence: 0.70, evidence: 'Vehicle class (context needed)' },
            { term: 'CT', lang: 'id', confidence: 0.70, evidence: 'Vehicle class (context needed)' },
            { term: 'PE', lang: 'id', confidence: 0.70, evidence: 'Vehicle class (context needed)' },
            { term: 'PT', lang: 'id', confidence: 0.70, evidence: 'Vehicle class (context needed)' }
        ],
        stemPatterns: [/^total\s*(unit|supir)/i, /^rasio/i, /^target/i, /^norma/i, /\bHK\b/i, /\/\s*(trip|km|hk|kg)/i]
    },
    
    UNIT_ECONOMICS: {
        category: 'Unit Economics',
        universalConcept: 'Per-unit performance metrics',
        priors: [
            { term: 'Revenue / Unit', lang: 'en', confidence: 0.92, evidence: 'Revenue per unit' },
            { term: 'GP repair / Unit', lang: 'en', confidence: 0.88, evidence: 'GP per unit' },
            { term: 'Pretax Inc / Unit', lang: 'en', confidence: 0.88, evidence: 'Pretax per unit' },
            { term: 'Revenue / Trip', lang: 'en', confidence: 0.92, evidence: 'Revenue per trip' },
            { term: 'Revenue / kg', lang: 'en', confidence: 0.90, evidence: 'Revenue per kg' },
            { term: 'Revenue / km', lang: 'en', confidence: 0.90, evidence: 'Revenue per km' },
            { term: 'Revenue / HK', lang: 'en', confidence: 0.88, evidence: 'Revenue per working day' },
            { term: 'Rp/km cost', lang: 'id', confidence: 0.85, evidence: 'Cost per km' },
            { term: 'Rp/kg cost', lang: 'id', confidence: 0.85, evidence: 'Cost per kg' },
            { term: 'Rp/Trip cost', lang: 'id', confidence: 0.85, evidence: 'Cost per trip' },
            { term: 'Rp/HK cost', lang: 'id', confidence: 0.85, evidence: 'Cost per working day' },
            { term: 'Cost per km Supir', lang: 'id', confidence: 0.85, evidence: 'Driver cost per km' },
            { term: 'Ban & Perbaikan', lang: 'id', confidence: 0.82, evidence: 'Tire & repair combined' }
        ],
        stemPatterns: [/\/\s*(unit|trip|kg|km|hk)/i, /^rp\s*\//i, /per\s*(unit|trip)/i]
    }
};

function normalizeText(text) {
    if (!text) return '';
    return text.toString()
        .toLowerCase()
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return normalizeText(text).split(/[\s\/\-\(\)]+/).filter(t => t.length > 1);
}

function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b.charAt(i-1) === a.charAt(j-1) 
                ? matrix[i-1][j-1] 
                : Math.min(matrix[i-1][j-1]+1, matrix[i][j-1]+1, matrix[i-1][j]+1);
        }
    }
    return matrix[b.length][a.length];
}

function fuzzyMatch(text, prior, threshold = 0.7) {
    const normalizedText = normalizeText(text);
    const normalizedPrior = normalizeText(prior.term);
    
    if (normalizedText.includes(normalizedPrior)) {
        return { match: true, score: 1.0, type: 'exact' };
    }
    
    if (normalizedPrior.includes(normalizedText) && normalizedText.length >= 4) {
        return { match: true, score: 0.9, type: 'substring' };
    }
    
    const textTokens = tokenize(text);
    const priorTokens = tokenize(prior.term);
    
    let matchedTokens = 0;
    for (const pt of priorTokens) {
        for (const tt of textTokens) {
            if (tt.includes(pt) || pt.includes(tt)) {
                matchedTokens++;
                break;
            }
        }
    }
    
    if (priorTokens.length > 0 && matchedTokens / priorTokens.length >= 0.5) {
        const partialScore = 0.7 + (0.2 * matchedTokens / priorTokens.length);
        return { match: true, score: partialScore, type: 'partial' };
    }
    
    const maxLen = Math.max(normalizedText.length, normalizedPrior.length);
    if (maxLen > 0 && maxLen <= 30) {
        const dist = levenshteinDistance(normalizedText, normalizedPrior);
        const similarity = 1 - (dist / maxLen);
        if (similarity >= threshold) {
            return { match: true, score: similarity, type: 'fuzzy' };
        }
    }
    
    return { match: false, score: 0, type: 'none' };
}

function classifyTerm(text, contextHints = {}) {
    if (!text || typeof text !== 'string') {
        return { category: 'Unknown', confidence: 0, evidence: 'Empty input', source: 'none' };
    }
    
    const normalizedText = normalizeText(text);
    
    let bestMatch = null;
    let bestScore = 0;
    let matchedPrior = null;
    let matchedCategory = null;
    
    for (const [categoryKey, categoryData] of Object.entries(H0_TAXONOMY)) {
        if (categoryKey === '_meta') continue;
        
        for (const pattern of categoryData.stemPatterns || []) {
            if (pattern.test(normalizedText)) {
                const stemScore = 0.85;
                if (stemScore > bestScore) {
                    bestScore = stemScore;
                    matchedCategory = categoryData;
                    matchedPrior = { term: pattern.toString(), confidence: 0.85, evidence: 'Stem pattern match' };
                    bestMatch = { match: true, score: stemScore, type: 'stem' };
                }
            }
        }
        
        for (const prior of categoryData.priors) {
            const result = fuzzyMatch(text, prior);
            if (result.match) {
                const adjustedScore = result.score * prior.confidence;
                if (adjustedScore > bestScore) {
                    bestScore = adjustedScore;
                    matchedPrior = prior;
                    matchedCategory = categoryData;
                    bestMatch = result;
                }
            }
        }
    }
    
    if (bestMatch && matchedCategory && matchedPrior) {
        return {
            category: matchedCategory.category,
            universalConcept: matchedCategory.universalConcept,
            confidence: Math.round(bestScore * 100),
            matchType: bestMatch.type,
            matchedTerm: matchedPrior.term,
            evidence: matchedPrior.evidence,
            source: 'h0_taxonomy',
            falsifiable: true,
            contextOverride: contextHints.override || null
        };
    }
    
    return {
        category: 'Unclassified',
        universalConcept: null,
        confidence: 0,
        matchType: 'none',
        evidence: 'No prior matched - requires AI classification',
        source: 'none',
        falsifiable: true,
        requiresAIClassification: true
    };
}

function classifyBatch(terms) {
    return terms.map(term => ({
        original: term,
        classification: classifyTerm(term)
    }));
}

function detectHierarchy(rows) {
    const result = [];
    let currentSection = null;
    let sectionLevel = 0;
    let lastNonEmptyRowIndex = -1;
    let consecutiveEmptyRows = 0;
    
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const isEmpty = !row.label || row.label.trim() === '';
        
        if (isEmpty) {
            consecutiveEmptyRows++;
            if (consecutiveEmptyRows >= 1) {
                currentSection = null;
                sectionLevel = 0;
            }
            continue;
        }
        
        consecutiveEmptyRows = 0;
        
        const indent = row.indent || 0;
        const isBold = row.isBold || false;
        const label = row.label.trim();
        
        const looksLikeHeader = isBold || 
            label.match(/^(Biaya|Pendapatan|Gross|Laba|Total|Northstar|Hasil|Revenue)/i) ||
            (label.length < 40 && !row.values?.some(v => v !== null && v !== '' && !isNaN(parseFloat(v))));
        
        let hierarchyLevel = 1;
        
        if (looksLikeHeader && indent === 0) {
            hierarchyLevel = 0;
            currentSection = label;
            sectionLevel = 0;
        } else if (indent > 0) {
            hierarchyLevel = Math.min(indent + 1, 3);
        } else if (currentSection) {
            hierarchyLevel = 1;
        }
        
        const classification = classifyTerm(label);
        
        result.push({
            rowIndex: i,
            label: label,
            hierarchyLevel: hierarchyLevel,
            parentSection: currentSection,
            isSectionHeader: looksLikeHeader && hierarchyLevel === 0,
            indent: indent,
            isBold: isBold,
            values: row.values || [],
            columnHeaders: row.columnHeaders || [],
            classification: classification,
            gapBefore: i - lastNonEmptyRowIndex > 1
        });
        
        lastNonEmptyRowIndex = i;
    }
    
    return result;
}

function buildStructuredAccounts(hierarchicalRows) {
    const accounts = [];
    
    for (const row of hierarchicalRows) {
        if (row.isSectionHeader) continue;
        
        const valuesByPeriod = {};
        const headers = row.columnHeaders || [];
        
        (row.values || []).forEach((val, idx) => {
            if (val !== null && val !== '' && !isNaN(parseFloat(val))) {
                const header = headers[idx] || `col_${idx}`;
                const normalizedHeader = header.toString().toLowerCase();
                
                let periodKey = header;
                if (normalizedHeader.includes('budget') || normalizedHeader.includes('anggaran')) {
                    periodKey = 'budget';
                } else if (normalizedHeader.includes('actual') || normalizedHeader.includes('realisasi')) {
                    periodKey = 'actual';
                } else if (normalizedHeader.match(/20\d{2}/)) {
                    periodKey = normalizedHeader.match(/20\d{2}/)[0];
                }
                
                valuesByPeriod[periodKey] = parseFloat(val);
            }
        });
        
        accounts.push({
            label: row.label,
            normalizedLabel: normalizeText(row.label),
            category: row.classification.category,
            universalConcept: row.classification.universalConcept,
            hierarchyLevel: row.hierarchyLevel,
            parentSection: row.parentSection,
            valuesByPeriod: valuesByPeriod,
            confidence: row.classification.confidence,
            evidence: row.classification.evidence,
            matchType: row.classification.matchType,
            requiresAIClassification: row.classification.requiresAIClassification || false
        });
    }
    
    return accounts;
}

async function contextOverrideCheck(accounts, groqToken, model = 'llama-3.3-70b-versatile') {
    const lowConfidenceItems = accounts.filter(a => a.confidence < 70 || a.requiresAIClassification);
    
    if (lowConfidenceItems.length === 0) {
        return { overrides: [], checked: 0 };
    }
    
    const termsToCheck = lowConfidenceItems.slice(0, 20).map(a => ({
        label: a.label,
        currentCategory: a.category,
        currentConfidence: a.confidence,
        parentSection: a.parentSection
    }));
    
    const prompt = `You are reviewing Indonesian financial terms that need classification verification.

For each term, determine the correct category from: Revenue, Direct Costs, Operating Expenses, Head Office Costs, Profit & Metrics, Assets & Liabilities, Operational Metrics, Unit Economics

Terms to verify:
${JSON.stringify(termsToCheck, null, 2)}

Output JSON array with overrides only if the current classification is wrong:
[
  { "label": "...", "correctCategory": "...", "confidence": 85, "evidence": "why this is correct" }
]

If current classification is acceptable, return empty array [].
Be conservative - only override if confident the classification is wrong.`;

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'system', content: 'You are a multilingual financial analyst specializing in Indonesian accounting terminology. Output valid JSON only.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.15,
                max_tokens: 1500
            },
            {
                headers: {
                    'Authorization': `Bearer ${groqToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const content = response.data.choices[0]?.message?.content || '[]';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        
        if (jsonMatch) {
            try {
                const overrides = JSON.parse(jsonMatch[0]);
                return { overrides, checked: termsToCheck.length };
            } catch (e) {
                return { overrides: [], checked: termsToCheck.length, error: 'JSON parse failed' };
            }
        }
        
        return { overrides: [], checked: termsToCheck.length };
    } catch (error) {
        console.error('❌ Context override check failed:', error.message);
        return { overrides: [], checked: 0, error: error.message };
    }
}

function applyOverrides(accounts, overrides) {
    if (!overrides || overrides.length === 0) return accounts;
    
    const overrideMap = new Map(overrides.map(o => [normalizeText(o.label), o]));
    
    return accounts.map(account => {
        const override = overrideMap.get(account.normalizedLabel);
        if (override) {
            return {
                ...account,
                category: override.correctCategory,
                confidence: override.confidence,
                evidence: `[OVERRIDE] ${override.evidence}`,
                wasOverridden: true,
                originalCategory: account.category
            };
        }
        return account;
    });
}

module.exports = {
    H0_TAXONOMY,
    classifyTerm,
    classifyBatch,
    fuzzyMatch,
    normalizeText,
    tokenize,
    detectHierarchy,
    buildStructuredAccounts,
    contextOverrideCheck,
    applyOverrides
};
