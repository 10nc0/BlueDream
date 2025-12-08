const fs = require('fs');
const path = require('path');
const os = require('os');

const PLAYGROUND_HF_VISION_TOKEN = process.env.PLAYGROUND_HF_VISION_TOKEN;

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

async function describeChartWithVision(imageBase64) {
    if (!PLAYGROUND_HF_VISION_TOKEN) {
        console.log('⚠️ Vision token not configured, skipping chart description');
        return null;
    }
    
    try {
        const axios = require('axios');
        const response = await axios.post(
            'https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct',
            {
                inputs: {
                    image: imageBase64,
                    text: "Describe this chart exactly. Extract: title, axes labels, data values, trends. Be factual and precise."
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${PLAYGROUND_HF_VISION_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        if (response.data && response.data[0]?.generated_text) {
            return response.data[0].generated_text;
        }
        return null;
    } catch (error) {
        console.error('Vision API error:', error.message);
        return null;
    }
}

// VISUAL PDF ANALYSIS: Render pages as images and analyze with Groq Vision
// Unlocks chemical structures, charts, diagrams, and other visual content

async function renderPDFPagesToImages(buffer, options = { maxPages: 5 }) {
    const images = [];
    
    try {
        // Dynamic import for ESM module compatibility
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const { createCanvas } = require('canvas');
        
        // Load PDF document
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;
        const pagesToRender = Math.min(totalPages, options.maxPages);
        
        console.log(`🖼️ PDF Visual: Rendering ${pagesToRender}/${totalPages} pages...`);
        
        for (let i = 1; i <= pagesToRender; i++) {
            try {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 2.0 }); // High-res for vision
                
                const canvas = createCanvas(viewport.width, viewport.height);
                const context = canvas.getContext('2d');
                
                // Render page to canvas
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;
                
                // Convert to base64 JPEG (smaller than PNG)
                const base64 = canvas.toDataURL('image/jpeg', 0.85);
                images.push({
                    page: i,
                    base64: base64,
                    width: viewport.width,
                    height: viewport.height
                });
                
                console.log(`  📄 Page ${i}: ${viewport.width}x${viewport.height}px rendered`);
            } catch (pageError) {
                console.log(`  ⚠️ Page ${i} render failed: ${pageError.message}`);
            }
        }
        
        console.log(`🖼️ PDF Visual: ${images.length} pages rendered successfully`);
    } catch (error) {
        console.error(`❌ PDF Visual: Rendering failed - ${error.message}`);
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
        
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Page ${pageNum}: Analyze this PDF page. Describe all visual elements:
- Charts/graphs: type, axes, data points, trends
- Chemical structures: molecules, formulas, reaction schemes
- Diagrams: flowcharts, schematics, illustrations
- Tables: if visible, extract key data
- Equations: mathematical or chemical formulas
Be factual and precise. Extract exact values where visible.`
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
        );
        
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
        
        return {
            success: true,
            data: {
                page: pageNum,
                description: description,
                contentType: contentType
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

function formatPDFResultForPrompt(result, fileName, userQuery) {
    const sections = [];
    
    sections.push(`📄 **Document: ${fileName}**\n`);
    
    if (result.tables.length > 0) {
        sections.push('### Tables Found:\n');
        result.tables.forEach((table, i) => {
            sections.push(`**Table ${i + 1}** (${table.rows} rows × ${table.cols} columns):`);
            sections.push(table.markdown);
            sections.push('');
        });
    }
    
    if (result.text && result.text.trim().length > 0) {
        sections.push('### Document Text:\n');
        const truncatedText = result.text.length > 4000 
            ? result.text.substring(0, 4000) + '\n[...truncated...]'
            : result.text;
        sections.push(truncatedText);
    }
    
    if (result.charts.length > 0) {
        sections.push('\n### Charts/Graphs:\n');
        result.charts.forEach((chart, i) => {
            sections.push(`**Chart ${i + 1}:** ${chart}`);
        });
    }
    
    sections.push(`\n---\n**User Query:** ${userQuery || 'Analyze this document and provide key insights.'}`);
    sections.push('\nProvide specific answers based on the document content above. For tables, reference exact cell values. Be precise and cite data points.');
    
    return sections.join('\n');
}

module.exports = {
    parsePDFHybrid,
    extractTablesWithTabula,
    describeChartWithVision,
    formatPDFResultForPrompt,
    renderPDFPagesToImages,
    analyzePageWithGroqVision,
    analyzePDFVisualContent
};
