const MONTH_NAMES_EN = ['january', 'february', 'march', 'april', 'may', 'june', 
                        'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES_ID = ['januari', 'februari', 'maret', 'april', 'mei', 'juni',
                        'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
const STOP_WORDS = new Set(['what', 'when', 'where', 'which', 'yang', 'dalam', 'dengan', 
                            'untuk', 'from', 'this', 'that', 'have', 'berapa', 'banyak',
                            'many', 'much', 'book', 'buku', 'message', 'pesan', 'about',
                            'the', 'and', 'atau', 'adalah', 'ada', 'pada', 'untuk']);

function extractDatePatterns(query) {
    const queryLower = query.toLowerCase();
    const patterns = [];
    
    for (let i = 0; i < MONTH_NAMES_EN.length; i++) {
        const regex = new RegExp(`(${MONTH_NAMES_EN[i]}|${MONTH_NAMES_ID[i]})\\s*(\\d{4})`, 'i');
        const match = queryLower.match(regex);
        if (match) {
            const monthNum = String(i + 1).padStart(2, '0');
            patterns.push(`${match[2]}-${monthNum}`);
        }
    }
    
    const isoMatch = queryLower.match(/(\d{4})-(\d{1,2})/);
    if (isoMatch) {
        patterns.push(`${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}`);
    }
    
    return patterns;
}

function extractKeywords(query) {
    return query.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOP_WORDS.has(w))
        .slice(0, 5);
}

function serializeCompact(messages, options = {}) {
    const { maxChars = 150 } = options;
    return messages.map(m => {
        const date = m.timestamp?.split('T')[0] || 'unknown';
        const content = (m.content || '').substring(0, maxChars);
        const bookPrefix = m.bookName ? `[${m.bookName}] ` : '';
        return `${bookPrefix}${date}: ${content}`;
    });
}

function applyQueryAwareFilter(messages, query, options = {}) {
    const { maxMessages = 2000 } = options;
    
    if (!messages || messages.length === 0) {
        return {
            sampledMessages: [],
            totalMessages: 0,
            sampledCount: 0,
            strategy: 'empty',
            contextNote: 'No messages available',
            overflowWarning: ''
        };
    }
    
    const datePatterns = extractDatePatterns(query);
    const keywords = extractKeywords(query);
    
    const hasDateFilter = datePatterns.length > 0;
    const hasKeywordFilter = keywords.length > 0;
    const useAndLogic = hasDateFilter && hasKeywordFilter;
    
    let relevantMsgs = messages.filter(m => {
        const content = (m.content || '').toLowerCase();
        const date = m.timestamp?.split('T')[0] || '';
        
        const matchesDate = datePatterns.some(pattern => date.startsWith(pattern));
        const matchesKeyword = keywords.some(kw => content.includes(kw));
        
        if (useAndLogic) {
            return matchesDate && matchesKeyword;
        } else if (hasDateFilter) {
            return matchesDate;
        } else if (hasKeywordFilter) {
            return matchesKeyword;
        }
        return false;
    });
    
    let contextNote = '';
    let sampledMessages;
    let overflowWarning = '';
    let strategy = 'filtered';
    
    if (relevantMsgs.length > 0) {
        relevantMsgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const filterDesc = useAndLogic 
            ? `date ${datePatterns.join('/')} AND keywords [${keywords.join(', ')}]`
            : hasDateFilter ? `date ${datePatterns.join('/')}`
            : `keywords [${keywords.join(', ')}]`;
        
        if (relevantMsgs.length <= maxMessages) {
            sampledMessages = relevantMsgs;
            contextNote = `Found ALL ${relevantMsgs.length} messages matching ${filterDesc}`;
        } else {
            sampledMessages = relevantMsgs.slice(0, maxMessages);
            contextNote = `Showing oldest ${maxMessages} of ${relevantMsgs.length} matching ${filterDesc}`;
            overflowWarning = `${relevantMsgs.length - maxMessages} additional matching messages were not included due to size limits. The count you provide may be incomplete.`;
        }
    } else {
        strategy = 'sampled';
        const sortedMsgs = [...messages].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        if (sortedMsgs.length <= maxMessages) {
            sampledMessages = sortedMsgs;
        } else {
            const step = Math.floor(sortedMsgs.length / maxMessages);
            sampledMessages = [];
            for (let i = 0; i < sortedMsgs.length && sampledMessages.length < maxMessages; i += step) {
                sampledMessages.push(sortedMsgs[i]);
            }
        }
        contextNote = `Sampled ${sampledMessages.length} of ${messages.length} total messages (no specific matches found)`;
    }
    
    return {
        sampledMessages,
        totalMessages: messages.length,
        sampledCount: sampledMessages.length,
        strategy,
        contextNote,
        overflowWarning,
        datePatterns,
        keywords
    };
}

module.exports = {
    extractDatePatterns,
    extractKeywords,
    serializeCompact,
    applyQueryAwareFilter
};
