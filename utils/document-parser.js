const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');

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
            text = await extractExcel(buffer);
        } else if (['docx', 'doc'].includes(ext)) {
            text = await extractWord(buffer);
        } else if (['txt', 'md', 'rtf'].includes(ext)) {
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
    const data = await pdfParse(buffer);
    return data.text || '';
}

async function extractExcel(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    
    const sheets = [];
    
    workbook.eachSheet((sheet, sheetId) => {
        const rows = [];
        rows.push(`\n### Sheet: ${sheet.name}\n`);
        
        let headers = [];
        sheet.eachRow((row, rowNum) => {
            const values = row.values.slice(1).map(v => {
                if (v === null || v === undefined) return '';
                if (typeof v === 'object' && v.text) return v.text;
                if (typeof v === 'object' && v.result !== undefined) return v.result;
                return String(v);
            });
            
            if (rowNum === 1) {
                headers = values;
                rows.push(`| ${values.join(' | ')} |`);
                rows.push(`| ${values.map(() => '---').join(' | ')} |`);
            } else {
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
