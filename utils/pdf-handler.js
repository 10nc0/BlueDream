const fs = require('fs');
const path = require('path');
const os = require('os');

// Retry helper with exponential backoff for Groq API calls
async function groqWithRetry(axiosCall, maxRetries = 3) {
    const axios = require('axios');
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await axiosCall();
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            
            // Retry on 429 (rate limit) or 5xx (server errors)
            if ((status === 429 || status >= 500) && attempt < maxRetries) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
                console.log(`⏳ Groq ${status}: Retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

async function parsePDFHybrid(buffer, fileName) {
    const result = { 
        text: '', 
        tables: [], 
        charts: [],
        hasStructuredData: false,
        extractionMethod: 'text'
    };
    
    console.log(`📄 Hybrid PDF parser: Processing ${fileName}`);
    
    try {
        const { PDFParse, VerbosityLevel } = require('pdf-parse');
        const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
        const data = await parser.getText();
        result.text = data.text || '';
        console.log(`📄 Text extraction: ${result.text.length} chars`);
    } catch (textError) {
        console.log(`⚠️ Text extraction failed: ${textError.message}`);
    }
    
    try {
        const tables = await extractTablesWithTabula(buffer);
        if (tables && tables.length > 0) {
            result.tables = tables;
            result.hasStructuredData = true;
            result.extractionMethod = 'tables';
            console.log(`📊 Table extraction: ${tables.length} tables found`);
        }
    } catch (tableError) {
        console.log(`⚠️ Table extraction skipped: ${tableError.message}`);
    }
    
    return result;
}

async function extractTablesWithTabula(buffer) {
    const tables = [];
    const tempFile = path.join(os.tmpdir(), `pdf_${Date.now()}.pdf`);
    
    try {
        fs.writeFileSync(tempFile, buffer);
        
        const tabula = require('tabula-js');
        
        const data = await new Promise((resolve, reject) => {
            const t = tabula(tempFile, { pages: 'all' });
            t.extractCsv((err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });
        
        if (data && typeof data === 'string' && data.trim().length > 0) {
            const lines = data.trim().split('\n');
            if (lines.length > 1) {
                const tableData = lines.map(line => {
                    const cells = [];
                    let current = '';
                    let inQuotes = false;
                    
                    for (const char of line) {
                        if (char === '"') {
                            inQuotes = !inQuotes;
                        } else if (char === ',' && !inQuotes) {
                            cells.push(current.trim());
                            current = '';
                        } else {
                            current += char;
                        }
                    }
                    cells.push(current.trim());
                    return cells;
                });
                
                const markdown = tableToMarkdown(tableData);
                tables.push({
                    markdown: markdown,
                    rows: tableData.length,
                    cols: tableData[0]?.length || 0
                });
            }
        }
    } catch (e) {
        console.log(`⚠️ Tabula extraction error: ${e.message}`);
    } finally {
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (e) {}
    }
    
    return tables;
}

function tableToMarkdown(tableData) {
    if (!tableData || tableData.length === 0) return '';
    
    const rows = [];
    
    const header = tableData[0].map(cell => String(cell || '').trim());
    rows.push(`| ${header.join(' | ')} |`);
    rows.push(`| ${header.map(() => '---').join(' | ')} |`);
    
    for (let i = 1; i < tableData.length; i++) {
        const row = tableData[i].map(cell => String(cell || '').trim());
        while (row.length < header.length) row.push('');
        rows.push(`| ${row.join(' | ')} |`);
    }
    
    return rows.join('\n');
}

// VISUAL PDF ANALYSIS: Render pages as images and analyze with Groq Vision
// Unlocks chemical structures, charts, diagrams, and other visual content
// Uses pdftoppm (Poppler CLI) directly via child_process to bypass canvas bugs

async function renderPDFPagesToImages(buffer, options = { maxPages: 5 }) {
    const images = [];
    const { execSync } = require('child_process');
    
    // Create unique temp file paths
    const timestamp = Date.now();
    const tempPdfPath = path.join(os.tmpdir(), `nyan_pdf_${timestamp}.pdf`);
    const tempOutputPrefix = path.join(os.tmpdir(), `nyan_page_${timestamp}`);
    
    try {
        // Write buffer to temp file (pdftoppm needs file path)
        fs.writeFileSync(tempPdfPath, buffer);
        
        // Get page count using pdfinfo
        let totalPages = 1;
        try {
            const infoOutput = execSync(`pdfinfo "${tempPdfPath}" 2>/dev/null | grep "^Pages:" | awk '{print $2}'`, { encoding: 'utf8' });
            totalPages = parseInt(infoOutput.trim()) || 1;
        } catch (e) {
            console.log(`⚠️ pdfinfo failed, assuming 1 page`);
        }
        
        const pagesToRender = Math.min(totalPages, options.maxPages);
        console.log(`🖼️ PDF Poppler: Rendering ${pagesToRender}/${totalPages} pages...`);
        
        // Render pages to JPEG using pdftoppm
        // -jpeg: output format, -r 225: 225 DPI (high-res for atom clarity), -f/-l: first/last page
        const cmd = `pdftoppm -jpeg -r 225 -f 1 -l ${pagesToRender} "${tempPdfPath}" "${tempOutputPrefix}"`;
        execSync(cmd, { timeout: 30000 });
        
        // Load rendered images as base64
        for (let i = 1; i <= pagesToRender; i++) {
            // pdftoppm naming: prefix-1.jpg or prefix-01.jpg depending on page count
            const possibleNames = [
                `${tempOutputPrefix}-${i}.jpg`,
                `${tempOutputPrefix}-${String(i).padStart(2, '0')}.jpg`,
                `${tempOutputPrefix}-${String(i).padStart(3, '0')}.jpg`
            ];
            
            let imgPath = null;
            for (const name of possibleNames) {
                if (fs.existsSync(name)) {
                    imgPath = name;
                    break;
                }
            }
            
            if (imgPath) {
                const imgBuffer = fs.readFileSync(imgPath);
                const base64 = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
                
                images.push({
                    page: i,
                    base64: base64,
                    width: 0,
                    height: 0
                });
                
                // Cleanup temp image
                try { fs.unlinkSync(imgPath); } catch (e) {}
                
                console.log(`  📄 Page ${i}: rendered (JPEG)`);
            } else {
                console.log(`  ⚠️ Page ${i}: output file not found`);
            }
        }
        
        console.log(`🖼️ PDF Poppler: ${images.length} pages rendered successfully`);
    } catch (error) {
        console.error(`❌ PDF Poppler: Rendering failed - ${error.message}`);
    } finally {
        // Cleanup temp PDF
        try { if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); } catch (e) {}
    }
    
    return images;
}

async function analyzePageWithGroqVision(imageBase64, pageNum, GROQ_TOKEN) {
    if (!GROQ_TOKEN) {
        return { success: false, error: 'Groq Vision token not configured' };
    }
    
    try {
        const axios = require('axios');
        
        // Extract base64 data (remove data:image/jpeg;base64, prefix)
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        
        // Use retry wrapper for resilient API calls
        const response = await groqWithRetry(() => axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Page ${pageNum}: Detailed chemical structure analysis. CRITICAL ATOM COUNTING RULES:

=== MOLECULAR FORMULA + COMMON NAME (Most Important) ===
1. Count EVERY atom separately. Final formula: "CxHyOzNw..." with exact counts.
2. If you recognize this compound, also provide its COMMON/KNOWN NAME (e.g., aspirin, caffeine, THC, morphine, etc.)
3. Format output: "Molecular Formula: C21H30O2" and "Known as: [name if recognized, or 'unknown' if not]"

FUSED RING SYSTEMS - KEY RULE:
- At ring fusion points, carbons are SHARED - count them ONCE, not twice
- Example: Naphthalene (2 fused benzene): 10 unique carbons (not 6+6=12)
- Example: THC (benzene + cyclohexene + pyran fused): Count shared carbons at junction once
- Tricyclic: If 3 rings share carbons, mark fusion points and count unique carbons only

STEP-BY-STEP ATOM COUNTING:
1. Identify all rings and their fusion points
2. Mark each unique carbon vertex (don't double-count)
3. Count hydrogens: Each unsubstituted carbon has H (valence rule)
4. Identify heteroatoms (O, N, S) and their substitution pattern
5. Sum: Total C + Total H + Total O + Total N... = Formula

RING IDENTIFICATION:
- Benzene (6C aromatic)
- Pyran (5C + 1O heterocycle)
- Furan/Thiophene (4C + 1X heterocycle)
- Cyclohexane/Cyclohexene (6C saturated/unsaturated)
- Cyclopentanone (5C + 1O ketone ring)
- Quinoline/Isoquinoline (bicyclic aromatic)

FUNCTIONAL GROUPS: OH, NH, C=O, C=C, ethers, esters, alkyl chains
STEREOCHEMISTRY: Wedge/dash bonds, double bond cis/trans
CHARTS/GRAPHS: axes, legend, data points
TABLES: Headers and row data

VERIFICATION: After counting, verify by recount. If complex tricyclic, explain ring fusion clearly.`
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.15,
                max_tokens: 1000
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        ));
        
        const description = response.data.choices[0]?.message?.content || '';
        
        // Classify visual content type
        const lower = description.toLowerCase();
        let contentType = 'general';
        if (lower.includes('chemical') || lower.includes('molecule') || 
            lower.includes('structure') || lower.includes('formula') ||
            lower.includes('benzene') || lower.includes('reaction')) {
            contentType = 'chemical';
        } else if (lower.includes('chart') || lower.includes('graph') || 
                   lower.includes('bar') || lower.includes('line') || lower.includes('pie')) {
            contentType = 'chart';
        } else if (lower.includes('diagram') || lower.includes('flowchart') || 
                   lower.includes('schematic')) {
            contentType = 'diagram';
        }
        
        // Confidence scoring based on response quality
        let confidence = 0.95;  // Default high confidence
        if (lower.includes('unclear') || lower.includes('cannot') || 
            description.length < 100) {
          confidence = 0.7;  // Lower confidence for uncertain/brief responses
        }
        
        return {
            success: true,
            data: {
                page: pageNum,
                description: description,
                contentType: contentType,
                confidence: confidence
            }
        };
    } catch (error) {
        console.error(`❌ Vision API error (page ${pageNum}):`, error.message);
        return { success: false, error: error.message };
    }
}

async function analyzePDFVisualContent(buffer, fileName, options = {}) {
    const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN;
    
    if (!PLAYGROUND_GROQ_VISION_TOKEN) {
        console.log('⚠️ PLAYGROUND_GROQ_VISION_TOKEN not configured - skipping PDF visual analysis');
        return { success: false, error: 'Vision token not configured', visualContent: [] };
    }
    
    const maxPages = options.maxPages || 5;
    const result = {
        success: false,
        visualContent: [],
        charts: [],
        chemicalStructures: [],
        diagrams: []
    };
    
    try {
        console.log(`🔬 PDF Visual: Analyzing ${fileName} for charts, structures, diagrams...`);
        
        // Render PDF pages to images
        const images = await renderPDFPagesToImages(buffer, { maxPages });
        
        if (images.length === 0) {
            return { success: false, error: 'No pages rendered', visualContent: [] };
        }
        
        // Analyze each page with Groq Vision (sequentially to respect rate limits)
        for (const img of images) {
            const analysis = await analyzePageWithGroqVision(
                img.base64, 
                img.page, 
                PLAYGROUND_GROQ_VISION_TOKEN
            );
            
            if (analysis.success) {
                result.visualContent.push(analysis.data);
                
                // Categorize by content type
                switch (analysis.data.contentType) {
                    case 'chemical':
                        result.chemicalStructures.push(analysis.data);
                        break;
                    case 'chart':
                        result.charts.push(analysis.data);
                        break;
                    case 'diagram':
                        result.diagrams.push(analysis.data);
                        break;
                }
            }
        }
        
        result.success = result.visualContent.length > 0;
        
        console.log(`🔬 PDF Visual: Found ${result.charts.length} charts, ${result.chemicalStructures.length} chemical structures, ${result.diagrams.length} diagrams`);
        
    } catch (error) {
        console.error(`❌ PDF Visual analysis failed: ${error.message}`);
        result.error = error.message;
    }
    
    return result;
}

module.exports = {
    parsePDFHybrid,
    extractTablesWithTabula,
    renderPDFPagesToImages,
    analyzePageWithGroqVision,
    analyzePDFVisualContent,
    groqWithRetry
};
