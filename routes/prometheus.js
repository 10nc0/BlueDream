const logger = require('../lib/logger');
const Prometheus = require('../prometheus');
const { buildAuditContext } = require('../utils/audit-context');

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
            
            return detectedFractalIds;
        } catch (error) {
            console.warn(`⚠️ Failed to detect book names:`, error.message);
            return [];
        }
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
            
            // Validate bookIds against current tenant - only keep books that exist
            let targetBookIds = null;
            if (bookIds && Array.isArray(bookIds) && bookIds.length > 0 && tenantSchema) {
                try {
                    const validationResult = await pool.query(
                        `SELECT fractal_id FROM ${tenantSchema}.books WHERE fractal_id = ANY($1) OR id::text = ANY($1)`,
                        [bookIds]
                    );
                    const validIds = validationResult.rows.map(r => r.fractal_id);
                    if (validIds.length > 0) {
                        targetBookIds = validIds;
                        console.log(`🔮 Prometheus: Validated ${validIds.length}/${bookIds.length} bookIds for ${tenantSchema}`);
                    } else {
                        console.log(`⚠️ Prometheus: No valid bookIds found in ${tenantSchema}, falling back to fractalId`);
                    }
                } catch (err) {
                    console.warn(`⚠️ Prometheus: BookIds validation failed:`, err.message);
                }
            }
            
            // Fallback to fractalId (current book being viewed)
            if (!targetBookIds && fractalId) {
                targetBookIds = [fractalId];
                console.log(`🔮 Prometheus: Using fractalId fallback: ${fractalId}`);
            }
            
            // Last resort: detect book names from query
            if (!targetBookIds) {
                targetBookIds = await detectAndLookupBookNames(userQuery, tenantSchema);
            }
            
            if (targetBookIds && targetBookIds.length > 0 && tenantSchema) {
                console.log(`🔮 Prometheus API: Fetching context for ${targetBookIds.length} books`);
                multiBookContext = await buildAuditContext(targetBookIds, tenantSchema, userQuery, {
                    pool,
                    thothBot,
                    userRole,
                    maxMessages: 2000
                });
                
                if (multiBookContext && multiBookContext.totalMessages > 0) {
                    result = await Prometheus.checkWithMultiBookContext(userQuery, multiBookContext, { language });
                    hasBookContext = true;
                } else {
                    console.log(`⚠️ No context available, using regular check`);
                    result = await Prometheus.check(messages, ruleType, { language });
                }
            } else {
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
                } catch (dbError) {
                    console.error('⚠️ Failed to save audit query:', dbError.message);
                }
            }
            
            await logAudit(pool, req, 'PROMETHEUS_CHECK', 'MESSAGE', null, null, {
                rule_type: ruleType,
                message_count: Array.isArray(messages) ? messages.length : 1,
                result_status: Array.isArray(result) ? result.map(r => r.status) : result.status
            }, tenantSchema);
            
            if (idrisBot && idrisBot.isReady() && tenantSchema) {
                try {
                    const tenantInfo = await pool.query(`SELECT id, ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1`, [tenantSchema]);
                    if (tenantInfo.rows.length > 0) {
                        const catalogId = tenantInfo.rows[0].id;
                        let threadId = tenantInfo.rows[0]?.ai_log_thread_id;
                        
                        if (!threadId) {
                            const tenantId = parseInt(tenantSchema.replace('tenant_', ''));
                            const threadInfo = await idrisBot.createAILogThread(tenantId, tenantSchema);
                            threadId = threadInfo.threadId;
                            await pool.query(`UPDATE core.tenant_catalog SET ai_log_thread_id = $1, ai_log_channel_id = $2 WHERE id = $3`, [threadInfo.threadId, threadInfo.channelId, catalogId]);
                        }
                        
                        const resultObj = Array.isArray(result) ? result[0] : result;
                        const bookName = hasBookContext ? (resultObj.bookName || (multiBookContext?.books?.[0]?.name)) : null;
                        await idrisBot.postAuditResult(threadId, resultObj, userQuery, bookName);
                    }
                } catch (discordError) {
                    console.error('⚠️ Failed to post audit to Discord:', discordError.message);
                }
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
            res.status(500).json({ error: error.message, needs_human_review: true });
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
