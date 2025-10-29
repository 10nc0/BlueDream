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
        this.clients = new Map(); // compositeKey (tenant:bridge) -> { client, status, qrCode, phoneNumber }
        this.messageHandlers = new Map(); // compositeKey -> message handler function
    }

    /**
     * Generate composite key for tenant-aware bridge tracking
     * @param {string} tenantSchema - The tenant schema (e.g., 'tenant_3')
     * @param {number} bridgeId - The bridge ID
     * @returns {string} Composite key like "tenant_3:7"
     */
    getCompositeKey(tenantSchema, bridgeId) {
        return `${tenantSchema}:${bridgeId}`;
    }

    /**
     * Initialize a WhatsApp client for a specific bot
     * @param {number} bridgeId - The bridge ID
     * @param {string} tenantSchema - The tenant schema (e.g., 'tenant_3', 'public')
     * @param {Function} onMessage - Message handler callback
     */
    async initializeClient(bridgeId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🔧 Initializing WhatsApp client for ${compositeKey}`);

        // Check if client already exists using composite key
        if (this.clients.has(compositeKey)) {
            const existing = this.clients.get(compositeKey);
            if (existing.status === 'ready') {
                console.log(`✅ WhatsApp client for ${compositeKey} already active`);
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

            // Store client state with composite key
            const clientState = {
                client,
                status: 'initializing',
                qrCode: null,
                phoneNumber: null,
                tenantSchema,
                bridgeId,
                compositeKey
            };
            this.clients.set(compositeKey, clientState);

            // QR Code event
            client.on('qr', async (qr) => {
                console.log(`📱 QR Code generated for ${compositeKey}`);
                clientState.qrCode = qr;
                clientState.status = 'qr_ready';

                // Update bridge status in database
                await this.updateBotStatus(bridgeId, tenantSchema, 'qr_ready', qr, null);
            });

            // Ready event
            client.on('ready', async () => {
                console.log(`✅ WhatsApp client ready for ${compositeKey}`);
                const info = client.info;
                const phoneNumber = info.wid.user;
                
                clientState.status = 'ready';
                clientState.phoneNumber = `+${phoneNumber}`;
                clientState.qrCode = null;

                // Update bridge in database
                await this.updateBotStatus(bridgeId, tenantSchema, 'ready', null, `+${phoneNumber}`);
                
                console.log(`📱 ${compositeKey} WhatsApp Number: +${phoneNumber}`);
            });

            // Authenticated event
            client.on('authenticated', async () => {
                console.log(`🔐 ${compositeKey} authenticated successfully`);
                clientState.status = 'authenticated';
                await this.updateBotStatus(bridgeId, tenantSchema, 'authenticated', null, null);
            });

            // Auth failure event
            client.on('auth_failure', async (error) => {
                console.error(`❌ Authentication failed for ${compositeKey}:`, error);
                clientState.status = 'auth_failed';
                await this.updateBotStatus(bridgeId, tenantSchema, 'auth_failed', null, null, error.message);
            });

            // Disconnected event
            client.on('disconnected', async (reason) => {
                console.log(`🔌 ${compositeKey} disconnected:`, reason);
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
                    console.error(`❌ Error handling message for ${compositeKey}:`, error);
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
     * Get client state for a bot (tenant-aware)
     */
    getClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        return this.clients.get(compositeKey);
    }

    /**
     * Get QR code for a bot (tenant-aware)
     */
    getQRCode(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        const clientState = this.clients.get(compositeKey);
        return clientState?.qrCode || null;
    }

    /**
     * Stop a WhatsApp client (preserves session for auto-reconnect)
     */
    async stopClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`⏸️  Stopping WhatsApp client for ${compositeKey} (preserving session)`);
        
        const clientState = this.clients.get(compositeKey);
        if (!clientState) {
            console.log(`⚠️  No client found for ${compositeKey}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(compositeKey);

            // Update database (keep session intact)
            await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client stopped for ${compositeKey} (session preserved)`);
        } catch (error) {
            console.error(`❌ Error stopping client for ${compositeKey}:`, error);
        }
    }

    /**
     * Destroy a WhatsApp client and delete its session (for relink only)
     */
    async destroyClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🗑️  Destroying WhatsApp client for ${compositeKey} (deleting session)`);
        
        const clientState = this.clients.get(compositeKey);
        if (!clientState) {
            console.log(`⚠️  No client found for ${compositeKey}`);
            return;
        }

        try {
            await clientState.client.destroy();
            this.clients.delete(compositeKey);
            
            // Delete session directory (for relink/reset only)
            const sessionPath = path.join('.wwebjs_auth', `bridge_${bridgeId}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️  Deleted session directory: ${sessionPath}`);
            }

            // Update database
            await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ WhatsApp client destroyed for ${compositeKey}`);
        } catch (error) {
            console.error(`❌ Error destroying client for ${compositeKey}:`, error);
        }
    }

    /**
     * Relink a bridge (destroy session and reinitialize for fresh QR code)
     */
    async relinkClient(bridgeId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🔄 Relinking WhatsApp client for ${compositeKey}`);
        await this.destroyClient(bridgeId, tenantSchema); // Full destroy with session deletion
        return await this.initializeClient(bridgeId, tenantSchema, onMessage);
    }

    /**
     * Get all active clients (returns composite keys)
     */
    getAllClients() {
        return Array.from(this.clients.entries()).map(([compositeKey, state]) => ({
            compositeKey,
            bridgeId: state.bridgeId,
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
        const stopPromises = Array.from(this.clients.entries()).map(([compositeKey, state]) => {
            return this.stopClient(state.bridgeId, state.tenantSchema); // Use stopClient, not destroyClient
        });
        await Promise.all(stopPromises);
        console.log('✅ All WhatsApp clients stopped (sessions preserved for auto-reconnect)');
    }
}

module.exports = WhatsAppClientManager;
