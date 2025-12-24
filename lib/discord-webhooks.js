'use strict';

const axios = require('axios');

const MESSAGE_CHUNK_SIZE = 3800;

function splitMessageIntoChunks(text, chunkSize = MESSAGE_CHUNK_SIZE) {
    if (text.length <= chunkSize) {
        return [text];
    }
    
    const chunks = [];
    let remaining = text;
    
    while (remaining.length > 0) {
        if (remaining.length <= chunkSize) {
            chunks.push(remaining);
            break;
        }
        
        let splitIndex = remaining.lastIndexOf('\n', chunkSize);
        if (splitIndex === -1 || splitIndex < chunkSize * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', chunkSize);
            if (splitIndex === -1 || splitIndex < chunkSize * 0.5) {
                splitIndex = chunkSize;
            }
        }
        
        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }
    
    return chunks;
}

async function postPayloadToWebhook(url, payload, options = {}) {
    if (!url) throw new Error('Webhook URL required');
    
    try {
        let response;
        
        if (options.mediaBuffer) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('files[0]', options.mediaBuffer, {
                filename: options.mediaFilename || 'attachment',
                contentType: options.mediaContentType || 'application/octet-stream'
            });
            form.append('payload_json', JSON.stringify(payload));
            response = await axios.post(url, form, { headers: form.getHeaders() });
        } 
        else if (options.isMedia && options.mediaBufferId && options.tenantSchema && options.pool) {
            const mediaClient = await options.pool.connect();
            try {
                const mediaResult = await mediaClient.query(`
                    SELECT media_data, media_type, filename 
                    FROM ${options.tenantSchema}.media_buffer 
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
                if (mediaResult.rows.length === 0) {
                    throw new Error(`Media buffer ID ${options.mediaBufferId} not found`);
                }
                
                const { media_data, media_type, filename } = mediaResult.rows[0];
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', media_data, {
                    filename: filename,
                    contentType: media_type
                });
                form.append('payload_json', JSON.stringify(payload));
                response = await axios.post(url, form, { headers: form.getHeaders() });
            } finally {
                mediaClient.release();
            }
        }
        else {
            response = await axios.post(url, payload);
        }
        
        return response;
    } catch (error) {
        console.error(`  ❌ Webhook POST failed: ${error.message}`);
        throw error;
    }
}

function createSendToLedger(pool, fallbackWebhookUrl) {
    return async function sendToLedger(payload, options = {}, book = null) {
        let ledgerUrl = book?.output_01_url;
        
        if (!ledgerUrl || !ledgerUrl.trim()) {
            ledgerUrl = fallbackWebhookUrl;
        }
        
        if (!ledgerUrl) {
            console.log('  ℹ️  No ledger configured - skipping Output #01');
            return null;
        }

        try {
            const output = options.output;
            const destinationType = output?.type || 'unknown';
            const destinationId = output?.type === 'thread' ? output?.thread_id : output?.channel_id;
            
            console.log(`  🔍 Ledger URL: ${ledgerUrl ? '[MASKED_LEDGER_WEBHOOK]' : 'none'}`);
            console.log(`  🔍 Destination: ${destinationType} (ID: ${destinationId || 'none'})`);
            
            const url = new URL(ledgerUrl);
            url.searchParams.set('wait', 'true');
            
            if (output?.type === 'thread' && output?.thread_id) {
                url.searchParams.set('thread_id', output.thread_id);
                console.log(`  📍 Targeting thread: ${output.thread_id}`);
            } else if (output?.type === 'channel') {
                console.log(`  📍 Targeting channel: ${output.channel_id}`);
            }

            const response = await postPayloadToWebhook(url.toString(), payload, {
                mediaBuffer: options.mediaBuffer,
                mediaFilename: options.mediaFilename,
                mediaContentType: options.mediaContentType,
                isMedia: options.isMedia,
                mediaBufferId: options.mediaBufferId,
                tenantSchema: options.tenantSchema,
                pool
            });

            console.log(`  ✅ Sent to Output #01 (Ledger) - Thread: ${options.threadId || 'channel'}`);
            return response.data?.channel_id || null;
        } catch (error) {
            console.error(`  ❌ Output #01 failed: ${error.message}`);
            console.error(`  🔍 URL attempted: ${ledgerUrl?.substring(0, 50)}...`);
            if (error.response?.data) {
                console.error(`  🔍 Discord error response:`, JSON.stringify(error.response.data, null, 2));
            }
            return null;
        }
    };
}

function createSendToUserOutput(pool) {
    return async function sendToUserOutput(payload, options = {}, book = null) {
        if (!book) {
            console.log('  ℹ️  No book context - skipping Output #0n');
            return false;
        }

        try {
            const webhooks = book.output_credentials?.webhooks || [];
            const fallbackUrl = book.output_0n_url;
            
            if (webhooks.length === 0 && (!fallbackUrl || !fallbackUrl.trim())) {
                console.log(`  ℹ️  No Output #0n configured - skipping user Discord`);
                return false;
            }
            
            const webhookList = webhooks.length > 0 
                ? webhooks.filter(w => w.url && w.url.trim())
                : (fallbackUrl ? [{ name: 'Personal Webhook', url: fallbackUrl }] : []);
            
            if (webhookList.length === 0) {
                console.log(`  ℹ️  No valid webhooks configured - skipping user Discord`);
                return false;
            }
            
            console.log(`  📤 Sending to ${webhookList.length} personal webhook(s)...`);
            
            const sendPromises = webhookList.map(async (webhook, index) => {
                try {
                    const url = new URL(webhook.url);
                    url.searchParams.set('wait', 'true');
                    
                    const output = options.output;
                    if (output?.type === 'thread' && output?.thread_id) {
                        url.searchParams.set('thread_id', output.thread_id);
                    }
                    
                    await postPayloadToWebhook(url.toString(), payload, {
                        isMedia: options.isMedia,
                        mediaBufferId: options.mediaBufferId,
                        tenantSchema: options.tenantSchema,
                        pool
                    });
                    
                    console.log(`    ✅ Sent to "${webhook.name || 'Webhook ' + (index + 1)}"`);
                    return true;
                } catch (error) {
                    console.error(`    ❌ Failed to send to "${webhook.name || 'Webhook ' + (index + 1)}": ${error.message}`);
                    return false;
                }
            });
            
            const results = await Promise.all(sendPromises);
            const successCount = results.filter(r => r).length;
            console.log(`  📊 Sent to ${successCount}/${webhookList.length} webhook(s)`);
            
            if (successCount > 0 && options.isMedia && options.mediaBufferId) {
                const deliveryClient = await pool.connect();
                try {
                    await deliveryClient.query(`
                        UPDATE ${options.tenantSchema}.media_buffer 
                        SET delivered_to_user = true,
                            delivery_attempts = delivery_attempts + 1,
                            last_delivery_attempt = NOW()
                        WHERE id = $1
                    `, [options.mediaBufferId]);
                } finally {
                    deliveryClient.release();
                }
            }

            console.log(`  ✅ Sent to Output #0n (User Discord)`);
            return true;
        } catch (error) {
            console.error(`  ❌ Output #0n failed: ${error.message}`);
            if (error.response?.data) {
                console.error(`  🔍 Discord error response:`, JSON.stringify(error.response.data, null, 2));
            }
            return false;
        }
    };
}

module.exports = {
    MESSAGE_CHUNK_SIZE,
    splitMessageIntoChunks,
    postPayloadToWebhook,
    createSendToLedger,
    createSendToUserOutput
};
