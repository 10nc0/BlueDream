const { parsePDFHybrid, analyzePDFVisualContent } = require('./pdf-handler');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

// ===== COMPOUND IDENTIFICATION =====
// Extract molecular formula and known name from Vision description
function extractFormulaAndKnownName(text) {
    // Match patterns like C21H30O2, C6H12O6, C15H22N2O, etc.
    const formulaRegex = /\b(C\d{1,3}H\d{1,3}(?:O\d{0,3})?(?:N\d{0,3})?(?:S\d{0,3})?(?:Cl\d{0,3})?(?:Br\d{0,3})?(?:F\d{0,3})?)\b/g;
    const matches = text.match(formulaRegex);
    
    let formula = null;
    if (matches && matches.length > 0) {
        // Return the most likely complete formula (longest match)
        formula = matches.sort((a, b) => b.length - a.length)[0];
        // Normalize: C, H, O, N, S, F uppercase; Cl, Br proper case
        formula = formula.replace(/([A-Za-z])(\d*)/g, (match, elem, num) => {
            if (elem.toLowerCase() === 'l' || elem.toLowerCase() === 'r') {
                return match;
            }
            return elem.toUpperCase() + (num || '');
        });
    }
    
    // Extract "Known as:" name if provided by Groq
    let knownName = null;
    const knownAsMatch = text.match(/Known as:\s*([^\n]+?)(?:\n|$)/i);
    if (knownAsMatch) {
        const candidate = knownAsMatch[1].trim();
        // Skip "unknown" or empty answers
        if (candidate && candidate.toLowerCase() !== 'unknown' && candidate.length > 0) {
            knownName = candidate;
        }
    }
    
    return { formula, knownName };
}

// Legacy function kept for backward compatibility
function extractMolecularFormula(text) {
    const { formula } = extractFormulaAndKnownName(text);
    return formula;
}

// Generate fuzzy formula variations (±1 on H and C to handle Vision counting errors)
function generateFormulaVariations(formula) {
    const variations = [formula]; // Start with exact match
    
    // Parse formula: extract C and H counts
    const cMatch = formula.match(/C(\d+)/);
    const hMatch = formula.match(/H(\d+)/);
    
    if (cMatch && hMatch) {
        const cCount = parseInt(cMatch[1]);
        const hCount = parseInt(hMatch[1]);
        
        // Generate ±1 H variations (most common Vision error)
        if (hCount > 1) {
            variations.push(formula.replace(/H\d+/, `H${hCount - 1}`));
        }
        variations.push(formula.replace(/H\d+/, `H${hCount + 1}`));
        
        // Generate ±1 C variations
        if (cCount > 1) {
            variations.push(formula.replace(/C\d+/, `C${cCount - 1}`));
        }
        variations.push(formula.replace(/C\d+/, `C${cCount + 1}`));
    }
    
    return [...new Set(variations)]; // Remove duplicates
}

// Search DDG for a single formula
async function searchDDGForFormula(formula) {
    const query = `${formula} molecule compound name`;
    const params = {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1,
        t: 'nyanbook'
    };
    const url = `https://api.duckduckgo.com/?${querystring.stringify(params)}`;
    
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const data = response.data;
        
        if (data.AbstractText) {
            return {
                name: data.Heading || '',
                description: data.AbstractText.substring(0, 300),
                source: data.AbstractURL || 'DuckDuckGo',
                matchedFormula: formula
            };
        }
        
        if (data.RelatedTopics && data.RelatedTopics.length > 0) {
            const topic = data.RelatedTopics.find(t => t.Text);
            if (topic) {
                return {
                    name: topic.FirstURL ? topic.FirstURL.split('/').pop().replace(/_/g, ' ') : formula,
                    description: topic.Text.substring(0, 300),
                    source: topic.FirstURL || 'DuckDuckGo',
                    matchedFormula: formula
                };
            }
        }
        
        return null;
    } catch (err) {
        console.log(`🔬 DDG search error for ${formula}: ${err.message}`);
        return null;
    }
}

// Search DDG for compound name - cascade: groq-known → exact → verified-ddg → structure → fuzzy
async function identifyCompoundByFormula(formula, structureDescription = '', knownName = null) {
    if (!formula) return null;
    
    // Stage 0: If Groq already identified it, use that (most reliable - direct from model)
    if (knownName) {
        console.log(`🔬 Compound ID: Stage 0 - Using Groq's known name: ${knownName}`);
        return {
            name: knownName,
            description: `Compound identified by Groq Vision analysis with molecular formula ${formula}`,
            source: 'Groq Vision',
            matchedFormula: formula,
            matchType: 'groq-known'
        };
    }
    
    // Stage 1: Try exact formula (direct from Vision analysis)
    console.log(`🔬 Compound ID: Stage 1 - Trying exact formula ${formula}...`);
    const exactResult = await searchDDGForFormula(formula);
    if (exactResult) {
        exactResult.matchType = 'exact';
        console.log(`🔬 Compound ID: ✓ Exact match found for ${formula}`);
        return exactResult;
    }
    
    // Stage 2: Try formula with multiple DDG query variations (empirical verification layer)
    console.log(`🔬 Compound ID: Stage 2 - Trying alternate DDG queries for formula verification...`);
    const queryVariations = [
        `${formula} compound`,
        `${formula} chemical`,
        `${formula} molecule name`,
        `${formula} pharmaceutical`,
        `${formula} natural product`
    ];
    
    for (const query of queryVariations) {
        console.log(`🔬 Compound ID: Trying query: "${query}"`);
        const params = {
            q: query,
            format: 'json',
            no_html: 1,
            skip_disambig: 1,
            t: 'nyanbook'
        };
        const url = `https://api.duckduckgo.com/?${querystring.stringify(params)}`;
        
        try {
            const response = await axios.get(url, { timeout: 5000 });
            const data = response.data;
            
            if (data.AbstractText) {
                console.log(`🔬 Compound ID: ✓ Found with query "${query}"`);
                return {
                    name: data.Heading || '',
                    description: data.AbstractText.substring(0, 300),
                    source: data.AbstractURL || 'DuckDuckGo',
                    matchedFormula: formula,
                    matchType: 'verified-ddg'
                };
            }
        } catch (err) {
            console.log(`🔬 Compound ID: Query failed: ${err.message}`);
        }
    }
    
    // Stage 3: Try structure-based search (empirical keyword matching on Vision observations)
    if (structureDescription) {
        console.log(`🔬 Compound ID: Stage 3 - Trying structure-based search...`);
        
        // Extract key structural terms from Vision analysis
        const structureTerms = [];
        if (/benzene|aromatic/i.test(structureDescription)) structureTerms.push('benzene');
        if (/pyran/i.test(structureDescription)) structureTerms.push('pyran');
        if (/cyclohexene|cyclohexane/i.test(structureDescription)) structureTerms.push('cyclohexene');
        if (/cannabin|thc|tetrahydro/i.test(structureDescription)) structureTerms.push('cannabinoid');
        if (/pentyl|alkyl chain/i.test(structureDescription)) structureTerms.push('pentyl');
        if (/hydroxyl|oh group/i.test(structureDescription)) structureTerms.push('hydroxyl');
        
        if (structureTerms.length >= 2) {
            const structureQuery = `${structureTerms.join(' ')} molecule compound`;
            console.log(`🔬 Compound ID: Structure query: "${structureQuery}"`);
            
            const params = {
                q: structureQuery,
                format: 'json',
                no_html: 1,
                skip_disambig: 1,
                t: 'nyanbook'
            };
            const url = `https://api.duckduckgo.com/?${querystring.stringify(params)}`;
            
            try {
                const response = await axios.get(url, { timeout: 5000 });
                const data = response.data;
                
                if (data.AbstractText) {
                    console.log(`🔬 Compound ID: ✓ Structure-based match found!`);
                    return {
                        name: data.Heading || '',
                        description: data.AbstractText.substring(0, 300),
                        source: data.AbstractURL || 'DuckDuckGo',
                        matchedFormula: formula,
                        matchType: 'structure-based'
                    };
                }
            } catch (err) {
                console.log(`🔬 Compound ID: Structure search error: ${err.message}`);
            }
        }
    }
    
    // Stage 4: Try fuzzy formula variations (±1 H, ±1 C - lowest confidence)
    console.log(`🔬 Compound ID: Stage 4 - Trying fuzzy formula variations...`);
    const variations = generateFormulaVariations(formula);
    
    // Skip the first variation (already tried as exact)
    for (let i = 1; i < variations.length; i++) {
        const variant = variations[i];
        const result = await searchDDGForFormula(variant);
        if (result) {
            result.matchType = 'fuzzy';
            console.log(`🔬 Compound ID: ✓ Fuzzy match found using ${variant} (original: ${formula})`);
            return result;
        }
    }
    
    console.log(`🔬 Compound ID: ✗ No match found - cascade: exact → verified-ddg → structure → fuzzy exhausted`);
    return null;
}

// Enrich chemistry context with parallel DDG queries before final Groq response
async function enrichChemistryContext(formula, structureDescription = '') {
    const results = { formulaContext: null, structureContext: null };
    
    console.log(`🔬 Chemistry Enrichment: Running parallel DDG queries...`);
    
    // Build parallel promises
    const promises = [];
    
    // Query 1: Formula-based search
    if (formula) {
        const formulaQuery = `${formula} compound molecule chemical`;
        console.log(`🔬 DDG Query 1: "${formulaQuery}"`);
        
        const formulaPromise = axios.get(`https://api.duckduckgo.com/?${querystring.stringify({
            q: formulaQuery,
            format: 'json',
            no_html: 1,
            skip_disambig: 1,
            t: 'nyanbook'
        })}`, { timeout: 5000 }).then(res => {
            if (res.data.AbstractText) {
                console.log(`🔬 DDG Query 1: ✓ Found context for formula`);
                return {
                    type: 'formula',
                    name: res.data.Heading || '',
                    description: res.data.AbstractText,
                    source: res.data.AbstractURL || 'DuckDuckGo',
                    formula: formula
                };
            }
            return null;
        }).catch(err => {
            console.log(`🔬 DDG Query 1: Failed - ${err.message}`);
            return null;
        });
        
        promises.push(formulaPromise.then(r => { results.formulaContext = r; }));
    }
    
    // Query 2: Structure-based search
    if (structureDescription) {
        const structureTerms = [];
        if (/benzene|aromatic/i.test(structureDescription)) structureTerms.push('benzene');
        if (/pyran/i.test(structureDescription)) structureTerms.push('pyran');
        if (/cyclohexene|cyclohexane/i.test(structureDescription)) structureTerms.push('cyclohexene');
        if (/cannabin|thc|tetrahydro/i.test(structureDescription)) structureTerms.push('cannabinoid');
        if (/pentyl|alkyl/i.test(structureDescription)) structureTerms.push('pentyl');
        if (/hydroxyl|oh group/i.test(structureDescription)) structureTerms.push('hydroxyl');
        if (/morphine|opioid/i.test(structureDescription)) structureTerms.push('opioid');
        if (/steroid|cholesterol/i.test(structureDescription)) structureTerms.push('steroid');
        
        if (structureTerms.length >= 2) {
            const structureQuery = `${structureTerms.join(' ')} compound molecule`;
            console.log(`🔬 DDG Query 2: "${structureQuery}"`);
            
            const structurePromise = axios.get(`https://api.duckduckgo.com/?${querystring.stringify({
                q: structureQuery,
                format: 'json',
                no_html: 1,
                skip_disambig: 1,
                t: 'nyanbook'
            })}`, { timeout: 5000 }).then(res => {
                if (res.data.AbstractText) {
                    console.log(`🔬 DDG Query 2: ✓ Found context for structure`);
                    return {
                        type: 'structure',
                        name: res.data.Heading || '',
                        description: res.data.AbstractText,
                        source: res.data.AbstractURL || 'DuckDuckGo',
                        searchTerms: structureTerms
                    };
                }
                return null;
            }).catch(err => {
                console.log(`🔬 DDG Query 2: Failed - ${err.message}`);
                return null;
            });
            
            promises.push(structurePromise.then(r => { results.structureContext = r; }));
        }
    }
    
    // Wait for all queries in parallel
    await Promise.all(promises);
    
    // Format enrichment context for prompt injection
    let contextText = '';
    
    if (results.formulaContext) {
        contextText += `\n### 🔬 External Knowledge (Formula ${formula}):\n`;
        contextText += `**${results.formulaContext.name}**: ${results.formulaContext.description}\n`;
        contextText += `Source: ${results.formulaContext.source}\n`;
    }
    
    if (results.structureContext && results.structureContext.name !== results.formulaContext?.name) {
        contextText += `\n### 🔬 External Knowledge (Structure):\n`;
        contextText += `**${results.structureContext.name}**: ${results.structureContext.description}\n`;
        contextText += `Source: ${results.structureContext.source}\n`;
    }
    
    // Determine verified compound info
    let verifiedCompound = null;
    if (results.formulaContext) {
        verifiedCompound = {
            name: results.formulaContext.name,
            description: results.formulaContext.description,
            source: results.formulaContext.source,
            matchedFormula: formula,
            matchType: 'ddg-verified'
        };
        // Extract canonical formula from DDG description if present
        const canonicalMatch = results.formulaContext.description.match(/C\d+H\d+(?:O\d*)?(?:N\d*)?/);
        if (canonicalMatch) {
            verifiedCompound.canonicalFormula = canonicalMatch[0];
            console.log(`🔬 Canonical formula from DDG: ${canonicalMatch[0]}`);
        }
    }
    
    console.log(`🔬 Chemistry Enrichment: Complete (formula: ${results.formulaContext ? '✓' : '✗'}, structure: ${results.structureContext ? '✓' : '✗'})`);
    
    return {
        contextText,
        formulaContext: results.formulaContext,
        structureContext: results.structureContext,
        verifiedCompound
    };
}

// Content-based cache: SHA-256 hash → extraction result
const extractionCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_SIZE = 1000; // LRU eviction threshold

function getCacheKey(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pruneCache() {
    if (extractionCache.size > CACHE_MAX_SIZE) {
        // Simple LRU: delete oldest 10% of entries
        const deleteCount = Math.floor(CACHE_MAX_SIZE * 0.1);
        const keys = Array.from(extractionCache.keys()).slice(0, deleteCount);
        keys.forEach(k => extractionCache.delete(k));
        console.log(`🧹 Cache: Pruned ${deleteCount} old entries`);
    }
}

const FILE_TYPES = {
    PDF: 'pdf',
    EXCEL: 'excel',
    WORD: 'word',
    PRESENTATION: 'presentation',
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
    MODERATE_API: 2
};

const EXTRACTION_TOOLS = {
    'pdf-parse': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'pdf-parse' },
    'tabula': { tier: COST_TIERS.FREE_LOCAL, type: 'table', name: 'tabula-js' },
    'exceljs': { tier: COST_TIERS.FREE_LOCAL, type: 'table', name: 'exceljs' },
    'mammoth': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'mammoth' },
    'mammoth-images': { tier: COST_TIERS.FREE_LOCAL, type: 'images', name: 'mammoth-images' },
    'buffer-text': { tier: COST_TIERS.FREE_LOCAL, type: 'text', name: 'buffer-utf8' },
    'groq-whisper': { tier: COST_TIERS.CHEAP_API, type: 'audio', name: 'groq-whisper' },
    'groq-pdf-vision': { tier: COST_TIERS.MODERATE_API, type: 'vision', name: 'groq-pdf-vision' },
    'groq-doc-vision': { tier: COST_TIERS.MODERATE_API, type: 'vision', name: 'groq-doc-vision' },
    'tesseract-ocr': { tier: COST_TIERS.MODERATE_API, type: 'ocr', name: 'tesseract.js' }
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
    if (['pptx', 'ppt'].includes(ext) || mime.includes('presentation') || mime.includes('powerpoint')) {
        return { type: FILE_TYPES.PRESENTATION, extension: ext, mime: mime };
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
                { tool: 'groq-pdf-vision', tier: COST_TIERS.MODERATE_API, purpose: 'visual-analysis' },
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
                { tool: 'mammoth', tier: COST_TIERS.FREE_LOCAL, purpose: 'text-extraction' },
                { tool: 'mammoth-images', tier: COST_TIERS.FREE_LOCAL, purpose: 'image-extraction' },
                { tool: 'groq-doc-vision', tier: COST_TIERS.MODERATE_API, purpose: 'visual-analysis' }
            );
            break;
            
        case FILE_TYPES.PRESENTATION:
            pipeline.push(
                { tool: 'groq-doc-vision', tier: COST_TIERS.MODERATE_API, purpose: 'visual-analysis' }
            );
            break;
            
        case FILE_TYPES.TEXT:
            pipeline.push(
                { tool: 'buffer-text', tier: COST_TIERS.FREE_LOCAL, purpose: 'text-extraction' }
            );
            break;
            
        case FILE_TYPES.IMAGE:
            pipeline.push(
                { tool: 'groq-pdf-vision', tier: COST_TIERS.MODERATE_API, purpose: 'image-analysis' }
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
    // Check cache first (SHA-256 content hash)
    const cacheKey = getCacheKey(buffer);
    const cached = extractionCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`📦 Cache HIT for ${fileName} (${cacheKey.slice(0, 8)}...)`);
        return { ...cached.result, fromCache: true };
    }
    
    const pipeline = selectExtractionPipeline(fileType);
    const result = {
        success: false,
        fileType: fileType.type,
        fileName: fileName,
        dataStructure: null,
        extractedData: null,
        toolsUsed: [],
        cascadeLog: [],
        jsonOutput: null,
        fromCache: false
    };
    
    console.log(`🔄 Cascade: Starting extraction for ${fileName} (${fileType.type})`);
    console.log(`🔄 Cascade: Pipeline = [${pipeline.map(p => p.tool).join(' → ')}]`);
    
    const cascadeOptions = { ...options };
    
    for (const step of pipeline) {
        if (step.condition === 'sparse-text' && result.extractedData?.text?.length > 100) {
            result.cascadeLog.push({ tool: step.tool, skipped: true, reason: 'text already extracted' });
            continue;
        }
        
        try {
            console.log(`⚙️ Cascade: Executing ${step.tool} (tier ${step.tier})`);
            const stepResult = await executeTool(step.tool, buffer, fileName, cascadeOptions);
            
            if (stepResult.success) {
                result.toolsUsed.push(step.tool);
                result.cascadeLog.push({ tool: step.tool, success: true, tier: step.tier });
                
                result.extractedData = mergeExtractionResults(result.extractedData, stepResult.data);
                result.dataStructure = determineDataStructure(result.extractedData);
                result.success = true;
                
                if (stepResult.data?.embeddedImages) {
                    cascadeOptions.extractedImages = stepResult.data.embeddedImages;
                    console.log(`📷 Cascade: Captured ${stepResult.data.embeddedImages.length} images for vision analysis`);
                }
                
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
    
    // Cache successful extractions
    if (result.success) {
        extractionCache.set(cacheKey, { result, timestamp: Date.now() });
        pruneCache();
        console.log(`📦 Cache SET for ${fileName} (${cacheKey.slice(0, 8)}...)`);
    }
    
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
            
        case 'mammoth-images':
            return await extractWordImages(buffer, options);
            
        case 'groq-doc-vision':
            return await analyzeDocumentVisuals(buffer, fileName, options);
            
        case 'buffer-text':
            return { success: true, data: { text: buffer.toString('utf-8') } };
            
        case 'groq-whisper':
            return await transcribeAudio(buffer, fileName, options);
            
        case 'groq-pdf-vision':
            return await extractPDFVisualContent(buffer, fileName, options);
            
        case 'tesseract-ocr':
            return { success: false, error: 'OCR requires image data - use groq-pdf-vision instead' };
            
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

async function extractWordImages(buffer, options = {}) {
    try {
        const images = [];
        
        try {
            const result = await mammoth.convertToHtml({
                buffer,
                convertImage: mammoth.images.imgElement(async function(image) {
                    const imageBuffer = await image.read();
                    const base64 = imageBuffer.toString('base64');
                    const contentType = image.contentType || 'image/png';
                    images.push({
                        base64,
                        contentType,
                        size: imageBuffer.length
                    });
                    return { src: `data:${contentType};base64,${base64}` };
                })
            });
        } catch (mammothErr) {
            console.log(`⚠️ Mammoth convertToHtml failed: ${mammothErr.message}`);
        }
        
        if (images.length === 0) {
            console.log('🔍 Mammoth found no images, trying direct DOCX media extraction...');
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(buffer);
            
            const mediaFolder = zip.folder('word/media');
            if (mediaFolder) {
                const mediaFiles = [];
                mediaFolder.forEach((relativePath, file) => {
                    if (!file.dir) {
                        mediaFiles.push({ path: relativePath, file });
                    }
                });
                
                for (const { path, file } of mediaFiles) {
                    const ext = path.toLowerCase().split('.').pop();
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'wmf', 'emf'];
                    if (imageExts.includes(ext)) {
                        const imgBuffer = await file.async('nodebuffer');
                        const base64 = imgBuffer.toString('base64');
                        const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
                        images.push({
                            base64,
                            contentType,
                            size: imgBuffer.length,
                            source: 'docx-media-folder'
                        });
                        console.log(`📷 Extracted from word/media: ${path} (${imgBuffer.length} bytes)`);
                    }
                }
            }
        }
        
        if (images.length === 0) {
            return { success: false, error: 'No embedded images found in document' };
        }
        
        console.log(`📷 Extracted ${images.length} embedded image(s) from Word document`);
        
        options.extractedImages = images;
        return { 
            success: true, 
            data: { 
                embeddedImages: images,
                imageCount: images.length,
                type: 'word-images'
            }
        };
    } catch (error) {
        console.error(`❌ Word image extraction error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function analyzeDocumentVisuals(buffer, fileName, options = {}) {
    const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN;
    
    if (!PLAYGROUND_GROQ_VISION_TOKEN) {
        console.log('⚠️ PLAYGROUND_GROQ_VISION_TOKEN not configured - skipping document visual analysis');
        return { success: false, error: 'Vision token not configured' };
    }
    
    const images = options.extractedImages || [];
    
    if (images.length === 0) {
        const ext = (fileName || '').toLowerCase().split('.').pop();
        if (['pptx', 'ppt', 'xlsx', 'xls'].includes(ext)) {
            console.log(`🔬 Doc Visual: Converting ${fileName} to images for analysis...`);
            const convertedImages = await convertDocumentToImages(buffer, fileName);
            if (convertedImages.length > 0) {
                images.push(...convertedImages);
            }
        }
    }
    
    if (images.length === 0) {
        return { success: false, error: 'No images to analyze' };
    }
    
    console.log(`🔬 Doc Visual: Analyzing ${images.length} image(s) with Groq Vision...`);
    
    const visualDescriptions = [];
    const axios = require('axios');
    
    const maxImages = Math.min(images.length, 5);
    
    for (let i = 0; i < maxImages; i++) {
        const img = images[i];
        const base64Data = img.base64.includes('base64,') 
            ? img.base64.split('base64,')[1] 
            : img.base64;
        
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: `Analyze this image from a document in detail.

=== IF CHEMICAL STRUCTURE ===
1. Count atoms carefully: C (carbons), H (hydrogens), O (oxygens), N (nitrogens), etc.
2. IMPORTANT: For fused ring systems, count shared carbons ONCE, not twice.
3. Provide MOLECULAR FORMULA: e.g., "Molecular Formula: C21H30O2"
4. If you recognize the compound, provide: "Known as: [compound name]" (e.g., THC, aspirin, caffeine)
5. Identify functional groups: -OH, C=O, rings, chains, etc.

=== IF CHART/GRAPH ===
Describe type, axes, data points, trends.

=== IF DIAGRAM ===
Explain what it shows, labels, relationships.

=== OTHER CONTENT ===
Describe what you see.

Be specific and technical. This is for scientific document analysis.`
                                },
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${img.contentType || 'image/png'};base64,${base64Data}`
                                    }
                                }
                            ]
                        }
                    ],
                    max_tokens: 1024,
                    temperature: 0.15
                },
                {
                    headers: {
                        'Authorization': `Bearer ${PLAYGROUND_GROQ_VISION_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );
            
            const description = response.data.choices?.[0]?.message?.content || 'Unable to analyze image';
            
            const contentType = description.toLowerCase().includes('chemical') || 
                               description.toLowerCase().includes('molecule') ||
                               description.toLowerCase().includes('structure') ? 'chemical' :
                               description.toLowerCase().includes('chart') ||
                               description.toLowerCase().includes('graph') ? 'chart' :
                               description.toLowerCase().includes('diagram') ? 'diagram' : 'visual';
            
            visualDescriptions.push({
                index: i + 1,
                contentType,
                description
            });
            
            console.log(`✅ Analyzed image ${i + 1}/${maxImages} (${contentType})`);
            
        } catch (error) {
            console.error(`❌ Failed to analyze image ${i + 1}: ${error.message}`);
            visualDescriptions.push({
                index: i + 1,
                contentType: 'error',
                description: `Analysis failed: ${error.message}`
            });
        }
    }
    
    if (visualDescriptions.length === 0) {
        return { success: false, error: 'No images could be analyzed' };
    }
    
    // Check for chemical structures and apply DDG enrichment
    const chemicalStructures = visualDescriptions.filter(vc => vc.contentType === 'chemical');
    let compoundInfo = null;
    let chemistryEnrichment = null;
    
    if (chemicalStructures.length > 0) {
        const allDescriptions = chemicalStructures.map(cs => cs.description).join(' ');
        const { formula, knownName } = extractFormulaAndKnownName(allDescriptions);
        
        if (formula) {
            console.log(`🧪 Detected molecular formula: ${formula}${knownName ? ` (Known as: ${knownName})` : ''}`);
            
            // Run DDG enrichment for chemistry queries
            chemistryEnrichment = await enrichChemistryContext(formula, allDescriptions);
            
            if (chemistryEnrichment.verifiedCompound) {
                compoundInfo = chemistryEnrichment.verifiedCompound;
                console.log(`🔬 Compound identified via DDG: ${compoundInfo.name}`);
            } else if (knownName) {
                // Fall back to Groq's identification if DDG didn't find it
                compoundInfo = {
                    name: knownName,
                    description: `Identified by Groq Vision with formula ${formula}`,
                    source: 'Groq Vision',
                    matchedFormula: formula,
                    matchType: 'groq-known'
                };
                console.log(`🔬 Compound identified via Groq: ${knownName}`);
            }
        }
    }
    
    const formattedVisuals = visualDescriptions.map(vc => {
        const typeLabel = vc.contentType === 'chemical' ? '🧪 Chemical Structure' :
                          vc.contentType === 'chart' ? '📊 Chart/Graph' :
                          vc.contentType === 'diagram' ? '📐 Diagram' : '🖼️ Visual';
        return `**Image ${vc.index} (${typeLabel}):**\n${vc.description}`;
    }).join('\n\n');
    
    // Add compound identification section
    let compoundSection = '';
    if (compoundInfo && compoundInfo.name) {
        compoundSection = `\n\n### 🔬 Compound Identification:\n**Name:** ${compoundInfo.name}`;
        if (compoundInfo.canonicalFormula) {
            compoundSection += `\n**Formula:** ${compoundInfo.canonicalFormula}`;
        }
        compoundSection += `\n**Source:** ${compoundInfo.source}`;
    }
    
    // Add DDG enrichment context
    const enrichmentSection = chemistryEnrichment?.contextText || '';
    
    return {
        success: true,
        data: {
            text: `\n### Visual Content Analysis:\n${formattedVisuals}${compoundSection}${enrichmentSection}`,
            visualContent: visualDescriptions,
            chemicalStructures: chemicalStructures,
            compoundInfo: compoundInfo,
            chemistryEnrichment: chemistryEnrichment,
            type: 'doc-vision'
        }
    };
}

async function convertDocumentToImages(buffer, fileName) {
    const images = [];
    const ext = (fileName || '').toLowerCase().split('.').pop();
    
    try {
        if (['xlsx', 'xls'].includes(ext)) {
            console.log(`📊 Excel file detected - extracting charts/images not directly supported, relying on table data`);
            return images;
        }
        
        if (['pptx', 'ppt'].includes(ext)) {
            console.log(`📽️ PowerPoint file detected - attempting slide extraction via JSZip...`);
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(buffer);
            
            const mediaFolder = zip.folder('ppt/media');
            if (mediaFolder) {
                const mediaFiles = [];
                mediaFolder.forEach((relativePath, file) => {
                    if (/\.(png|jpg|jpeg|gif|bmp)$/i.test(relativePath)) {
                        mediaFiles.push({ path: relativePath, file });
                    }
                });
                
                for (const { path, file } of mediaFiles.slice(0, 5)) {
                    try {
                        const imgBuffer = await file.async('nodebuffer');
                        const base64 = imgBuffer.toString('base64');
                        const ext = path.split('.').pop().toLowerCase();
                        const contentType = ext === 'png' ? 'image/png' : 
                                           ext === 'gif' ? 'image/gif' : 'image/jpeg';
                        images.push({ base64, contentType, size: imgBuffer.length });
                        console.log(`📷 Extracted PPT image: ${path}`);
                    } catch (e) {
                        console.error(`Failed to extract ${path}: ${e.message}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error(`❌ Document to images conversion error: ${error.message}`);
    }
    
    return images;
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

async function extractPDFVisualContent(buffer, fileName, options = {}) {
    try {
        const result = await analyzePDFVisualContent(buffer, fileName, { maxPages: 5 });
        
        if (!result.success || result.visualContent.length === 0) {
            return { success: false, error: result.error || 'No visual content extracted' };
        }
        
        // Check for chemical structures and apply DDG enrichment
        let compoundInfo = null;
        let chemistryEnrichment = null;
        
        if (result.chemicalStructures && result.chemicalStructures.length > 0) {
            const allDescriptions = result.chemicalStructures.map(cs => cs.description).join(' ');
            const { formula, knownName } = extractFormulaAndKnownName(allDescriptions);
            
            if (formula) {
                console.log(`🧪 Detected molecular formula: ${formula}${knownName ? ` (Known as: ${knownName})` : ''}`);
                
                // Run DDG enrichment for chemistry queries
                chemistryEnrichment = await enrichChemistryContext(formula, allDescriptions);
                
                if (chemistryEnrichment.verifiedCompound) {
                    compoundInfo = chemistryEnrichment.verifiedCompound;
                    console.log(`🔬 Compound identified via DDG: ${compoundInfo.name}`);
                } else if (knownName) {
                    // Fall back to Groq's identification if DDG didn't find it
                    compoundInfo = {
                        name: knownName,
                        description: `Identified by Groq Vision with formula ${formula}`,
                        source: 'Groq Vision',
                        matchedFormula: formula,
                        matchType: 'groq-known'
                    };
                    console.log(`🔬 Compound identified via Groq: ${knownName}`);
                }
            }
        }
        
        // Format visual content for merging with text extraction
        const visualDescriptions = result.visualContent.map(vc => {
            const typeLabel = vc.contentType === 'chemical' ? '🧪 Chemical Structure' :
                              vc.contentType === 'chart' ? '📊 Chart/Graph' :
                              vc.contentType === 'diagram' ? '📐 Diagram' : '🖼️ Visual';
            return `**Page ${vc.page} (${typeLabel}):**\n${vc.description}`;
        }).join('\n\n');
        
        // Add compound identification section
        let compoundSection = '';
        if (compoundInfo && compoundInfo.name) {
            compoundSection = `\n\n### 🔬 Compound Identification:\n**Name:** ${compoundInfo.name}`;
            if (compoundInfo.canonicalFormula) {
                compoundSection += `\n**Formula:** ${compoundInfo.canonicalFormula}`;
            }
            compoundSection += `\n**Source:** ${compoundInfo.source}`;
        }
        
        // Add DDG enrichment context
        const enrichmentSection = chemistryEnrichment?.contextText || '';
        
        return { 
            success: true, 
            data: { 
                text: `\n### Visual Content Analysis:\n${visualDescriptions}${compoundSection}${enrichmentSection}`,
                visualContent: result.visualContent,
                charts: result.charts,
                chemicalStructures: result.chemicalStructures,
                diagrams: result.diagrams,
                compoundInfo: compoundInfo,
                chemistryEnrichment: chemistryEnrichment,
                type: 'pdf-vision'
            }
        };
    } catch (error) {
        console.error(`❌ PDF visual extraction error: ${error.message}`);
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
