const axios = require('axios');

const MULTILINGUAL_ACCOUNTING_MAPPING = `
UNIVERSAL ACCOUNTING CONCEPT MAPPING (Auto-detect language):

Your task: Map local accounting terminology to universal concepts.
Be aggressive with synonyms and regional variations.

REVENUE CONCEPTS (map these to "Revenue"):
- Indonesian: Pendapatan, Penjualan, Omzet, Pendapatan Net Klaim, Pendapatan Net PPN, Pemasukan
- Chinese: 收入, 营收, 销售收入, 营业收入, 總收入
- Japanese: 売上, 収益, 売上高, 営業収益
- Korean: 매출, 수익, 영업수익
- Spanish: Ingresos, Ventas, Facturación
- French: Revenus, Chiffre d'affaires, Ventes
- German: Umsatz, Einnahmen, Erlöse
- Arabic: إيرادات, مبيعات, دخل
- Portuguese: Receita, Faturamento, Vendas
- Thai: รายได้, ยอดขาย

EXPENSE/COST CONCEPTS (map these to "Operating Expenses"):
- Indonesian: Beban, Biaya, Pengeluaran, Cost, Expense, HPP
- Chinese: 费用, 成本, 支出, 运营成本
- Japanese: 費用, コスト, 経費, 営業費用
- Korean: 비용, 원가, 경비
- Spanish: Gastos, Costos, Costes
- French: Charges, Coûts, Dépenses
- German: Kosten, Aufwand, Ausgaben
- Arabic: مصاريف, تكاليف, نفقات
- Portuguese: Despesas, Custos, Gastos
- Thai: ค่าใช้จ่าย, ต้นทุน

PROFIT CONCEPTS (map these to "Profit"):
- Indonesian: Laba, Keuntungan, Laba Bersih, Laba sebelum PPh, EBITDA
- Chinese: 利润, 净利润, 毛利, 营业利润
- Japanese: 利益, 純利益, 営業利益
- Korean: 이익, 순이익, 영업이익
- Spanish: Beneficio, Ganancia, Utilidad
- French: Bénéfice, Profit, Résultat
- German: Gewinn, Profit, Ergebnis
- Arabic: ربح, أرباح, صافي الربح
- Portuguese: Lucro, Resultado, Ganho
- Thai: กำไร, ผลกำไร

COMPENSATION/PAYROLL CONCEPTS:
- Indonesian: Upah Trip, Gaji, Insentif, Total Bulanan Supir
- Chinese: 工资, 薪酬, 奖金, 津贴
- Japanese: 給与, 賃金, 報酬, 手当
- Korean: 급여, 임금, 보너스
- Spanish: Salario, Sueldo, Nómina
- French: Salaire, Rémunération, Paie
- German: Gehalt, Lohn, Vergütung
- Arabic: راتب, أجر, مكافأة
- Portuguese: Salário, Remuneração, Folha
- Thai: เงินเดือน, ค่าจ้าง

ASSET CONCEPTS:
- Indonesian: Aset, Harta, Aktiva
- Chinese: 资产, 固定资产, 流动资产
- Japanese: 資産, 固定資産, 流動資産
- Korean: 자산, 고정자산, 유동자산
- Spanish: Activos, Bienes
- French: Actifs, Biens
- German: Vermögen, Aktiva
- Arabic: أصول, موجودات
- Portuguese: Ativos, Bens
- Thai: สินทรัพย์

LIABILITY CONCEPTS:
- Indonesian: Kewajiban, Utang, Liabilitas
- Chinese: 负债, 债务, 应付款
- Japanese: 負債, 借入金, 債務
- Korean: 부채, 채무
- Spanish: Pasivos, Deudas, Obligaciones
- French: Passifs, Dettes
- German: Verbindlichkeiten, Schulden
- Arabic: التزامات, ديون, مطلوبات
- Portuguese: Passivos, Dívidas
- Thai: หนี้สิน

For ANY non-English term that appears financial, attempt to classify it into:
Revenue, Expenses, Profit, Assets, Liabilities, Equity, Compensation, Tax, or Other
`;

const SUBJECT_OBJECT_PRESERVATION = `
ONTOLOGICAL PURITY: Subject vs Object Preservation

CRITICAL: Never conflate WHO with WHAT is paid.

SUBJECTS (living beings - use these as category qualifiers):
- Workers: Driver, Supir, 司机, 運転手, Employee, Staff, Mekanik, Mechanic
- Entities: Company, Vendor, Client, Customer, Supplier

OBJECTS (money flows - describe what the payment IS FOR):
- "Upah Trip" → "Trip-based compensation" (not "Driver wages")
- "Driver Salary" → "Driver compensation expense" 
- "Gaji Bulanan" → "Monthly salary expense"

RULE: When you see "Driver + money term", output:
"Driver [compensation/payment/expense]" - preserving that a PERSON receives it

WRONG: "Upah" → "Driver"
RIGHT: "Upah Trip Supir" → "Driver trip compensation (cost)"
`;

const FINANCIAL_DETECTION_PATTERNS = [
    /pendapatan|penjualan|beban|biaya|laba|rugi|omzet/i,
    /revenue|expense|profit|loss|income|cost|margin/i,
    /收入|费用|利润|成本|销售|支出/,
    /売上|費用|利益|原価|収益/,
    /매출|비용|이익|원가|수익/,
    /ingresos|gastos|beneficio|costos|ventas/i,
    /revenus|charges|bénéfice|coûts|ventes/i,
    /umsatz|kosten|gewinn|einnahmen|ausgaben/i,
    /إيرادات|مصاريف|ربح|تكاليف/,
    /receita|despesas|lucro|custos|vendas/i,
    /รายได้|ค่าใช้จ่าย|กำไร|ต้นทุน/,
    /budget|anggaran|预算|予算|예산|presupuesto|budget/i,
    /balance.*sheet|neraca|资产负债|貸借対照表|대차대조표/i,
    /p\&l|profit.*loss|laba.*rugi|损益|損益/i,
];

function isFinancialContent(text) {
    if (!text || typeof text !== 'string') return false;
    const normalizedText = text.toLowerCase();
    
    for (const pattern of FINANCIAL_DETECTION_PATTERNS) {
        if (pattern.test(normalizedText)) {
            return true;
        }
    }
    return false;
}

function detectFinancialDocument(extractedData) {
    if (!extractedData) return { isFinancial: false };
    
    let textToCheck = '';
    
    if (extractedData.tables && Array.isArray(extractedData.tables)) {
        for (const table of extractedData.tables) {
            if (table.headers) textToCheck += ' ' + table.headers.join(' ');
            if (table.rows) {
                for (const row of table.rows.slice(0, 10)) {
                    textToCheck += ' ' + row.join(' ');
                }
            }
        }
    }
    
    if (extractedData.text) {
        textToCheck += ' ' + extractedData.text.substring(0, 5000);
    }
    
    const isFinancial = isFinancialContent(textToCheck);
    
    let detectedLanguage = 'unknown';
    if (/[\u4e00-\u9fff]/.test(textToCheck)) detectedLanguage = 'chinese';
    else if (/[\u3040-\u30ff]/.test(textToCheck)) detectedLanguage = 'japanese';
    else if (/[\uac00-\ud7af]/.test(textToCheck)) detectedLanguage = 'korean';
    else if (/[\u0600-\u06ff]/.test(textToCheck)) detectedLanguage = 'arabic';
    else if (/[\u0e00-\u0e7f]/.test(textToCheck)) detectedLanguage = 'thai';
    else if (/pendapatan|biaya|laba|beban/i.test(textToCheck)) detectedLanguage = 'indonesian';
    else if (/ingresos|gastos|beneficio/i.test(textToCheck)) detectedLanguage = 'spanish';
    else if (/revenus|charges|bénéfice/i.test(textToCheck)) detectedLanguage = 'french';
    else if (/umsatz|kosten|gewinn/i.test(textToCheck)) detectedLanguage = 'german';
    else if (/receita|despesas|lucro/i.test(textToCheck)) detectedLanguage = 'portuguese';
    else if (/revenue|expense|profit/i.test(textToCheck)) detectedLanguage = 'english';
    
    return {
        isFinancial,
        detectedLanguage,
        sampleText: textToCheck.substring(0, 500)
    };
}

async function stage0Internalize(rawData, groqToken, model = 'llama-3.3-70b-versatile') {
    const prompt = `${MULTILINGUAL_ACCOUNTING_MAPPING}

${SUBJECT_OBJECT_PRESERVATION}

You are an experienced multilingual CFO reviewing a real-world financial document.
Your task is to INTERNALIZE this data by mapping all local terminology to universal accounting concepts.

RAW DATA:
${typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2)}

OUTPUT FORMAT (JSON):
{
    "detected_language": "indonesian|chinese|japanese|korean|spanish|french|german|arabic|portuguese|thai|other",
    "document_type": "budget|income_statement|balance_sheet|cash_flow|invoice|other",
    "mapped_concepts": [
        {
            "original_term": "Pendapatan Net Klaim",
            "universal_concept": "Revenue",
            "category": "income",
            "confidence": 0.95
        }
    ],
    "financial_summary": {
        "revenue_lines": ["line items identified as revenue"],
        "expense_lines": ["line items identified as expenses"],
        "profit_lines": ["line items identified as profit/loss"],
        "other_lines": ["unclassified but potentially important"]
    },
    "subject_entities": ["Driver", "Vendor", "Company"],
    "overall_confidence": 0.85
}

Be AGGRESSIVE with synonym matching. If it looks financial, classify it.
Map messy real-world labels to clean universal concepts.`;

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'system', content: 'You are a multilingual financial analyst. Output valid JSON only.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 2000
            },
            {
                headers: {
                    'Authorization': `Bearer ${groqToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const content = response.data.choices[0]?.message?.content || '{}';
        
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (parseErr) {
                console.log('⚠️ Stage 0: JSON parse failed, returning raw');
                return { raw_content: content, overall_confidence: 0.5 };
            }
        }
        
        return { raw_content: content, overall_confidence: 0.5 };
    } catch (error) {
        console.error('❌ Stage 0 internalization error:', error.message);
        return { error: error.message, overall_confidence: 0 };
    }
}

function stage1SemanticMap(internalizedData) {
    if (!internalizedData || internalizedData.error) {
        return {
            success: false,
            confidence: 0,
            error: internalizedData?.error || 'No internalized data'
        };
    }

    const mappedConcepts = internalizedData.mapped_concepts || [];
    const avgConfidence = mappedConcepts.length > 0
        ? mappedConcepts.reduce((sum, c) => sum + (c.confidence || 0), 0) / mappedConcepts.length
        : internalizedData.overall_confidence || 0.5;

    const subjectEntities = internalizedData.subject_entities || [];
    const compensationLines = mappedConcepts.filter(c => 
        c.universal_concept?.toLowerCase().includes('compensation') ||
        c.original_term?.toLowerCase().includes('upah') ||
        c.original_term?.toLowerCase().includes('gaji') ||
        c.original_term?.includes('工资') ||
        c.original_term?.includes('給与')
    );
    
    for (const comp of compensationLines) {
        const hasSubjectContext = subjectEntities.some(s => 
            comp.original_term?.toLowerCase().includes(s.toLowerCase())
        );
        if (hasSubjectContext) {
            comp.subject_preserved = true;
            comp.note = `Compensation flow TO ${subjectEntities.find(s => comp.original_term?.toLowerCase().includes(s.toLowerCase())) || 'entity'}`;
        }
    }

    return {
        success: true,
        confidence: avgConfidence * 100,
        language: internalizedData.detected_language,
        documentType: internalizedData.document_type,
        mappedConcepts,
        financialSummary: internalizedData.financial_summary,
        subjectEntities,
        needsClarification: avgConfidence < 0.7,
        internalizedContext: internalizedData
    };
}

async function stage2Reason(semanticMap, userQuestion, nyanProtocolPrompt, groqToken, model = 'llama-3.3-70b-versatile') {
    const contextSummary = `
INTERNALIZED FINANCIAL CONTEXT:
- Language: ${semanticMap.language || 'auto-detected'}
- Document Type: ${semanticMap.documentType || 'financial'}
- Confidence: ${semanticMap.confidence?.toFixed(1)}%

MAPPED CONCEPTS:
${(semanticMap.mappedConcepts || []).map(c => 
    `• "${c.original_term}" → ${c.universal_concept} (${(c.confidence * 100).toFixed(0)}%)`
).join('\n')}

FINANCIAL SUMMARY:
${semanticMap.financialSummary ? JSON.stringify(semanticMap.financialSummary, null, 2) : 'See mapped concepts above'}

SUBJECT ENTITIES (living beings in this document):
${(semanticMap.subjectEntities || []).join(', ') || 'None explicitly identified'}
`;

    const finalPrompt = `${nyanProtocolPrompt}

${contextSummary}

USER QUESTION:
${userQuestion}

Answer with H₀ purity. No hallucination. Cite specific line items from the document.
If confidence is low, acknowledge uncertainty but still provide the best interpretation.`;

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'system', content: nyanProtocolPrompt },
                    { role: 'user', content: finalPrompt }
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

        return {
            success: true,
            response: response.data.choices[0]?.message?.content || 'No response generated.',
            tokensUsed: response.data.usage?.total_tokens || 0
        };
    } catch (error) {
        console.error('❌ Stage 2 reasoning error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

async function selfHealClarify(semanticMap, groqToken, model = 'llama-3.3-70b-versatile') {
    const lowConfidenceConcepts = (semanticMap.mappedConcepts || [])
        .filter(c => (c.confidence || 0) < 0.7)
        .map(c => c.original_term);

    if (lowConfidenceConcepts.length === 0) {
        return { needed: false };
    }

    const prompt = `You are reviewing a ${semanticMap.language || 'non-English'} financial document.
These terms had low confidence mapping:
${lowConfidenceConcepts.join('\n')}

For EACH term, provide:
1. Most likely universal accounting category
2. Alternative interpretations
3. Context clues that would disambiguate

Be AGGRESSIVE with synonyms. Think like a local accountant who has seen thousands of documents.
Output as JSON array.`;

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 1000
            },
            {
                headers: {
                    'Authorization': `Bearer ${groqToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        return {
            needed: true,
            clarifications: response.data.choices[0]?.message?.content || '',
            termsAnalyzed: lowConfidenceConcepts.length
        };
    } catch (error) {
        console.error('❌ Self-heal clarification error:', error.message);
        return { needed: true, error: error.message };
    }
}

async function processFinancialDocument(rawData, userQuestion, nyanProtocolPrompt, groqToken) {
    console.log('🌐 Stage 0: Internalizing multilingual financial data (temp 0.3)...');
    const internalized = await stage0Internalize(rawData, groqToken);
    
    console.log(`📊 Stage 1: Semantic mapping (deterministic)...`);
    const semanticMap = stage1SemanticMap(internalized);
    console.log(`   Confidence: ${semanticMap.confidence?.toFixed(1)}%, Language: ${semanticMap.language}`);
    
    if (semanticMap.needsClarification) {
        console.log('🔧 Self-healing: Low confidence detected, running clarification...');
        const clarification = await selfHealClarify(semanticMap, groqToken);
        if (clarification.needed && clarification.clarifications) {
            semanticMap.selfHealData = clarification;
        }
    }
    
    console.log('🎯 Stage 2: H₀ reasoning (temp 0.15)...');
    const result = await stage2Reason(semanticMap, userQuestion, nyanProtocolPrompt, groqToken);
    
    return {
        ...result,
        pipeline: {
            internalized: internalized,
            semanticMap: semanticMap,
            selfHealed: semanticMap.needsClarification
        }
    };
}

module.exports = {
    detectFinancialDocument,
    isFinancialContent,
    processFinancialDocument,
    stage0Internalize,
    stage1SemanticMap,
    stage2Reason,
    selfHealClarify,
    MULTILINGUAL_ACCOUNTING_MAPPING,
    SUBJECT_OBJECT_PRESERVATION
};
