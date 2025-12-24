const axios = require('axios');
const FormData = require('form-data');
const { TwilioChannel } = require('../lib/channels/twilio');

async function registerInpipeRoutes(app, deps) {
    const { pool, bots, helpers, constants, logger } = deps;
    const { hermes: hermesBot } = bots || {};
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    const LIMBO_THREAD_ID = '1433850939751534672';
    
    if (!pool) {
        logger.warn('Inpipe routes: pool not available, skipping registration');
        return;
    }
    
    const twilioChannel = new TwilioChannel();
    await twilioChannel.initialize();
    logger.info('Registering inpipe routes: POST /api/twilio/webhook');
    
    app.post('/api/twilio/webhook', async (req, res) => {
        try {
            const validation = twilioChannel.validateSignature(req);
            if (!validation.valid) {
                logger.warn({ error: validation.error }, 'Twilio signature validation failed');
                return res.status(validation.status).json({ error: validation.error });
            }
            
            logger.info('Twilio signature verified (O(1) push guard passed)');
            
            const rawPayload = twilioChannel.parsePayload(req);
            const msg = twilioChannel.normalizeMessage(rawPayload);
            
            logger.info({ phone: msg.phone, body: msg.body?.substring(0, 50), joinCode: msg.joinCode }, 'Twilio webhook received');
            
            if (twilioChannel.isSandboxJoinCommand(msg.bodyLower)) {
                logger.info('Ignoring Twilio sandbox join command');
                return sendChannelResponse(res, twilioChannel);
            }
            
            const routingResult = await routeMessage(pool, msg);
            
            if (!routingResult.bookRecord) {
                await handleLimboMessage(res, twilioChannel, msg, rawPayload, deps);
                return;
            }
            
            const { bookRecord, routingMethod } = routingResult;
            
            if (bookRecord.status === 'pending') {
                await handlePendingBook(res, twilioChannel, msg, bookRecord, deps);
                return;
            }
            
            if (bookRecord.status === 'active') {
                await handleActiveBook(res, twilioChannel, msg, rawPayload, bookRecord, deps);
                return;
            }
            
            logger.warn({ status: bookRecord.status, fractalId: bookRecord.fractal_id }, 'Unknown book status');
            return sendChannelResponse(res, twilioChannel);
            
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Twilio webhook error');
            const response = twilioChannel.getEmptyResponse();
            res.status(500).send(response.body);
        }
    });
    
    logger.info('Inpipe routes registered successfully');
}

async function routeMessage(pool, msg) {
    const logger = require('../lib/logger');
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

async function handleLimboMessage(res, channel, msg, rawPayload, deps) {
    const { pool, constants, logger } = deps;
    const LIMBO_THREAD_ID = '1433850939751534672';
    const NYANBOOK_LEDGER_WEBHOOK = constants?.NYANBOOK_LEDGER_WEBHOOK;
    
    logger.info({ phone: msg.phone }, 'Routing to limbo (no valid join code)');
    
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
    
    try {
        await sendToDiscordThread(LIMBO_THREAD_ID, limboPayload, media, deps);
        logger.info({ phone: msg.phone }, 'Limbo message forwarded to t1-b1 thread');
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to forward limbo message');
    }
    
    const domain = process.env.REPLIT_DOMAINS?.split(',')[0] || 'your dashboard';
    await channel.sendReply(msg.rawFrom, 
        `Welcome to Nyanbook! To activate your book, send your join code (format: bookname-abc123).\n\nCreate a book at: ${domain}`
    );
    
    return sendChannelResponse(res, channel);
}

async function handlePendingBook(res, channel, msg, bookRecord, deps) {
    const { pool, bots, logger } = deps;
    const { hermes: hermesBot } = bots;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id, phone: msg.phone }, 'Activating pending book');
    
    const bookIdResult = await pool.query(`
        SELECT id FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookIdResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Book not found in tenant schema');
        return sendChannelResponse(res, channel);
    }
    
    const bookId = bookIdResult.rows[0].id;
    
    await pool.query(`
        UPDATE core.book_registry 
        SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
        WHERE id = $2
    `, [msg.phone, bookRecord.id]);
    
    await pool.query(`
        UPDATE ${tenantSchema}.books 
        SET status = 'active'
        WHERE id = $1
    `, [bookId]);
    
    logger.info({ fractalId: bookRecord.fractal_id, bookId, phone: msg.phone }, 'Activated book');
    
    await pool.query(`
        INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        ON CONFLICT (book_registry_id, phone) DO UPDATE 
        SET last_engaged_at = NOW(), is_creator = TRUE
    `, [bookRecord.id, msg.phone]);
    
    if (hermesBot && hermesBot.isReady()) {
        try {
            const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
            const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
            
            logger.info({ bookName: bookRecord.book_name, tenantId, bookId }, 'Hermes creating dual outputs');
            const dualThreads = await hermesBot.createDualThreadsForBook(
                bookRecord.outpipe_ledger,
                null,
                bookRecord.book_name,
                tenantId,
                bookId
            );
            
            await pool.query(`
                UPDATE ${tenantSchema}.books 
                SET output_credentials = jsonb_set(
                    COALESCE(output_credentials, '{}'::jsonb),
                    '{output_01}',
                    $1::jsonb
                )
                WHERE id = $2
            `, [JSON.stringify(dualThreads.output_01), bookId]);
            
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
            
            logger.info({ threadId: dualThreads.output_01?.thread_id }, 'Hermes thread created');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to create Hermes thread');
        }
    }
    
    await channel.sendReply(msg.rawFrom, 
        `Book activated! Your messages will now be saved to "${bookRecord.book_name}". Send anything to test it out!`
    );
    
    return sendChannelResponse(res, channel);
}

async function handleActiveBook(res, channel, msg, rawPayload, bookRecord, deps) {
    const { pool, logger } = deps;
    const tenantSchema = bookRecord.tenant_schema;
    
    logger.info({ fractalId: bookRecord.fractal_id }, 'Forwarding message to active book');
    
    const bookDetailsResult = await pool.query(`
        SELECT id, name, fractal_id, output_credentials 
        FROM ${tenantSchema}.books 
        WHERE fractal_id = $1
        LIMIT 1
    `, [bookRecord.fractal_id]);
    
    if (bookDetailsResult.rows.length === 0) {
        logger.error({ fractalId: bookRecord.fractal_id, tenantSchema }, 'Book not found in tenant schema');
        return sendChannelResponse(res, channel);
    }
    
    const book = bookDetailsResult.rows[0];
    
    try {
        await pool.query(`
            INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
            VALUES ($1, $2, FALSE, NOW(), NOW())
            ON CONFLICT (book_registry_id, phone) DO UPDATE 
            SET last_engaged_at = NOW()
        `, [bookRecord.id, msg.phone]);
        logger.info({ phone: msg.phone, fractalId: bookRecord.fractal_id }, 'Tracked engagement');
    } catch (error) {
        logger.error({ error: error.message }, 'Could not track engagement');
    }
    
    const outputCreds = book.output_credentials || {};
    const output01 = outputCreds.output_01;
    const webhooks = outputCreds.webhooks || [];
    
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
    
    if (output01?.type === 'thread' && output01?.thread_id) {
        try {
            await sendToDiscordThread(output01.thread_id, { embeds: [embed] }, media, deps);
            logger.info({ threadId: output01.thread_id }, 'Sent to Ledger thread');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send to Ledger');
        }
    }
    
    for (const webhook of webhooks) {
        try {
            await sendToWebhook(webhook.url, { embeds: [embed] }, media);
            logger.info({ webhookName: webhook.name || 'Personal' }, 'Sent to webhook');
        } catch (error) {
            logger.error({ error: error.message, webhookName: webhook.name }, 'Failed to send to webhook');
        }
    }
    
    return sendChannelResponse(res, channel);
}

async function sendToDiscordThread(threadId, payload, media, deps) {
    const hermesToken = process.env.HERMES_TOKEN;
    
    if (media) {
        const form = new FormData();
        form.append('files[0]', media.buffer, {
            filename: media.filename,
            contentType: media.contentType
        });
        form.append('payload_json', JSON.stringify(payload));
        
        await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, form, {
            headers: {
                'Authorization': `Bot ${hermesToken}`,
                ...form.getHeaders()
            }
        });
    } else {
        await axios.post(`https://discord.com/api/v10/channels/${threadId}/messages`, payload, {
            headers: {
                'Authorization': `Bot ${hermesToken}`,
                'Content-Type': 'application/json'
            }
        });
    }
}

async function sendToWebhook(webhookUrl, payload, media) {
    if (media) {
        const form = new FormData();
        form.append('files[0]', media.buffer, {
            filename: media.filename,
            contentType: media.contentType
        });
        form.append('payload_json', JSON.stringify(payload));
        
        await axios.post(webhookUrl, form, {
            headers: form.getHeaders()
        });
    } else {
        await axios.post(webhookUrl, payload);
    }
}

function sendChannelResponse(res, channel) {
    const response = channel.getEmptyResponse();
    if (response.contentType) {
        res.set('Content-Type', response.contentType);
    }
    return res.status(response.status).send(response.body);
}

module.exports = { registerInpipeRoutes };
