const axios = require('axios');
const FormData = require('form-data');
const { buildCapsule } = require('../utils/message-capsule');
const { pinJson } = require('../utils/ipfs-pinner');
const { routeUserOutput } = require('./outpipes/router');
const { assertValidSchemaName, VALID_SCHEMA_PATTERN } = require('./validators');
const { detectLanguage } = require('../utils/language-detector');
const format = require('pg-format');

// Phone-bearing channels; all others store phone_number = null (Telegram, LINE, email).
// Password reset is gated on phone activation — non-phone users silent-fail on reset.
const PHONE_CHANNELS = new Set(['twilio']);

// ═══════════════════════════════════════════════════════════════
// DURABLE MESSAGE QUEUE: PostgreSQL-backed with priority + retry
// ═══════════════════════════════════════════════════════════════
// Architecture:
//   core.message_queue table with priority column (media/text).
//   Drain order: media first, then text (ORDER BY priority, created_at).
//   Atomic dequeue via UPDATE … FOR UPDATE SKIP LOCKED … RETURNING.
//   Survives restarts: stale 'processing' rows reset to 'pending' on boot.
//   Failed items retry up to MAX_RETRY_COUNT times; last_error stored on row.
//   Requeue failed items: UPDATE core.message_queue SET status='pending',
//     retry_count=0, last_error=NULL WHERE status='failed';
//
// Processing loop (not interval):
//   Continuous async loop with adaptive gap between messages.
//   Normal load: 500ms gap (safe: ~2/sec vs Discord's 5/5sec per route).
//   Burst mode (queue > 5): 200ms gap (~5/sec globally across routes).
//   No dead-wait: loop polls at 100ms when idle.
//   Graceful shutdown: stopQueueProcessor() sets _queueShutdown=true and
//     wakes any in-progress sleep. The loop checks the flag (a) at the top
//     of each iteration, (b) immediately after dequeueItem() returns, and
//     (c) after processQueuedMessage() returns — guaranteeing at most one
//     in-flight message completes before the loop exits (finish-then-stop,
//     never drain). Any item dequeued during the shutdown window stays in
//     `processing` state and is recovered by recoverStaleProcessing() on boot.
//
// Rate limits respected:
//   Discord API: 5 req/5sec per route — we write to different threads so
//                burst mode (200ms) stays under the global 50 req/sec cap.
//   LINE Content API: 2000 req/min — 5/sec is 300/min, well within limit.
//   Twilio webhook: 60 req/min inbound — handled by vegapunk.js rate limiter.
// ═══════════════════════════════════════════════════════════════

const IDEMPOTENCY_TTL_INTERVAL = '6 hours';
const MAX_QUEUE_SIZE = 200;
const NORMAL_GAP_MS  = 500;
const BURST_GAP_MS   = 200;
const BURST_THRESHOLD = 5;
const MAX_RETRY_COUNT = 3;

let _pool = null;
let _cachedDepth = 0;
let _depthCacheTime = 0;
const DEPTH_CACHE_TTL_MS = 200;

let _queueShutdown = false;
let _wakeQueue = null;

function _interruptibleSleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        _wakeQueue = () => { clearTimeout(timer); resolve(); };
    }).finally(() => { _wakeQueue = null; });
}

const MESSAGE_QUEUE = { get length() { return _cachedDepth; } };

function getCachedDepth() { return _cachedDepth; }

function setPool(pool) { _pool = pool; }

async function totalQueueDepth() {
    const now = Date.now();
    if (now - _depthCacheTime < DEPTH_CACHE_TTL_MS) return _cachedDepth;
    try {
        const r = await _pool.query(`SELECT COUNT(*) AS c FROM core.message_queue WHERE status = 'pending'`);
        _cachedDepth = parseInt(r.rows[0].c, 10);
        _depthCacheTime = now;
    } catch (_) { /* use cached */ }
    return _cachedDepth;
}

async function enqueueItem(item) {
    const priority = item.msg.hasMedia ? 'media' : 'text';
    await _pool.query(
        `INSERT INTO core.message_queue (priority, payload, status) VALUES ($1, $2, 'pending')`,
        [priority, JSON.stringify(item)]
    );
    _depthCacheTime = 0;
}

async function dequeueItem() {
    const r = await _pool.query(`
        UPDATE core.message_queue
        SET status = 'processing', updated_at = NOW()
        WHERE id = (
            SELECT id FROM core.message_queue
            WHERE status = 'pending' AND retry_count < $1
            ORDER BY CASE WHEN priority = 'media' THEN 0 ELSE 1 END, created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, payload
    `, [MAX_RETRY_COUNT]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const item = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    item._queueId = row.id;
    return item;
}

async function markQueueDone(queueId) {
    await _pool.query(`UPDATE core.message_queue SET status = 'done', updated_at = NOW() WHERE id = $1`, [queueId]);
    _depthCacheTime = 0;
}

async function markQueueRetry(queueId, errorMessage) {
    const errTrunc = errorMessage ? String(errorMessage).substring(0, 500) : null;
    const r = await _pool.query(
        `UPDATE core.message_queue
         SET retry_count = retry_count + 1,
             updated_at  = NOW(),
             status      = CASE WHEN retry_count + 1 >= $2 THEN 'failed' ELSE 'pending' END,
             last_error  = CASE WHEN retry_count + 1 >= $2 THEN $3 ELSE last_error END
         WHERE id = $1 RETURNING status`,
        [queueId, MAX_RETRY_COUNT, errTrunc]
    );
    _depthCacheTime = 0;
    return r.rows[0]?.status;
}

async function recoverStaleProcessing(logger) {
    try {
        const r = await _pool.query(`
            UPDATE core.message_queue
            SET status = 'pending', updated_at = NOW()
            WHERE status = 'processing'
            RETURNING id
        `);
        if (r.rowCount > 0) {
            logger.info({ recovered: r.rowCount }, `📥 Recovered ${r.rowCount} in-flight messages back to pending`);
        }
        const pending = await _pool.query(`SELECT COUNT(*) AS c FROM core.message_queue WHERE status = 'pending'`);
        const depth = parseInt(pending.rows[0].c, 10);
        if (depth > 0) {
            logger.info({ queueDepth: depth }, `📥 Resuming with ${depth} queued messages from previous session`);
        }
    } catch (err) {
        logger.error({ err }, 'Queue recovery failed');
    }
}

async function cleanupDoneMessages(pool, logger) {
    try {
        const r = await pool.query(`DELETE FROM core.message_queue WHERE status IN ('done', 'failed') AND updated_at < NOW() - INTERVAL '24 hours'`);
        if (r.rowCount > 0) {
            logger.info({ purged: r.rowCount }, '🧹 Purged completed/failed queue entries');
        }
    } catch (err) {
        logger.error({ err }, 'Queue cleanup failed');
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// QUEUE PROCESSOR: continuous adaptive async loop
// ═══════════════════════════════════════════════════════════════
// The processor does not use a polling interval — a gap is inserted
// between messages; instead an explicit gap is inserted after each message.
// Gap adapts to queue depth: burst mode shortens it when load is high.
// Dispatches via item.channel — adding a channel requires zero changes here.
function startQueueProcessor(deps) {
    const { logger, channelRegistry } = deps;
    _queueShutdown = false;

    logger.info({
        normalGapMs: NORMAL_GAP_MS,
        burstGapMs: BURST_GAP_MS,
        burstThreshold: BURST_THRESHOLD
    }, '⚙️ Queue processor started (PostgreSQL-backed, adaptive async loop)');

    const loopDone = (async function loop() {
        while (!_queueShutdown) {
            let item;
            try {
                item = await dequeueItem();
            } catch (err) {
                logger.error({ err }, 'dequeueItem failed');
                await _interruptibleSleep(1000);
                continue;
            }

            if (_queueShutdown) break;

            if (!item) {
                await _interruptibleSleep(100);
                continue;
            }

            const startTime = Date.now();
            const tier = item.msg.hasMedia ? 'media' : 'text';
            const channel = channelRegistry[item.channel];

            if (!channel) {
                logger.error({ channelName: item.channel, messageSid: item.messageSid }, 'Unknown channel in queue item — marking done');
                await markQueueDone(item._queueId).catch(() => {});
                continue;
            }

            let processed = false;
            try {
                await processQueuedMessage(item.msg, item.rawPayload, channel, deps, item.channel);
                processed = true;
            } catch (error) {
                const newStatus = await markQueueRetry(item._queueId, error.message).catch(() => 'unknown');
                const depth = await totalQueueDepth();
                const isFailed = newStatus === 'failed';
                logger[isFailed ? 'warn' : 'error']({
                    error: error.message,
                    messageSid: item.messageSid,
                    tier,
                    status: newStatus,
                    queueDepth: depth
                }, isFailed ? 'Queued message permanently failed (max retries) — last_error stored on queue row' : 'Failed to process queued message — will retry');
            }

            if (processed) {
                await markQueueDone(item._queueId).catch(err =>
                    logger.error({ err, queueId: item._queueId }, 'markQueueDone failed — row will be recovered on restart')
                );
                const depth = await totalQueueDepth();
                logger.info({
                    messageSid: item.messageSid,
                    tier,
                    duration: Date.now() - startTime,
                    queueDepth: depth
                }, 'Queued message processed');
            }

            if (_queueShutdown) break;

            const depth = await totalQueueDepth();
            const gap = depth >= BURST_THRESHOLD ? BURST_GAP_MS : NORMAL_GAP_MS;
            const elapsed = Date.now() - startTime;
            const wait = Math.max(0, gap - elapsed);
            if (wait > 0) await _interruptibleSleep(wait);
        }
        logger.info('⛔ Queue processor stopped (graceful shutdown complete)');
    })();

    return {
        stop() {
            _queueShutdown = true;
            if (_wakeQueue) _wakeQueue();
            return loopDone;
        },
        done: loopDone
    };
}

// Process a single queued message
async function processQueuedMessage(msg, rawPayload, channel, deps, channelName) {
    const { pool, logger } = deps;

    if (channelName === 'webhook') {
        await processWebhookMessage(msg, rawPayload, deps);
        return;
    }
    
    const routingResult = await routeMessage(pool, msg, logger);
    
    if (!routingResult.bookRecord) {
        await handleLimboMessageAsync(channel, msg, rawPayload, deps);
        return;
    }
    
    const { bookRecord } = routingResult;
    
    if (bookRecord.status === 'pending') {
        await handlePendingBookAsync(channel, msg, bookRecord, deps);
        return;
    }
    
    if (bookRecord.status === 'active') {
        await handleActiveBookAsync(channel, msg, rawPayload, bookRecord, deps);
        return;
    }
    
    logger.warn({ status: bookRecord.status, fractalId: bookRecord.fractal_id }, 'Unknown book status');
}

async function processWebhookMessage(msg, rawPayload, deps) {
    const { pool, helpers, logger } = deps;
    const tenantSchema = msg.tenantSchema;

    if (!VALID_SCHEMA_PATTERN.test(tenantSchema)) {
        logger.error({ tenantSchema }, 'Webhook queue: invalid tenant schema');
        return;
    }

    const bookResult = await pool.query(
        format(`SELECT id, fractal_id, name, output_01_url, output_0n_url, output_credentials, outpipes_user FROM %I.books WHERE fractal_id = $1`, tenantSchema),
        [msg.fractalId]
    );
    if (bookResult.rows.length === 0) {
        logger.warn({ fractalId: msg.fractalId }, 'Webhook queue: book deleted between enqueue and processing — message dropped (not retriable)');
        return;
    }

    const book = bookResult.rows[0];
    if (book && typeof book.output_credentials === 'string') {
        try { book.output_credentials = JSON.parse(book.output_credentials); }
        catch { book.output_credentials = {}; }
    }

    const discordPayload = {
        username: msg.senderName,
        avatar_url: msg.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
        content: msg.body || '',
        embeds: []
    };
    if (msg.media_url) {
        discordPayload.embeds.push({ image: { url: msg.media_url } });
    }

    const sendToLedger = helpers?.sendToLedger;
    if (sendToLedger) {
        const threadName = book.output_credentials?.thread_name;
        const threadId = book.output_credentials?.thread_id;
        await sendToLedger(discordPayload, {
            isMedia: !!msg.media_url,
            threadName,
            threadId
        }, book);
    }

    const outpipeCapsule = {
        sender: msg.senderName,
        text: msg.body || '',
        media_url: msg.media_url || null,
        avatar_url: msg.avatar_url || null,
        book_name: book.name || null,
        timestamp: new Date().toISOString()
    };
    await routeUserOutput(outpipeCapsule, { isMedia: !!msg.media_url }, book, { pool, tenantSchema });

    // Archive to anatta_messages + core.message_ledger via capsule pipeline (fire-and-forget)
    // Uses senderName as the phone/identity field so the ledger hash is based on the agent identity.
    processCapsule(
        book,
        { tenant_schema: tenantSchema },
        { ...msg, phone: msg.senderName || 'webhook-agent' },
        null,
        null,
        deps
    );

    logger.info({ sender: msg.senderName, bookId: msg.fractalId }, 'Webhook queue: message processed');
}

// Cleanup old idempotency entries from DB (DELETE rows older than TTL window)
async function cleanupIdempotencyCache(pool, logger) {
    try {
        const result = await pool.query(
            `DELETE FROM core.processed_sids
             WHERE processed_at < NOW() - INTERVAL '${IDEMPOTENCY_TTL_INTERVAL}'`
        );
        const cleaned = result.rowCount || 0;
        if (cleaned > 0) {
            logger.info({ cleaned }, 'Idempotency DB cleanup');
        }
    } catch (err) {
        logger.warn({ err: err.message }, 'Idempotency DB cleanup error (non-fatal)');
    }
}

async function routeMessage(pool, msg, logger) {
    let bookRecord = null;
    let routingMethod = 'unknown';
    
    if (msg.joinCode) {
        logger.info({ joinCode: msg.joinCode }, 'Join code provided - checking registry');
        const result = await pool.query(`
            SELECT id, tenant_schema, tenant_email, fractal_id, book_name, join_code,
                   outpipe_ledger, outpipes_user, status, phone_number, creator_phone
            FROM core.book_registry
            WHERE LOWER(join_code) = LOWER($1)
        `, [msg.joinCode]);
        
        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'join_code';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Found via join code');
        } else {
            logger.info({ joinCode: msg.joinCode }, 'Join code not found in registry');
        }
    } else if (msg.channel === 'telegram') {
        // Telegram routes via channel_identifiers (not book_engaged_phones)
        logger.info({ userId: msg.phone }, 'Telegram: no join code — using channel_identifiers lookup');
        const result = await pool.query(`
            SELECT br.id, br.tenant_schema, br.tenant_email, br.fractal_id, br.book_name, br.join_code,
                   br.outpipe_ledger, br.outpipes_user, br.status, br.phone_number, br.creator_phone, br.updated_at,
                   ci.created_at AS last_engaged_at
            FROM core.channel_identifiers ci
            JOIN core.book_registry br ON br.fractal_id = ci.book_fractal_id
            WHERE ci.channel = 'telegram' AND ci.external_id = $1 AND br.status = 'active'
            LIMIT 1
        `, [String(msg.phone)]);

        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'channel_id';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Telegram: found via channel_identifiers');
        } else {
            logger.info({ userId: msg.phone }, 'Telegram: no active book found in channel_identifiers');
        }
    } else {
        logger.info({ phone: msg.phone }, 'No join code - using phone lookup');
        const result = await pool.query(`
            SELECT br.id, br.tenant_schema, br.tenant_email, br.fractal_id, br.book_name, br.join_code,
                   br.outpipe_ledger, br.outpipes_user, br.status, br.phone_number, br.creator_phone, br.updated_at,
                   ep.last_engaged_at
            FROM core.book_engaged_phones ep
            JOIN core.book_registry br ON br.id = ep.book_registry_id
            WHERE ep.phone = $1 AND br.status = 'active'
            ORDER BY ep.last_engaged_at DESC
            LIMIT 1
        `, [msg.phone]);
        
        if (result.rows.length > 0) {
            bookRecord = result.rows[0];
            routingMethod = 'phone';
            logger.info({ fractalId: bookRecord.fractal_id, bookName: bookRecord.book_name }, 'Found via phone');
        } else {
            logger.info({ phone: msg.phone }, 'No active book found for phone');
        }
    }
    
    return { bookRecord, routingMethod };
}


async function sendToDiscordThread(threadId, payload, media, deps) {
    const hermesToken = deps?.constants?.HERMES_TOKEN || process.env.HERMES_TOKEN;
    const logger = deps?.logger;

    const doSend = async () => {
        if (media) {
            const form = new FormData();
            form.append('files[0]', media.buffer, {
                filename: media.filename,
                contentType: media.contentType
            });
            form.append('payload_json', JSON.stringify(payload));
            return await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, form, {
                headers: {
                    'Authorization': `Bot ${hermesToken}`,
                    ...form.getHeaders()
                }
            });
        } else {
            return await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, payload, {
                headers: {
                    'Authorization': `Bot ${hermesToken}`,
                    'Content-Type': 'application/json'
                }
            });
        }
    };

    const trySend = async (attempt) => {
        try {
            return await doSend();
        } catch (err) {
            const status = err?.response?.status;

            // Discord rate limit — honor retry_after and retry once
            if (status === 429 && attempt < 2) {
                const retryAfterMs = Math.ceil((err.response.data?.retry_after || 1) * 1000);
                if (logger) logger.warn({ threadId, retryAfterMs, attempt }, '⏳ Discord 429 — backing off');
                await sleep(retryAfterMs);
                return trySend(attempt + 1);
            }

            // Thread archived — unarchive and retry once
            const isArchived = status === 403 && err?.response?.data?.code === 50083;
            if (isArchived && attempt < 2) {
                if (logger) logger.info({ threadId }, '🔓 Thread archived — unarchiving and retrying');
                await axios.patch(
                    `https://discord.com/api/v10/channels/${threadId}`,
                    { archived: false, auto_archive_duration: 10080 },
                    { headers: { 'Authorization': `Bot ${hermesToken}`, 'Content-Type': 'application/json' } }
                );
                return trySend(attempt + 1);
            }

            throw err;
        }
    };

    return trySend(1);
}

function sendChannelResponse(res, channel) {
    const response = channel.getEmptyResponse();
    if (response.contentType) {
        res.set('Content-Type', response.contentType);
    }
    return res.status(response.status).send(response.body);
}

// ═══════════════════════════════════════════════════════════════
// ASYNC HANDLERS: "Send and Fire" - Discord webhook as source of truth
// No Twilio reply since we already ACK'd immediately
// ═══════════════════════════════════════════════════════════════

// ── Capsule pipeline helper ───────────────────────────────────────────────────
// Shared by all active-book message paths. Fire-and-forget — never blocks the
// Discord write. Writes ledger row immediately (CIDs null), fills in as pins resolve.
async function processCapsule(book, bookRecord, msg, media, discordResponse, deps) {
    const { pool, logger } = deps;
    const tenantIdMatch = bookRecord.tenant_schema?.match(/tenant_(\d+)/);
    const capsuleTenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
    const langResult = msg.body ? detectLanguage(msg.body) : { lang: null, confidence: 0 };
    const detectedLang = langResult.confidence >= 0.3 ? langResult.lang : null;
    const capsule = buildCapsule({
        bookFractalId: book.fractal_id,
        tenantId: capsuleTenantId,
        phone: msg.phone,
        body: msg.body,
        media,
        timestamp: new Date().toISOString()
    });
    if (media && capsule.attachments.length > 0) {
        const cdnUrl = discordResponse?.data?.attachments?.[0]?.url;
        if (cdnUrl) capsule.attachments[0].attachment_url = cdnUrl;
    }
    ;(async () => {
        try {
            if (pool) {
                const env = deps?.constants?.IS_PROD ? 'prod' : 'dev';
                await pool.query(
                    `INSERT INTO core.message_ledger
                     (message_fractal_id, book_fractal_id, sender_hash, content_hash,
                      has_attachment, env, detected_lang)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (message_fractal_id) DO NOTHING`,
                    [
                        capsule.message_fractal_id,
                        capsule.book_fractal_id,
                        capsule.sender_hash,
                        capsule.content_hash,
                        capsule.attachments.length > 0 || !!msg.media_url,
                        env,
                        detectedLang
                    ]
                );
            }

            // Archive to messages table for PostgreSQL agent read path (non-fatal)
            if (pool && bookRecord?.tenant_schema) {
                try {
                    const tenantSchemaSafe = assertValidSchemaName(bookRecord.tenant_schema);
                    const mediaDiscordUrl = discordResponse?.data?.attachments?.[0]?.url || null;
                    await pool.query(
                        format(
                            `INSERT INTO %I.anatta_messages
                             (book_fractal_id, message_fractal_id, sender_name, body, has_attachment, media_url, recorded_at)
                             VALUES ($1,$2,$3,$4,$5,$6,NOW())
                             ON CONFLICT (message_fractal_id) DO NOTHING`,
                            tenantSchemaSafe
                        ),
                        [
                            capsule.book_fractal_id,
                            capsule.message_fractal_id,
                            msg.senderName || msg.phone || null,
                            msg.body || null,
                            capsule.attachments.length > 0 || !!msg.media_url,
                            mediaDiscordUrl || msg.media_url || null
                        ]
                    );
                } catch (msgTableErr) {
                    logger.warn({ err: msgTableErr.message }, '⚠️ messages table insert failed (non-fatal)');
                }
            }

            const jsonResult = await pinJson(capsule);
            if (jsonResult?.cid && pool) {
                await pool.query(
                    `UPDATE core.message_ledger SET ipfs_cid = $1 WHERE message_fractal_id = $2`,
                    [jsonResult.cid, capsule.message_fractal_id]
                );
                // Back-fill attachment_cid on the messages row with the IPFS CID
                if (bookRecord?.tenant_schema) {
                    try {
                        const tenantSchemaSafe = assertValidSchemaName(bookRecord.tenant_schema);
                        await pool.query(
                            format(
                                `UPDATE %I.anatta_messages SET attachment_cid = $1 WHERE message_fractal_id = $2`,
                                tenantSchemaSafe
                            ),
                            [jsonResult.cid, capsule.message_fractal_id]
                        );
                    } catch (cidUpdateErr) {
                        logger.warn({ err: cidUpdateErr.message }, '⚠️ messages attachment_cid update failed (non-fatal)');
                    }
                }
            }
            if (media?.buffer && capsule.attachments[0]?.attachment_url) {
                if (pool) {
                    await pool.query(
                        `UPDATE core.message_ledger SET attachment_cid = $1 WHERE message_fractal_id = $2`,
                        [capsule.attachments[0].attachment_url, capsule.message_fractal_id]
                    );
                }
            }
            logger.info({
                msgFractalId: capsule.message_fractal_id,
                ipfsCid: jsonResult?.cid || null
            }, '🜁 Capsule sealed');
        } catch (err) {
            logger.warn({ err: err.message }, '⚠️ Capsule pipeline error (non-fatal)');
        }
    })();
}

async function handleLimboMessageAsync(channel, msg, rawPayload, deps) {
    const { pool, constants, logger } = deps;
    const LIMBO_THREAD_ID = constants?.LIMBO_THREAD_ID;
    
    logger.info({ phone: msg.phone }, 'Async: Routing to limbo (no valid join code)');
    
    const limboPayload = {
        embeds: [{
            title: `Limbo Message (No Join Code)`,
            description: msg.body || '_(No text content)_',
            color: 0xFF6B6B,
            fields: [
                { name: 'Phone', value: msg.phone, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true },
                { name: 'Status', value: 'No valid join code found', inline: false },
                { name: 'Message', value: `\`${(msg.body || '').substring(0, 100)}\``, inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'User needs to send a valid join code (e.g., "bookname-abc123")' }
        }]
    };
    
    let media = null;
    if (msg.hasMedia) {
        media = await channel.downloadMedia(rawPayload.mediaUrl, rawPayload.mediaContentType);
        if (media) {
            limboPayload.embeds[0].fields.push({ 
                name: 'Media', 
                value: `${media.contentType} (${(media.buffer.length / 1024).toFixed(1)} KB)`,
                inline: false 
            });
        }
    }
    
    // SEND TO DISCORD (source of truth)
    try {
        await sendToDiscordThread(LIMBO_THREAD_ID, limboPayload, media, deps);
        logger.info({ phone: msg.phone }, 'Async: Limbo message forwarded to Discord');
    } catch (error) {
        logger.error({ error: error.message }, 'Async: Failed to forward limbo message');
    }
    
    // FIRE: Send Twilio reply (non-blocking, no need to wait)
    const domain = process.env.REPLIT_DOMAINS?.split(',')[0] || 'your dashboard';
    channel.sendReply(msg.rawFrom, 
        `Welcome to Nyanbook! To activate your book, send your join code (format: bookname-abc123).\n\nCreate a book at: ${domain}`
    ).catch(err => logger.warn({ error: err.message }, 'Async: Twilio reply failed (non-critical)'));
}

async function handlePendingBookAsync(channel, msg, bookRecord, deps) {
    const { pool, bots, logger } = deps;
    const { hermes: hermesBot } = bots;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id, phone: msg.phone }, 'Async: Activating pending book');
    
    const bookIdResult = await pool.query(`
        SELECT id FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookIdResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Async: Book not found in tenant schema');
        return;
    }
    
    const bookId = bookIdResult.rows[0].id;

    // phone_number stores E.164 only — null for non-phone channels (Line, Telegram, email).
    const phoneToStore = PHONE_CHANNELS.has(msg.channel) ? msg.phone : null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE core.book_registry 
            SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
            WHERE id = $2
        `, [phoneToStore, bookRecord.id]);
        await client.query(`
            UPDATE ${tenantSchema}.books 
            SET status = 'active'
            WHERE id = $1
        `, [bookId]);
        await client.query('COMMIT');
    } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
    } finally {
        client.release();
    }
    
    logger.info({ fractalId: bookRecord.fractal_id, bookId, phone: msg.phone, channel: msg.channel }, 'Async: Activated book');
    
    await pool.query(`
        INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        ON CONFLICT (book_registry_id, phone) DO UPDATE 
        SET last_engaged_at = NOW(), is_creator = TRUE
    `, [bookRecord.id, msg.phone]);

    // Telegram: write to channel_identifiers + activate book_channels row.
    // Always upsert (DO UPDATE) so relinking always wins — latest join code
    // takes over immediately; messages never fire to a previous book by mistake.
    if (msg.channel === 'telegram') {
        // Step 1: Check if previously linked to a different book
        const prevLink = await pool.query(`
            SELECT book_fractal_id, tenant_schema FROM core.channel_identifiers
            WHERE channel = 'telegram' AND external_id = $1
        `, [String(msg.phone)]);
        if (prevLink.rows.length > 0 && prevLink.rows[0].book_fractal_id !== bookRecord.fractal_id) {
            const oldFractal = prevLink.rows[0].book_fractal_id;
            const oldSchema  = assertValidSchemaName(prevLink.rows[0].tenant_schema);
            try {
                await pool.query(`
                    UPDATE ${oldSchema}.book_channels
                    SET status = 'inactive', updated_at = NOW()
                    WHERE book_fractal_id = $1 AND direction = 'inpipe' AND channel = 'telegram'
                `, [oldFractal]);
                logger.info({ oldFractal, newFractal: bookRecord.fractal_id }, 'Async: Telegram old book_channels deactivated on relink');
            } catch (e) {
                logger.warn({ err: e.message }, 'Async: Telegram old book_channels deactivation skipped');
            }
        }
        // Step 2: Upsert — always points to the latest book
        await pool.query(`
            INSERT INTO core.channel_identifiers (channel, external_id, book_fractal_id, tenant_schema)
            VALUES ('telegram', $1, $2, $3)
            ON CONFLICT (channel, external_id)
            DO UPDATE SET book_fractal_id = EXCLUDED.book_fractal_id,
                          tenant_schema   = EXCLUDED.tenant_schema
        `, [String(msg.phone), bookRecord.fractal_id, tenantSchema]);
        // Step 3: Activate new book's book_channels row
        await pool.query(`
            UPDATE ${tenantSchema}.book_channels
            SET status = 'active', updated_at = NOW()
            WHERE book_fractal_id = $1 AND direction = 'inpipe' AND channel = 'telegram'
        `, [bookRecord.fractal_id]);
        logger.info({ fractalId: bookRecord.fractal_id }, 'Async: Telegram channel_identifiers + book_channels activated (latest wins)');
    }
    
    if (hermesBot && hermesBot.isReady()) {
        try {
            const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
            const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
            
            // outpipes_user is JSONB in core.book_registry — pg auto-parses it to an array.
            const outpipesUser = Array.isArray(bookRecord.outpipes_user) ? bookRecord.outpipes_user : [];
            let userOutputUrl = outpipesUser.length > 0 ? (outpipesUser[0]?.url || null) : null;
            
            logger.info({ bookName: bookRecord.book_name, tenantId, bookId, hasUserOutput: !!userOutputUrl }, 'Async: Hermes creating dual outputs');
            const dualThreads = await hermesBot.createDualThreadsForBook(
                bookRecord.outpipe_ledger,
                userOutputUrl,
                bookRecord.book_name,
                tenantId,
                bookId
            );
            
            const outputDestinations = {};
            if (dualThreads.output_01) outputDestinations.output_01 = dualThreads.output_01;
            if (dualThreads.output_0n) outputDestinations.output_0n = dualThreads.output_0n;
            
            await pool.query(`
                UPDATE ${tenantSchema}.books 
                SET output_credentials = COALESCE(output_credentials, '{}'::jsonb) || $1::jsonb
                WHERE id = $2
            `, [JSON.stringify(outputDestinations), bookId]);
            
            // SEND TO DISCORD (source of truth)
            const activationEmbed = {
                embeds: [{
                    title: `Book Activated`,
                    description: `Join code: \`${msg.joinCode}\``,
                    color: 0x00FF00,
                    fields: [
                        { name: 'Phone', value: msg.phone, inline: true },
                        { name: 'Book', value: bookRecord.book_name, inline: true },
                        { name: 'Fractal ID', value: bookRecord.fractal_id, inline: false }
                    ],
                    timestamp: new Date().toISOString()
                }]
            };
            
            if (dualThreads.output_01?.thread_id) {
                await sendToDiscordThread(dualThreads.output_01.thread_id, activationEmbed, null, deps);
            }
            
            logger.info({ 
                threadId: dualThreads.output_01?.thread_id, 
                hasUserOutput: !!dualThreads.output_0n 
            }, 'Async: Hermes dual-thread setup complete');
        } catch (error) {
            logger.error({ error: error.message }, 'Async: Failed to create Hermes threads');
        }
    }
    
    // FIRE: Send Twilio reply (non-blocking)
    channel.sendReply(msg.rawFrom, 
        `Book activated! Your messages will now be saved to "${bookRecord.book_name}". Send anything to test it out!`
    ).catch(err => logger.warn({ error: err.message }, 'Async: Twilio activation reply failed (non-critical)'));
}

async function handleActiveBookAsync(channel, msg, rawPayload, bookRecord, deps) {
    const { pool, logger } = deps;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id }, 'Async: Forwarding message to active book');
    
    const bookDetailsResult = await pool.query(`
        SELECT id, name, fractal_id, output_credentials, outpipes_user
        FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookDetailsResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Async: Book not found in tenant schema');
        return;
    }
    
    const book = bookDetailsResult.rows[0];
    
    // Track engagement (non-blocking on failure)
    try {
        await pool.query(`
            INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
            VALUES ($1, $2, FALSE, NOW(), NOW())
            ON CONFLICT (book_registry_id, phone) DO UPDATE 
            SET last_engaged_at = NOW()
        `, [bookRecord.id, msg.phone]);
        logger.info({ phone: msg.phone, fractalId: bookRecord.fractal_id }, 'Async: Tracked engagement');
    } catch (error) {
        logger.error({ error: error.message }, 'Async: Could not track engagement');
    }
    
    const outputCreds = book.output_credentials || {};
    const output01 = outputCreds.output_01;
    
    const isCreator = (bookRecord.creator_phone && msg.phone === bookRecord.creator_phone) ||
                      (!bookRecord.creator_phone && msg.phone === bookRecord.phone_number);
    
    const embed = {
        description: msg.body || '_(No text content)_',
        color: isCreator ? 0x25D366 : 0x7289DA,
        fields: [
            { name: 'Phone', value: msg.phone, inline: true },
            { name: 'Book', value: book.name, inline: true },
            { name: 'Time', value: new Date().toLocaleString(), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    
    let media = null;
    if (msg.hasMedia) {
        media = await channel.downloadMedia(rawPayload.mediaUrl, rawPayload.mediaContentType);
        if (media) {
            embed.fields.push({ 
                name: 'Media', 
                value: `${media.contentType} (${(media.buffer.length / 1024).toFixed(1)} KB)`,
                inline: false 
            });
        } else {
            embed.fields.push({ 
                name: 'Media (download failed)', 
                value: `[${rawPayload.mediaContentType || 'attachment'}](${rawPayload.mediaUrl})`,
                inline: false 
            });
        }
    }
    
    // SEND TO DISCORD (source of truth) - Ledger thread
    let discordResponse = null;
    if (output01?.type === 'thread' && output01?.thread_id) {
        try {
            discordResponse = await sendToDiscordThread(output01.thread_id, { embeds: [embed] }, media, deps);
            logger.info({ threadId: output01.thread_id }, 'Async: Sent to Ledger thread');
        } catch (error) {
            logger.error({ error: error.message }, 'Async: Failed to send to Ledger');
        }
    }
    
    // OUTPUT #0n: fractal user outpipes (discord webhook / email / custom webhook).
    // routeUserOutput handles both typed outpipes_user and legacy output_credentials.webhooks
    // fallback in one place — book must include outpipes_user from the re-query above.
    // media_url uses the Discord CDN attachment URL (stable) when available.
    try {
        const outpipeCapsule = {
            sender: msg.phone,
            text:   msg.body || '',
            media_url:  discordResponse?.data?.attachments?.[0]?.url || null,
            book_name:  book.name || null,
            timestamp:  new Date().toISOString()
        };
        await routeUserOutput(outpipeCapsule, { isMedia: !!media }, book, { pool, tenantSchema });
    } catch (err) {
        logger.warn({ err: err.message }, 'Async: routeUserOutput error (non-fatal)');
    }

    // ── Capsule pipeline (fire-and-forget — never blocks Discord write) ──────
    processCapsule(book, bookRecord, msg, media, discordResponse, deps);
}

module.exports = {
    MAX_QUEUE_SIZE,
    MESSAGE_QUEUE,
    getCachedDepth,
    setPool,
    totalQueueDepth,
    enqueueItem,
    recoverStaleProcessing,
    cleanupDoneMessages,
    startQueueProcessor,
    cleanupIdempotencyCache,
    sendChannelResponse,
    sleep
};
