const { parsePDFHybrid, analyzePDFVisualContent, groqWithRetry } = require('./pdf-handler');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');
const { analyzeFinancialDocument, formatPhysicsAnalysis, getFinancialPhysicsSeed, quickNonFinancialCheck } = require('./financial-physics');
// Harmonized imports from data-package for shared caching
const { globalDocCache, computeDocHash, FILE_TYPES: DP_FILE_TYPES } = require('./data-package');

// ===== INTELLIGENT CHUNKING (GroundX-inspired) =====
// Splits text by sections without cutting mid-table or mid-paragraph
function intelligentChunking(text, maxTokens = 1000) {
    if (!text || text.length === 0) return [];
    
    // Split by double newlines (paragraph/section boundaries)
    const sections = text.split(/\n\n+/);
    const chunks = [];
    let currentChunk = '';
    
    // Approximate: 1 token ≈ 4 characters
    const maxChars = maxTokens * 4;
    
    for (const section of sections) {
        // If adding this section exceeds limit, save current chunk and start new
        if ((currentChunk.length + section.length) > maxChars) {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }
            // If single section is too large, split by single newlines
            if (section.length > maxChars) {
                const lines = section.split('\n');
                currentChunk = '';
                for (const line of lines) {
                    if ((currentChunk.length + line.length) > maxChars) {
                        if (currentChunk.trim()) {
                            chunks.push(currentChunk.trim());
                        }
                        currentChunk = line;
                    } else {
                        currentChunk += '\n' + line;
                    }
                }
            } else {
                currentChunk = section;
            }
        } else {
            currentChunk += '\n\n' + section;
        }
    }
    
    // Don't forget the last chunk
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    console.log(`📦 Chunking: Split into ${chunks.length} chunks (max ${maxTokens} tokens each)`);
    return chunks;
}

// ===== MULTI-DOC CONTEXT MERGE (Corporate Multi-Attachment) =====
// Labels each document for clear reference in AI responses
function buildMultiDocContext(extractedItems) {
    if (!extractedItems || extractedItems.length === 0) {
        return '';
    }
    
    let context = '';
    const docSummaries = [];
    
    extractedItems.forEach((item, idx) => {
        const docNumber = idx + 1;
        const fileName = item.fileName || item.name || `Document ${docNumber}`;
        const label = `[Document ${docNumber}: ${fileName}]`;
        
        // Extract text content
        let textContent = '';
        if (item.text) {
            textContent = item.text;
        } else if (item.summary) {
            textContent = item.summary;
        } else if (item.extractedData?.text) {
            textContent = item.extractedData.text;
        } else if (typeof item === 'string') {
            textContent = item;
        }
        
        // Apply intelligent chunking for long documents
        if (textContent.length > 4000) {
            const chunks = intelligentChunking(textContent, 800);
            textContent = chunks.slice(0, 3).join('\n\n[...]\n\n');
            if (chunks.length > 3) {
                textContent += `\n\n[${chunks.length - 3} more sections not shown]`;
            }
        }
        
        context += `\n\n${label}\n`;
        context += textContent || '[No text extracted]';
        
        // Build summary for cross-reference
        docSummaries.push({
            number: docNumber,
            name: fileName,
            type: item.fileType || item.type || 'document',
            preview: (textContent || '').substring(0, 100)
        });
    });
    
    // Add document index at the top for easy reference
    if (extractedItems.length > 1) {
        let indexHeader = '📋 **DOCUMENT INDEX:**\n';
        docSummaries.forEach(doc => {
            indexHeader += `  ${doc.number}. ${doc.name} (${doc.type})\n`;
        });
        indexHeader += '\n---';
        context = indexHeader + context;
    }
    
    console.log(`📦 Multi-Doc Merge: Combined ${extractedItems.length} documents into unified context`);
    return context.trim();
}

// ===== CHEMICAL CONSTANTS (SETTLED SCIENCE) =====
// 18 compounds with UNIQUE formulas - IUPAC Gold Book 2024
// Stage 0: Instant recognition (0.4s vs 4.2s DDG)
// Note: C21H30O2 has isomers (THC/CBD) - requires Vision context to disambiguate
const CHEMICAL_CONSTANTS = {
    // CANNABINOIDS
    // C21H30O2 = THC or CBD (isomers) - Vision name determines which
    'C21H30O2': { name: 'Tetrahydrocannabinol (THC)', confidence: 0.99, source: 'IUPAC', 
                  isomers: ['THC', 'tetrahydrocannabinol', 'CBD', 'cannabidiol', 'Δ8-THC', 'Δ9-THC', 'delta-8', 'delta-9'], 
                  note: 'Vision context required for isomer disambiguation' },
    'C21H32O2': { name: 'Cannabigerol (CBG)', confidence: 0.99, source: 'IUPAC' },
    
    // PHARMACEUTICAL (unique formulas)
    'C9H8O4': { name: 'Acetylsalicylic acid (Aspirin)', confidence: 0.99, source: 'IUPAC' },
    'C8H10N4O2': { name: 'Caffeine', confidence: 0.99, source: 'IUPAC' },
    'C13H18O2': { name: 'Ibuprofen', confidence: 0.99, source: 'IUPAC' },
    'C8H9NO2': { name: 'Acetaminophen (Paracetamol)', confidence: 0.99, source: 'IUPAC' },
    
    // NEUROTRANSMITTERS (unique formulas)
    'C8H11NO2': { name: 'Dopamine', confidence: 0.99, source: 'IUPAC' },
    'C10H12N2O': { name: 'Serotonin', confidence: 0.99, source: 'IUPAC' },
    'C9H13NO3': { name: 'Adrenaline (Epinephrine)', confidence: 0.99, source: 'IUPAC' },
    
    // STEROIDS (unique formulas)
    'C27H46O': { name: 'Cholesterol', confidence: 0.99, source: 'IUPAC' },
    'C19H28O2': { name: 'Testosterone', confidence: 0.99, source: 'IUPAC' },
    'C18H24O2': { name: '17β-Estradiol', confidence: 0.99, source: 'IUPAC' },
    
    // SIMPLE MOLECULES (unique formulas)
    'C6H12O6': { name: 'D-Glucose', confidence: 0.99, source: 'IUPAC' },
    'C2H6O': { name: 'Ethanol', confidence: 0.99, source: 'IUPAC' },
    'C3H6O': { name: 'Acetone', confidence: 0.99, source: 'IUPAC' },
    'C6H6': { name: 'Benzene', confidence: 0.99, source: 'IUPAC' },
    
    // ALKALOIDS (unique formulas)
    'C17H21NO4': { name: 'Morphine', confidence: 0.99, source: 'IUPAC' },
    'C10H14N2': { name: 'Nicotine', confidence: 0.99, source: 'IUPAC' }
};

// Lookup settled science by formula (Stage 0)
function lookupSettledScience(formula) {
    if (!formula) return null;
    const normalized = formula.toUpperCase().replace(/\s+/g, '');
    return CHEMICAL_CONSTANTS[normalized] || null;
}

// ===== CODE DETECTION HEURISTICS =====
// Determines if a text file likely contains code
function isLikelyCode(text, fileName) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    const codeExts = ['js', 'ts', 'py', 'go', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'rs', 'swift', 'sh', 'sql', 'html', 'css'];
    if (codeExts.includes(ext)) return true;
    
    // Heuristics for .txt files
    if (ext === 'txt') {
        const codePatterns = [
            /function\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=/,
            /import\s+.*\s+from|require\s*\(|module\.exports\s*=/,
            /class\s+\w+|def\s+\w+\s*\(|if\s+__name__\s*==\s*['"]__main__['"]/,
            /interface\s+\w+|enum\s+\w+|type\s+\w+\s*=/
        ];
        return codePatterns.some(p => p.test(text.substring(0, 2000)));
    }
    
    return false;
}

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
    
    // Extract compound name using multiple strategies
    let knownName = null;
    
    // Strategy 1: Look for "Known as: CompoundName" (capture full name until punctuation/newline)
    const knownAsMatch = text.match(/Known as:\s*\**\s*([A-Za-z0-9\-]+(?:[\s\-][A-Za-z0-9\-]+)*)/i);
    if (knownAsMatch) {
        let candidate = knownAsMatch[1].trim();
        // Clean up trailing words like "compound", "molecule", etc.
        candidate = candidate.replace(/\s+(compound|molecule|structure|chemical|acid|analog|derivative)$/i, '').trim();
        // Strip leading punctuation/bullets before checking verbose patterns (fixes "- The compound appears to be")
        const cleanedCandidate = candidate.replace(/^[\-\*\•\·\>\s]+/, '').trim();
        // Reject verbose phrases that aren't actual compound names
        const verbosePatterns = /^(the\s+(compound|structure|molecule)|this|it|appears\s+to|seems\s+to|likely|possibly|probably|compound\s+appears)/i;
        if (cleanedCandidate && cleanedCandidate.toLowerCase() !== 'unknown' && cleanedCandidate.length > 1 && !verbosePatterns.test(cleanedCandidate)) {
            knownName = cleanedCandidate;
        }
    }
    
    // Strategy 2: Look for recognized compound names (18 settled-science compounds only)
    // Matches CHEMICAL_CONSTANTS - unique formulas with IUPAC names
    if (!knownName) {
        // Only match the 18 settled-science compounds
        const compoundPatterns = [
            // CANNABINOIDS
            /\b(THC|tetrahydrocannabinol|Δ9-THC|delta-9-thc)\b/i,
            /\b(CBD|cannabidiol)\b/i,
            /\b(CBG|cannabigerol)\b/i,
            // PHARMACEUTICAL
            /\b(aspirin|acetylsalicylic acid)\b/i,
            /\b(caffeine)\b/i,
            /\b(ibuprofen)\b/i,
            /\b(acetaminophen|paracetamol)\b/i,
            // NEUROTRANSMITTERS
            /\b(dopamine)\b/i,
            /\b(serotonin)\b/i,
            /\b(adrenaline|epinephrine)\b/i,
            // STEROIDS
            /\b(cholesterol)\b/i,
            /\b(testosterone)\b/i,
            /\b(estradiol)\b/i,
            // SIMPLE MOLECULES
            /\b(glucose)\b/i,
            /\b(ethanol)\b/i,
            /\b(acetone)\b/i,
            /\b(benzene)\b/i,
            // ALKALOIDS
            /\b(morphine)\b/i,
            /\b(nicotine)\b/i,
        ];
        
        for (const pattern of compoundPatterns) {
            const match = text.match(pattern);
            if (match) {
                knownName = match[1];
                break;
            }
        }
    }
    
    // Sanity check: reject garbage compound names that aren't real chemistry
    if (knownName) {
        const garbageNames = /^(not\s+applicable|n\/?a|unknown|none|unidentified|not\s+available|not\s+specified|no\s+name|no\s+data|image|photo|picture|diagram|figure|scientific\s+data|general|visual|text|document|file)$/i;
        if (garbageNames.test(knownName.trim())) {
            knownName = null;
        }
    }
    
    // Strategy 3: Extract from verbose Vision patterns like "appears to represent X" or "appears to be X"
    // This catches cases where Vision output is structured as sentences
    if (!knownName) {
        const verboseExtractionPatterns = [
            /(?:appears to (?:represent|be|show)|represents?|identified as|likely (?:is|to be)|seems to be|is (?:likely|probably))\s+(?:a\s+)?(?:compound\s+)?(?:called\s+|known as\s+)?([A-Za-z][A-Za-z0-9\-]*(?:[\s\-][A-Za-z0-9\-]+)*?)(?:\s*\(|\s*,|\s*\.|\s*with|\s*compound|\s*molecule|\s*structure|\s+the\b|$)/i,
            /(?:This|The)\s+(?:compound|structure|molecule)\s+(?:is|appears to be|represents?)\s+([A-Za-z][A-Za-z0-9\-]+(?:\s+[A-Za-z0-9\-]+)*?)(?:\s*\(|\s*,|\s*\.|\s+the\b|$)/i,
        ];
        
        for (const pattern of verboseExtractionPatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                let candidate = match[1].trim();
                // Clean common trailing words
                candidate = candidate.replace(/\s+(compound|molecule|structure|chemical|with|formula)$/i, '').trim();
                // Reject single letters or very short strings
                if (candidate.length > 2 && !/^(a|an|the|this|it)$/i.test(candidate)) {
                    knownName = candidate;
                    break;
                }
            }
        }
    }
    
    // Final sanity check on knownName after all strategies
    if (knownName) {
        const garbageNames = /^(not\s+applicable|n\/?a|unknown|none|unidentified|not\s+available|not\s+specified|no\s+name|no\s+data|image|photo|picture|diagram|figure|scientific\s+data|general|visual|text|document|file)$/i;
        if (garbageNames.test(knownName.trim())) {
            console.log(`🧪 extractFormulaAndKnownName: Rejected garbage name "${knownName}"`);
            knownName = null;
        }
    }
    
    return { formula, knownName };
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

// ===== SCHOLASTIC DOMAIN CLASSIFIER =====
// Multi-signal scoring: determines what an image is ABOUT (subject) vs what tools it uses
// Hierarchy: pure-math → applied-math → domain sciences (chemistry, engineering, etc.)
// Key insight: "contains math" ≠ "is about math" — equations in a chemistry paper = chemistry
const SCHOLASTIC_DOMAINS = {
    'pure-math': {
        subject: [
            'theorem', 'proof', 'lemma', 'corollary', 'axiom', 'postulate', 'qed',
            'pythagor', 'gougu', 'euclid', 'fermat', 'riemann', 'gauss',
            'number theory', 'set theory', 'topology', 'abstract algebra',
            'geometric proof', 'geometric construction', 'mathematical proof',
            'congruence', 'similarity', 'bisect', 'perpendicular',
            'hypotenuse', 'right triangle', 'square root', 'irrational',
            'fibonacci', 'prime number', 'factorial', 'combinatori',
            'integral calculus', 'differential calculus', 'mathematical induction',
            'grid.based', 'grid.pattern', 'puzzle', 'sudoku', 'magic square'
        ],
        tool: [
            'equation', 'formula', 'variable', 'function', 'graph',
            'algebra', 'calculus', 'trigonometr', 'geometry', 'geometric',
            'mathematical', 'triangle', 'circle', 'angle', 'matrix'
        ],
        subjectWeight: 3.0,
        toolWeight: 0.3
    },
    'chemistry': {
        subject: [
            'molecule', 'molecular', 'benzene', 'inorganic',
            'reagent', 'solvent', 'cation', 'anion',
            'hydroxyl', 'methyl', 'ethyl', 'phenyl', 'amino', 'carboxyl',
            'polymer', 'monomer', 'catalyst',
            'distill', 'titrat', 'chromatograph', 'spectro',
            'crystallin', 'isomer', 'enantiomer', 'racemic', 'stereochem',
            'pharmacolog', 'metabol', 'chemical structure', 'chemical bond',
            'covalent', 'ionic bond', 'valence', 'electron shell',
            'periodic table', 'molar', 'stoichiometr', 'chemical reaction',
            'buffer solution', 'precipitat'
        ],
        tool: [
            'chemical', 'formula', 'bond', 'element', 'reaction',
            'compound', 'organic', 'atom', 'ion', 'acid', 'base',
            'oxidation', 'reduction', 'synthesis', 'orbital', 'ph '
        ],
        subjectWeight: 3.0,
        toolWeight: 0.5
    },
    'engineering': {
        subject: [
            'circuit', 'resistor', 'capacitor', 'inductor', 'transistor',
            'voltage', 'current', 'ohm', 'watt', 'amplifier',
            'load.bearing', 'stress.strain', 'tensile', 'shear force',
            'beam', 'truss', 'structural', 'material science',
            'thermodynamic', 'heat transfer', 'fluid mechanic',
            'hydraulic', 'pneumatic', 'gear', 'torque', 'rpm',
            'blueprint', 'cad', 'technical drawing', 'cross.section',
            'wiring', 'pcb', 'microcontroller', 'plc', 'signal processing'
        ],
        tool: [
            'diagram', 'schematic', 'system', 'design', 'component'
        ],
        subjectWeight: 3.0,
        toolWeight: 0.3
    },
    'biology': {
        subject: [
            'cell', 'mitosis', 'meiosis', 'dna', 'rna', 'protein',
            'enzyme', 'photosynthesis', 'respiration', 'chromosome',
            'gene', 'allele', 'phenotype', 'genotype', 'organism',
            'taxonomy', 'species', 'ecosystem', 'ecology',
            'anatomy', 'physiology', 'tissue', 'organ', 'neuron',
            'bacteria', 'virus', 'pathogen', 'antibody', 'antigen',
            'microscop', 'botanical', 'zoologic', 'marine biology'
        ],
        tool: [
            'biological', 'living', 'growth', 'reproduction'
        ],
        subjectWeight: 3.0,
        toolWeight: 0.3
    },
    'finance': {
        subject: [
            'stock', 'bond', 'equity', 'dividend', 'portfolio',
            'balance sheet', 'income statement', 'cash flow',
            'depreciation', 'amortization', 'revenue', 'profit margin',
            'interest rate', 'inflation', 'gdp', 'fiscal',
            'derivative', 'option', 'futures', 'hedge', 'swap',
            'yield curve', 'credit risk', 'market cap', 'ipo'
        ],
        tool: [
            'financial', 'economic', 'market', 'investment', 'accounting'
        ],
        subjectWeight: 3.0,
        toolWeight: 0.3
    }
};

function classifyScholasticDomain(description) {
    if (!description) return { domain: 'general', confidence: 0, scores: {} };
    
    const descLow = description.toLowerCase();
    const scores = {};
    
    const descNorm = descLow.replace(/[.\-_]/g, ' ');
    
    function matchTerm(term, text) {
        const hasSpace = term.includes(' ');
        if (hasSpace) {
            return text.includes(term.toLowerCase());
        }
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}`, 'i').test(text);
    }
    
    for (const [domain, config] of Object.entries(SCHOLASTIC_DOMAINS)) {
        let score = 0;
        let subjectHits = 0;
        let toolHits = 0;
        const matchedSubjects = [];
        const matchedTools = [];
        
        for (const term of config.subject) {
            if (matchTerm(term, descNorm)) {
                score += config.subjectWeight;
                subjectHits++;
                matchedSubjects.push(term);
            }
        }
        
        for (const term of config.tool) {
            if (matchTerm(term, descNorm)) {
                score += config.toolWeight;
                toolHits++;
                matchedTools.push(term);
            }
        }
        
        scores[domain] = { score, subjectHits, toolHits, matchedSubjects, matchedTools };
    }
    
    const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
    const top = sorted[0];
    const runner = sorted[1];
    
    const activeDomains = sorted.filter(([, s]) => s.score > 0);
    if (activeDomains.length > 1) {
        console.log(`📚 Scholastic signals: ${activeDomains.map(([d, s]) => `${d}(S:${s.subjectHits}[${s.matchedSubjects.join(',')}] T:${s.toolHits}[${s.matchedTools.join(',')}] =${s.score.toFixed(1)})`).join(' | ')}`);
    }
    
    if (top[1].score === 0) {
        return { domain: 'general', confidence: 0, scores };
    }
    
    if (top[1].subjectHits === 0) {
        return { domain: 'general', confidence: 0.2, scores, note: 'tool-only signals, no subject match' };
    }
    
    // Cross-domain conflict: pure-math overrides chemistry when math has clear subject presence
    // and chemistry is NOT strongly dominant (i.e., chemistry lacks strong unique subject hits)
    if (top[0] === 'chemistry' && scores['pure-math']?.subjectHits > 0) {
        const mathScore = scores['pure-math'];
        const chemScore = top[1];
        // Override only when: math has subject hits AND chemistry subject hits are weak (<=2)
        // This protects legitimate chemistry (molecular, benzene, reagent etc. = high subject hits)
        if (mathScore.subjectHits > 0 && chemScore.subjectHits <= 2) {
            console.log(`📚 Scholastic OVERRIDE: chemistry → pure-math (math subjects=${mathScore.subjectHits}, chem subjects=${chemScore.subjectHits} — chemistry too weak to dominate)`);
            const confidence = Math.min(0.99, 0.5 + mathScore.subjectHits * 0.1);
            return {
                domain: 'pure-math',
                confidence: Math.round(confidence * 100) / 100,
                subjectHits: mathScore.subjectHits,
                toolHits: mathScore.toolHits,
                scores,
                override: `chemistry → pure-math`
            };
        }
    }
    
    const dominance = runner[1].score > 0 ? top[1].score / runner[1].score : 10;
    const confidence = Math.min(0.99, 0.5 + (dominance - 1) * 0.15 + top[1].subjectHits * 0.08);
    
    return {
        domain: top[0],
        confidence: Math.round(confidence * 100) / 100,
        subjectHits: top[1].subjectHits,
        toolHits: top[1].toolHits,
        scores
    };
}

function scholasticToContentType(classification) {
    switch (classification.domain) {
        case 'chemistry': return 'chemical';
        case 'pure-math': return 'diagram';
        case 'engineering': return 'diagram';
        case 'biology': return 'diagram';
        case 'finance': return 'chart';
        default: return 'visual';
    }
}

// Chemistry harm-reduction enrichment template (for structured answers)
function createChemistryEnrichmentTemplate(compoundName) {
    return `
[INSTRUCTION: Using the reference data below, write a harm-reduction profile for ${compoundName || 'this compound'}. Do NOT describe this instruction or the reference data — directly provide the information using EXACTLY these section headers in bold:]

**Uses & Applications:**
(Summarize medical, recreational, research, or other uses from the reference data)

**Metabolism & Pharmacology:**
(How the compound is processed by the body — absorption, liver metabolism, metabolites, excretion)

**Side Effects:**
(Common adverse effects, contraindications)

**Abuse Potential:**
(Addictiveness, psychological/physical dependence risk, overdose susceptibility)

**Toxicity & Lethal Doses:**
(LD50 if available, lethal dose ranges, toxic thresholds)

**Reversal Agents & Treatment:**
(Specific antidotes like naloxone for opioids, flumazenil for benzodiazepines, or supportive care)

[If data is unavailable for a section, write "Insufficient data" under that header. Be direct and factual — no filler.]
`;
}

// Enrich chemistry context with parallel DDG queries before final Groq response
async function enrichChemistryContext(formula, structureDescription = '', knownCompoundName = null, options = {}) {
    const results = { formulaContext: null, structureContext: null, compoundContext: null };
    
    // Extract compound name from structure description if not provided
    if (!knownCompoundName && structureDescription) {
        const { knownName } = extractFormulaAndKnownName(structureDescription);
        knownCompoundName = knownName;
    }
    
    console.log(`🔬 Chemistry Enrichment: Running parallel DDG queries...${knownCompoundName ? ` (compound hint: ${knownCompoundName})` : ''}`);
    
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
    
    // Query 3: Direct compound name search (highest success rate with DDG)
    if (knownCompoundName) {
        // Clean compound name - strip leading punctuation/bullets
        let cleanName = knownCompoundName.replace(/^[\-\*\•\·\>\s]+/, '').replace(/[^\w\s-]/g, '').trim();
        
        // Extra safety: reject verbose phrases that slipped through extraction
        const verboseCheck = /^(the\s+(compound|structure|molecule)|this|it|appears\s+to|seems\s+to|likely|possibly|probably|compound\s+appears)/i;
        if (verboseCheck.test(cleanName)) {
            console.log(`🔬 DDG Query 3: Skipped - verbose phrase detected: "${cleanName}"`);
            cleanName = null;
        }
        
        if (!cleanName) {
            // Skip Query 3 if no valid compound name
        } else {
        // Map common abbreviations to full chemical names for better DDG results
        const chemicalNameMap = {
            'thc': 'tetrahydrocannabinol',
            'cbd': 'cannabidiol',
            'lsd': 'lysergic acid diethylamide',
            'mdma': 'methylenedioxymethamphetamine',
            'gaba': 'gamma aminobutyric acid',
            'dmt': 'dimethyltryptamine',
            'pcp': 'phencyclidine',
            'ghb': 'gamma hydroxybutyrate'
        };
        
        // Try full name first, then abbreviation
        const fullName = chemicalNameMap[cleanName.toLowerCase()] || null;
        const queryName = fullName || cleanName;
        
        console.log(`🔬 DDG Query 3: "${queryName}"${fullName ? ` (expanded from ${cleanName})` : ''}`);
        
        const compoundPromise = axios.get(`https://api.duckduckgo.com/?${querystring.stringify({
            q: queryName,
            format: 'json',
            no_html: 1,
            skip_disambig: 1,
            t: 'nyanbook'
        })}`, { timeout: 5000 }).then(async res => {
            if (res.data.AbstractText) {
                console.log(`🔬 DDG Query 3: ✓ Found context for compound name`);
                return {
                    type: 'compound',
                    name: res.data.Heading || cleanName,
                    description: res.data.AbstractText,
                    source: res.data.AbstractURL || 'DuckDuckGo',
                    searchedName: queryName
                };
            }
            // Fallback: try abbreviation if we expanded
            if (fullName && cleanName !== queryName) {
                console.log(`🔬 DDG Query 3b: Trying "${cleanName}" as fallback`);
                const fallbackRes = await axios.get(`https://api.duckduckgo.com/?${querystring.stringify({
                    q: cleanName,
                    format: 'json',
                    no_html: 1,
                    skip_disambig: 1,
                    t: 'nyanbook'
                })}`, { timeout: 5000 });
                if (fallbackRes.data.AbstractText) {
                    console.log(`🔬 DDG Query 3b: ✓ Found context via fallback`);
                    return {
                        type: 'compound',
                        name: fallbackRes.data.Heading || cleanName,
                        description: fallbackRes.data.AbstractText,
                        source: fallbackRes.data.AbstractURL || 'DuckDuckGo',
                        searchedName: cleanName
                    };
                }
            }
            return null;
        }).catch(err => {
            console.log(`🔬 DDG Query 3: Failed - ${err.message}`);
            return null;
        });
        
        promises.push(compoundPromise.then(r => { results.compoundContext = r; }));
        }
    }
    
    // Wait for all queries in parallel
    await Promise.all(promises);
    
    // === Wikipedia API: Fetch full context if any enrichment succeeded (n > 0) ===
    // Replaces DDG Query 4-5 with structured Wikipedia JSON
    let wikipediaContext = null;
    
    const hasEnrichment = results.formulaContext || results.structureContext || results.compoundContext;
    
    if (hasEnrichment) {
        // Determine best compound name for Wikipedia lookup
        const wikiSearchName = results.compoundContext?.name || 
                               results.formulaContext?.name || 
                               results.structureContext?.name;
        
        if (wikiSearchName) {
            // Acronym expansion map - guaranteed first-try match for common compounds
            const acronymMap = {
                'THC': 'Tetrahydrocannabinol',
                'CBD': 'Cannabidiol',
                'CBG': 'Cannabigerol',
                'CBN': 'Cannabinol',
                'CBC': 'Cannabichromene',
                'LSD': 'Lysergic acid diethylamide',
                'MDMA': '3,4-Methylenedioxymethamphetamine',
                'DMT': 'N,N-Dimethyltryptamine',
                'PCP': 'Phencyclidine',
                'GHB': 'Gamma-Hydroxybutyric acid'
            };
            
            // Expand acronym if recognized (case-insensitive match)
            const expandedName = acronymMap[wikiSearchName.toUpperCase()] || wikiSearchName;
            
            // Clean compound name for Wikipedia URL (remove parenthetical abbreviations)
            const cleanWikiName = expandedName
                .replace(/\s*\([^)]*\)\s*/g, '') // Remove (THC), (CBD), etc.
                .trim()
                .replace(/\s+/g, '_'); // Replace spaces with underscores
            
            console.log(`📚 Wikipedia API: Fetching full context for "${cleanWikiName}"...`);
            
            try {
                // Use Action API with prop=extracts for longer content (up to 2000 chars)
                // REST API only returns ~400 chars, Action API gives full intro section
                const wikiResponse = await axios.get(
                    `https://en.wikipedia.org/w/api.php`,
                    { 
                        timeout: 8000,
                        params: {
                            action: 'query',
                            titles: cleanWikiName,
                            prop: 'extracts|info',
                            exchars: 5000,           // Up to 5000 chars (full article for harm-reduction coverage)
                            explaintext: 1,          // Plain text, no HTML
                            inprop: 'url',           // Include page URL
                            format: 'json',
                            formatversion: 2,        // Modern JSON: pages as array, not object
                            redirects: 1,            // Follow redirects: THC → Tetrahydrocannabinol
                            origin: '*'              // CORS support
                        },
                        headers: {
                            'User-Agent': 'NyanBook/1.0 (https://nyanbook.com; contact@nyanbook.com)'
                        }
                    }
                );
                
                // Parse Action API response with formatversion=2: { query: { pages: [ { ... } ] } }
                const pages = wikiResponse.data?.query?.pages;
                if (pages && pages.length > 0) {
                    const page = pages[0]; // formatversion=2 returns array
                    
                    // Check for valid page (missing: true means page not found)
                    if (!page.missing && page.extract) {
                        wikipediaContext = {
                            title: page.title,
                            description: '', // Action API doesn't return description
                            extract: page.extract, // Full article content (up to 5000 chars - includes uses, side effects, abuse potential)
                            source: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
                            type: 'standard'
                        };
                        console.log(`📚 Wikipedia API: ✓ Retrieved ${wikipediaContext.extract.length} chars for "${wikipediaContext.title}"`);
                    } else if (page.missing) {
                        console.log(`📚 Wikipedia API: Page not found for "${cleanWikiName}"`);
                    } else {
                        console.log(`📚 Wikipedia API: No extract for "${cleanWikiName}"`);
                    }
                }
            } catch (wikiErr) {
                console.log(`📚 Wikipedia API: Failed - ${wikiErr.message}`);
                // Fallback: Wikipedia context remains null, DDG context still available
            }
        }
    }
    
    // Format enrichment context for prompt injection
    let contextText = '';
    
    // Priority: Wikipedia full context > compound context > formula context > structure context
    // Wikipedia provides comprehensive info including uses and metabolism
    if (wikipediaContext && wikipediaContext.extract) {
        if (!options.suppressTemplate) {
            contextText += createChemistryEnrichmentTemplate(wikipediaContext.title);
        }
        contextText += `\n### 📚 Reference Data (${wikipediaContext.title}):\n`;
        if (wikipediaContext.description) {
            contextText += `**${wikipediaContext.description}**\n\n`;
        }
        contextText += `${wikipediaContext.extract}\n`;
        contextText += `Source: ${wikipediaContext.source}\n`;
    } else if (results.compoundContext) {
        if (!options.suppressTemplate) {
            contextText += createChemistryEnrichmentTemplate(results.compoundContext.name);
        }
        contextText += `\n### 🔬 Reference Data (${results.compoundContext.name}):\n`;
        contextText += `${results.compoundContext.description}\n`;
        contextText += `Source: ${results.compoundContext.source}\n`;
    } else if (knownCompoundName || formula) {
        const fallbackName = knownCompoundName || formula;
        const isGenericFallback = /^(unknown|unverified|unidentified|puzzle|grid|geometric|figure|pattern|more related)/i.test(fallbackName);
        if (!isGenericFallback && !options.suppressTemplate) {
            console.log(`🧪 Chemistry Enrichment: DDG/Wikipedia failed, using template fallback for "${fallbackName}"`);
            contextText += createChemistryEnrichmentTemplate(fallbackName);
            contextText += `\n### 🔬 Compound Analysis (${fallbackName}):\n`;
            contextText += `Vision identified this compound but external verification was unavailable.\n`;
            contextText += `Use your chemistry knowledge to provide the information requested above.\n`;
        } else {
            console.log(`🧪 Chemistry Enrichment: Skipping template for generic/suppressed name "${fallbackName}"`);
        }
    }
    
    // Add formula context only if different from main compound
    if (results.formulaContext && 
        results.formulaContext.name !== results.compoundContext?.name &&
        results.formulaContext.name !== wikipediaContext?.title) {
        contextText += `\n### 🔬 Formula Context (${formula}):\n`;
        contextText += `**${results.formulaContext.name}**: ${results.formulaContext.description}\n`;
        contextText += `Source: ${results.formulaContext.source}\n`;
    }
    
    // Add structure context only if different
    if (results.structureContext && 
        results.structureContext.name !== results.formulaContext?.name &&
        results.structureContext.name !== results.compoundContext?.name &&
        results.structureContext.name !== wikipediaContext?.title) {
        contextText += `\n### 🔬 Structure Context:\n`;
        contextText += `**${results.structureContext.name}**: ${results.structureContext.description}\n`;
        contextText += `Source: ${results.structureContext.source}\n`;
    }
    
    // Determine verified compound info (compound context has highest priority)
    let verifiedCompound = null;
    if (results.compoundContext) {
        verifiedCompound = {
            name: results.compoundContext.name,
            description: results.compoundContext.description,
            source: results.compoundContext.source,
            matchedFormula: formula,
            matchType: 'ddg-verified'
        };
        // Extract canonical formula from DDG description if present
        const canonicalMatch = results.compoundContext.description.match(/C\d+H\d+(?:O\d*)?(?:N\d*)?/);
        if (canonicalMatch) {
            verifiedCompound.canonicalFormula = canonicalMatch[0];
            console.log(`🔬 Canonical formula from DDG: ${canonicalMatch[0]}`);
        }
    } else if (results.formulaContext) {
        verifiedCompound = {
            name: results.formulaContext.name,
            description: results.formulaContext.description,
            source: results.formulaContext.source,
            matchedFormula: formula,
            matchType: 'ddg-verified'
        };
        const canonicalMatch = results.formulaContext.description.match(/C\d+H\d+(?:O\d*)?(?:N\d*)?/);
        if (canonicalMatch) {
            verifiedCompound.canonicalFormula = canonicalMatch[0];
            console.log(`🔬 Canonical formula from DDG: ${canonicalMatch[0]}`);
        }
    }
    
    console.log(`🔬 Chemistry Enrichment: Complete (formula: ${results.formulaContext ? '✓' : '✗'}, structure: ${results.structureContext ? '✓' : '✗'}, compound: ${results.compoundContext ? '✓' : '✗'}, wikipedia: ${wikipediaContext ? '✓' : '✗'})`);
    
    // Return enrichment data - context will be cleared after Groq finishes
    return {
        contextText,
        formulaContext: results.formulaContext,
        structureContext: results.structureContext,
        compoundContext: results.compoundContext,
        wikipediaContext, // Full Wikipedia JSON for reference
        verifiedCompound
    };
}

// ===== UNIFIED CHEMISTRY PIPELINE =====
// Tiered Epistemology: Stage 0 (settled) → Stage 0.5 (conflict) → Stage 1+ (discovery)
async function processChemistryContent(visionObservations) {
    // visionObservations: array of {description, contentType, ...}
    // Returns: { compoundInfo, chemistryEnrichment, enrichedText }
    
    if (!visionObservations || visionObservations.length === 0) {
        return null;
    }
    
    const chemicalObservations = visionObservations.filter(obs => {
        if (obs.contentType !== 'chemical') return false;
        const scholastic = classifyScholasticDomain(obs.description);
        if (scholastic.domain !== 'chemistry' && scholastic.domain !== 'general') {
            console.log(`🧪 Chemistry Pipeline: Rejected observation — scholastic domain is "${scholastic.domain}" not chemistry`);
            return false;
        }
        return true;
    });
    
    if (chemicalObservations.length === 0) {
        return null;
    }
    
    console.log(`🧪 Chemistry Pipeline: Processing ${chemicalObservations.length} chemical observation(s)`);
    
    // Combine all descriptions for extraction
    const allDescriptions = chemicalObservations.map(obs => obs.description || '').join('\n\n');
    
    // Extract formula and compound name from Vision
    const { formula, knownName } = extractFormulaAndKnownName(allDescriptions);
    
    if (!formula && !knownName) {
        console.log(`🧪 Chemistry Pipeline: No formula or compound name detected`);
        return null;
    }
    
    console.log(`🧪 Chemistry Pipeline: Formula=${formula || 'unknown'}, VisionName=${knownName || 'unknown'}`);
    
    // ===== STAGE 0: SETTLED SCIENCE CHECK (instant, no DDG) =====
    const settledScience = lookupSettledScience(formula);
    let compoundInfo = null;
    let chemistryEnrichment = null;
    let stage = null;
    
    if (settledScience) {
        const settledName = settledScience.name.split('(')[0].trim(); // Extract base name
        const visionNameLower = (knownName || '').toLowerCase();
        const settledNameLower = settledName.toLowerCase();
        
        // Check if Vision name is a known isomer of this formula
        const isKnownIsomer = settledScience.isomers && 
            settledScience.isomers.some(iso => visionNameLower.includes(iso.toLowerCase()));
        
        // Check for agreement: Vision name matches or is subset of settled name
        const visionAgrees = !knownName || 
            settledNameLower.includes(visionNameLower) || 
            visionNameLower.includes(settledNameLower.split(' ')[0]) ||
            visionNameLower.includes('thc') && settledNameLower.includes('tetrahydrocannabinol') ||
            visionNameLower.includes('tetrahydrocannabinol') && settledNameLower.includes('thc');
        
        if (visionAgrees || isKnownIsomer) {
            // ===== STAGE 0: INSTANT MATCH (Vision + Settled agree, or known isomer) =====
            // If Vision identifies a known isomer (e.g., CBD instead of THC), trust Vision
            const finalName = isKnownIsomer && knownName ? knownName : settledScience.name;
            const isomerNote = isKnownIsomer && knownName ? ` (Vision identified isomer: ${knownName})` : '';
            
            console.log(`⚡ Stage 0: SETTLED SCIENCE → ${finalName} (0.4s, 99% confidence)${isomerNote}`);
            stage = 'stage-0-settled';
            
            compoundInfo = {
                name: finalName,
                confidence: settledScience.confidence,
                source: `${settledScience.source} (Settled Science)`,
                matchedFormula: formula,
                matchType: isKnownIsomer ? 'settled-isomer' : 'settled-science'
            };
            
            // Still run DDG for enrichment context (uses, interactions) but skip compound identification
            chemistryEnrichment = await enrichChemistryContext(formula, allDescriptions, finalName.split('(')[0].trim());
            
        } else {
            // ===== STAGE 0.5: CONFLICT DETECTED (Vision ≠ Settled) =====
            console.log(`🚨 Stage 0.5: CONFLICT → Vision="${knownName}" vs Settled="${settledScience.name}"`);
            console.log(`🔍 Stage 0.5: Triggering DDG arbitration...`);
            stage = 'stage-0.5-conflict';
            
            // Run DDG to arbitrate the conflict
            chemistryEnrichment = await enrichChemistryContext(formula, allDescriptions, knownName);
            
            if (chemistryEnrichment.verifiedCompound) {
                const ddgName = chemistryEnrichment.verifiedCompound.name.toLowerCase();
                const visionWins = ddgName.includes(visionNameLower) || visionNameLower.includes(ddgName.split(' ')[0]);
                
                if (visionWins) {
                    console.log(`✅ Stage 0.5: DDG ARBITRATION → Vision wins (${knownName})`);
                    compoundInfo = {
                        name: knownName,
                        confidence: 0.85,
                        source: `DDG Verified (Vision confirmed over Settled)`,
                        matchedFormula: formula,
                        matchType: 'conflict-resolved-vision',
                        note: `Settled science suggested "${settledScience.name}" but DDG verified Vision claim`
                    };
                } else {
                    console.log(`✅ Stage 0.5: DDG ARBITRATION → Settled wins (${settledScience.name})`);
                    compoundInfo = {
                        name: settledScience.name,
                        confidence: 0.95,
                        source: `${settledScience.source} (DDG confirmed)`,
                        matchedFormula: formula,
                        matchType: 'conflict-resolved-settled',
                        note: `Vision claimed "${knownName}" but DDG verified Settled Science`
                    };
                }
            } else {
                // DDG inconclusive - trust settled science with lower confidence
                console.log(`⚠️ Stage 0.5: DDG inconclusive → Defaulting to Settled (${settledScience.name})`);
                compoundInfo = {
                    name: settledScience.name,
                    confidence: 0.75,
                    source: `${settledScience.source} (conflict unresolved)`,
                    matchedFormula: formula,
                    matchType: 'conflict-unresolved',
                    note: `Vision claimed "${knownName}", DDG inconclusive, using Settled Science`
                };
            }
        }
    } else {
        // ===== STAGE 1+: DISCOVERY CASCADE (no settled science match) =====
        console.log(`🔬 Stage 1+: DISCOVERY CASCADE → No settled science for ${formula || knownName}`);
        stage = 'stage-1-discovery';
        
        // Full DDG enrichment for novel compounds
        chemistryEnrichment = await enrichChemistryContext(formula, allDescriptions, knownName);
        
        if (chemistryEnrichment.verifiedCompound) {
            compoundInfo = {
                ...chemistryEnrichment.verifiedCompound,
                confidence: 0.85,
                matchType: 'ddg-discovered'
            };
            console.log(`✅ Stage 1: DDG DISCOVERED → ${compoundInfo.name} (85% confidence)`);
        } else if (knownName) {
            compoundInfo = {
                name: `${knownName} (unverified)`,
                confidence: 0.50,
                source: 'Groq Vision (unverified)',
                matchedFormula: formula,
                matchType: 'vision-hypothesis'
            };
            console.log(`⚠️ Stage 1: UNVERIFIED → ${knownName} (50% confidence, needs human verification)`);
        }
    }
    
    // Build enriched text section
    let enrichedText = '';
    
    if (compoundInfo && compoundInfo.name) {
        enrichedText += `\n\n### 🔬 Compound Identification:\n**Name:** ${compoundInfo.name}`;
        if (compoundInfo.canonicalFormula) {
            enrichedText += `\n**Formula:** ${compoundInfo.canonicalFormula}`;
        } else if (formula) {
            enrichedText += `\n**Formula:** ${formula}`;
        }
        enrichedText += `\n**Confidence:** ${Math.round((compoundInfo.confidence || 0.5) * 100)}%`;
        enrichedText += `\n**Source:** ${compoundInfo.source}`;
        if (compoundInfo.note) {
            enrichedText += `\n**Note:** ${compoundInfo.note}`;
        }
    }
    
    // Add DDG context
    if (chemistryEnrichment && chemistryEnrichment.contextText) {
        enrichedText += chemistryEnrichment.contextText;
    }
    
    return {
        compoundInfo,
        chemistryEnrichment,
        enrichedText,
        formula,
        knownName,
        stage
    };
}

// HARMONIZED: Use shared DocumentExtractionCache from data-package.js
// This unifies caching across the pipeline
function getCacheKey(buffer) {
    return computeDocHash(buffer);
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
    // HARMONIZED: Use shared DocumentExtractionCache from data-package.js
    const cacheKey = getCacheKey(buffer);
    const tenantId = options.tenantId || 'global';
    const cached = globalDocCache.get(cacheKey, tenantId);
    
    if (cached) {
        console.log(`📦 Cache HIT for ${fileName} (${cacheKey.slice(0, 8)}...)`);
        return { ...cached, fromCache: true };
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
    
    // HARMONIZED: Cache successful extractions in shared cache
    if (result.success) {
        globalDocCache.set(cacheKey, result, tenantId);
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
        // Use hybrid parser which extracts ALL pages (not just first page)
        const result = await parsePDFHybrid(buffer, fileName);
        
        const pdfData = {
            text: result.text || '',
            pageCount: result.pageCount || 1,
            truncated: result.truncated || false
        };
        
        // Run Financial Physics (includes built-in 5-line guard for non-financial data)
        if (pdfData.text.length > 100) {
            try {
                const financialAnalysis = await analyzeFinancialDocument({ text: pdfData.text });
                if (financialAnalysis && financialAnalysis.documentType?.type !== 'non_financial') {
                    pdfData.financialAnalysis = financialAnalysis;
                    console.log(`📊 PDF Financial Physics: ${financialAnalysis.documentType.type} (${financialAnalysis.classifications?.length || 0} items classified)`);
                }
            } catch (finErr) {
                console.log(`⚠️ PDF Financial Physics skipped: ${finErr.message}`);
            }
        }
        
        return { success: true, data: pdfData };
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
        let totalComputedValues = 0;
        let totalFormulaWarnings = [];
        
        workbook.eachSheet((sheet) => {
            const sheetData = {
                name: sheet.name,
                rows: [],
                headers: [],
                structuredRows: [],
                mergedCells: [],
                computedValues: 0,
                formulaWarnings: []
            };
            
            const mergedRanges = [];
            if (sheet.hasMerges) {
                Object.keys(sheet._merges || {}).forEach(key => {
                    mergedRanges.push(key);
                });
            }
            sheetData.mergedCells = mergedRanges;
            
            let columnHeaders = [];
            let lastNonEmptyRow = 0;
            
            sheet.eachRow({ includeEmpty: true }, (row, rowNum) => {
                const values = [];
                const cellDetails = [];
                let rowHasContent = false;
                let firstCellValue = '';
                let firstCellIndent = 0;
                let firstCellBold = false;
                
                row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                    let value = null;
                    let numericValue = null;
                    let displayValue = '';
                    let isFormula = false;
                    let isComputed = false;
                    
                    if (cell.value !== null && cell.value !== undefined) {
                        rowHasContent = true;
                        
                        if (typeof cell.value === 'object') {
                            // PRIORITY 1: Formula with cached result (Excel computed it)
                            if (cell.value.formula && cell.value.result !== undefined) {
                                value = cell.value.result;
                                numericValue = typeof value === 'number' ? value : null;
                                isFormula = true;
                                isComputed = true;
                                sheetData.computedValues++;
                            }
                            // PRIORITY 2: Formula WITHOUT cached result (show as text warning)
                            else if (cell.value.formula) {
                                value = `=${cell.value.formula}`;
                                isFormula = true;
                                isComputed = false;
                                sheetData.formulaWarnings.push({
                                    cell: cell.address,
                                    formula: cell.value.formula,
                                    sheet: sheet.name
                                });
                            }
                            // PRIORITY 3: Rich text or hyperlink
                            else if (cell.value.result !== undefined) {
                                value = cell.value.result;
                                numericValue = typeof value === 'number' ? value : null;
                            } else if (cell.value.text !== undefined) {
                                value = cell.value.text;
                            } else if (cell.value.richText) {
                                value = cell.value.richText.map(rt => rt.text).join('');
                            } else {
                                value = String(cell.value);
                            }
                        } else if (typeof cell.value === 'number') {
                            value = cell.value;
                            numericValue = cell.value;
                        } else {
                            value = String(cell.value);
                        }
                        
                        displayValue = value !== null ? String(value) : '';
                    }
                    
                    const isBold = cell.font?.bold || false;
                    const indent = cell.alignment?.indent || 0;
                    const isMerged = mergedRanges.some(range => {
                        const match = range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);
                        if (match) {
                            const startCol = match[1].charCodeAt(0) - 64;
                            const startRow = parseInt(match[2]);
                            const endCol = match[3].charCodeAt(0) - 64;
                            const endRow = parseInt(match[4]);
                            return rowNum >= startRow && rowNum <= endRow && colNum >= startCol && colNum <= endCol;
                        }
                        return false;
                    });
                    
                    if (colNum === 1) {
                        firstCellValue = displayValue;
                        firstCellIndent = indent;
                        firstCellBold = isBold;
                    }
                    
                    values.push(displayValue);
                    cellDetails.push({
                        value: value,
                        numericValue: numericValue,
                        displayValue: displayValue,
                        isBold: isBold,
                        indent: indent,
                        isMerged: isMerged,
                        isFormula: isFormula,
                        isComputed: isComputed,
                        col: colNum
                    });
                });
                
                if (rowNum === 1 || (rowNum <= 3 && !columnHeaders.length && rowHasContent)) {
                    const hasOnlyText = cellDetails.every(c => c.numericValue === null || c.value === '');
                    if (hasOnlyText && rowHasContent) {
                        columnHeaders = values.filter(v => v && v.trim());
                        sheetData.headers = columnHeaders;
                    }
                }
                
                const isEmptyRow = !rowHasContent || values.every(v => !v || v.trim() === '');
                const gapFromPrevious = rowNum - lastNonEmptyRow;
                
                sheetData.rows.push(values);
                sheetData.structuredRows.push({
                    rowNum: rowNum,
                    label: firstCellValue,
                    values: values.slice(1),
                    numericValues: cellDetails.slice(1).map(c => c.numericValue),
                    isBold: firstCellBold,
                    indent: firstCellIndent,
                    isEmpty: isEmptyRow,
                    gapBefore: gapFromPrevious > 1,
                    columnHeaders: columnHeaders.slice(1),
                    cellDetails: cellDetails
                });
                
                if (rowHasContent) {
                    lastNonEmptyRow = rowNum;
                }
            });
            
            // Aggregate stats for this sheet
            totalComputedValues += sheetData.computedValues;
            totalFormulaWarnings = totalFormulaWarnings.concat(sheetData.formulaWarnings);
            
            sheets.push(sheetData);
        });
        
        // Excel stats for Groq context
        const excelStats = {
            computedValues: totalComputedValues,
            formulaWarnings: totalFormulaWarnings,
            hasUncomputedFormulas: totalFormulaWarnings.length > 0
        };
        
        if (totalComputedValues > 0) {
            console.log(`✅ Excel: ${totalComputedValues} pre-computed values (cached by Excel)`);
        }
        if (totalFormulaWarnings.length > 0) {
            console.log(`⚠️ Excel: ${totalFormulaWarnings.length} formulas without cached values (shown as text)`);
        }
        
        const excelData = { tables: sheets, type: 'excel', enhanced: true, stats: excelStats };
        
        // Run Financial Physics (includes built-in 5-line guard for non-financial data)
        try {
            const financialAnalysis = await analyzeFinancialDocument({ tables: sheets });
            if (financialAnalysis && financialAnalysis.documentType?.type !== 'non_financial') {
                console.log(`🧠 Financial Physics: ${financialAnalysis.documentType.type} (${(financialAnalysis.documentType.confidence * 100).toFixed(1)}%)`);
                excelData.financialAnalysis = financialAnalysis;
            }
        } catch (physicsErr) {
            console.log(`⚠️ Financial physics skipped: ${physicsErr.message}`);
        }
        
        return { success: true, data: excelData };
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
            
            const scholastic = classifyScholasticDomain(description);
            let contentType = scholasticToContentType(scholastic);
            if (contentType === 'visual') {
                const descLow = description.toLowerCase();
                if (/\b(chart|graph|plot|histogram)\b/i.test(descLow)) contentType = 'chart';
                else if (/\b(diagram|schematic|flowchart)\b/i.test(descLow)) contentType = 'diagram';
            }
            console.log(`📚 Scholastic: ${scholastic.domain} (confidence: ${scholastic.confidence}, subject: ${scholastic.subjectHits || 0}, tool: ${scholastic.toolHits || 0})`);
            
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
    
    // Format visual descriptions
    const formattedVisuals = visualDescriptions.map(vc => {
        const typeLabel = vc.contentType === 'chemical' ? '🧪 Chemical Structure' :
                          vc.contentType === 'chart' ? '📊 Chart/Graph' :
                          vc.contentType === 'diagram' ? '📐 Diagram' : '🖼️ Visual';
        return `**Image ${vc.index} (${typeLabel}):**\n${vc.description}`;
    }).join('\n\n');
    
    // Use unified chemistry pipeline (topic-based, not format-based)
    const chemistryResult = await processChemistryContent(visualDescriptions);
    const chemicalStructures = visualDescriptions.filter(vc => vc.contentType === 'chemical');
    
    return {
        success: true,
        data: {
            text: `\n### Visual Content Analysis:\n${formattedVisuals}${chemistryResult?.enrichedText || ''}`,
            visualContent: visualDescriptions,
            chemicalStructures: chemicalStructures,
            compoundInfo: chemistryResult?.compoundInfo || null,
            chemistryEnrichment: chemistryResult?.chemistryEnrichment || null,
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
    const ext = (fileName || '').toLowerCase().split('.').pop();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext);
    
    try {
        let visualContent = [];
        
        if (isImage) {
            // Handle standalone images directly
            console.log(`🖼️ Image Visual: Analyzing ${fileName} with Groq Vision...`);
            const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN;
            
            if (!PLAYGROUND_GROQ_VISION_TOKEN) {
                return { success: false, error: 'Vision token not configured' };
            }
            
            const base64 = buffer.toString('base64');
            const contentType = ext === 'png' ? 'image/png' : 
                               ext === 'gif' ? 'image/gif' :
                               ext === 'webp' ? 'image/webp' : 'image/jpeg';
            
            // Analyze standalone image with same prompt as PDF pages
            const analysisResult = await analyzeImageWithGroqVision(
                base64, 
                contentType, 
                PLAYGROUND_GROQ_VISION_TOKEN,
                fileName
            );
            
            if (analysisResult) {
                visualContent.push({
                    page: 1,
                    contentType: analysisResult.contentType,
                    description: analysisResult.description
                });
            }
        } else {
            // Handle PDFs via page rendering
            const result = await analyzePDFVisualContent(buffer, fileName, { maxPages: 5 });
            
            if (!result.success || result.visualContent.length === 0) {
                return { success: false, error: result.error || 'No visual content extracted' };
            }
            visualContent = result.visualContent;
        }
        
        if (visualContent.length === 0) {
            return { success: false, error: 'No visual content extracted' };
        }
        
        // Format visual content for merging with text extraction
        const visualDescriptions = visualContent.map(vc => {
            const typeLabel = vc.contentType === 'chemical' ? '🧪 Chemical Structure' :
                              vc.contentType === 'chart' ? '📊 Chart/Graph' :
                              vc.contentType === 'diagram' ? '📐 Diagram' : '🖼️ Visual';
            const label = isImage ? 'Image' : `Page ${vc.page}`;
            return `**${label} (${typeLabel}):**\n${vc.description}`;
        }).join('\n\n');
        
        // Use unified chemistry pipeline (topic-based, not format-based)
        const chemistryResult = await processChemistryContent(visualContent);
        
        const chemicalStructures = visualContent.filter(vc => vc.contentType === 'chemical');
        const charts = visualContent.filter(vc => vc.contentType === 'chart');
        const diagrams = visualContent.filter(vc => vc.contentType === 'diagram');
        
        return { 
            success: true, 
            data: { 
                text: `\n### Visual Content Analysis:\n${visualDescriptions}${chemistryResult?.enrichedText || ''}`,
                visualContent: visualContent,
                charts: charts,
                chemicalStructures: chemicalStructures,
                diagrams: diagrams,
                compoundInfo: chemistryResult?.compoundInfo || null,
                chemistryEnrichment: chemistryResult?.chemistryEnrichment || null,
                type: isImage ? 'image-vision' : 'pdf-vision'
            }
        };
    } catch (error) {
        console.error(`❌ ${isImage ? 'Image' : 'PDF'} visual extraction error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Analyze a single image with Groq Vision (shared by all visual analysis paths)
async function analyzeImageWithGroqVision(base64, contentType, token, fileName) {
    const { AI_MODELS, GROQ_RETRY } = require('../config/constants');
    
    const systemPrompt = `You are a visual content analyzer specializing in scientific documents.
Analyze this image and identify:
1. Chemical structures (molecules, compounds, reactions)
2. Charts/graphs (data visualizations, plots)
3. Diagrams (flowcharts, schematics, technical drawings)

For chemical structures, provide:
- Molecular Formula: (e.g., C21H30O2)
- Known as: (compound name if recognizable, e.g., THC, caffeine, aspirin)
- Key functional groups visible
- Structural features

Respond with a clear description of what you observe.`;

    try {
        const response = await groqWithRetry(async () => {
            return await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: AI_MODELS.VISION,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: `${systemPrompt}\n\nAnalyze this image from ${fileName}:` },
                                { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } }
                            ]
                        }
                    ],
                    temperature: 0.1,
                    max_completion_tokens: 1024
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );
        }, GROQ_RETRY.MAX_RETRIES);
        
        const description = response.data.choices?.[0]?.message?.content || '';
        
        const scholastic = classifyScholasticDomain(description);
        let contentType_result = scholasticToContentType(scholastic);
        if (contentType_result === 'visual') {
            const descLower = description.toLowerCase();
            if (/\b(chart|graph|plot|axis|data|trend|bar|line|pie)\b/i.test(descLower)) {
                contentType_result = 'chart';
            } else if (/\b(diagram|flow|schematic|process|step|arrow|box)\b/i.test(descLower)) {
                contentType_result = 'diagram';
            } else {
                contentType_result = 'general';
            }
        }
        
        console.log(`📚 Scholastic: ${scholastic.domain} (confidence: ${scholastic.confidence}, subject: ${scholastic.subjectHits || 0}, tool: ${scholastic.toolHits || 0}) → ${contentType_result}`);
        
        return {
            description,
            contentType: contentType_result
        };
    } catch (error) {
        const errData = error.response?.data || {};
        console.error(`❌ Groq Vision error for ${fileName}: ${error.message}`, JSON.stringify(errData));
        return null;
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
    
    // Preserve Excel stats for Groq context
    if (newData.stats) {
        merged.stats = newData.stats;
    }
    
    // Preserve financial analysis
    if (newData.financialAnalysis) {
        merged.financialAnalysis = newData.financialAnalysis;
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
        
        // Excel stats for Groq context
        if (result.extractedData.stats) {
            json.content.excelStats = result.extractedData.stats;
        }
        
        // Financial analysis
        if (result.extractedData.financialAnalysis) {
            json.content.financialAnalysis = result.extractedData.financialAnalysis;
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
    
    // Excel stats: inform Groq about data reliability
    if (json.content.excelStats) {
        const stats = json.content.excelStats;
        if (stats.computedValues > 0) {
            contextParts.push(`✅ **${stats.computedValues} pre-computed values** (cached by Excel - high reliability)`);
        }
        if (stats.hasUncomputedFormulas) {
            contextParts.push(`⚠️ **${stats.formulaWarnings.length} formulas without cached values** (shown as formula text)`);
            // Show first 5 warnings
            const sampleWarnings = stats.formulaWarnings.slice(0, 5);
            sampleWarnings.forEach(w => {
                contextParts.push(`   • ${w.cell}: =${w.formula}`);
            });
            if (stats.formulaWarnings.length > 5) {
                contextParts.push(`   ... and ${stats.formulaWarnings.length - 5} more`);
            }
        }
    }
    contextParts.push('---');
    
    if (json.content.financialAnalysis) {
        contextParts.push(formatPhysicsAnalysis(json.content.financialAnalysis));
        contextParts.push('---');
    }
    
    if (json.content.tables && json.content.tables.length > 0) {
        contextParts.push('### Extracted Tables:\n');
        
        // For financial documents, show more rows (up to 777) to capture full projections
        const isFinancial = !!json.content.financialAnalysis;
        const maxRows = isFinancial ? 777 : 50;
        
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
                    table.rows.slice(1, maxRows).forEach(row => {
                        contextParts.push(`| ${row.join(' | ')} |`);
                    });
                    if (table.rows.length > maxRows) {
                        contextParts.push(`\n[...${table.rows.length - maxRows} more rows truncated...]`);
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

/**
 * Process document for AI consumption
 * HARMONIZED: Wrapper function using shared cache from data-package.js
 * Returns { text, fileName, success } format expected by nyan-ai.js
 * 
 * @param {Buffer|string} buffer - Document content (Buffer or base64 string)
 * @param {string} fileName - Original file name
 * @param {string} mimeType - MIME type
 * @param {Object} options - Optional: { tenantId } for cache scoping
 */
async function processDocumentForAI(buffer, fileName, mimeType, options = {}) {
    try {
        // Handle base64 encoded data with proper detection
        let dataBuffer = buffer;
        if (typeof buffer === 'string') {
            // Strip data URL prefix if present
            const base64Match = buffer.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
                dataBuffer = Buffer.from(base64Match[1], 'base64');
            } else {
                // Detect if string is valid base64 or plain text
                // Base64 strings are typically longer and contain only valid chars
                const isBase64 = /^[A-Za-z0-9+/=]+$/.test(buffer) && buffer.length > 100;
                if (isBase64) {
                    dataBuffer = Buffer.from(buffer, 'base64');
                } else {
                    // Plain text - encode as UTF-8
                    dataBuffer = Buffer.from(buffer, 'utf-8');
                }
            }
        } else if (!Buffer.isBuffer(buffer)) {
            dataBuffer = Buffer.from(buffer);
        }
        
        // Get file type with fallback to TEXT for unknown types
        const fileType = identifyFileType(fileName, mimeType) || { 
            type: FILE_TYPES.TEXT, 
            extension: (fileName || '').split('.').pop() || 'txt',
            mime: mimeType || 'text/plain'
        };
        console.log(`📄 Processing document: ${fileName} (type: ${fileType.type})`);
        
        // HARMONIZED: Pass tenantId through for cache scoping
        const result = await executeExtractionCascade(dataBuffer, fileType, fileName, { 
            tenantId: options.tenantId 
        });
        
        if (result.success && result.extractedData) {
            // Build text from extracted data
            let text = '';
            
            if (result.extractedData.text) {
                text = result.extractedData.text;
            }
            
            // Append table data if present
            if (result.extractedData.tables && result.extractedData.tables.length > 0) {
                text += '\n\n--- TABLES ---\n';
                result.extractedData.tables.forEach((table, i) => {
                    text += `\nTable ${i + 1}:\n`;
                    if (table.headers) text += table.headers.join(' | ') + '\n';
                    if (table.rows) {
                        table.rows.forEach(row => {
                            text += row.join(' | ') + '\n';
                        });
                    }
                });
            }
            
            return {
                text: text.trim(),
                fileName,
                success: true,
                fileType: fileType.type,
                toolsUsed: result.toolsUsed
            };
        }
        
        return { text: '', fileName, success: false, error: 'No data extracted' };
    } catch (error) {
        console.error(`❌ processDocumentForAI error for ${fileName}:`, error.message);
        return { text: '', fileName, success: false, error: error.message };
    }
}

module.exports = {
    FILE_TYPES,
    DATA_STRUCTURES,
    COST_TIERS,
    identifyFileType,
    selectExtractionPipeline,
    executeExtractionCascade,
    formatJSONForGroq,
    getFinancialPhysicsSeed,
    processDocumentForAI,
    // New functions for multi-doc corporate support
    intelligentChunking,
    buildMultiDocContext,
    // Vision analysis for direct image processing
    analyzeImageWithGroqVision,
    // Chemistry enrichment for chemical structure analysis
    processChemistryContent,
    // Scholastic domain classifier
    classifyScholasticDomain,
    scholasticToContentType
};
