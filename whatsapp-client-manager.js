const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

/**
 * WhatsApp Client Manager
 * Manages multiple WhatsApp client instances (one per bot)
 * Enables true multi-tenant SaaS where each tenant has their own WhatsApp bridge
 */
class WhatsAppClientManager {
    constructor(pool, chromiumPath) {
        this.pool = pool;
        this.chromiumPath = chromiumPath;
        this.clients = new Map(); // botId -> { client, status, qrCode, phoneNumber }
        this.messageHandlers = new Map(); // botId -> message handler function
    }

    /**
     * Initialize a WhatsApp client for a specific bot
     * @param {number} botId - The bot ID
     * @param {string} tenantSchema - The tenant schema (e.g., 'tenant_3', 'public')
     * @param {Function} onMessage - Message handler callback
     */
    async initializeClient(botId, tenantSchema, onMessage) {
        console.log(`🔧 Initializing WhatsApp client for bot ${botId} (${tenantSchema})`);

        // Check if client already exists
        if (this.clients.has(botId)) {
            const existing = this.clients.get(botId);
            if (existing.status === 'ready') {
                console.log(`✅ WhatsApp client for bot ${botId} already active`);
                return existing;
            }
        }

        try {
            // Create session directory for this bot
            const sessionPath = path.join('.wwebjs_auth', `bot_${botId}`);
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }

            // Create WhatsApp client with LocalAuth for this bot
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: `bot_${botId}`,
                    dataPath: './.wwebjs_auth'
                }),
                puppeteer: {
                    headless: true,
                    executablePath: this.chromiumPath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu'
                    ]
                }
            });

            // Store client state
            const clientState = {
                client,
                status: 'initializing',
                qrCode: null,
                phoneNumber: null,
                tenantSchema,
                botId
            };
            this.clients.set(botId, clientState);

            // QR Code event
            client.on('qr', async (qr) => {
                console.log(`📱 QR Code generated for bot ${botId}`);
                clientState.qrCode = qr;
                clientState.status = 'qr_ready';

                // Update bot status in database
                await this.updateBotStatus(botId, tenantSchema, 'qr_ready', qr, null);
            });

            // Ready event
            client.on('ready', async () => {
                console.log(`✅ WhatsApp client ready for bot ${botId}`);
                const info = client.info;
                const phoneNumber = info.wid.user;
                
                clientState.status = 'ready';
                clientState.phoneNumber = `+${phoneNumber}`;
                clientState.qrCode = null;

                // Update bot in database
                await this.updateBotStatus(botId, tenantSchema, 'ready', null, `+${phoneNumber}`);
                
                console.log(`📱 Bot ${botId} WhatsApp Number: +${phoneNumber}`);
            });

            // Authenticated event
            client.on('authenticated', async () => {
                console.log(`🔐 Bot ${botId} authenticated successfully`);
                clientState.status = 'authenticated';
                await this.updateBotStatus(botId, tenantSchema, 'authenticated', null, null);
            });

            // Auth failure event
            client.on('auth_failure', async (error) => {
                console.error(`❌ Authentication failed for bot ${botId}:`, error);
                clientState.status = 'auth_failed';
                await this.updateBotStatus(botId, tenantSchema, 'auth_failed', null, null, error.message);
            });

            // Disconnected event
            client.on('disconnected', async (reason) => {
                console.log(`🔌 Bot ${botId} disconnected:`, reason);
                clientState.status = 'disconnected';
                await this.updateBotStatus(botId, tenantSchema, 'disconnected', null, null, reason);
            });

            // Message event - route to tenant-specific handler
            client.on('message', async (message) => {
                try {
                    if (onMessage) {
                        await onMessage(message, botId, tenantSchema);
                    }
                } catch (error) {
                    console.error(`❌ Error handling message for bot ${botId}:`, error);
                }
            });

            // Initialize the client
            await client.initialize();
            
            return clientState;
        } catch (error) {
            console.error(`❌ Failed to initialize WhatsApp client for bot ${botId}:`, error);
            await this.updateBotStatus(botId, tenantSchema, 'error', null, null, error.message);
            throw error;
        }
    }

    /**
     * Update bot status in database (tenant-aware)
     */
    async updateBotStatus(botId, tenantSchema, status, qrCode, contactInfo, errorMessage) {
        try {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`SET LOCAL search_path TO ${tenantSchema}`);
                
                // Only update columns that exist in tenant schema (qr_code and session_error were removed)
                await client.query(`
                    UPDATE bots 
                    SET status = $1, 
                        contact_info = COALESCE($2, contact_info),
                        updated_at = NOW()
                    WHERE id = $3
                `, [status, contactInfo, botId]);
                
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`Error updating bot ${botId} status:`, error);
        }
    }

    /**
     * Get client state for a bot
     */
    getClient(botId) {
        return this.clients.get(botId);
    }

    /**
     * Get QR code for a bot
     */
    getQRCode(botId) {
        const clientState = this.clients.get(botId);
        return clientState?.qrCode || null;
    }

    /**
     * Stop a WhatsApp client (preserves session for auto-reconnect)
     */
    async stopClient(botId, tenantSchema) {
        console.log(`⏸️  Stopping WhatsApp client for bot ${botId} (preserving session)`);
        
        const clientState = this.clients.get(botId);
        if (!clientState) {
            console.log(`⚠️  No client found for bot ${botId}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(botId);

            // Update database (keep session intact)
            await this.updateBotStatus(botId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client stopped for bot ${botId} (session preserved)`);
        } catch (error) {
            console.error(`❌ Error stopping client for bot ${botId}:`, error);
        }
    }

    /**
     * Destroy a WhatsApp client and delete its session (for relink only)
     */
    async destroyClient(botId, tenantSchema) {
        console.log(`🗑️  Destroying WhatsApp client for bot ${botId} (deleting session)`);
        
        const clientState = this.clients.get(botId);
        if (!clientState) {
            console.log(`⚠️  No client found for bot ${botId}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(botId);
            
            // Delete session directory (for relink/reset only)
            const sessionPath = path.join('.wwebjs_auth', `bot_${botId}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️  Deleted session directory: ${sessionPath}`);
            }

            // Update database
            await this.updateBotStatus(botId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client destroyed for bot ${botId}`);
        } catch (error) {
            console.error(`❌ Error destroying client for bot ${botId}:`, error);
        }
    }

    /**
     * Relink a bot (destroy session and reinitialize for fresh QR code)
     */
    async relinkClient(botId, tenantSchema, onMessage) {
        console.log(`🔄 Relinking WhatsApp client for bot ${botId}`);
        await this.destroyClient(botId, tenantSchema); // Full destroy with session deletion
        return await this.initializeClient(botId, tenantSchema, onMessage);
    }

    /**
     * Get all active clients
     */
    getAllClients() {
        return Array.from(this.clients.entries()).map(([botId, state]) => ({
            botId,
            status: state.status,
            phoneNumber: state.phoneNumber,
            tenantSchema: state.tenantSchema,
            hasQR: state.qrCode !== null
        }));
    }

    /**
     * Cleanup all clients (for graceful shutdown - preserves sessions)
     */
    async cleanup() {
        console.log('🧹 Gracefully stopping all WhatsApp clients (preserving sessions)...');
        const stopPromises = Array.from(this.clients.keys()).map(botId => {
            const state = this.clients.get(botId);
            return this.stopClient(botId, state.tenantSchema); // Use stopClient, not destroyClient
        });
        await Promise.all(stopPromises);
        console.log('✅ All WhatsApp clients stopped (sessions preserved for auto-reconnect)');
    }
}

module.exports = WhatsAppClientManager;
