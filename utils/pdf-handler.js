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
    formatPDFResultForPrompt
};
