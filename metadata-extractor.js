/**
 * Metadata Extractor - Zero-cost regex-based extraction (no AI dependencies)
 * 
 * Purpose: Extract hashtags and dates from freeform text
 * Examples:
 *   "#FromDad Christmas 2021" → tags: ['#FromDad'], dates: ['Christmas 2021']
 *   "Draft MoU v1 at client Oct-25" → tags: [], dates: ['Oct-25']
 */

class MetadataExtractor {
    constructor() {
        // Hashtag regex: #word (alphanumeric + underscore)
        this.hashtagRegex = /#[a-zA-Z0-9_]+/g;
        
        // Date patterns (common formats people naturally use)
        this.datePatterns = [
            // YYYY-MM-DD (2025-06-15)
            /\b\d{4}-\d{2}-\d{2}\b/g,
            
            // YYYY-MM (2025-06)
            /\b\d{4}-\d{2}\b/g,
            
            // MMM-DD or MMM-YYYY (Oct-25, Oct-2025)
            /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4}\b/gi,
            
            // DD-MMM-YYYY (25-Oct-2025)
            /\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}\b/gi,
            
            // Month YYYY (Christmas 2021, Summer 2025)
            /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Christmas|Easter|Summer|Winter|Fall|Spring)\s+\d{4}\b/gi,
            
            // YYYY (standalone year)
            /\b(19|20)\d{2}\b/g,
            
            // MM/DD/YYYY or DD/MM/YYYY
            /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
            
            // Natural language dates (Today, Yesterday, Last week, etc.)
            /\b(?:today|yesterday|tomorrow|last\s+week|last\s+month|this\s+week|this\s+month)\b/gi
        ];
    }

    /**
     * Extract hashtags from text
     * @param {string} text - Freeform text
     * @returns {string[]} - Array of unique hashtags
     */
    extractHashtags(text) {
        if (!text || typeof text !== 'string') {
            return [];
        }
        
        const matches = text.match(this.hashtagRegex) || [];
        // Return unique hashtags, preserve case
        return [...new Set(matches)];
    }

    /**
     * Extract dates from text
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
     * @param {string} text - Freeform text
     * @returns {Object} - { tags: string[], dates: string[] }
     */
    extract(text) {
        return {
            tags: this.extractHashtags(text),
            dates: this.extractDates(text)
        };
    }

    /**
     * Test extraction with examples
     */
    static test() {
        const extractor = new MetadataExtractor();
        
        console.log('\n🧪 Testing Metadata Extractor\n');
        
        const testCases = [
            '#FromDad Christmas 2021',
            'Draft MoU v1 at client Oct-25',
            'Meeting notes from 2025-06-15 #work #important',
            'Family vacation #summer #thailand 2025',
            'Document received yesterday #urgent',
            'Project Alpha launch Spring 2026 #milestone #teamwork'
        ];
        
        testCases.forEach((text, i) => {
            const result = extractor.extract(text);
            console.log(`Test ${i + 1}: "${text}"`);
            console.log(`  Tags: ${JSON.stringify(result.tags)}`);
            console.log(`  Dates: ${JSON.stringify(result.dates)}`);
            console.log('');
        });
    }
}

module.exports = MetadataExtractor;

// Run tests if executed directly
if (require.main === module) {
    MetadataExtractor.test();
}
