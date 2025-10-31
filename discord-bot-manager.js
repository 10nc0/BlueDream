const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

class DiscordBotManager {
    constructor() {
        this.client = null;
        this.ready = false;
        this.retryQueue = new Map();
    }

    async initialize() {
        if (this.client) {
            console.log('🤖 Discord bot already initialized');
            return;
        }

        const botToken = process.env.DISCORD_BOT_TOKEN;
        if (!botToken) {
            console.log('⚠️  DISCORD_BOT_TOKEN not set - thread auto-creation disabled');
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
                console.error('❌ Discord bot error:', error.message);
            });

            // Wait for ready event with timeout
            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Bot login timeout (30s)'));
                    }, 30000);

                    this.client.once('ready', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        console.log(`✅ Discord bot logged in as ${this.client.user.tag}`);
                        resolve();
                    });
                }),
                this.client.login(botToken)
            ]);

            console.log('🤖 Discord bot ready for thread management');
        } catch (error) {
            console.error('❌ Failed to initialize Discord bot:', error.message);
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async getChannelFromWebhookUrl(webhookUrl) {
        if (!this.client || !this.ready) {
            throw new Error('Discord bot not initialized');
        }

        try {
            const webhookIdMatch = webhookUrl.match(/\/webhooks\/(\d+)\//);
            if (!webhookIdMatch) {
                throw new Error('Invalid webhook URL format');
            }

            const webhookId = webhookIdMatch[1];

            const webhook = await this.client.fetchWebhook(webhookId);
            
            // Discord.js v14: Use channelId property and client.channels.fetch
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
        const transientCodes = [
            429,
            500, 502, 503, 504,
            50001, 
            130000
        ];
        
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
            throw new Error('Discord bot not initialized or not ready');
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

            console.log(`🧵 Created Discord thread: "${threadName}" (ID: ${thread.id})`);
            
            return {
                threadId: thread.id,
                threadName: threadName,
                channelId: channel.id
            };
        } catch (error) {
            console.error(`❌ Failed to create thread for bridge ${bridgeName} (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
            
            if (this.isTransientError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`⏳ Retrying thread creation in ${delay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.createThreadForBridge(webhookUrl, bridgeName, tenantId, bridgeId, retryCount + 1);
            }
            
            throw error;
        }
    }

    async sendInitialMessage(threadId, bridgeName, webhookUrl, retryCount = 0) {
        if (!this.client || !this.ready) {
            throw new Error('Discord bot not initialized or not ready');
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

            console.log(`✅ Sent initial message to thread ${threadId}`);
        } catch (error) {
            console.error(`❌ Failed to send initial message to thread ${threadId} (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
            
            if (this.isTransientError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.sendInitialMessage(threadId, bridgeName, webhookUrl, retryCount + 1);
            }
            
            throw error;
        }
    }

    async retryThreadCreation(bridgeId, tenantId, webhookUrl, bridgeName, dbClient) {
        try {
            console.log(`🔄 Retrying thread creation for bridge t${tenantId}-b${bridgeId}...`);
            
            const threadInfo = await this.createThreadForBridge(
                webhookUrl,
                bridgeName,
                tenantId,
                bridgeId
            );
            
            if (threadInfo && dbClient) {
                await dbClient.query(
                    `UPDATE bridges 
                     SET output_credentials = output_credentials || $1::jsonb
                     WHERE id = $2`,
                    [JSON.stringify({ thread_id: threadInfo.threadId, thread_name: threadInfo.threadName }), bridgeId]
                );
                
                await this.sendInitialMessage(threadInfo.threadId, bridgeName, webhookUrl);
                
                console.log(`✅ Retry successful: Thread created for bridge t${tenantId}-b${bridgeId}`);
                this.retryQueue.delete(`${tenantId}-${bridgeId}`);
                
                return true;
            }
        } catch (error) {
            console.error(`❌ Retry failed for bridge t${tenantId}-b${bridgeId}:`, error.message);
            this.retryQueue.delete(`${tenantId}-${bridgeId}`);
            return false;
        }
    }

    queueRetry(bridgeId, tenantId, webhookUrl, bridgeName, dbClient, delayMs = 60000) {
        const queueKey = `${tenantId}-${bridgeId}`;
        
        if (this.retryQueue.has(queueKey)) {
            console.log(`⚠️  Retry already queued for bridge t${tenantId}-b${bridgeId}`);
            return;
        }
        
        console.log(`📝 Queueing thread creation retry for bridge t${tenantId}-b${bridgeId} (delay: ${delayMs}ms)`);
        
        const timeoutId = setTimeout(async () => {
            await this.retryThreadCreation(bridgeId, tenantId, webhookUrl, bridgeName, dbClient);
        }, delayMs);
        
        this.retryQueue.set(queueKey, {
            timeoutId,
            bridgeId,
            tenantId,
            webhookUrl,
            bridgeName,
            dbClient
        });
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            console.log('🔌 Shutting down Discord bot...');
            
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

module.exports = DiscordBotManager;
