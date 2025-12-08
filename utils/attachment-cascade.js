const { parsePDFHybrid } = require('./pdf-handler');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');

const FILE_TYPES = {
    PDF: 'pdf',
    EXCEL: 'excel',
    WORD: 'word',
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    UNKNOWN: 'unknown'
};

const DATA_STRUCTURES = {
    TEXT: 'text',
    TABLE: 'table',
    MIXED: 'mixed',
    BINARY: 'binary'
};

const COST_TIERS = {
    FREE_LOCAL: 0,
    CHEAP_API: 1,
    MODERATE_API: 2,
    EXPENSIVE_API: 3
};

const EXTRACTION_TOOLS = {
    'pdf-parse': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'pdf-parse' },
    'tabula': { tier: COST_TIERS.FREE_LOCAL, type: 'table', name: 'tabula-js' },
    'exceljs': { tier: COST_TIERS.FREE_LOCAL, type: 'table', name: 'exceljs' },
    'mammoth': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'mammoth' },
    'buffer-text': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'buffer-utf8' },
    'groq-whisper': { tier: COST_TIERS.CHEAP_API, type: 'audio', name: 'groq-whisper' },
    'tesseract-ocr': { tier: COST_TIERS.MODERATE_API, type: 'ocr', name: 'tesseract.js' },
    'hf-vision': { tier: COST_TIERS.EXPENSIVE_API, type: 'vision', name: 'huggingface-vision' }
};

function identifyFileType(fileName, mimeType) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    const mime = (mimeType || '').toLowerCase();
    
    if (ext === 'pdf' || mime.includes('pdf')) {
        return { type: FILE_TYPES.PDF, extension: ext, mime: mime };
    }
    if (['xlsx', 'xls'].includes(ext) || mime.includes('spreadsheet') || mime.includes('excel')) {
        return { type: FILE_TYPES.EXCEL, extension: ext, mime: mime };
    }
    if (['docx', 'doc'].includes(ext) || mime.includes('word')) {
        return { type: FILE_TYPES.WORD, extension: ext, mime: mime };
    }
    if (['txt', 'md', 'csv', 'json', 'xml', 'html'].includes(ext) || mime.includes('text')) {
        return { type: FILE_TYPES.TEXT, extension: ext, mime: mime };
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext) || mime.includes('image')) {
        return { type: FILE_TYPES.IMAGE, extension: ext, mime: mime };
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'].includes(ext) || mime.includes('audio')) {
        return { type: FILE_TYPES.AUDIO, extension: ext, mime: mime };
    }
    
    return { type: FILE_TYPES.UNKNOWN, extension: ext, mime: mime };
}

function selectExtractionPipeline(fileType) {
    const pipeline = [];
    
    switch (fileType.type) {
        case FILE_TYPES.PDF:
            pipeline.push(
                { tool: 'pdf-parse', tier: COST_TIERS.FREE_LOCAL, purpose: 'text-extraction' },
                { tool: 'tabula', tier: COST_TIERS.FREE_LOCAL, purpose: 'table-extraction' },
                { tool: 'tesseract-ocr', tier: COST_TIERS.MODERATE_API, purpose: 'ocr-fallback', condition: 'sparse-text' }
            );
            break;
            
        case FILE_TYPES.EXCEL:
            pipeline.push(
                { tool: 'exceljs', tier: COST_TIERS.FREE_LOCAL, purpose: 'table-extraction' }
            );
            break;
            
        case FILE_TYPES.WORD:
            pipeline.push(
                { tool: 'mammoth', tier: COST_TIERS.FREE_LOCAL, purpose: 'text-extraction' }
            );
            break;
            
        case FILE_TYPES.TEXT:
            pipeline.push(
                { tool: 'buffer-text', tier: COST_TIERS.FREE_LOCAL, purpose: 'text-extraction' }
            );
            break;
            
        case FILE_TYPES.IMAGE:
            pipeline.push(
                { tool: 'hf-vision', tier: COST_TIERS.EXPENSIVE_API, purpose: 'image-analysis' }
            );
            break;
            
        case FILE_TYPES.AUDIO:
            pipeline.push(
                { tool: 'groq-whisper', tier: COST_TIERS.CHEAP_API, purpose: 'transcription' }
            );
            break;
            
        default:
            pipeline.push(
                { tool: 'buffer-text', tier: COST_TIERS.FREE_LOCAL, purpose: 'raw-text' }
            );
    }
    
    return pipeline.sort((a, b) => a.tier - b.tier);
}

async function executeExtractionCascade(buffer, fileType, fileName, options = {}) {
    const pipeline = selectExtractionPipeline(fileType);
    const result = {
        success: false,
        fileType: fileType.type,
        fileName: fileName,
        dataStructure: null,
        extractedData: null,
        toolsUsed: [],
        cascadeLog: [],
        jsonOutput: null
    };
    
    console.log(`🔄 Cascade: Starting extraction for ${fileName} (${fileType.type})`);
    console.log(`🔄 Cascade: Pipeline = [${pipeline.map(p => p.tool).join(' → ')}]`);
    
    for (const step of pipeline) {
        if (step.condition === 'sparse-text' && result.extractedData?.text?.length > 100) {
            result.cascadeLog.push({ tool: step.tool, skipped: true, reason: 'text already extracted' });
            continue;
        }
        
        try {
            console.log(`⚙️ Cascade: Executing ${step.tool} (tier ${step.tier})`);
            const stepResult = await executeTool(step.tool, buffer, fileName, options);
            
            if (stepResult.success) {
                result.toolsUsed.push(step.tool);
                result.cascadeLog.push({ tool: step.tool, success: true, tier: step.tier });
                
                result.extractedData = mergeExtractionResults(result.extractedData, stepResult.data);
                result.dataStructure = determineDataStructure(result.extractedData);
                result.success = true;
                
                console.log(`✅ Cascade: ${step.tool} succeeded`);
            } else {
                result.cascadeLog.push({ tool: step.tool, success: false, error: stepResult.error });
                console.log(`⚠️ Cascade: ${step.tool} failed - ${stepResult.error}`);
            }
        } catch (error) {
            result.cascadeLog.push({ tool: step.tool, success: false, error: error.message });
            console.log(`❌ Cascade: ${step.tool} error - ${error.message}`);
        }
    }
    
    result.jsonOutput = formatAsJSON(result);
    
    return result;
}

async function executeTool(toolName, buffer, fileName, options) {
    switch (toolName) {
        case 'pdf-parse':
            return await extractPDFText(buffer, fileName);
            
        case 'tabula':
            return await extractPDFTables(buffer, fileName);
            
        case 'exceljs':
            return await extractExcelData(buffer, fileName);
            
        case 'mammoth':
            return await extractWordText(buffer);
            
        case 'buffer-text':
            return { success: true, data: { text: buffer.toString('utf-8') } };
            
        case 'groq-whisper':
            return await transcribeAudio(buffer, fileName, options);
            
        case 'hf-vision':
            return await analyzeImage(buffer, fileName, options);
            
        case 'tesseract-ocr':
            return { success: false, error: 'OCR requires image data - PDF-to-image pipeline not implemented' };
            
        default:
            return { success: false, error: `Unknown tool: ${toolName}` };
    }
}

async function extractPDFText(buffer, fileName) {
    try {
        const { PDFParse, VerbosityLevel } = require('pdf-parse');
        const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
        const data = await parser.getText();
        return { success: true, data: { text: data.text || '' } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function extractPDFTables(buffer, fileName) {
    try {
        const result = await parsePDFHybrid(buffer, fileName);
        if (result.tables && result.tables.length > 0) {
            return { success: true, data: { tables: result.tables } };
        }
        return { success: false, error: 'No tables found' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function extractExcelData(buffer, fileName) {
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        
        const sheets = [];
        workbook.eachSheet((sheet) => {
            const sheetData = {
                name: sheet.name,
                rows: [],
                headers: []
            };
            
            sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
                const values = [];
                row.eachCell({ includeEmpty: true }, (cell) => {
                    let value = '';
                    if (cell.value !== null && cell.value !== undefined) {
                        if (typeof cell.value === 'object') {
                            value = cell.value.text || cell.value.result || String(cell.value);
                        } else {
                            value = String(cell.value);
                        }
                    }
                    values.push(value);
                });
                
                if (rowNum === 1) {
                    sheetData.headers = values;
                }
                sheetData.rows.push(values);
            });
            
            sheets.push(sheetData);
        });
        
        return { success: true, data: { tables: sheets, type: 'excel' } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function extractWordText(buffer) {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return { success: true, data: { text: result.value || '' } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function transcribeAudio(buffer, fileName, options) {
    const PLAYGROUND_GROQ_TOKEN = process.env.PLAYGROUND_GROQ_TOKEN;
    if (!PLAYGROUND_GROQ_TOKEN) {
        return { success: false, error: 'Groq token not configured' };
    }
    
    try {
        const FormData = require('form-data');
        const axios = require('axios');
        
        const form = new FormData();
        form.append('file', buffer, { filename: fileName });
        form.append('model', 'whisper-large-v3-turbo');
        
        const response = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${PLAYGROUND_GROQ_TOKEN}`
                },
                timeout: 60000
            }
        );
        
        return { success: true, data: { text: response.data.text || '', type: 'transcription' } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function analyzeImage(buffer, fileName, options) {
    const PLAYGROUND_HF_VISION_TOKEN = process.env.PLAYGROUND_HF_VISION_TOKEN;
    if (!PLAYGROUND_HF_VISION_TOKEN) {
        return { success: false, error: 'HuggingFace vision token not configured' };
    }
    
    try {
        const axios = require('axios');
        const base64 = buffer.toString('base64');
        
        const response = await axios.post(
            'https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct',
            {
                inputs: base64,
                parameters: {
                    text: options.imagePrompt || "Describe this image in detail. Extract any text, numbers, or data visible. Be precise and factual.",
                    max_new_tokens: 500,
                    temperature: 0.1,
                    top_p: 0.95
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${PLAYGROUND_HF_VISION_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            }
        );
        
        const description = response.data?.[0]?.generated_text || '';
        return { success: true, data: { text: description, type: 'vision-analysis' } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function mergeExtractionResults(existing, newData) {
    if (!existing) {
        return newData;
    }
    
    const merged = { ...existing };
    
    if (newData.text) {
        merged.text = (merged.text || '') + '\n' + newData.text;
    }
    if (newData.tables) {
        merged.tables = [...(merged.tables || []), ...newData.tables];
    }
    if (newData.type) {
        merged.type = newData.type;
    }
    
    return merged;
}

function determineDataStructure(data) {
    if (!data) return DATA_STRUCTURES.BINARY;
    
    const hasText = data.text && data.text.trim().length > 0;
    const hasTables = data.tables && data.tables.length > 0;
    
    if (hasText && hasTables) return DATA_STRUCTURES.MIXED;
    if (hasTables) return DATA_STRUCTURES.TABLE;
    if (hasText) return DATA_STRUCTURES.TEXT;
    return DATA_STRUCTURES.BINARY;
}

function formatAsJSON(result) {
    const json = {
        metadata: {
            fileName: result.fileName,
            fileType: result.fileType,
            dataStructure: result.dataStructure,
            toolsUsed: result.toolsUsed,
            extractionSuccess: result.success
        },
        content: {}
    };
    
    if (result.extractedData) {
        if (result.extractedData.text) {
            json.content.text = result.extractedData.text.trim();
        }
        if (result.extractedData.tables) {
            json.content.tables = result.extractedData.tables.map((table, i) => {
                if (table.markdown) {
                    return { index: i, format: 'markdown', data: table.markdown };
                }
                if (table.rows) {
                    return { 
                        index: i, 
                        format: 'structured',
                        sheetName: table.name,
                        headers: table.headers,
                        rows: table.rows
                    };
                }
                return table;
            });
        }
    }
    
    return json;
}

function formatJSONForGroq(cascadeResult, userQuery) {
    const json = cascadeResult.jsonOutput;
    
    let contextParts = [];
    contextParts.push(`📄 **Document: ${json.metadata.fileName}**`);
    contextParts.push(`**Type:** ${json.metadata.fileType} | **Structure:** ${json.metadata.dataStructure}`);
    contextParts.push(`**Extraction:** ${json.metadata.toolsUsed.join(' → ')}`);
    contextParts.push('---');
    
    if (json.content.tables && json.content.tables.length > 0) {
        contextParts.push('### Extracted Tables:\n');
        json.content.tables.forEach((table, i) => {
            if (table.format === 'markdown') {
                contextParts.push(`**Table ${i + 1}:**`);
                contextParts.push(table.data);
            } else if (table.format === 'structured') {
                contextParts.push(`**${table.sheetName || `Table ${i + 1}`}:**`);
                if (table.headers && table.headers.length > 0) {
                    contextParts.push(`| ${table.headers.join(' | ')} |`);
                    contextParts.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
                }
                if (table.rows) {
                    table.rows.slice(1, 50).forEach(row => {
                        contextParts.push(`| ${row.join(' | ')} |`);
                    });
                    if (table.rows.length > 50) {
                        contextParts.push(`\n[...${table.rows.length - 50} more rows truncated...]`);
                    }
                }
            }
            contextParts.push('');
        });
    }
    
    if (json.content.text) {
        contextParts.push('### Document Text:\n');
        const text = json.content.text;
        const truncated = text.length > 4000 ? text.substring(0, 4000) + '\n[...truncated...]' : text;
        contextParts.push(truncated);
    }
    
    contextParts.push('\n---');
    contextParts.push(`**User Query:** ${userQuery || 'Analyze this document and provide key insights.'}`);
    contextParts.push('\nProvide specific answers based on the extracted data. For tables, reference exact cell values. Be precise and cite data points.');
    
    return contextParts.join('\n');
}

module.exports = {
    FILE_TYPES,
    DATA_STRUCTURES,
    COST_TIERS,
    identifyFileType,
    selectExtractionPipeline,
    executeExtractionCascade,
    formatJSONForGroq
};
