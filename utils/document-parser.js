const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');

// Handle different export patterns of pdf-parse
const pdf = pdfParse.default || pdfParse;

const MAX_TOKENS = 6000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

async function extractTextFromDocument(base64Data, fileName) {
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = (fileName || '').toLowerCase().split('.').pop();
    
    console.log(`📄 Document parser: Processing ${fileName} (${ext})`);
    
    try {
        let text = '';
        
        if (ext === 'pdf') {
            text = await extractPDF(buffer);
        } else if (['xlsx', 'xls'].includes(ext)) {
            text = await extractExcel(buffer, ext);
        } else if (ext === 'docx') {
            text = await extractWord(buffer);
        } else if (ext === 'doc') {
            throw new Error('Legacy .doc format is not supported. Please convert to .docx or PDF first.');
        } else if (['txt', 'md', 'csv'].includes(ext)) {
            text = buffer.toString('utf-8');
        } else {
            text = buffer.toString('utf-8');
        }
        
        const truncated = truncateToTokenLimit(text, fileName);
        console.log(`📄 Extracted ${text.length} chars → ${truncated.length} chars (after truncation)`);
        
        return truncated;
        
    } catch (error) {
        console.error(`❌ Document parsing error for ${fileName}:`, error.message);
        throw new Error(`Failed to parse ${ext.toUpperCase()} file: ${error.message}`);
    }
}

async function extractPDF(buffer) {
    const data = await pdf(buffer);
    return data.text || '';
}

async function extractExcel(buffer, ext) {
    const workbook = new ExcelJS.Workbook();
    
    if (ext === 'xlsx') {
        await workbook.xlsx.load(buffer);
    } else {
        try {
            await workbook.xlsx.load(buffer);
        } catch (e) {
            throw new Error('Legacy .xls format may not be fully supported. Please convert to .xlsx');
        }
    }
    
    const sheets = [];
    
    workbook.eachSheet((sheet, sheetId) => {
        const rows = [];
        rows.push(`\n### Sheet: ${sheet.name}\n`);
        
        const columnCount = sheet.actualColumnCount || sheet.columnCount || 1;
        let headerRow = [];
        
        sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
            const values = [];
            for (let col = 1; col <= columnCount; col++) {
                const cell = row.getCell(col);
                let value = '';
                
                if (cell.value === null || cell.value === undefined) {
                    value = '';
                } else if (typeof cell.value === 'object') {
                    if (cell.value.text) {
                        value = cell.value.text;
                    } else if (cell.value.result !== undefined) {
                        value = String(cell.value.result);
                    } else if (cell.value.formula && cell.result !== undefined) {
                        value = String(cell.result);
                    } else {
                        value = String(cell.text || cell.value);
                    }
                } else {
                    value = String(cell.value);
                }
                
                value = value.replace(/\|/g, '¦').replace(/\n/g, ' ');
                values.push(value);
            }
            
            if (rowNum === 1) {
                headerRow = values;
                rows.push(`| ${values.join(' | ')} |`);
                rows.push(`| ${values.map(() => '---').join(' | ')} |`);
            } else {
                while (values.length < headerRow.length) {
                    values.push('');
                }
                rows.push(`| ${values.join(' | ')} |`);
            }
        });
        
        sheets.push(rows.join('\n'));
    });
    
    return sheets.join('\n\n');
}

async function extractWord(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
}

function truncateToTokenLimit(text, fileName) {
    if (!text || text.length <= MAX_CHARS) {
        return text;
    }
    
    const truncated = text.substring(0, MAX_CHARS);
    const lastParagraph = truncated.lastIndexOf('\n\n');
    const lastSentence = truncated.lastIndexOf('. ');
    
    let cutPoint = MAX_CHARS;
    if (lastParagraph > MAX_CHARS * 0.8) {
        cutPoint = lastParagraph;
    } else if (lastSentence > MAX_CHARS * 0.8) {
        cutPoint = lastSentence + 1;
    }
    
    return truncated.substring(0, cutPoint) + 
           `\n\n[Document truncated - showing first ~${MAX_TOKENS} tokens of ${Math.round(text.length / CHARS_PER_TOKEN)} total tokens]`;
}

function getDocumentPrompt(documentText, fileName, userQuery) {
    return `📄 **Document: ${fileName}**

---
${documentText}
---

**User Query:** ${userQuery || 'Analyze this document and provide key insights.'}

Provide helpful analysis based on the document content above. If the document contains data, summarize key findings. If it's text, extract main points. Be specific and cite relevant sections.`;
}

module.exports = {
    extractTextFromDocument,
    getDocumentPrompt,
    MAX_TOKENS
};
