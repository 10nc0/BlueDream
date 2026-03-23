// thoth-bot.js
// THOTH (0) - THE MIRROR
// Permissions: READ_MESSAGE_HISTORY only (NO WRITE)
// Security: Can only read messages, cannot create/modify/delete

const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./lib/logger');

class ThothBot {
    constructor() {
        this.client = null;
        this.ready = false;
    }

    async initialize() {
        if (this.client) {
            logger.info('⚡ Thoth bot already initialized');
            return;
        }

        const thothToken = process.env.THOTH_TOKEN;
        if (!thothToken) {
            logger.warn('⚠️ THOTH_TOKEN not set — message reading disabled');
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
                logger.error({ err: error }, 'Thoth bot error');
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Thoth login timeout (30s)'));
                    }, 30000);

                    this.client.once('clientReady', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        logger.info({ tag: this.client.user.tag }, '👁️ Thoth (0) logged in');
                        resolve();
                    });
                }),
                this.client.login(thothToken)
            ]);

            logger.info('👁️ Thoth bot ready for message mirroring');
        } catch (error) {
            logger.error({ err: error }, '❌ Failed to initialize Thoth bot');
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async fetchMessagesFromThread(threadId, bridgeCreatedAt, limit = 100) {
        if (!this.client || !this.ready) {
            throw new Error('Thoth bot not initialized');
        }

        try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                throw new Error(`Thread ${threadId} not found or not a thread`);
            }

            const messages = await thread.messages.fetch({ limit });
            const bridgeTimestamp = new Date(bridgeCreatedAt).getTime();

            const filtered = messages
                .filter(msg => msg.createdTimestamp >= bridgeTimestamp)
                .map(msg => ({
                    id: msg.id,
                    sender_name: msg.author.username,
                    sender_avatar: msg.author.displayAvatarURL(),
                    message_content: msg.content,
                    timestamp: msg.createdAt.toISOString(),
                    has_media: msg.attachments.size > 0,
                    media_url: msg.attachments.size > 0 ? msg.attachments.first().url : null,
                    media_type: msg.attachments.size > 0 ? msg.attachments.first().contentType : null,
                    embeds: msg.embeds.map(embed => ({
                        title: embed.title,
                        description: embed.description,
                        color: embed.color,
                        fields: embed.fields
                    }))
                }))
                .reverse();

            logger.info({ count: filtered.length, threadId }, '📜 Thoth fetched messages from thread');
            return filtered;
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Thoth failed to fetch messages from thread');
            throw error;
        }
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            logger.info('🛑 Shutting down Thoth...');
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = ThothBot;
