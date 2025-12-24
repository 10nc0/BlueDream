const logger = require('../lib/logger');
const Prometheus = require('../prometheus');

function registerPrometheusRoutes(app, deps) {
    const { pool, middleware, tenantMiddleware, helpers, bots } = deps;
    const { requireAuth } = middleware;
    const { getAllTenantSchemas } = tenantMiddleware;
    const { logAudit } = helpers;
    const { thoth: thothBot, idris: idrisBot, horus: horusBot } = bots;

    async function detectAndLookupBookNames(userQuery, tenantSchema, client = pool) {
        if (!userQuery || typeof userQuery !== 'string') return [];
        
        try {
            const result = await client.query(
                `SELECT fractal_id, name FROM ${tenantSchema}.books WHERE status != 'archived' ORDER BY name ASC`
            );
            
            const books = result.rows;
            if (books.length === 0) return [];
            
            const detectedFractalIds = [];
            const queryLower = userQuery.toLowerCase();
            
            for (const book of books) {
                const bookNameLower = book.name.toLowerCase();
                if (queryLower.includes(bookNameLower) || 
                    new RegExp(`\\b${bookNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(userQuery)) {
                    if (!detectedFractalIds.includes(book.fractal_id)) {
                        detectedFractalIds.push(book.fractal_id);
                    }
                }
            }
            
            if (detectedFractalIds.length > 1) {
                console.log(`📖 Detected ${detectedFractalIds.length} books in query: ${detectedFractalIds.join(', ')}`);
            }
            
            return detectedFractalIds;
        } catch (error) {
            console.warn(`⚠️ Failed to detect book names:`, error.message);
            return [];
        }
    }

    async function fetchBookContextForPrometheus(fractalId, tenantSchema, client = pool) {
        if (!fractalId || !tenantSchema) return null;
        
        try {
            const bookResult = await client.query(
                `SELECT id, name, output_credentials, created_at FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [fractalId]
            );
            
            if (bookResult.rows.length === 0) return null;
            
            const book = bookResult.rows[0];
            const bookCreatedAt = new Date(book.created_at);
            
            let outputCredentials = book.output_credentials;
            if (typeof outputCredentials === 'string') {
                outputCredentials = JSON.parse(outputCredentials);
            }
            
            const outputData = outputCredentials?.output_01;
            if (!outputData?.thread_id) {
                return {
                    name: book.name,
                    fractalId: fractalId,
                    createdAt: bookCreatedAt.toISOString(),
                    totalMessages: 0,
                    messagesThisMonth: 0,
                    dateRange: 'No messages yet',
                    recentMessages: []
                };
            }
            
            if (!thothBot || !thothBot.client || !thothBot.ready) {
                return {
                    name: book.name,
                    fractalId: fractalId,
                    createdAt: bookCreatedAt.toISOString(),
                    totalMessages: 0,
                    messagesThisMonth: 0,
                    dateRange: 'Discord bot not ready',
                    recentMessages: []
                };
            }
            
            const thread = await thothBot.client.channels.fetch(outputData.thread_id);
            if (!thread) return null;
            
            const discordMessages = await thread.messages.fetch({ limit: 100, force: true });
            
            const now = new Date();
            const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            
            const messages = Array.from(discordMessages.values())
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
                        createdAt: msg.createdAt
                    };
                })
                .sort((a, b) => b.createdAt - a.createdAt);
            
            const messagesByMonth = {};
            messages.forEach(msg => {
                const monthKey = `${msg.createdAt.getFullYear()}-${String(msg.createdAt.getMonth() + 1).padStart(2, '0')}`;
                messagesByMonth[monthKey] = (messagesByMonth[monthKey] || 0) + 1;
            });
            
            const messagesThisMonth = messages.filter(m => m.createdAt >= thisMonth).length;
            
            const dateRange = messages.length > 0
                ? `${messages[messages.length - 1].timestamp.split('T')[0]} to ${messages[0].timestamp.split('T')[0]}`
                : 'No messages';
            
            console.log(`📚 Prometheus context: Book "${book.name}" has ${messages.length} messages`);
            
            return {
                name: book.name,
                fractalId: fractalId,
                createdAt: bookCreatedAt.toISOString(),
                totalMessages: messages.length,
                messagesThisMonth: messagesThisMonth,
                dateRange: dateRange,
                messageStats: messagesByMonth,
                recentMessages: messages.slice(0, 100).map(m => ({
                    timestamp: m.timestamp,
                    content: m.content
                }))
            };
        } catch (error) {
            console.error(`❌ Failed to fetch book context: ${error.message}`);
            return null;
        }
    }

    async function fetchMultiBookContextForPrometheus(bookIds, tenantSchema, userRole, client = pool) {
        if (!bookIds || !Array.isArray(bookIds) || bookIds.length === 0 || !tenantSchema) {
            return null;
        }
        
        console.log(`📚 Prometheus multi-book: Fetching ${bookIds.length} books for ${tenantSchema}...`);
        
        const books = [];
        const accessibleSchemas = new Set();
        
        const hasExtendedAccess = userRole === 'dev';
        
        if (hasExtendedAccess) {
            const allSchemas = await getAllTenantSchemas(client, userRole);
            allSchemas.forEach(s => accessibleSchemas.add(s.tenant_schema));
        } else {
            accessibleSchemas.add(tenantSchema);
        }
        
        for (const bookId of bookIds) {
            let bookContext = null;
            
            bookContext = await fetchBookContextForPrometheus(bookId, tenantSchema, client);
            
            if (!bookContext && hasExtendedAccess) {
                for (const schema of accessibleSchemas) {
                    if (schema === tenantSchema) continue;
                    bookContext = await fetchBookContextForPrometheus(bookId, schema, client);
                    if (bookContext) {
                        bookContext.sourceSchema = schema;
                        break;
                    }
                }
            }
            
            if (bookContext && bookContext.totalMessages > 0) {
                bookContext.sourceSchema = bookContext.sourceSchema || tenantSchema;
                books.push(bookContext);
            } else {
                console.warn(`⚠️ Book ${bookId} not accessible or has no messages`);
            }
        }
        
        if (books.length === 0) {
            return null;
        }
        
        const allMessages = [];
        const bookSummaries = [];
        
        for (const book of books) {
            bookSummaries.push({
                name: book.name,
                fractalId: book.fractalId,
                totalMessages: book.totalMessages,
                dateRange: book.dateRange
            });
            
            for (const msg of book.recentMessages) {
                allMessages.push({
                    ...msg,
                    bookName: book.name,
                    bookFractalId: book.fractalId
                });
            }
        }
        
        allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        const totalMessages = books.reduce((sum, b) => sum + b.totalMessages, 0);
        
        console.log(`📚 Prometheus multi-book: Aggregated ${totalMessages} messages from ${books.length} books`);
        
        return {
            isMultiBook: true,
            bookCount: books.length,
            books: bookSummaries,
            totalMessages: totalMessages,
            recentMessages: allMessages.slice(0, 150),
            dateRange: allMessages.length > 0
                ? `${allMessages[allMessages.length - 1].timestamp.split('T')[0]} to ${allMessages[0].timestamp.split('T')[0]}`
                : 'No messages'
        };
    }

    app.post('/api/prometheus/check', requireAuth, async (req, res) => {
        try {
            const { messages, ruleType = 'general', language, bookId, fractalId, bookIds } = req.body;
            
            console.log(`🔮 Prometheus API received: fractalId="${fractalId}", bookIds=${JSON.stringify(bookIds)}, tenantSchema="${req.tenantContext?.tenantSchema || req.tenantSchema}"`);
            
            if (!messages || (Array.isArray(messages) && messages.length === 0)) {
                return res.status(400).json({ 
                    error: 'messages is required (string or array of strings)' 
                });
            }
            
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const userRole = req.userRole;
            const startTime = Date.now();
            let result;
            let hasBookContext = false;
            let multiBookContext = null;
            
            const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
            
            let detectedBookIds = null;
            
            if (bookIds && Array.isArray(bookIds) && bookIds.length > 0) {
                detectedBookIds = bookIds;
                console.log(`📖 Using client-provided bookIds (singularity): ${detectedBookIds.length} book(s)`);
            } else {
                const autoDetectedFractalIds = await detectAndLookupBookNames(userQuery, tenantSchema);
                if (autoDetectedFractalIds && autoDetectedFractalIds.length > 0) {
                    detectedBookIds = autoDetectedFractalIds;
                    console.log(`📖 Server auto-detected ${detectedBookIds.length} book(s) from query text`);
                }
            }
            
            if (detectedBookIds && Array.isArray(detectedBookIds) && detectedBookIds.length > 0 && tenantSchema) {
                console.log(`🔮 Prometheus API: Multi-book query for ${detectedBookIds.length} books`);
                
                multiBookContext = await fetchMultiBookContextForPrometheus(detectedBookIds, tenantSchema, userRole);
                
                if (multiBookContext && multiBookContext.totalMessages > 0) {
                    result = await Prometheus.checkWithMultiBookContext(userQuery, multiBookContext, { language });
                    hasBookContext = true;
                } else {
                    console.log(`⚠️ No multi-book context available, using regular check`);
                    result = await Prometheus.check(messages, ruleType, { language });
                }
            }
            else if (fractalId && fractalId !== 'null' && fractalId !== 'undefined' && tenantSchema) {
                console.log(`🔮 Prometheus API: Context query for book ${fractalId}`);
                
                const bookContext = await fetchBookContextForPrometheus(fractalId, tenantSchema);
                
                if (bookContext && bookContext.totalMessages > 0) {
                    const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
                    result = await Prometheus.checkWithContext(userQuery, bookContext, { language });
                    hasBookContext = true;
                } else {
                    console.log(`⚠️ No book context available, using regular check`);
                    result = await Prometheus.check(messages, ruleType, { language });
                }
            } 
            else {
                console.log(`🔮 Prometheus API: Checking ${Array.isArray(messages) ? messages.length : 1} message(s) with rule: ${ruleType}`);
                result = await Prometheus.check(messages, ruleType, { language });
            }
            
            const processingTime = Date.now() - startTime;
            
            const userId = req.user?.id || req.session?.userId;
            
            if (tenantSchema && userId) {
                try {
                    const resultObj = Array.isArray(result) ? result[0] : result;
                    await pool.query(`
                        INSERT INTO ${tenantSchema}.audit_queries 
                        (user_id, book_id, rule_type, language, input_messages, result_status, 
                         result_confidence, result_reason, result_data, raw_response, processing_time_ms)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    `, [
                        userId,
                        bookId ? parseInt(bookId) : null,
                        ruleType,
                        language || 'en',
                        JSON.stringify(Array.isArray(messages) ? messages : [messages]),
                        resultObj?.status || 'UNKNOWN',
                        resultObj?.confidence || 0,
                        resultObj?.reason || null,
                        resultObj?.data_extracted ? JSON.stringify(resultObj.data_extracted) : null,
                        resultObj?.raw_response || null,
                        processingTime
                    ]);
                    console.log(`✅ Prometheus audit saved to ${tenantSchema}.audit_queries`);
                } catch (dbError) {
                    console.error('⚠️ Failed to save audit query (table may not exist):', dbError.message);
                }
            }
            
            await logAudit(pool, req, 'PROMETHEUS_CHECK', 'MESSAGE', null, null, {
                rule_type: ruleType,
                message_count: Array.isArray(messages) ? messages.length : 1,
                result_status: Array.isArray(result) ? result.map(r => r.status) : result.status
            }, tenantSchema);
            
            if (idrisBot && idrisBot.isReady() && tenantSchema) {
                try {
                    console.log(`🧿 Prometheus Discord: Looking up AI log thread for ${tenantSchema}...`);
                    
                    const tenantInfo = await pool.query(`
                        SELECT id, ai_log_thread_id, ai_log_channel_id 
                        FROM core.tenant_catalog 
                        WHERE tenant_schema = $1
                    `, [tenantSchema]);
                    
                    if (tenantInfo.rows.length === 0) {
                        console.warn(`⚠️ Prometheus Discord: ${tenantSchema} not found in tenant_catalog - skipping Discord logging`);
                    } else {
                        const catalogId = tenantInfo.rows[0].id;
                        let threadId = tenantInfo.rows[0]?.ai_log_thread_id;
                        
                        if (!threadId) {
                            const tenantId = parseInt(tenantSchema.replace('tenant_', ''));
                            console.log(`🧿 Creating AI log thread for ${tenantSchema}...`);
                            const threadInfo = await idrisBot.createAILogThread(tenantId, tenantSchema);
                            threadId = threadInfo.threadId;
                            
                            await pool.query(`
                                UPDATE core.tenant_catalog 
                                SET ai_log_thread_id = $1, ai_log_channel_id = $2 
                                WHERE id = $3
                            `, [threadInfo.threadId, threadInfo.channelId, catalogId]);
                            console.log(`✅ AI log thread created: ${threadId}`);
                        } else {
                            console.log(`🧿 Using existing AI log thread: ${threadId}`);
                        }
                        
                        const resultObj = Array.isArray(result) ? result[0] : result;
                        const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
                        const bookName = hasBookContext ? resultObj.bookName : null;
                        
                        await idrisBot.postAuditResult(threadId, resultObj, userQuery, bookName);
                        console.log(`📜 Prometheus audit posted to Discord thread ${threadId}`);
                    }
                } catch (discordError) {
                    console.error('⚠️ Failed to post audit to Discord:', discordError.message);
                }
            } else {
                if (!idrisBot) console.log('⚠️ Prometheus Discord: Idris bot not available');
                else if (!idrisBot.isReady()) console.log('⚠️ Prometheus Discord: Idris bot not ready');
                else if (!tenantSchema) console.log('⚠️ Prometheus Discord: No tenant schema available');
            }
            
            res.json({ 
                success: true, 
                result,
                rule_type: ruleType,
                has_book_context: hasBookContext,
                processing_time_ms: processingTime,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('❌ Prometheus API error:', error);
            res.status(500).json({ 
                error: error.message,
                needs_human_review: true
            });
        }
    });

    app.get('/api/prometheus/rules', requireAuth, async (req, res) => {
        try {
            const rules = Prometheus.listRuleTypes();
            res.json({ rules });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/prometheus/history', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const userId = req.user?.id || req.session?.userId;
            const { limit = 50, offset = 0 } = req.query;
            
            if (!tenantSchema) {
                return res.status(400).json({ error: 'Tenant context required' });
            }
            
            const result = await pool.query(`
                SELECT 
                    aq.id,
                    aq.rule_type,
                    aq.language,
                    aq.input_messages,
                    aq.result_status,
                    aq.result_confidence,
                    aq.result_reason,
                    aq.result_data,
                    aq.processing_time_ms,
                    aq.created_at,
                    b.name as book_name,
                    b.fractal_id as book_fractal_id
                FROM ${tenantSchema}.audit_queries aq
                LEFT JOIN ${tenantSchema}.books b ON aq.book_id = b.id
                WHERE aq.user_id = $1
                ORDER BY aq.created_at DESC
                LIMIT $2 OFFSET $3
            `, [userId, parseInt(limit), parseInt(offset)]);
            
            const countResult = await pool.query(`
                SELECT COUNT(*) as total FROM ${tenantSchema}.audit_queries WHERE user_id = $1
            `, [userId]);
            
            res.json({
                success: true,
                history: result.rows,
                total: parseInt(countResult.rows[0].total),
                limit: parseInt(limit),
                offset: parseInt(offset)
            });
        } catch (error) {
            console.error('❌ Prometheus history error:', error);
            if (error.code === '42P01') {
                return res.json({ success: true, history: [], total: 0, limit: 50, offset: 0 });
            }
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/prometheus/discord-history', requireAuth, async (req, res) => {
        try {
            const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
            const { limit = 50 } = req.query;
            
            if (!tenantSchema) {
                return res.status(400).json({ error: 'Tenant context required' });
            }
            
            if (!horusBot || !horusBot.isReady()) {
                return res.status(503).json({ error: 'AI audit log reader not available' });
            }
            
            const tenantInfo = await pool.query(`
                SELECT ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1
            `, [tenantSchema]);
            
            const threadId = tenantInfo.rows[0]?.ai_log_thread_id;
            
            if (!threadId) {
                return res.json({ success: true, logs: [], message: 'No AI audit log thread exists yet' });
            }
            
            const logs = await horusBot.fetchAuditLogs(threadId, parseInt(limit));
            const stats = await horusBot.getAuditStats(threadId);
            
            res.json({
                success: true,
                logs,
                stats,
                thread_id: threadId
            });
        } catch (error) {
            console.error('❌ Discord history error:', error);
            res.status(500).json({ error: error.message });
        }
    });

}

module.exports = { registerPrometheusRoutes };
