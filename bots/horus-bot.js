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

            const messages  = await thread.messages.fetch({ limit });
            const auditLogs = await this._stitchWindow(messages, thread);

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

            // If the oldest raw message is a continuation its header may be on the next page
            const rawArray      = [...messages.values()];
            const oldestRaw     = rawArray[rawArray.length - 1];
            const oldestIsCont  = oldestRaw && this._classifyMessage(oldestRaw) === 'continuation';

            const auditLogs = await this._stitchWindow(messages, thread);
            // _stitchWindow returns newest→oldest; reverse to oldest→newest for paginated display
            auditLogs.reverse();

            return {
                logs:     auditLogs,
                hasMore:  messages.size === limit || oldestIsCont,
                oldestId: auditLogs.length > 0 ? auditLogs[0].id : null,
                newestId: auditLogs.length > 0 ? auditLogs[auditLogs.length - 1].id : null
            };
        } catch (error) {
            logger.error({ threadId, err: error }, '❌ Horus failed to fetch paginated audit logs');
            throw error;
        }
    }

    // Classify a raw Discord message for stitching
    _classifyMessage(msg) {
        const firstEmbed = msg.embeds?.[0];
        if (firstEmbed) {
            if (firstEmbed.title) {
                if (firstEmbed.title.includes('Monthly Book Closing')) return 'closing';
                // Legacy: "✅ AI Audit Result" (old embed format, answer in field)
                if (firstEmbed.title.includes('AI Audit Result'))      return 'legacy-audit';
            }
            // New format: answer in embed.description, slim field set
            if (firstEmbed.description != null && firstEmbed.fields?.[0]?.name === '📝 Query') {
                return 'audit';
            }
        }
        // Overflow continuation posted by Idris as a Discord reply
        if (msg.content && msg.content.startsWith('\u27b6 audit:')) return 'continuation';
        return 'other';
    }

    parseAuditMessage(msg) {
        const type = this._classifyMessage(msg);
        const log = {
            id:        msg.id,
            timestamp: msg.createdAt.toISOString(),
            content:   msg.content,
            embeds:    []
        };

        if (msg.embeds.length > 0) {
            log.embeds = msg.embeds.map(embed => ({
                title:       embed.title,
                description: embed.description,
                color:       embed.color,
                fields:      embed.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline })),
                timestamp:   embed.timestamp,
                footer:      embed.footer ? { text: embed.footer.text } : null
            }));
        }

        const firstEmbed = msg.embeds[0];

        if (type === 'audit') {
            // New format: description holds the answer, slim fields
            const queryField = firstEmbed.fields?.find(f => f.name === '📝 Query');
            const bookField  = firstEmbed.fields?.find(f => f.name === '📚 Book');
            // Strip leading emoji from title to get status: "{emoji} {STATUS}"
            const statusMatch = firstEmbed.title ? firstEmbed.title.match(/^\S+\s+(.+)$/) : null;
            log.type = 'audit';
            log.parsed = {
                status:      statusMatch ? statusMatch[1].trim() : null,
                confidence:  null,
                query:       queryField ? queryField.value : null,
                answer:      firstEmbed.description || null,
                bookContext: bookField  ? bookField.value  : null
            };
        } else if (type === 'legacy-audit') {
            // Old format: answer truncated to 500 chars in a field
            const statusField     = firstEmbed.fields?.find(f => f.name === '📊 Status');
            const confidenceField = firstEmbed.fields?.find(f => f.name === '🎯 Confidence');
            const queryField      = firstEmbed.fields?.find(f => f.name === '📝 Query');
            const answerField     = firstEmbed.fields?.find(f => f.name === '💬 Answer');
            const bookField       = firstEmbed.fields?.find(f => f.name === '📚 Book Context');
            const rawConf = confidenceField ? parseInt(confidenceField.value) : null;
            log.type = 'audit';
            log.parsed = {
                status:      statusField ? statusField.value.replace(/\*/g, '') : null,
                confidence:  Number.isNaN(rawConf) ? null : rawConf,
                query:       queryField ? queryField.value : null,
                answer:      answerField ? answerField.value : null,
                bookContext: bookField   ? bookField.value  : null
            };
        } else if (type === 'closing') {
            const monthMatch      = firstEmbed.title.match(/Monthly Book Closing\s*—\s*(.+)$/);
            const getClosingField = (name) => firstEmbed.fields?.find(f => f.name === name)?.value ?? null;
            log.type = 'closing';
            log.parsed = {
                month:          monthMatch ? monthMatch[1].trim() : null,
                totalMessages:  parseInt(getClosingField('📬 Total Messages')) || 0,
                textMessages:   parseInt(getClosingField('💬 Text'))           || 0,
                mediaMessages:  parseInt(getClosingField('🖼️ Media'))          || 0,
                contributors:   parseInt(getClosingField('👥 Contributors'))   || 0,
                attachmentSize: getClosingField('📎 Attachment Size'),
                entities:       getClosingField('🔍 Entities'),
                languages:      getClosingField('🌐 Languages'),
                tags:           getClosingField('🏷️ Tags'),
                timeRange:      getClosingField('🕐 Time Range'),
                bookInfo:       firstEmbed.footer?.text ?? null
            };
        }

        return log;
    }

    // Two-pass stitch: collect headers + continuations, join overflow chunks back onto headers.
    // rawMessages is a Discord Collection (newest→oldest, Discord default).
    // Returns an array of log entries (headers only), newest→oldest.
    async _stitchWindow(rawMessages, thread) {
        const CONT_RE = /^\u27b6 audit:(\d+) (\d+)\/(\d+)\n([\s\S]*)/;

        const headerMap = new Map();  // msgId → log entry (insertion order = newest→oldest)
        const conts     = [];         // { parentId, seq, text }

        for (const msg of rawMessages.values()) {
            const type = this._classifyMessage(msg);
            if (type === 'audit' || type === 'legacy-audit' || type === 'closing') {
                headerMap.set(msg.id, this.parseAuditMessage(msg));
            } else if (type === 'continuation') {
                const m = CONT_RE.exec(msg.content);
                if (m) conts.push({ parentId: m[1], seq: parseInt(m[2]), text: m[4] });
            }
        }

        // Sort so overflow appends in correct order (seq 2, 3, 4 …)
        conts.sort((a, b) => a.seq - b.seq);

        const orphanMap = new Map();  // parentId → sorted cont list (cross-page case)

        for (const cont of conts) {
            if (headerMap.has(cont.parentId)) {
                const log = headerMap.get(cont.parentId);
                if (log.parsed) log.parsed.answer = (log.parsed.answer || '') + cont.text;
            } else {
                if (!orphanMap.has(cont.parentId)) orphanMap.set(cont.parentId, []);
                orphanMap.get(cont.parentId).push(cont);
            }
        }

        // Resolve orphans: fetch parent headers not present in the current window
        for (const [parentId, orphanConts] of orphanMap.entries()) {
            try {
                const parentMsg = await thread.messages.fetch(parentId);
                if (parentMsg) {
                    const log = this.parseAuditMessage(parentMsg);
                    if (log.parsed) {
                        orphanConts.sort((a, b) => a.seq - b.seq);
                        log.parsed.answer = (log.parsed.answer || '') + orphanConts.map(c => c.text).join('');
                    }
                    headerMap.set(parentId, log);
                }
            } catch (fetchErr) {
                logger.warn({ parentId, err: fetchErr.message }, '\u26a0\ufe0f Horus could not fetch orphan parent message');
            }
        }

        return [...headerMap.values()];
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
