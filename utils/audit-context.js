const crypto = require('crypto');
const logger = require('../lib/logger');
const { AUDIT } = require('../config/constants');
const { CapsuleChain } = require('./capsule-chain');

const MONTH_NAMES_EN = ['january', 'february', 'march', 'april', 'may', 'june', 
                        'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES_ID = ['januari', 'februari', 'maret', 'april', 'mei', 'juni',
                        'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
const STOP_WORDS = new Set(['what', 'when', 'where', 'which', 'yang', 'dalam', 'dengan', 
                            'untuk', 'from', 'this', 'that', 'have', 'berapa', 'banyak',
                            'many', 'much', 'book', 'buku', 'message', 'pesan', 'about',
                            'the', 'and', 'atau', 'adalah', 'ada', 'pada', 'untuk']);

function buildCapsuleChain(allMessages, query) {
    const chain = new CapsuleChain();
    chain.setQuery(query);
    
    const c0 = chain.c0_universe(allMessages);
    
    const datePatterns = extractDatePatterns(query);
    const c1 = chain.c1_timeMatch(c0.output, datePatterns);
    
    const c2 = chain.c2_actionMatch(c1.output, query);
    
    chain.c3_aggregates(c2.output);
    
    logger.debug(`📦 CapsuleChain: ${chain.getTraceCompact()} | ${chain.getTrace()}`);
    
    return chain;
}

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
    const { maxMessages = AUDIT.MAX_MESSAGES } = options;
    
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
    
    // DATE FILTER PRIORITY: When date patterns are detected, use DATE-ONLY filtering.
    // Keywords are passed to the LLM for semantic understanding, NOT for literal message filtering.
    // This prevents counting queries like "berapa perbaikan di desember 2025" from failing
    // when repair messages don't literally contain the word "perbaikan".
    let relevantMsgs = messages.filter(m => {
        const content = (m.content || '').toLowerCase();
        const date = m.timestamp?.split('T')[0] || '';
        
        const matchesDate = datePatterns.some(pattern => date.startsWith(pattern));
        const matchesKeyword = keywords.some(kw => content.includes(kw));
        
        // Priority: Date filter takes precedence for counting accuracy
        if (hasDateFilter) {
            return matchesDate;
        } else if (hasKeywordFilter) {
            return matchesKeyword;
        }
        return false;
    });
    
    logger.debug(`🔍 Audit filter: datePatterns=${JSON.stringify(datePatterns)}, keywords=${JSON.stringify(keywords)}, matched=${relevantMsgs.length}/${messages.length}`);
    
    let contextNote = '';
    let sampledMessages;
    let overflowWarning = '';
    let strategy = 'filtered';
    
    if (relevantMsgs.length > 0) {
        relevantMsgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const filterDesc = hasDateFilter 
            ? `date ${datePatterns.join('/')}`
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

async function enrichMessagesWithLang(messages, bookFractalId, pool) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const langMap = new Map();

    if (pool && bookFractalId) {
        try {
            const result = await pool.query(
                `SELECT content_hash, detected_lang FROM core.message_ledger
                 WHERE book_fractal_id = $1 AND detected_lang IS NOT NULL`,
                [bookFractalId]
            );
            for (const row of result.rows) {
                langMap.set(row.content_hash, row.detected_lang);
            }
        } catch (err) {
            logger.warn({ err: err.message, bookFractalId }, '🌈 Audit: lang ledger lookup failed — falling back to inline detection');
        }
    }

    for (const msg of messages) {
        const content = msg.content || '';
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        msg.lang = langMap.get(hash) || null;
    }
}

function buildLangComposition(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const counts = {};
    let total = 0;

    for (const msg of messages) {
        if (msg.lang) {
            counts[msg.lang] = (counts[msg.lang] || 0) + 1;
            total++;
        }
    }

    if (total === 0) return null;

    const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => ({
            lang,
            count,
            pct: Math.round((count / total) * 100),
        }));

    return {
        total,
        undetected: messages.length - total,
        languages: sorted,
        summary: sorted.map(l => `${l.pct}% ${l.lang}`).join(', '),
    };
}

// Parse tenant schema from bookId pattern: book_t{N}_* or dev_book_t{N}_*
function parseTenantFromBookId(bookId) {
    if (!bookId || typeof bookId !== 'string') return null;
    
    // Match patterns like "book_t34_abc123" or "dev_book_t1_abc123"
    const match = bookId.match(/(?:dev_)?book_t(\d+)_/);
    if (match) {
        return `tenant_${match[1]}`;
    }
    return null;
}

async function buildAuditContext(bookIds, fallbackTenantSchema, query, options = {}) {
    const { pool, thothBot, userRole } = options;
    const { maxMessages = AUDIT.MAX_MESSAGES } = options;

    if (!bookIds || !Array.isArray(bookIds) || bookIds.length === 0) {
        return null;
    }

    // Cache for tenant existence checks to avoid redundant queries in multi-book scenarios
    const tenantExistenceCache = new Map();

    const books = [];
    for (const bookId of bookIds) {
        // Parse tenant from bookId, fallback to provided schema
        const targetSchema = parseTenantFromBookId(bookId) || fallbackTenantSchema;
        
        if (!targetSchema) {
            console.warn(`🌈 Audit: Cannot determine tenant for book ${bookId}`);
            continue;
        }

        // Hardening: Verify tenant schema exists in core catalog before querying
        // This prevents probing non-existent schemas via manipulated bookIds
        if (!tenantExistenceCache.has(targetSchema)) {
            try {
                const schemaCheck = await pool.query(
                    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
                    [targetSchema]
                );
                tenantExistenceCache.set(targetSchema, schemaCheck.rows.length > 0);
            } catch (err) {
                console.error(`🌈 Audit: Schema check failed for ${targetSchema}:`, err.message);
                tenantExistenceCache.set(targetSchema, false);
            }
        }

        if (!tenantExistenceCache.get(targetSchema)) {
            console.warn(`🌈 Audit: Security check failed - tenant ${targetSchema} does not exist`);
            continue;
        }
        
        // Fetch book details from the correct tenant schema
        const bookResult = await pool.query(
            `SELECT id, name, fractal_id, output_credentials, created_at FROM ${targetSchema}.books WHERE fractal_id = $1 OR id::text = $1`,
            [bookId]
        );

        if (bookResult.rows.length === 0) {
            console.warn(`🌈 Audit: Book ${bookId} not found in ${targetSchema}`);
            continue;
        }

        const book = bookResult.rows[0];
        const bookCreatedAt = new Date(book.created_at);
        let outputCredentials = book.output_credentials;
        if (typeof outputCredentials === 'string') outputCredentials = JSON.parse(outputCredentials);
        
        const threadId = outputCredentials?.output_01?.thread_id;
        if (!threadId) {
            console.warn(`🌈 Audit: No thread_id for book ${book.name}`);
            continue;
        }

        if (!thothBot || !thothBot.client || !thothBot.ready) {
            console.warn(`🌈 Audit: Thoth bot not ready`);
            continue;
        }

        try {
            const thread = await thothBot.client.channels.fetch(threadId);
            if (!thread) continue;

            let allDiscordMessages = [];
            let lastId = null;
            while (true) {
                const fetchOptions = { limit: 100 };
                if (lastId) fetchOptions.before = lastId;
                const fetched = await thread.messages.fetch(fetchOptions);
                if (fetched.size === 0) break;
                allDiscordMessages = allDiscordMessages.concat(Array.from(fetched.values()));
                lastId = fetched.last().id;
                if (allDiscordMessages.length >= 5000) break;
            }

            const messages = allDiscordMessages
                .filter(msg => msg.createdAt >= bookCreatedAt)
                .map(msg => {
                    let content = msg.content;
                    if (!content && msg.embeds.length > 0) {
                        const embed = msg.embeds[0];
                        content = embed.description || '';
                        const bodyField = embed.fields?.find(f => f.name === '📝 Body');
                        if (bodyField) content = bodyField.value;
                    }
                    return {
                        id: msg.id,
                        content: content,
                        timestamp: msg.createdAt.toISOString(),
                        createdAt: msg.createdAt,
                        bookName: book.name
                    };
                });

            await enrichMessagesWithLang(messages, book.fractal_id, pool);

            books.push({
                name: book.name,
                fractalId: book.fractal_id || book.id.toString(),
                totalMessages: messages.length,
                messages,
                dateRange: messages.length > 0 
                    ? `${messages[messages.length-1].timestamp.split('T')[0]} to ${messages[0].timestamp.split('T')[0]}`
                    : 'No messages'
            });
        } catch (err) {
            console.error(`🌈 Audit: Failed to fetch thread ${threadId}:`, err.message);
        }
    }

    if (books.length === 0) return null;

    const allMessages = books.flatMap(b => b.messages)
        .sort((a, b) => b.createdAt - a.createdAt);

    const capsuleChain = buildCapsuleChain(allMessages, query);
    const terminalCapsule = capsuleChain.getTerminalCapsule();
    
    const c1Capsule = capsuleChain.capsules.find(c => c.stage === 'C1_TIME_MATCH');
    const c2Capsule = capsuleChain.capsules.find(c => c.stage === 'C2_ACTION_MATCH');
    
    const contextMessages = c2Capsule ? c2Capsule.output : allMessages;
    const contextNote = capsuleChain.getTrace();
    const overflowWarning = contextMessages.length > maxMessages 
        ? `Showing ${maxMessages} of ${contextMessages.length} action-matched messages`
        : '';
    
    const sampledMessages = contextMessages.length > maxMessages 
        ? contextMessages.slice(0, maxMessages) 
        : contextMessages;

    const langComposition = buildLangComposition(sampledMessages);

    return {
        isMultiBook: true,
        bookCount: books.length,
        books: books.map(b => ({
            name: b.name,
            fractalId: b.fractalId,
            totalMessages: b.totalMessages,
            dateRange: b.dateRange
        })),
        totalMessages: allMessages.length,
        allMessages: allMessages,
        recentMessages: sampledMessages,
        sampledCount: sampledMessages.length,
        sampleStrategy: 'capsule_chain',
        contextNote: contextNote,
        overflowWarning: overflowWarning,
        entityAggregates: terminalCapsule.output,
        capsuleChain: capsuleChain.toJSON(),
        langComposition,
        dateRange: allMessages.length > 0 
            ? `${allMessages[allMessages.length-1].timestamp.split('T')[0]} to ${allMessages[0].timestamp.split('T')[0]}`
            : 'No messages'
    };
}

module.exports = {
    extractDatePatterns,
    extractKeywords,
    serializeCompact,
    applyQueryAwareFilter,
    buildAuditContext,
    parseTenantFromBookId,
    buildCapsuleChain,
    enrichMessagesWithLang,
    buildLangComposition
};
