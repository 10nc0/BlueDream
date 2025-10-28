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
        this.clients = new Map(); // bridgeId -> { client, status, qrCode, phoneNumber }
        this.messageHandlers = new Map(); // bridgeId -> message handler function
    }

    /**
     * Initialize a WhatsApp client for a specific bot
     * @param {number} bridgeId - The bridge ID
     * @param {string} tenantSchema - The tenant schema (e.g., 'tenant_3', 'public')
     * @param {Function} onMessage - Message handler callback
     */
    async initializeClient(bridgeId, tenantSchema, onMessage) {
        console.log(`🔧 Initializing WhatsApp client for bridge ${bridgeId} (${tenantSchema})`);

        // Check if client already exists
        if (this.clients.has(bridgeId)) {
            const existing = this.clients.get(bridgeId);
            if (existing.status === 'ready') {
                console.log(`✅ WhatsApp client for bridge ${bridgeId} already active`);
                return existing;
            }
        }

        try {
            // Create session directory for this bot
            const sessionPath = path.join('.wwebjs_auth', `bridge_${bridgeId}`);
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }

            // Create WhatsApp client with LocalAuth for this bot
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: `bridge_${bridgeId}`,
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
                bridgeId
            };
            this.clients.set(bridgeId, clientState);

            // QR Code event
            client.on('qr', async (qr) => {
                console.log(`📱 QR Code generated for bridge ${bridgeId}`);
                clientState.qrCode = qr;
                clientState.status = 'qr_ready';

                // Update bridge status in database
                await this.updateBotStatus(bridgeId, tenantSchema, 'qr_ready', qr, null);
            });

            // Ready event
            client.on('ready', async () => {
                console.log(`✅ WhatsApp client ready for bridge ${bridgeId}`);
                const info = client.info;
                const phoneNumber = info.wid.user;
                
                clientState.status = 'ready';
                clientState.phoneNumber = `+${phoneNumber}`;
                clientState.qrCode = null;

                // Update bridge in database
                await this.updateBotStatus(bridgeId, tenantSchema, 'ready', null, `+${phoneNumber}`);
                
                console.log(`📱 Bridge ${bridgeId} WhatsApp Number: +${phoneNumber}`);
            });

            // Authenticated event
            client.on('authenticated', async () => {
                console.log(`🔐 Bridge ${bridgeId} authenticated successfully`);
                clientState.status = 'authenticated';
                await this.updateBotStatus(bridgeId, tenantSchema, 'authenticated', null, null);
            });

            // Auth failure event
            client.on('auth_failure', async (error) => {
                console.error(`❌ Authentication failed for bridge ${bridgeId}:`, error);
                clientState.status = 'auth_failed';
                await this.updateBotStatus(bridgeId, tenantSchema, 'auth_failed', null, null, error.message);
            });

            // Disconnected event
            client.on('disconnected', async (reason) => {
                console.log(`🔌 Bridge ${bridgeId} disconnected:`, reason);
                clientState.status = 'disconnected';
                await this.updateBotStatus(bridgeId, tenantSchema, 'disconnected', null, null, reason);
            });

            // Message event - route to tenant-specific handler
            client.on('message', async (message) => {
                try {
                    if (onMessage) {
                        await onMessage(message, bridgeId, tenantSchema);
                    }
                } catch (error) {
                    console.error(`❌ Error handling message for bridge ${bridgeId}:`, error);
                }
            });

            // Initialize the client
            await client.initialize();
            
            return clientState;
        } catch (error) {
            console.error(`❌ Failed to initialize WhatsApp client for bridge ${bridgeId}:`, error);
            await this.updateBotStatus(bridgeId, tenantSchema, 'error', null, null, error.message);
            throw error;
        }
    }

    /**
     * Update bridge status in database (tenant-aware)
     */
    async updateBotStatus(bridgeId, tenantSchema, status, qrCode, contactInfo, errorMessage) {
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
                `, [status, contactInfo, bridgeId]);
                
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`Error updating bridge ${bridgeId} status:`, error);
        }
    }

    /**
     * Get client state for a bot
     */
    getClient(bridgeId) {
        return this.clients.get(bridgeId);
    }

    /**
     * Get QR code for a bot
     */
    getQRCode(bridgeId) {
        const clientState = this.clients.get(bridgeId);
        return clientState?.qrCode || null;
    }

    /**
     * Stop a WhatsApp client (preserves session for auto-reconnect)
     */
    async stopClient(bridgeId, tenantSchema) {
        console.log(`⏸️  Stopping WhatsApp client for bridge ${bridgeId} (preserving session)`);
        
        const clientState = this.clients.get(bridgeId);
        if (!clientState) {
            console.log(`⚠️  No client found for bridge ${bridgeId}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(bridgeId);

            // Update database (keep session intact)
            await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client stopped for bridge ${bridgeId} (session preserved)`);
        } catch (error) {
            console.error(`❌ Error stopping client for bridge ${bridgeId}:`, error);
        }
    }

    /**
     * Destroy a WhatsApp client and delete its session (for relink only)
     */
    async destroyClient(bridgeId, tenantSchema) {
        console.log(`🗑️  Destroying WhatsApp client for bridge ${bridgeId} (deleting session)`);
        
        const clientState = this.clients.get(bridgeId);
        if (!clientState) {
            console.log(`⚠️  No client found for bridge ${bridgeId}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(bridgeId);
            
            // Delete session directory (for relink/reset only)
            const sessionPath = path.join('.wwebjs_auth', `bridge_${bridgeId}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️  Deleted session directory: ${sessionPath}`);
            }

            // Update database
            await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client destroyed for bridge ${bridgeId}`);
        } catch (error) {
            console.error(`❌ Error destroying client for bridge ${bridgeId}:`, error);
        }
    }

    /**
     * Relink a bridge (destroy session and reinitialize for fresh QR code)
     */
    async relinkClient(bridgeId, tenantSchema, onMessage) {
        console.log(`🔄 Relinking WhatsApp client for bridge ${bridgeId}`);
        await this.destroyClient(bridgeId, tenantSchema); // Full destroy with session deletion
        return await this.initializeClient(bridgeId, tenantSchema, onMessage);
    }

    /**
     * Get all active clients
     */
    getAllClients() {
        return Array.from(this.clients.entries()).map(([bridgeId, state]) => ({
            bridgeId,
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
        const stopPromises = Array.from(this.clients.keys()).map(bridgeId => {
            const state = this.clients.get(bridgeId);
            return this.stopClient(bridgeId, state.tenantSchema); // Use stopClient, not destroyClient
        });
        await Promise.all(stopPromises);
        console.log('✅ All WhatsApp clients stopped (sessions preserved for auto-reconnect)');
    }
}

module.exports = WhatsAppClientManager;
