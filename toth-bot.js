// toth-bot.js
// TOTH (0) - THE MIRROR
// Permissions: READ_MESSAGE_HISTORY only (NO WRITE)
// Security: Can only read messages, cannot create/modify/delete

const { Client, GatewayIntentBits } = require('discord.js');

class TothBot {
    constructor() {
        this.client = null;
        this.ready = false;
    }

    async initialize() {
        if (this.client) {
            console.log('📖 Toth bot already initialized');
            return;
        }

        const tothToken = process.env.TOTH_TOKEN;
        if (!tothToken) {
            console.log('⚠️  TOTH_TOKEN not set - message reading disabled');
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
                console.error('❌ Toth bot error:', error.message);
            });

            await Promise.race([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Toth login timeout (30s)'));
                    }, 30000);

                    this.client.once('ready', () => {
                        clearTimeout(timeout);
                        this.ready = true;
                        console.log(`✅ Toth (0) logged in as ${this.client.user.tag}`);
                        resolve();
                    });
                }),
                this.client.login(tothToken)
            ]);

            console.log('🔍 Toth bot ready for message mirroring');
        } catch (error) {
            console.error('❌ Failed to initialize Toth bot:', error.message);
            this.client = null;
            this.ready = false;
            throw error;
        }
    }

    async fetchMessagesFromThread(threadId, bridgeCreatedAt, limit = 100) {
        if (!this.client || !this.ready) {
            throw new Error('Toth bot not initialized');
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

            console.log(`📖 Toth fetched ${filtered.length} messages from thread ${threadId}`);
            return filtered;
        } catch (error) {
            console.error(`❌ Toth failed to fetch messages from thread ${threadId}:`, error.message);
            throw error;
        }
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            console.log('🔌 Shutting down Toth...');
            await this.client.destroy();
            this.client = null;
            this.ready = false;
        }
    }
}

module.exports = TothBot;
