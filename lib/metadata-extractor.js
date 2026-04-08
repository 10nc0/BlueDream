const logger = require("./logger");
/**
 * Metadata Extractor - Universal tagging system
 * 
 * Philosophy: Any input can be a tag. Support all cultures, languages, and formats.
 * 
 * Tag Types:
 *   - Plain tags: "bug", "hello", "yes" (any word)
 *   - Hashtags: "#important", "#work" (derivative of tags, starts with #)
 *   - Captions: "00", "123", "v1.0" (numeric/alphanumeric identifiers)
 *   - Temporal: "tomorrow", "2025-11-01" (dates)
 *   - Multilingual: "こんにちは", "你好", "مرحبا" (any language)
 * 
 * Examples:
 *   "bug hello yes" → tags: ['bug', 'hello', 'yes']
 *   "#important work" → tags: ['#important', 'work']
 *   "00 Draft v1.0" → tags: ['00', 'Draft', 'v1.0']
 *   "Tomorrow meeting" → tags: ['Tomorrow', 'meeting']
 */

class MetadataExtractor {
    constructor() {
        // Date patterns (for temporal classification)
        // ORDER MATTERS: Most specific patterns first (multi-word before single-word)
        this.datePatterns = [
            // Natural language multi-word dates (MUST come first)
            /\b(?:next|last|this)\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
            
            // Month YYYY (Christmas 2021, Summer 2025)
            /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Christmas|Easter|Summer|Winter|Fall|Spring)\s+\d{4}\b/gi,
            
            // YYYY-MM-DD (2025-06-15)
            /\b\d{4}-\d{2}-\d{2}\b/g,
            
            // YYYY-MM (2025-06)
            /\b\d{4}-\d{2}\b/g,
            
            // MMM-DD or MMM-YYYY (Oct-25, Oct-2025)
            /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4}\b/gi,
            
            // DD-MMM-YYYY (25-Oct-2025)
            /\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}\b/gi,
            
            // MM/DD/YYYY or DD/MM/YYYY
            /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
            
            // YYYY (standalone year)
            /\b(19|20)\d{2}\b/g,
            
            // Natural language single-word dates (MUST come after multi-word)
            /\b(?:today|yesterday|tomorrow)\b/gi
        ];
    }

    /**
     * Extract all tags from text (universal approach)
     * @param {string} text - Freeform text
     * @returns {string[]} - Array of unique tags (all space-separated tokens)
     */
    extractTags(text) {
        if (!text || typeof text !== 'string') {
            return [];
        }
        
        // Split by whitespace, normalize each token:
        //   - Strip leading non-letter/non-digit chars (except # for hashtags)
        //   - Strip trailing non-letter/non-digit chars
        //   - Lowercase
        //   - Unicode-aware (u flag): multilingual tokens pass through correctly
        //   - Internal punctuation preserved (e.g. "v1.0", "v2-beta" stay intact)
        const tokens = text
            .split(/\s+/)
            .map(token => token
                .replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '')
                .toLowerCase()
            )
            .filter(token => token.length > 0);
        
        return [...new Set(tokens)];
    }

    /**
     * Extract dates from text (for temporal classification)
     * @param {string} text - Freeform text
     * @returns {string[]} - Array of unique date strings
     */
    extractDates(text) {
        if (!text || typeof text !== 'string') {
            return [];
        }
        
        const allDates = [];
        
        // Test all date patterns
        for (const pattern of this.datePatterns) {
            const matches = text.match(pattern) || [];
            allDates.push(...matches);
        }
        
        // Return unique dates, case-insensitive deduplication
        const uniqueDates = [...new Set(allDates.map(d => d.toLowerCase()))];
        return uniqueDates;
    }

    /**
     * Extract all metadata from text
     * TIGHTEST FUNNEL UPFRONT: Extract dates first, then tags from remainder
     * @param {string} text - Freeform text
     * @returns {Object} - { tags: string[], dates: string[] }
     */
    extract(text) {
        if (!text || typeof text !== 'string') {
            return { tags: [], dates: [] };
        }
        
        // Step 1: Extract dates FIRST (tightest funnel)
        const dates = this.extractDates(text);
        
        // Step 2: Remove date phrases from text to avoid duplicate tagging
        let remainingText = text;
        dates.forEach(date => {
            // Remove the date phrase from text (case-insensitive)
            const regex = new RegExp(date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            remainingText = remainingText.replace(regex, '');
        });
        
        // Step 3: Extract tags from REMAINING text (after dates removed)
        const tags = this.extractTags(remainingText);
        
        return {
            tags: tags,
            dates: dates
        };
    }

    /**
     * Test extraction with examples
     */
    static test() {
        const extractor = new MetadataExtractor();
        
        logger.debug('\n🧪 Testing Universal Metadata Extractor\n');
        
        const testCases = [
            // Basic — already lowercase, no change expected
            { input: 'bug hello yes',                              expectedTags: ['bug', 'hello', 'yes'] },
            // Hashtags — already lowercase
            { input: '#important work meeting',                    expectedTags: ['#important', 'work', 'meeting'] },
            // Mixed case — Draft/Final lowercased; v1.0 internal dot preserved
            { input: '00 Draft v1.0 Final',                       expectedTags: ['00', 'draft', 'v1.0', 'final'] },
            // Date removed; remaining tokens lowercased
            { input: 'Tomorrow client presentation',               expectedTags: ['client', 'presentation'] },
            // Multilingual — pass-through, no change
            { input: 'こんにちは 你好 مرحبا multilingual',           expectedTags: ['こんにちは', '你好', 'مرحبا', 'multilingual'] },
            // Date removed; remaining lowercased; hashtags lowercased
            { input: 'Meeting notes from 2025-06-15 #work #important', expectedTags: ['meeting', 'notes', 'from', '#work', '#important'] },
            // Season+year date removed; remaining lowercased
            { input: 'Family vacation Summer 2025',                expectedTags: ['family', 'vacation'] },
            // Date removed; remaining lowercased; hashtag preserved
            { input: 'Document received yesterday #urgent',        expectedTags: ['document', 'received', '#urgent'] },
            // Season+year date removed; remaining lowercased
            { input: 'Project Alpha launch Spring 2026 milestone', expectedTags: ['project', 'alpha', 'launch', 'milestone'] },
            // Punctuation stripping
            { input: 'urgent! (bug) hello,',                      expectedTags: ['urgent', 'bug', 'hello'] },
            // Hashtag case normalization
            { input: '#Important #WORK',                           expectedTags: ['#important', '#work'] },
            // Internal punctuation preserved, trailing stripped
            { input: 'v1.0, v2-beta.',                            expectedTags: ['v1.0', 'v2-beta'] },
        ];
        
        let passed = 0;
        testCases.forEach((tc, i) => {
            const result = extractor.extract(tc.input);
            const tagsMatch = JSON.stringify(result.tags) === JSON.stringify(tc.expectedTags);
            const status = tagsMatch ? '✅' : '❌';
            if (tagsMatch) passed++;
            logger.debug(`Test ${i + 1} ${status}: "${tc.input}"`);
            logger.debug(`  Tags:     ${JSON.stringify(result.tags)}`);
            if (!tagsMatch) logger.debug(`  Expected: ${JSON.stringify(tc.expectedTags)}`);
            logger.debug(`  Dates:    ${JSON.stringify(result.dates)}`);
            logger.debug('');
        });
        logger.debug(`${passed}/${testCases.length} tests passed`);
    }
}

module.exports = MetadataExtractor;

// Run tests if executed directly
if (require.main === module) {
    MetadataExtractor.test();
}
