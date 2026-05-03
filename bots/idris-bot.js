// idris-bot.js
// IDRIS (ι) - THE SCRIBE
// Permissions: MANAGE_THREADS only (NO READ)
// Security: Can only create threads and post via webhook, cannot read messages
// Purpose: Write-only bot for Nyan AI audit log posting

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const { AUDIT } = require('../config/constants');
const logger = require('../lib/logger');

class IdrisBot {
    constructor() {
        this.client = null;
        this.ready = false;
        this.webhookUrl = null;
    }

    async initialize() {
        if (this.client) {
            logger.info('⚡ Idris bot already initialized');
            return;
        }

        const idrisToken = process.env.IDRIS_AI_LOG_TOKEN;
        // Legacy: PROMETHEUS_WEBHOOK_URL still in use - migrate to NYAN_AUDIT_WEBHOOK_URL
        this.webhookUrl = process.env.NYAN_AUDIT_WEBHOOK_URL || process.env.PROMETHEUS_WEBHOOK_URL;
        
        if (!idrisToken) {
            logger.warn('⚠️ IDRIS_AI_LOG_TOKEN not set — AI audit logging disabled');
            return;
        }

        if (!this.webhookUrl) {
            logger.warn('⚠️ NYAN_AUDIT_WEBHOOK_URL not set — AI audit posting disabled');
        }

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages
                ]
            });

            this.client.on('error', (error) => {
                logger.error({ err: error }, 'Idris bot error');
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Idris login timeout (30s)'));
                    }, 30000);

                    this.client.once('clientReady', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        logger.info({ tag: this.client.user.tag }, '📝 Idris (ι) logged in');
                        resolve();
                    });
                }),
                this.client.login(idrisToken)
            ]);

            logger.info('📝 Idris bot ready for AI audit logging');
        } catch (error) {
            logger.error({ err: error }, '❌ Failed to initialize Idris bot');
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
            throw new Error('NYAN_AUDIT_WEBHOOK_URL not configured');
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

            logger.info({ threadName, threadId: thread.id }, '📝 Idris created AI log thread');
            
            // Add Horus (read bot) to thread for message reading
            const HORUS_USER_ID = process.env.HORUS_BOT_USER_ID;
            if (HORUS_USER_ID) {
                try {
                    await thread.members.add(HORUS_USER_ID);
                    logger.debug({ threadId: thread.id }, '📝 Added Horus to AI log thread');
                } catch (addError) {
                    logger.warn({ err: addError }, '⚠️ Failed to add Horus to thread');
                }
            }
            
            // Post initial message to thread
            await this.postToThread(thread.id, {
                content: `🧿 **AI Audit Log Initialized**\n📅 Created: ${new Date().toISOString()}\n🏢 Tenant: ${displayName}\n\n_All Nyan AI audit checks will be logged here._`
            });
            
            return {
                threadId: thread.id,
                threadName: threadName,
                channelId: channel.id
            };
        } catch (error) {
            logger.error({ tenantId, err: error }, '❌ Idris failed to create AI log thread');
            throw error;
        }
    }

    async postToThread(threadId, messageData) {
        if (!this.webhookUrl) {
            throw new Error('NYAN_AUDIT_WEBHOOK_URL not configured');
        }

        try {
            const webhookWithThread = `${this.webhookUrl}?thread_id=${threadId}`;
            
            const response = await axios.post(webhookWithThread, messageData, {
                headers: { 'Content-Type': 'application/json' }
            });

            return response.data;
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Idris failed to post to thread');
            throw error;
        }
    }

    async createBookAuditThread(fractalId, bookName) {
        if (!this.client || !this.ready) {
            throw new Error('Idris bot not initialized or not ready');
        }
        if (!this.webhookUrl) {
            throw new Error('NYAN_AUDIT_WEBHOOK_URL not configured');
        }

        const channel = await this.getChannelFromWebhookUrl(this.webhookUrl);
        const rawName = `📖 Book Audit — ${bookName} (${fractalId})`;
        const threadName = rawName.substring(0, 100);

        const thread = await channel.threads.create({
            name: threadName,
            autoArchiveDuration: 10080,
            reason: `Auto-created AI audit thread for book: ${fractalId}`,
            type: ChannelType.PublicThread
        });

        logger.info({ threadName, threadId: thread.id, fractalId }, '📖 Idris created book audit thread');

        const HORUS_USER_ID = process.env.HORUS_BOT_USER_ID;
        if (HORUS_USER_ID) {
            try {
                await thread.members.add(HORUS_USER_ID);
            } catch (addErr) {
                logger.warn({ err: addErr }, '⚠️ Failed to add Horus to book audit thread');
            }
        }

        await this.postToThread(thread.id, {
            content: `📖 **Book Audit Log Initialized**\n📅 Created: ${new Date().toISOString()}\n📚 Book: ${bookName}\n🔑 Fractal ID: ${fractalId}\n\n_All Nyan AI audit checks for this book will be logged here._`
        });

        return { threadId: thread.id, threadName, channelId: channel.id };
    }

    async postAuditResult(threadId, auditResult, query, bookName = null) {
        const statusEmoji = AUDIT.STATUS_EMOJI;

        const emoji = statusEmoji[auditResult.status] || '❓';
        const confidence = auditResult.confidence ?? null;
        const confidenceDisplay = confidence !== null
            ? `${confidence}% ${this.getConfidenceBar(confidence)}`
            : 'unverified';

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
                    value: confidenceDisplay,
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
        logger.info({ threadId }, '📝 Idris posted audit result');
    }

    async postMonthlyClosing(threadId, tally) {
        const fields = [
            { name: '📬 Total Messages', value: `${tally.total_messages}`, inline: true },
            { name: '💬 Text', value: `${tally.text_messages}`, inline: true },
            { name: '🖼️ Media', value: `${tally.media_messages}`, inline: true },
            { name: '👥 Contributors', value: `${tally.contributor_count}`, inline: true }
        ];

        if (tally.total_attachment_bytes > 0) {
            const sizeStr = tally.total_attachment_bytes > 1048576
                ? `${(tally.total_attachment_bytes / 1048576).toFixed(1)} MB`
                : `${(tally.total_attachment_bytes / 1024).toFixed(1)} KB`;
            fields.push({ name: '📎 Attachment Size', value: sizeStr, inline: true });
        }

        const entityTypes = Object.keys(tally.entities || {});
        if (entityTypes.length > 0) {
            const entityStr = entityTypes.map(t => `${t}: ${tally.entities[t]}`).join(', ');
            fields.push({ name: '🔍 Entities', value: entityStr.length > 500 ? entityStr.substring(0, 497) + '...' : entityStr, inline: false });
        }

        const tagKeys = Object.keys(tally.tags || {});
        if (tagKeys.length > 0) {
            const tagStr = tagKeys
                .sort((a, b) => tally.tags[b] - tally.tags[a])
                .slice(0, 15)
                .map(k => `${k} (${tally.tags[k]})`)
                .join(', ');
            fields.push({ name: '🏷️ Tags', value: tagStr, inline: false });
        }

        if (tally.time_range) {
            fields.push({
                name: '🕐 Time Range',
                value: `${new Date(tally.time_range.earliest).toUTCString()} → ${new Date(tally.time_range.latest).toUTCString()}`,
                inline: false
            });
        }

        const embed = {
            title: `📊 Monthly Book Closing — ${tally.month}`,
            color: 0x3b82f6,
            fields,
            footer: { text: `Book: ${tally.book_name} (${tally.book_fractal_id})` },
            timestamp: tally.generated_at
        };

        await this.postToThread(threadId, { embeds: [embed] });
        logger.info({ threadId, month: tally.month, bookName: tally.book_name }, '📊 Idris posted monthly closing');
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
            logger.info('🛑 Shutting down Idris...');
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = IdrisBot;
