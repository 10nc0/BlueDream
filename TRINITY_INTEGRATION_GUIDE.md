# 🌈 Trinity Integration Guide
## Splitting Seraphim → Hermes + Toth

### Current State (Single Bot)
```
DISCORD_BOT_TOKEN → DiscordBotManager
├── createThreadForBridge() ← Thread creation
├── sendInitialMessage() ← Write messages  
└── (no message reading yet)
```

### Target State (Trinity v1.1)
```
HERMES_TOKEN → HermesBot (φ - Creator)
├── Permissions: MANAGE_THREADS + VIEW_CHANNEL (NO SEND_MESSAGES)
├── createThreadForBridge() ← ONLY thread creation
└── (initial messages sent via webhook, not bot)

TOTH_TOKEN → TothBot (0 - Mirror)
├── Permissions: READ_MESSAGE_HISTORY + VIEW_CHANNEL (NO WRITE)
├── fetchMessagesFromThread() ← ONLY read messages
└── on('messageCreate') ← ONLY listen/reflect

INPIPE → WebhookClient (∞ - Sustainer)
├── Permissions: N/A (uses webhook URLs, not bot)
├── Sends ALL messages (including bridge activation)
└── Webhook01 (Ledger) + User webhooks
```

---

## 📍 INSERTION POINT #1: Create `hermes-bot.js`

**File**: `hermes-bot.js` (NEW FILE)
**Purpose**: Thread creation ONLY (stripped from `discord-bot-manager.js`)

```javascript
// hermes-bot.js
// HERMES (φ) - THE CREATOR
// Permissions: MANAGE_THREADS only

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

class HermesBot {
    constructor() {
        this.client = null;
        this.ready = false;
    }

    async initialize() {
        const hermesToken = process.env.HERMES_TOKEN;
        if (!hermesToken) {
            console.log('⚠️  HERMES_TOKEN not set - thread creation disabled');
            return;
        }

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        await Promise.race([
            new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Hermes login timeout'));
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

        console.log('🌟 Hermes ready for thread creation');
    }

    // 👉 COPY from discord-bot-manager.js lines 126-166
    async createThreadForBridge(webhookUrl, bridgeName, tenantId, bridgeId, retryCount = 0) {
        // ... (existing code from DiscordBotManager.createThreadForBridge)
        // No changes needed - just moved here
    }

    // 👉 COPY from discord-bot-manager.js lines 60-100
    async getChannelFromWebhookUrl(webhookUrl) {
        // ... (existing helper)
    }

    // 👉 COPY from discord-bot-manager.js lines 227-278
    async sendInitialMessage(threadId, bridgeName, webhookUrl, retryCount = 0) {
        // ... (existing code)
    }

    isReady() {
        return this.ready && this.client !== null;
    }

    async shutdown() {
        if (this.client) {
            console.log('🔌 Shutting down Hermes...');
            await this.client.destroy();
        }
    }
}

module.exports = HermesBot;
```

---

## 📍 INSERTION POINT #2: Create `toth-bot.js`

**File**: `toth-bot.js` (NEW FILE)
**Purpose**: Read-only message mirroring

```javascript
// toth-bot.js
// TOTH (0) - THE MIRROR
// Permissions: READ_MESSAGE_HISTORY only (NO WRITE)

const { Client, GatewayIntentBits } = require('discord.js');

class TothBot {
    constructor() {
        this.client = null;
        this.ready = false;
    }

    async initialize() {
        const tothToken = process.env.TOTH_TOKEN;
        if (!tothToken) {
            console.log('⚠️  TOTH_TOKEN not set - message reading disabled');
            return;
        }

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent  // Required for reading
            ]
        });

        await Promise.race([
            new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Toth login timeout'));
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

        console.log('🔍 Toth ready for message mirroring');
    }

    // 👉 NEW FUNCTION: Fetch messages from thread (for /api/messages endpoint)
    async fetchMessagesFromThread(threadId, bridgeCreatedAt, limit = 100) {
        if (!this.client || !this.ready) {
            throw new Error('Toth not initialized');
        }

        try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                throw new Error(`Thread ${threadId} not found`);
            }

            // Fetch messages created AFTER bridge creation
            const messages = await thread.messages.fetch({ limit });
            const bridgeTimestamp = new Date(bridgeCreatedAt).getTime();

            const filtered = messages
                .filter(msg => msg.createdTimestamp >= bridgeTimestamp)
                .map(msg => ({
                    id: msg.id,
                    content: msg.content,
                    author: msg.author.username,
                    timestamp: msg.createdAt.toISOString(),
                    embeds: msg.embeds,
                    attachments: msg.attachments.map(a => ({
                        url: a.url,
                        type: a.contentType
                    }))
                }));

            return filtered;
        } catch (error) {
            console.error(`❌ Toth failed to fetch messages:`, error.message);
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
        }
    }
}

module.exports = TothBot;
```

---

## 📍 INSERTION POINT #3: Update `index.js`

**File**: `index.js`
**Location**: Where `DiscordBotManager` is initialized

### BEFORE (Current):
```javascript
const DiscordBotManager = require('./discord-bot-manager');
const discordBot = new DiscordBotManager();

// Later...
await discordBot.initialize();
```

### AFTER (Trinity):
```javascript
const HermesBot = require('./hermes-bot');
const TothBot = require('./toth-bot');

const hermesBot = new HermesBot();  // φ - Creates threads
const tothBot = new TothBot();      // 0 - Reads messages

// Later in initialization...
console.log('🌈 Initializing Trinity...');
await Promise.all([
    hermesBot.initialize(),
    tothBot.initialize()
]);
console.log('✨ Trinity ready: Hermes (φ) + Toth (0)');
```

### Update API Routes:
```javascript
// Thread creation → Use Hermes
app.post('/api/bridges', async (req, res) => {
    // OLD: const threadInfo = await discordBot.createThreadForBridge(...)
    // NEW:
    const threadInfo = await hermesBot.createThreadForBridge(...);
});

// Message reading → Use Toth
app.get('/api/messages/:bridgeId', async (req, res) => {
    // NEW:
    const messages = await tothBot.fetchMessagesFromThread(threadId, bridgeCreatedAt);
    res.json({ messages });
});
```

---

## 🔐 Environment Variables

Add to your `.env`:
```bash
# OLD (keep for now, will deprecate):
DISCORD_BOT_TOKEN=xxxxx

# NEW (Trinity):
HERMES_TOKEN=xxxxx   # Bot with MANAGE_THREADS permission
TOTH_TOKEN=xxxxx     # Bot with READ_MESSAGE_HISTORY only
```

---

## 🎯 Migration Strategy

### Phase 1: Add bots (parallel to existing)
1. Create `hermes-bot.js` ✅
2. Create `toth-bot.js` ✅
3. Initialize both in `index.js` ✅
4. **Keep old `DiscordBotManager` as fallback**

### Phase 2: Route traffic
1. Update `/api/bridges` → use `hermesBot`
2. Update `/api/messages` → use `tothBot`
3. Test with both systems running

### Phase 3: Remove old bot
1. Delete `discord-bot-manager.js`
2. Remove `DISCORD_BOT_TOKEN`

---

## 🌟 Benefits

| Before (Seraphim) | After (Trinity) |
|---|---|
| 1 bot = 1 token = all permissions | 2 bots = 2 tokens = scoped permissions |
| Security risk if token leaks | Toth can't create/delete (read-only) |
| Hard to audit who did what | Clear separation: Hermes creates, Toth reads |

---

## 📝 Notes

- **Webhook01 (Ledger)** is unchanged - still uses WebhookClient
- **Inpipe** is just webhook firing - no bot needed
- Both bots can run in parallel during migration
- Toth will be used later for real-time mirroring (`messageCreate` events)
