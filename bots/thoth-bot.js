// thoth-bot.js
// THOTH (0) - THE MIRROR
// Permissions: READ_MESSAGE_HISTORY only (NO WRITE)
// Security: Can only read messages, cannot create/modify/delete

const logger = require('../lib/logger');

class ThothBot {
    constructor() {
        this.client = null;
        this.ready = false;
        this.initializing = null;
    }

    async initialize() {
        if (this.ready && this.client) {
            logger.info('⚡ Thoth bot already initialized');
            return;
        }
        if (this.initializing) return this.initializing;

        this.initializing = this._initialize();
        try {
            await this.initializing;
        } finally {
            this.initializing = null;
        }
    }

    async _initialize() {
        let client = null;
        const thothToken = process.env.THOTH_TOKEN;
        if (!thothToken) {
            logger.warn('⚠️ THOTH_TOKEN not set — message reading disabled');
            return;
        }

        try {
            const { Client, GatewayIntentBits } = require('discord.js');
            client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent
                ]
            });
            this.client = client;
            this.ready = false;

            client.on('error', (error) => {
                logger.error({ err: error }, 'Thoth bot error');
            });

            let timeout;
            let onReady;
            const ready = new Promise((resolve, reject) => {
                onReady = () => {
                    if (this.client !== client) {
                        reject(new Error('Thoth client replaced before ready'));
                        return;
                    }
                    if (!client.user?.tag) {
                        reject(new Error('Thoth client ready without a user identity'));
                        return;
                    }
                    this.ready = true;
                    logger.info({ tag: client.user.tag }, '👁️ Thoth (0) logged in');
                    resolve();
                };
                client.once('clientReady', onReady);
                timeout = setTimeout(() => reject(new Error('Thoth login timeout (30s)')), 30000);
            });

            try {
                // Login may resolve before Discord emits clientReady; only that
                // event proves the client identity is available for use.
                await Promise.race([ready, client.login(thothToken).then(() => ready)]);
            } finally {
                clearTimeout(timeout);
                client.off('clientReady', onReady);
            }

            logger.info('👁️ Thoth bot ready for message mirroring');
        } catch (error) {
            logger.error({ err: error }, '❌ Failed to initialize Thoth bot');
            if (this.client === client) {
                this.client = null;
                this.ready = false;
            }
            if (client) {
                await client.destroy().catch((destroyError) => {
                    logger.warn({ code: destroyError.code }, 'Thoth failed client cleanup');
                });
            }
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
        const client = this.client;
        const initializing = this.initializing;
        this.client = null;
        this.ready = false;
        if (initializing) await initializing.catch(() => {});
        else if (client) {
            logger.info('🛑 Shutting down Thoth...');
            await client.destroy();
        }
    }
}

module.exports = ThothBot;
