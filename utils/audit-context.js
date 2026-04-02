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

// Build a tsquery-safe token string from an array of keywords.
// Each token is sanitised to alphanumeric + underscore to avoid injection.
function buildTsQuery(keywords) {
    return keywords
        .map(kw => kw.replace(/[^a-z0-9_]/g, ''))
        .filter(Boolean)
        .join(' & ');
}

// Fetch messages from anatta_messages using full-text search when keywords has
// 2+ tokens or a single long token (uses fts_vector GIN index), falling back
// to ILIKE for a single short token (<=3 chars). Results from FTS are ranked
// by ts_rank descending and include `_ftsRanked: true` for caller ordering.
//
// `keywords` — pre-filtered significant tokens (from extractKeywords, length>3)
// `rawTokens` — all lowercased split tokens from the raw query (unfiltered),
//               used to detect single short-token queries that should use ILIKE.
//
// Returns an array of plain message objects compatible with the audit context
// format: { id, content, timestamp, bookName, sender, _ftsRanked }.
async function fetchMessagesByKeywords(pool, tenantSchema, bookFractalId, keywords, options = {}) {
    const { assertValidSchemaName } = require('../lib/validators');
    const schemaSafe = assertValidSchemaName(tenantSchema);
    const { limit = 500, datePatterns = [], rawTokens = [] } = options;

    let whereClauses = ['book_fractal_id = $1'];
    const params = [bookFractalId];

    // Date-range filter when date patterns are present
    if (datePatterns.length > 0) {
        const dateOr = datePatterns
            .map(p => {
                params.push(`${p}%`);
                return `recorded_at::text LIKE $${params.length}`;
            })
            .join(' OR ');
        whereClauses.push(`(${dateOr})`);
    }

    let orderBy = 'recorded_at DESC';
    let rankSelect = '';
    let usedFts = false;

    // Classify tokens for search strategy selection.
    // significantRaw: tokens not in stop-words, used for short-token detection.
    // A "short" token is <=3 chars; FTS 'simple' dictionary ignores such terms.
    const significantRaw = rawTokens.filter(w => w.length > 0 && !STOP_WORDS.has(w));
    const allShortRaw = significantRaw.every(w => w.length <= 3);

    if (keywords.length >= 2) {
        // Multi-keyword query: use FTS (GIN index path) for O(log n) ranked retrieval
        const tsq = buildTsQuery(keywords);
        if (tsq) {
            params.push(tsq);
            whereClauses.push(`fts_vector @@ to_tsquery('simple', $${params.length})`);
            rankSelect = `, ts_rank(fts_vector, to_tsquery('simple', $${params.length})) AS _rank`;
            orderBy = `_rank DESC, recorded_at DESC`;
            usedFts = true;
        }
    } else if (keywords.length === 1) {
        // Single long token (>3 chars): use FTS (GIN index) for performance
        const tsq = buildTsQuery(keywords);
        if (tsq) {
            params.push(tsq);
            whereClauses.push(`fts_vector @@ to_tsquery('simple', $${params.length})`);
            rankSelect = `, ts_rank(fts_vector, to_tsquery('simple', $${params.length})) AS _rank`;
            orderBy = `_rank DESC, recorded_at DESC`;
            usedFts = true;
        }
    } else if (significantRaw.length > 0 && allShortRaw) {
        // All significant tokens are short (<=3 chars): fall back to ILIKE OR clauses.
        // FTS 'simple' dictionary ignores short tokens entirely.
        const ilikeClauses = significantRaw.map(w => {
            params.push(`%${w}%`);
            return `body ILIKE $${params.length}`;
        });
        whereClauses.push(`(${ilikeClauses.join(' OR ')})`);
    }

    const where = whereClauses.join(' AND ');
    params.push(limit);

    try {
        const result = await pool.query(
            `SELECT id, sender_name, body, recorded_at${rankSelect}
             FROM ${schemaSafe}.anatta_messages
             WHERE ${where}
             ORDER BY ${orderBy}
             LIMIT $${params.length}`,
            params
        );
        return result.rows.map(row => ({
            id:         row.id,
            content:    row.body || '',
            timestamp:  row.recorded_at instanceof Date
                ? row.recorded_at.toISOString()
                : new Date(row.recorded_at).toISOString(),
            sender:     row.sender_name || null,
            bookName:   null,
            _ftsRanked: usedFts,
            _ftsRank:   usedFts ? (row._rank || 0) : null
        }));
    } catch (err) {
        // If the FTS column is missing (migration hasn't run yet), fall back
        // to a plain ILIKE query so audit results are not silently lost.
        const isFtsColumnMissing = usedFts &&
            (err.code === '42703' || /fts_vector|column.*does not exist/i.test(err.message));

        if (isFtsColumnMissing) {
            logger.warn({ tenantSchema, bookFractalId },
                '🔍 Audit FTS: fts_vector column missing, falling back to ILIKE (migration pending)');
            try {
                const allKws = [...(keywords || []), ...(significantRaw || [])].filter(Boolean);
                if (allKws.length === 0) return [];
                const fallbackParams = [bookFractalId, `%${allKws[0]}%`, limit];
                const fallbackResult = await pool.query(
                    `SELECT id, sender_name, body, recorded_at
                     FROM ${schemaSafe}.anatta_messages
                     WHERE book_fractal_id = $1 AND body ILIKE $2
                     ORDER BY recorded_at DESC
                     LIMIT $3`,
                    fallbackParams
                );
                return fallbackResult.rows.map(row => ({
                    id:         row.id,
                    content:    row.body || '',
                    timestamp:  row.recorded_at instanceof Date
                        ? row.recorded_at.toISOString()
                        : new Date(row.recorded_at).toISOString(),
                    sender:     row.sender_name || null,
                    bookName:   null,
                    _ftsRanked: false,
                    _ftsRank:   null
                }));
            } catch (fallbackErr) {
                logger.warn({ err: fallbackErr.message, tenantSchema, bookFractalId },
                    '🔍 Audit FTS: ILIKE fallback also failed');
                return [];
            }
        }

        logger.warn({ err: err.message, tenantSchema, bookFractalId },
            '🔍 Audit FTS: anatta_messages keyword query failed');
        return [];
    }
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
            logger.warn({ err: err.message, bookFractalId }, '🌈 Audit: lang ledger lookup failed — messages will have lang=null');
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

        // Extract keywords and raw tokens for FTS query
        const queryKeywords = extractKeywords(query);
        const queryDatePatterns = extractDatePatterns(query);
        const rawTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

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

            const discordMessages = allDiscordMessages
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

            // ── Supplement with DB FTS results ───────────────────────────────
            // Query anatta_messages via fts_vector GIN index for keyword-matched
            // messages. Results are ranked by ts_rank and merged into the Discord
            // message set (deduplicated by timestamp+content prefix).
            // Only query DB when there's a meaningful search predicate to avoid
            // returning unfiltered rows. Gate: FTS keywords present OR all
            // significant raw tokens are short (ILIKE fallback path).
            const significantRawForDb = rawTokens.filter(w => w.length > 0 && !STOP_WORDS.has(w));
            const allShortRawForDb = significantRawForDb.length > 0 &&
                significantRawForDb.every(w => w.length <= 3);
            const hasDbSearchTerms = queryKeywords.length > 0 || allShortRawForDb;

            let dbMessages = [];
            if (pool && book.fractal_id && hasDbSearchTerms) {
                dbMessages = await fetchMessagesByKeywords(
                    pool,
                    targetSchema,
                    book.fractal_id,
                    queryKeywords,
                    { limit: maxMessages, datePatterns: queryDatePatterns, rawTokens }
                );
                if (dbMessages.length > 0) {
                    dbMessages = dbMessages.map(m => ({ ...m, bookName: book.name, createdAt: new Date(m.timestamp) }));
                    logger.debug(`🔍 Audit FTS: ${dbMessages.length} messages from DB for book ${book.name}`);
                }
            }

            // Merge DB FTS results into Discord messages (deduplicate by timestamp+content prefix)
            const seenKeys = new Set(discordMessages.map(m => `${m.timestamp}:${(m.content||'').substring(0,80)}`));
            const mergedMessages = [...discordMessages];
            for (const dbMsg of dbMessages) {
                const key = `${dbMsg.timestamp}:${(dbMsg.content||'').substring(0,80)}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    mergedMessages.push(dbMsg);
                }
            }

            await enrichMessagesWithLang(mergedMessages, book.fractal_id, pool);

            books.push({
                name: book.name,
                fractalId: book.fractal_id || book.id.toString(),
                totalMessages: mergedMessages.length,
                messages: mergedMessages,
                dateRange: mergedMessages.length > 0 
                    ? `${mergedMessages[mergedMessages.length-1].timestamp.split('T')[0]} to ${mergedMessages[0].timestamp.split('T')[0]}`
                    : 'No messages'
            });
        } catch (err) {
            console.error(`🌈 Audit: Failed to fetch thread ${threadId}:`, err.message);
        }
    }

    if (books.length === 0) return null;

    const flatMessages = books.flatMap(b => b.messages);

    // Preserve FTS rank ordering when present: FTS-ranked messages sort by
    // ts_rank descending (relevance) first, then chronologically. Non-ranked
    // messages use chronological order only. This ensures multi-keyword FTS
    // result ordering is not overridden by the global sort.
    const hasFtsRanked = flatMessages.some(m => m._ftsRanked);
    const allMessages = flatMessages.sort((a, b) => {
        if (hasFtsRanked) {
            const rankDiff = (b._ftsRank || 0) - (a._ftsRank || 0);
            if (rankDiff !== 0) return rankDiff;
        }
        return b.createdAt - a.createdAt;
    });

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
        sampleStrategy: hasFtsRanked ? 'fts_ranked_capsule_chain' : 'capsule_chain',
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
    buildTsQuery,
    fetchMessagesByKeywords,
    serializeCompact,
    applyQueryAwareFilter,
    buildAuditContext,
    parseTenantFromBookId,
    buildCapsuleChain,
    enrichMessagesWithLang,
    buildLangComposition
};
