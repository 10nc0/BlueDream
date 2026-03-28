// hermes-bot.js
// HERMES (φ) - THE CREATOR
// Permissions: MANAGE_THREADS only
// Security: Cannot read messages, only create/manage threads

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const logger = require('../lib/logger');

class HermesBot {
    constructor() {
        this.client = null;
        this.ready = false;
        this.retryQueue = new Map();
    }

    async initialize() {
        if (this.client) {
            logger.info('⚡ Hermes bot already initialized');
            return;
        }

        const hermesToken = process.env.HERMES_TOKEN;
        if (!hermesToken) {
            logger.warn('⚠️ HERMES_TOKEN not set — thread creation disabled');
            return;
        }

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages
                ]
            });

            this.client.on('error', (error) => {
                logger.error({ err: error }, 'Hermes bot error');
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Hermes login timeout (30s)'));
                    }, 30000);

                    this.client.once('clientReady', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        logger.info({ tag: this.client.user.tag }, '⚡ Hermes (φ) logged in');
                        resolve();
                    });
                }),
                this.client.login(hermesToken)
            ]);

            logger.info('⚡ Hermes bot ready for thread creation');
        } catch (error) {
            logger.error({ err: error }, '❌ Failed to initialize Hermes bot');
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async getChannelFromWebhookUrl(webhookUrl, channelId = null) {
        if (!this.client || !this.ready) {
            throw new Error('Hermes bot not initialized');
        }

        try {
            let targetChannelId = channelId;
            
            // If no channelId provided, extract it from webhook URL
            if (!targetChannelId) {
                const webhookIdMatch = webhookUrl.match(/\/webhooks\/(\d+)\/([a-zA-Z0-9_-]+)/);
                if (!webhookIdMatch) {
                    throw new Error('Invalid webhook URL format - provide channelId explicitly or use full webhook URL');
                }
                
                const webhookId = webhookIdMatch[1];
                const webhookToken = webhookIdMatch[2];
                
                // Fetch webhook to get channel_id
                const axios = require('axios');
                const webhookResponse = await axios.get(`https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}`);
                targetChannelId = webhookResponse.data.channel_id;
                
                if (!targetChannelId) {
                    throw new Error('Could not extract channel_id from webhook');
                }
            }
            
            const channel = await this.client.channels.fetch(targetChannelId);
            
            if (!channel) {
                throw new Error(`Channel ${targetChannelId} not found`);
            }

            if (!channel.isTextBased()) {
                throw new Error(`Channel ${channel.id} is not a text channel`);
            }

            return channel;
        } catch (error) {
            if (error.code === 50013) {
                throw new Error(`Missing permissions to access channel`);
            }
            throw new Error(`Failed to get channel: ${error.message}`);
        }
    }

    isTransientError(error) {
        const transientCodes = [429, 500, 502, 503, 504, 50001, 130000];
        
        if (error.code && transientCodes.includes(error.code)) {
            return true;
        }
        
        if (error.message && (
            error.message.includes('timeout') ||
            error.message.includes('rate limit') ||
            error.message.includes('temporarily') ||
            error.message.includes('retry')
        )) {
            return true;
        }
        
        return false;
    }

    async createThreadForBook(webhookUrl, bookName, tenantId, bookId, channelId = null, retryCount = 0) {
        if (!this.client || !this.ready) {
            throw new Error('Hermes bot not initialized or not ready');
        }

        const maxRetries = 3;
        const baseDelay = 2000;

        try {
            const channel = channelId 
                ? await this.client.channels.fetch(channelId)
                : await this.getChannelFromWebhookUrl(webhookUrl, channelId);
            
            const threadName = `${bookName} (t${tenantId}-b${bookId})`;
            
            const thread = await channel.threads.create({
                name: threadName,
                autoArchiveDuration: 10080,
                reason: `Auto-created thread for book: ${bookName}`,
                type: ChannelType.PublicThread
            });

            logger.info({ threadName, threadId: thread.id }, '🧵 Hermes created thread');
            
            const THOTH_USER_ID = '1434213576737820733';
            try {
                await thread.members.add(THOTH_USER_ID);
                logger.debug({ threadId: thread.id }, '🧵 Added Thoth to thread');
            } catch (addError) {
                logger.warn({ err: addError }, '⚠️ Failed to add Thoth to thread');
            }
            
            return {
                threadId: thread.id,
                threadName: threadName,
                channelId: channel.id
            };
        } catch (error) {
            logger.error({ bookName, attempt: retryCount + 1, maxRetries, err: error }, '❌ Hermes failed to create thread');
            
            if (this.isTransientError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info({ delayMs: delay, attempt: retryCount + 1 }, '⏳ Retrying thread creation');
                
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.createThreadForBook(webhookUrl, bookName, tenantId, bookId, channelId, retryCount + 1);
            }
            
            throw error;
        }
    }

    async createDualThreadsForBook(webhook01Url, webhook0nUrl, bookName, tenantId, bookId, threadModeUser = true, existingCredentials = null) {
        logger.info({ bookName, tenantId, bookId }, '🔀 Hermes creating dual outputs');
        
        const results = {
            output_01: null,
            output_0n: null,
            errors: []
        };

        // IDEMPOTENT: Check if output_01 thread already exists
        if (existingCredentials?.output_01?.thread_id) {
            logger.debug({ threadId: existingCredentials.output_01.thread_id }, '📌 output_01 thread already exists — skipping creation');
            results.output_01 = existingCredentials.output_01;
        } else if (webhook01Url) {
            // OUTPUT #01: Nyanbook Ledger (ALWAYS THREAD)
            try {
                const threadInfo = await this.createThreadForBook(
                    webhook01Url,
                    `${bookName} [Ledger]`,
                    tenantId,
                    bookId
                );
                results.output_01 = {
                    type: 'thread',
                    thread_id: threadInfo.threadId,
                    thread_name: threadInfo.threadName,
                    channel_id: threadInfo.channelId
                };
                logger.info({ threadId: threadInfo.threadId }, '📌 output_01 (Ledger thread) ready');
            } catch (error) {
                logger.error({ err: error }, '❌ Failed to create output_01 thread');
                results.errors.push({ output: 'output_01', error: error.message });
            }
        }

        // IDEMPOTENT: Check if output_0n already configured (webhook OR thread)
        if (existingCredentials?.output_0n?.webhook_url || existingCredentials?.output_0n?.thread_id) {
            logger.debug('📤 output_0n already configured — skipping');
            results.output_0n = existingCredentials.output_0n;
        } else if (webhook0nUrl) {
            // OUTPUT #0n: User Discord (webhook-only)
            results.output_0n = {
                type: 'webhook',
                webhook_url: webhook0nUrl
            };
            logger.debug('📤 output_0n (webhook) stored');
        }

        return results;
    }


    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            logger.info('🛑 Shutting down Hermes...');
            
            for (const [key, retry] of this.retryQueue.entries()) {
                clearTimeout(retry.timeoutId);
            }
            this.retryQueue.clear();
            
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = HermesBot;
