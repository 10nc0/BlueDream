// horus-bot.js
// HORUS (Ω) - THE WATCHER
// Permissions: READ_MESSAGE_HISTORY only (NO WRITE)
// Security: Can only read messages, cannot create/modify/delete
// Purpose: Read-only bot for fetching Nyan AI audit logs

const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('../lib/logger');

class HorusBot {
    constructor() {
        this.client = null;
        this.ready = false;
    }

    async initialize() {
        if (this.client) {
            logger.info('⚡ Horus bot already initialized');
            return;
        }

        const horusToken = process.env.HORUS_AI_LOG_TOKEN;
        if (!horusToken) {
            logger.warn('⚠️ HORUS_AI_LOG_TOKEN not set — AI audit reading disabled');
            return;
        }

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent
                ]
            });

            this.client.on('error', (error) => {
                logger.error({ err: error }, 'Horus bot error');
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Horus login timeout (30s)'));
                    }, 30000);

                    this.client.once('clientReady', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        logger.info({ tag: this.client.user.tag }, '🔍 Horus (Ω) logged in');
                        resolve();
                    });
                }),
                this.client.login(horusToken)
            ]);

            logger.info('🔍 Horus bot ready for AI audit reading');
        } catch (error) {
            logger.error({ err: error }, '❌ Failed to initialize Horus bot');
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async fetchAuditLogs(threadId, limit = 50) {
        if (!this.client || !this.ready) {
            throw new Error('Horus bot not initialized');
        }

        try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                throw new Error(`Thread ${threadId} not found or not a thread`);
            }

            const messages = await thread.messages.fetch({ limit });

            const auditLogs = messages
                .map(msg => {
                    const log = {
                        id: msg.id,
                        timestamp: msg.createdAt.toISOString(),
                        content: msg.content,
                        embeds: []
                    };

                    // Parse embeds for structured audit data
                    if (msg.embeds.length > 0) {
                        log.embeds = msg.embeds.map(embed => ({
                            title: embed.title,
                            color: embed.color,
                            fields: embed.fields.map(f => ({
                                name: f.name,
                                value: f.value,
                                inline: f.inline
                            })),
                            timestamp: embed.timestamp
                        }));

                        // Extract status from first embed if it's an audit result
                        const firstEmbed = msg.embeds[0];
                        if (firstEmbed.title && firstEmbed.title.includes('AI Audit Result')) {
                            const statusField = firstEmbed.fields.find(f => f.name === '📊 Status');
                            const confidenceField = firstEmbed.fields.find(f => f.name === '🎯 Confidence');
                            const queryField = firstEmbed.fields.find(f => f.name === '📝 Query');
                            const answerField = firstEmbed.fields.find(f => f.name === '💬 Answer');
                            const bookField = firstEmbed.fields.find(f => f.name === '📚 Book Context');

                            const rawConf = confidenceField ? parseInt(confidenceField.value) : null;
                            log.parsed = {
                                status: statusField ? statusField.value.replace(/\*/g, '') : null,
                                confidence: Number.isNaN(rawConf) ? null : rawConf,
                                query: queryField ? queryField.value : null,
                                answer: answerField ? answerField.value : null,
                                bookContext: bookField ? bookField.value : null
                            };
                        }
                    }

                    return log;
                });
            // Discord returns newest first - keep that order for display

            logger.info({ count: auditLogs.length, threadId }, '📊 Horus fetched audit logs');
            return auditLogs;
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Horus failed to fetch audit logs');
            throw error;
        }
    }

    async fetchAuditLogsPaginated(threadId, options = {}) {
        if (!this.client || !this.ready) {
            throw new Error('Horus bot not initialized');
        }

        const { limit = 25, before = null, after = null } = options;

        try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                throw new Error(`Thread ${threadId} not found or not a thread`);
            }

            const fetchOptions = { limit };
            if (before) fetchOptions.before = before;
            if (after) fetchOptions.after = after;

            const messages = await thread.messages.fetch(fetchOptions);

            const auditLogs = messages
                .map(msg => this.parseAuditMessage(msg))
                .reverse();

            return {
                logs: auditLogs,
                hasMore: messages.size === limit,
                oldestId: auditLogs.length > 0 ? auditLogs[0].id : null,
                newestId: auditLogs.length > 0 ? auditLogs[auditLogs.length - 1].id : null
            };
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Horus failed to fetch paginated audit logs');
            throw error;
        }
    }

    parseAuditMessage(msg) {
        const log = {
            id: msg.id,
            timestamp: msg.createdAt.toISOString(),
            content: msg.content,
            embeds: []
        };

        if (msg.embeds.length > 0) {
            log.embeds = msg.embeds.map(embed => ({
                title: embed.title,
                color: embed.color,
                fields: embed.fields.map(f => ({
                    name: f.name,
                    value: f.value,
                    inline: f.inline
                })),
                timestamp: embed.timestamp
            }));

            const firstEmbed = msg.embeds[0];
            if (firstEmbed.title && firstEmbed.title.includes('AI Audit Result')) {
                const statusField = firstEmbed.fields.find(f => f.name === '📊 Status');
                const confidenceField = firstEmbed.fields.find(f => f.name === '🎯 Confidence');
                const queryField = firstEmbed.fields.find(f => f.name === '📝 Query');
                const answerField = firstEmbed.fields.find(f => f.name === '💬 Answer');
                const bookField = firstEmbed.fields.find(f => f.name === '📚 Book Context');

                const rawConf = confidenceField ? parseInt(confidenceField.value) : null;
                log.type = 'audit';
                log.parsed = {
                    status: statusField ? statusField.value.replace(/\*/g, '') : null,
                    confidence: Number.isNaN(rawConf) ? null : rawConf,
                    query: queryField ? queryField.value : null,
                    answer: answerField ? answerField.value : null,
                    bookContext: bookField ? bookField.value : null
                };
            } else if (firstEmbed.title && firstEmbed.title.includes('Monthly Book Closing')) {
                log.type = 'closing';
                const monthMatch = firstEmbed.title.match(/Monthly Book Closing\s*—\s*(.+)$/);
                const getClosingField = (name) => firstEmbed.fields.find(f => f.name === name)?.value ?? null;
                log.parsed = {
                    month: monthMatch ? monthMatch[1].trim() : null,
                    totalMessages: parseInt(getClosingField('📬 Total Messages')) || 0,
                    textMessages: parseInt(getClosingField('💬 Text')) || 0,
                    mediaMessages: parseInt(getClosingField('🖼️ Media')) || 0,
                    contributors: parseInt(getClosingField('👥 Contributors')) || 0,
                    attachmentSize: getClosingField('📎 Attachment Size'),
                    entities: getClosingField('🔍 Entities'),
                    languages: getClosingField('🌐 Languages'),
                    tags: getClosingField('🏷️ Tags'),
                    timeRange: getClosingField('🕐 Time Range'),
                    bookInfo: firstEmbed.footer?.text ?? null
                };
            }
        }

        return log;
    }

    async getAuditStats(threadId) {
        if (!this.client || !this.ready) {
            throw new Error('Horus bot not initialized');
        }

        try {
            const logs = await this.fetchAuditLogs(threadId, 100);
            
            const stats = {
                total: 0,
                pass: 0,
                fail: 0,
                warning: 0,
                review: 0,
                averageConfidence: 0
            };

            let totalConfidence = 0;
            let confidenceCount = 0;

            for (const log of logs) {
                if (log.parsed) {
                    stats.total++;
                    const status = log.parsed.status?.toUpperCase();
                    if (status === 'PASS') stats.pass++;
                    else if (status === 'FAIL') stats.fail++;
                    else if (status === 'WARNING') stats.warning++;
                    else if (status === 'REVIEW') stats.review++;

                    if (log.parsed.confidence !== null && log.parsed.confidence !== undefined) {
                        totalConfidence += log.parsed.confidence;
                        confidenceCount++;
                    }
                }
            }

            stats.averageConfidence = confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : 0;

            return stats;
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Horus failed to get audit stats');
            throw error;
        }
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            logger.info('🛑 Shutting down Horus...');
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = HorusBot;
