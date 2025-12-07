// idris-bot.js
// IDRIS (ι) - THE SCRIBE
// Permissions: MANAGE_THREADS only (NO READ)
// Security: Can only create threads and post via webhook, cannot read messages
// Purpose: Write-only bot for AI audit log posting (Prometheus Trinity)

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');

class IdrisBot {
    constructor() {
        this.client = null;
        this.ready = false;
        this.webhookUrl = null;
    }

    async initialize() {
        if (this.client) {
            console.log('📜 Idris bot already initialized');
            return;
        }

        const idrisToken = process.env.IDRIS_AI_LOG_TOKEN;
        this.webhookUrl = process.env.PROMETHEUS_WEBHOOK_URL;
        
        if (!idrisToken) {
            console.log('⚠️  IDRIS_AI_LOG_TOKEN not set - AI audit logging disabled');
            return;
        }

        if (!this.webhookUrl) {
            console.log('⚠️  PROMETHEUS_WEBHOOK_URL not set - AI audit posting disabled');
        }

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages
                ]
            });

            this.client.on('error', (error) => {
                console.error('❌ Idris bot error:', error.message);
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Idris login timeout (30s)'));
                    }, 30000);

                    this.client.once('clientReady', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        console.log(`✅ Idris (ι) logged in as ${this.client.user.tag}`);
                        resolve();
                    });
                }),
                this.client.login(idrisToken)
            ]);

            console.log('📜 Idris bot ready for AI audit logging');
        } catch (error) {
            console.error('❌ Failed to initialize Idris bot:', error.message);
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async getChannelFromWebhookUrl(webhookUrl) {
        if (!this.client || !this.ready) {
            throw new Error('Idris bot not initialized');
        }

        try {
            const webhookIdMatch = webhookUrl.match(/\/webhooks\/(\d+)\/([a-zA-Z0-9_-]+)/);
            if (!webhookIdMatch) {
                throw new Error('Invalid webhook URL format');
            }
            
            const webhookId = webhookIdMatch[1];
            const webhookToken = webhookIdMatch[2];
            
            const webhookResponse = await axios.get(`https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}`);
            const channelId = webhookResponse.data.channel_id;
            
            if (!channelId) {
                throw new Error('Could not extract channel_id from webhook');
            }
            
            const channel = await this.client.channels.fetch(channelId);
            
            if (!channel || !channel.isTextBased()) {
                throw new Error(`Channel ${channelId} not found or not a text channel`);
            }

            return channel;
        } catch (error) {
            throw new Error(`Failed to get channel: ${error.message}`);
        }
    }

    async createAILogThread(tenantId, tenantName = null) {
        if (!this.client || !this.ready) {
            throw new Error('Idris bot not initialized or not ready');
        }

        if (!this.webhookUrl) {
            throw new Error('PROMETHEUS_WEBHOOK_URL not configured');
        }

        try {
            const channel = await this.getChannelFromWebhookUrl(this.webhookUrl);
            
            const displayName = tenantName || `Tenant ${tenantId}`;
            const threadName = `🧿 AI Audit Log - ${displayName} (t${tenantId})`;
            
            const thread = await channel.threads.create({
                name: threadName,
                autoArchiveDuration: 10080,
                reason: `Auto-created AI audit log thread for tenant: ${tenantId}`,
                type: ChannelType.PublicThread
            });

            console.log(`🧵 Idris created AI log thread: "${threadName}" (ID: ${thread.id})`);
            
            // Add Horus (read bot) to thread for message reading
            const HORUS_USER_ID = process.env.HORUS_BOT_USER_ID;
            if (HORUS_USER_ID) {
                try {
                    await thread.members.add(HORUS_USER_ID);
                    console.log(`  ✅ Added Horus (mirror bot) to AI log thread`);
                } catch (addError) {
                    console.warn(`  ⚠️  Failed to add Horus to thread: ${addError.message}`);
                }
            }
            
            // Post initial message to thread
            await this.postToThread(thread.id, {
                content: `🧿 **AI Audit Log Initialized**\n📅 Created: ${new Date().toISOString()}\n🏢 Tenant: ${displayName}\n\n_All Prometheus AI checks will be logged here._`
            });
            
            return {
                threadId: thread.id,
                threadName: threadName,
                channelId: channel.id
            };
        } catch (error) {
            console.error(`❌ Idris failed to create AI log thread for tenant ${tenantId}:`, error.message);
            throw error;
        }
    }

    async postToThread(threadId, messageData) {
        if (!this.webhookUrl) {
            throw new Error('PROMETHEUS_WEBHOOK_URL not configured');
        }

        try {
            const webhookWithThread = `${this.webhookUrl}?thread_id=${threadId}`;
            
            const response = await axios.post(webhookWithThread, messageData, {
                headers: { 'Content-Type': 'application/json' }
            });

            return response.data;
        } catch (error) {
            console.error(`❌ Idris failed to post to thread ${threadId}:`, error.message);
            throw error;
        }
    }

    async postAuditResult(threadId, auditResult, query, bookName = null) {
        const statusEmoji = {
            'PASS': '✅',
            'FAIL': '❌',
            'WARNING': '⚠️',
            'REVIEW': '🔍'
        };

        const emoji = statusEmoji[auditResult.status] || '❓';
        const confidence = auditResult.confidence || 0;
        const confidenceBar = this.getConfidenceBar(confidence);

        const embed = {
            title: `${emoji} AI Audit Result`,
            color: this.getStatusColor(auditResult.status),
            fields: [
                {
                    name: '📝 Query',
                    value: query.length > 200 ? query.substring(0, 200) + '...' : query,
                    inline: false
                },
                {
                    name: '📊 Status',
                    value: `**${auditResult.status}**`,
                    inline: true
                },
                {
                    name: '🎯 Confidence',
                    value: `${confidence}% ${confidenceBar}`,
                    inline: true
                }
            ],
            timestamp: new Date().toISOString()
        };

        if (bookName) {
            embed.fields.unshift({
                name: '📚 Book Context',
                value: bookName,
                inline: true
            });
        }

        if (auditResult.answer) {
            embed.fields.push({
                name: '💬 Answer',
                value: auditResult.answer.length > 500 ? auditResult.answer.substring(0, 500) + '...' : auditResult.answer,
                inline: false
            });
        }

        if (auditResult.data_extracted && Object.keys(auditResult.data_extracted).length > 0) {
            const dataStr = JSON.stringify(auditResult.data_extracted, null, 2);
            embed.fields.push({
                name: '📊 Extracted Data',
                value: '```json\n' + (dataStr.length > 400 ? dataStr.substring(0, 400) + '...' : dataStr) + '\n```',
                inline: false
            });
        }

        if (auditResult.reason) {
            embed.fields.push({
                name: '💭 Reasoning',
                value: auditResult.reason.length > 300 ? auditResult.reason.substring(0, 300) + '...' : auditResult.reason,
                inline: false
            });
        }

        await this.postToThread(threadId, { embeds: [embed] });
        console.log(`📜 Idris posted audit result to thread ${threadId}`);
    }

    getStatusColor(status) {
        const colors = {
            'PASS': 0x10b981,
            'FAIL': 0xef4444,
            'WARNING': 0xf59e0b,
            'REVIEW': 0x6366f1
        };
        return colors[status] || 0x94a3b8;
    }

    getConfidenceBar(confidence) {
        const filled = Math.round(confidence / 10);
        const empty = 10 - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            console.log('🔌 Shutting down Idris...');
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = IdrisBot;
