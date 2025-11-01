// hermes-bot.js
// HERMES (φ) - THE CREATOR
// Permissions: MANAGE_THREADS only
// Security: Cannot read messages, only create/manage threads

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

class HermesBot {
    constructor() {
        this.client = null;
        this.ready = false;
        this.retryQueue = new Map();
    }

    async initialize() {
        if (this.client) {
            console.log('✨ Hermes bot already initialized');
            return;
        }

        const hermesToken = process.env.HERMES_TOKEN;
        if (!hermesToken) {
            console.log('⚠️  HERMES_TOKEN not set - thread creation disabled');
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
                console.error('❌ Hermes bot error:', error.message);
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Hermes login timeout (30s)'));
                    }, 30000);

                    this.client.once('ready', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        console.log(`✅ Hermes (φ) logged in as ${this.client.user.tag}`);
                        resolve();
                    });
                }),
                this.client.login(hermesToken)
            ]);

            console.log('🌟 Hermes bot ready for thread creation');
        } catch (error) {
            console.error('❌ Failed to initialize Hermes bot:', error.message);
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async getChannelFromWebhookUrl(webhookUrl) {
        if (!this.client || !this.ready) {
            throw new Error('Hermes bot not initialized');
        }

        try {
            const webhookIdMatch = webhookUrl.match(/\/webhooks\/(\d+)\//);
            if (!webhookIdMatch) {
                throw new Error('Invalid webhook URL format');
            }

            const webhookId = webhookIdMatch[1];
            const webhook = await this.client.fetchWebhook(webhookId);
            
            if (!webhook.channelId) {
                throw new Error(`No channel ID found for webhook ${webhookId}`);
            }
            
            const channel = await this.client.channels.fetch(webhook.channelId);
            
            if (!channel) {
                throw new Error(`Channel not found for webhook ${webhookId}`);
            }

            if (!channel.isTextBased()) {
                throw new Error(`Channel ${channel.id} is not a text channel`);
            }

            return channel;
        } catch (error) {
            if (error.code === 10015) {
                throw new Error(`Webhook not found or deleted: ${webhookUrl}`);
            }
            if (error.code === 50013) {
                throw new Error(`Missing permissions to access webhook channel`);
            }
            throw new Error(`Failed to get channel from webhook: ${error.message}`);
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

    async createThreadForBridge(webhookUrl, bridgeName, tenantId, bridgeId, retryCount = 0) {
        if (!this.client || !this.ready) {
            throw new Error('Hermes bot not initialized or not ready');
        }

        const maxRetries = 3;
        const baseDelay = 2000;

        try {
            const channel = await this.getChannelFromWebhookUrl(webhookUrl);
            const threadName = `${bridgeName} (t${tenantId}-b${bridgeId})`;
            
            const thread = await channel.threads.create({
                name: threadName,
                autoArchiveDuration: 10080,
                reason: `Auto-created thread for bridge: ${bridgeName}`,
                type: ChannelType.PublicThread
            });

            console.log(`🧵 Hermes created thread: "${threadName}" (ID: ${thread.id})`);
            
            return {
                threadId: thread.id,
                threadName: threadName,
                channelId: channel.id
            };
        } catch (error) {
            console.error(`❌ Hermes failed to create thread for ${bridgeName} (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
            
            if (this.isTransientError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`⏳ Retrying thread creation in ${delay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.createThreadForBridge(webhookUrl, bridgeName, tenantId, bridgeId, retryCount + 1);
            }
            
            throw error;
        }
    }

    async createDualThreadsForBridge(webhook01Url, webhook0nUrl, bridgeName, tenantId, bridgeId, threadModeUser = true) {
        console.log(`🧵 Hermes creating dual outputs for: ${bridgeName} (t${tenantId}-b${bridgeId})`);
        
        const results = {
            output_01: null,
            output_0n: null,
            errors: []
        };

        // OUTPUT #01: Nyanbook Ledger (ALWAYS THREAD)
        if (webhook01Url) {
            try {
                const threadInfo = await this.createThreadForBridge(
                    webhook01Url,
                    `${bridgeName} [Ledger]`,
                    tenantId,
                    bridgeId
                );
                results.output_01 = {
                    type: 'thread',
                    thread_id: threadInfo.threadId,
                    thread_name: threadInfo.threadName,
                    channel_id: threadInfo.channelId
                };
                console.log(`  ✅ output_01 (Ledger thread): ${threadInfo.threadId}`);
            } catch (error) {
                console.error(`  ❌ Failed to create output_01 thread:`, error.message);
                results.errors.push({ output: 'output_01', error: error.message });
            }
        }

        // OUTPUT #0n: User Discord (webhook-only)
        if (webhook0nUrl) {
            results.output_0n = {
                type: 'webhook',
                webhook_url: webhook0nUrl
            };
            console.log(`  ✅ output_0n (webhook): stored`);
        }

        return results;
    }

    async sendInitialMessage(threadId, bridgeName, webhookUrl, retryCount = 0) {
        if (!this.client || !this.ready) {
            throw new Error('Hermes bot not initialized');
        }

        const maxRetries = 2;
        const baseDelay = 1000;

        try {
            const thread = await this.client.channels.fetch(threadId);
            
            if (!thread) {
                throw new Error(`Thread ${threadId} not found`);
            }

            await thread.send({
                embeds: [{
                    title: `🌈 ${bridgeName} - Bridge Activated`,
                    description: 'All messages from this bridge will appear in this thread.',
                    color: 0x00ff88,
                    fields: [
                        {
                            name: '📱 Input Platform',
                            value: 'WhatsApp',
                            inline: true
                        },
                        {
                            name: '📤 Output Platform',
                            value: 'Discord Thread',
                            inline: true
                        }
                    ],
                    footer: {
                        text: 'Your Nyanbook~ 🌈'
                    },
                    timestamp: new Date()
                }]
            });

            console.log(`✅ Hermes sent initial message to thread ${threadId}`);
        } catch (error) {
            console.error(`❌ Hermes failed to send initial message (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
            
            if (this.isTransientError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.sendInitialMessage(threadId, bridgeName, webhookUrl, retryCount + 1);
            }
            
            throw error;
        }
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            console.log('🔌 Shutting down Hermes...');
            
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
