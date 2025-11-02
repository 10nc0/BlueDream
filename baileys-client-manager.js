const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const BaileysMessageAdapter = require('./baileys-message-adapter');
const fs = require('fs');
const path = require('path');
const P = require('pino');

/**
 * Baileys WhatsApp Client Manager
 * Drop-in replacement for WhatsAppClientManager using Baileys instead of Puppeteer
 * Same interface, no browser needed - works reliably on Replit
 */
class BaileysClientManager {
    constructor(pool) {
        this.pool = pool;
        this.clients = new Map(); // compositeKey -> { sock, status, qrCode, phoneNumber, ...}
        this.messageHandlers = new Map(); // compositeKey -> message handler function
        
        // Pino logger (silent by default, can enable for debugging)
        this.logger = P({ level: 'silent' });
    }

    /**
     * Generate composite key for tenant-aware bridge tracking
     */
    getCompositeKey(tenantSchema, bridgeId) {
        return `${tenantSchema}:${bridgeId}`;
    }

    /**
     * Initialize a WhatsApp client for a specific bridge
     */
    async initializeClient(bridgeId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🔧 Initializing Baileys client for ${compositeKey}`);

        // Check if client already exists
        if (this.clients.has(compositeKey)) {
            const existing = this.clients.get(compositeKey);
            if (existing.status === 'connected') {
                console.log(`✅ Baileys client for ${compositeKey} already active`);
                return existing;
            }
        }

        try {
            // Create tenant-scoped session directory
            const sessionClientId = `${tenantSchema}_bridge_${bridgeId}`;
            const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
            const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
            
            // Ensure directory exists
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
                console.log(`📁 Created Baileys session directory: ${sessionPath}`);
            }

            // Load auth state from multi-file storage
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            
            // Fetch latest Baileys version
            const { version } = await fetchLatestBaileysVersion();

            // Create Baileys socket
            const sock = makeWASocket({
                version,
                logger: this.logger,
                printQRInTerminal: false, // We handle QR display ourselves
                auth: state,
                // Mobile connection (more reliable than browser)
                browser: ['Nyanbook Bridge', 'Chrome', '110.0.0'],
                syncFullHistory: false, // Don't sync old messages on connect
            });

            // Store client state
            const clientState = {
                sock,
                status: 'initializing',
                qrCode: null,
                phoneNumber: null,
                tenantSchema,
                bridgeId,
                compositeKey,
                createdAt: Date.now(),
                reconnectAttempts: 0
            };
            this.clients.set(compositeKey, clientState);

            // Save credentials on update
            sock.ev.on('creds.update', saveCreds);

            // CONNECTION UPDATES: Handle QR, authentication, ready states
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // QR CODE GENERATION
                if (qr) {
                    console.log(`📱 QR Code generated for ${compositeKey}`);
                    clientState.qrCode = qr;
                    clientState.status = 'qr_ready';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'qr_ready', qr, null);
                }

                // CONNECTION ESTABLISHED
                if (connection === 'open') {
                    console.log(`✅ Baileys client ready for ${compositeKey}`);
                    
                    // Get phone number from auth state
                    const phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';
                    
                    clientState.status = 'connected';
                    clientState.phoneNumber = `+${phoneNumber}`;
                    clientState.qrCode = null;
                    clientState.reconnectAttempts = 0;
                    
                    await this.updateBotStatus(bridgeId, tenantSchema, 'connected', null, `+${phoneNumber}`);
                    console.log(`📱 ${compositeKey} connected with number: +${phoneNumber}`);
                }

                // CONNECTION CLOSED
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    const reason = statusCode || 'unknown';
                    
                    console.log(`🔌 ${compositeKey} disconnected: ${reason}`);
                    clientState.status = 'disconnected';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'disconnected', null, null, `Reason: ${reason}`);

                    // Calculate session age
                    const sessionAge = clientState.createdAt ? (Date.now() - clientState.createdAt) : 0;
                    const isNewSession = sessionAge < 5 * 60 * 1000;

                    // SMART RECONNECT LOGIC
                    let shouldDestroy = false;

                    if (clientState.intentionalStop) {
                        shouldDestroy = true;
                        console.log(`🗑️  Intentional stop for ${compositeKey} - destroying client`);
                    } else if (reason === DisconnectReason.loggedOut && !isNewSession) {
                        shouldDestroy = true;
                        console.log(`🗑️  User logout detected for ${compositeKey} - destroying client`);
                    } else if (reason === DisconnectReason.loggedOut && isNewSession) {
                        shouldDestroy = false;
                        console.log(`🔄 Anti-spam kick detected for ${compositeKey} (session age: ${Math.round(sessionAge/1000)}s) - will auto-reconnect`);
                    }

                    if (shouldDestroy) {
                        this.clients.delete(compositeKey);
                        this.messageHandlers.delete(compositeKey);
                    } else if (shouldReconnect) {
                        // AUTO-RECONNECT with exponential backoff
                        // Max 5 attempts before giving up (10s, 20s, 40s, 60s, 60s)
                        const currentAttempts = clientState.reconnectAttempts || 0;
                        
                        if (currentAttempts >= 5) {
                            console.log(`❌ ${compositeKey} exceeded max reconnect attempts (5), giving up`);
                            await this.updateBotStatus(bridgeId, tenantSchema, 'disconnected', null, null, 'Max reconnect attempts exceeded');
                            this.clients.delete(compositeKey);
                            this.messageHandlers.delete(compositeKey);
                            return;
                        }
                        
                        const reconnectDelay = Math.min(60000, 10000 * Math.pow(2, currentAttempts));
                        clientState.reconnectAttempts = currentAttempts + 1;
                        
                        console.log(`🔄 Temporary disconnect for ${compositeKey} - will auto-reconnect in ${reconnectDelay/1000}s (attempt ${clientState.reconnectAttempts}/5)`);
                        
                        setTimeout(async () => {
                            try {
                                console.log(`🔄 Auto-reconnecting ${compositeKey} (attempt ${clientState.reconnectAttempts}/5)...`);
                                await this.updateBotStatus(bridgeId, tenantSchema, 'reconnecting', null, null, `Auto-reconnect attempt ${clientState.reconnectAttempts}/5`);
                                
                                const messageHandler = this.messageHandlers.get(compositeKey);
                                await this.initializeClient(bridgeId, tenantSchema, messageHandler);
                            } catch (reconnectError) {
                                console.error(`❌ Auto-reconnect failed for ${compositeKey}:`, reconnectError.message);
                            }
                        }, reconnectDelay);
                    }
                }
            });

            // MESSAGE HANDLER
            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return; // Only process new messages

                for (const msg of messages) {
                    try {
                        // Skip if message is from self or broadcast
                        if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

                        // Update activity timestamp for health monitoring
                        clientState.lastActivity = Date.now();

                        if (onMessage) {
                            // Wrap Baileys message with adapter to make it compatible with whatsapp-web.js format
                            const adaptedMessage = new BaileysMessageAdapter(msg, sock);
                            await onMessage(adaptedMessage, bridgeId, tenantSchema);
                        }
                    } catch (error) {
                        console.error(`❌ Error handling message for ${compositeKey}:`, error);
                    }
                }
            });

            // Store message handler for auto-reconnect
            if (onMessage) {
                this.messageHandlers.set(compositeKey, onMessage);
            }

            return clientState;
        } catch (error) {
            console.error(`❌ Failed to initialize Baileys client for bridge ${bridgeId}:`, error);
            await this.updateBotStatus(bridgeId, tenantSchema, 'error', null, null, error.message);
            throw error;
        }
    }

    /**
     * Update bridge status in database
     */
    async updateBotStatus(bridgeId, tenantSchema, status, qrCode, contactInfo, errorMessage) {
        try {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`SET LOCAL search_path TO ${tenantSchema}`);
                
                await client.query(`
                    UPDATE bridges 
                    SET status = $1, 
                        updated_at = NOW()
                    WHERE id = $2
                `, [status, bridgeId]);
                
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
     * Get client state
     */
    getClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        return this.clients.get(compositeKey);
    }

    /**
     * Get QR code
     */
    getQRCode(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        const clientState = this.clients.get(compositeKey);
        return clientState?.qrCode || null;
    }

    /**
     * Stop client (preserve session - graceful shutdown without revoking credentials)
     */
    async stopClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`⏸️  Stopping Baileys client for ${compositeKey} (preserving session)`);
        
        const clientState = this.clients.get(compositeKey);
        if (!clientState) {
            console.log(`⚠️  No client found for ${compositeKey}`);
            return;
        }

        try {
            clientState.intentionalStop = true;
            
            // CRITICAL: Use end() instead of logout() to preserve credentials
            // logout() revokes the WhatsApp session and forces re-QR authentication
            // end() gracefully closes the WebSocket connection while keeping auth files intact
            clientState.sock.end();
            
            this.clients.delete(compositeKey);
            await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ Baileys client stopped for ${compositeKey} (session preserved)`);
        } catch (error) {
            console.error(`❌ Error stopping client for ${compositeKey}:`, error);
        }
    }

    /**
     * Destroy client and delete session
     * IMPORTANT: Uses sock.logout() (not sock.end()) to intentionally revoke WhatsApp credentials
     * This ensures the session cannot be reused after deletion, which is the desired behavior
     * when a bridge is permanently removed (unlike stopClient which preserves credentials)
     */
    async destroyClient(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🗑️  Destroying Baileys client for ${compositeKey}`);
        
        const clientState = this.clients.get(compositeKey);
        if (clientState) {
            try {
                clientState.intentionalStop = true;
                // logout() revokes credentials (correct for bridge deletion)
                await clientState.sock.logout();
            } catch (error) {
                // Ignore logout errors
            }
            this.clients.delete(compositeKey);
        }

        // Delete session directory
        const sessionClientId = `${tenantSchema}_bridge_${bridgeId}`;
        const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
        const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
        
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️  Session deleted: ${compositeKey}`);
        }

        await this.updateBotStatus(bridgeId, tenantSchema, 'inactive', null, null, null);
        console.log(`✅ Baileys client destroyed for ${compositeKey}`);
    }

    /**
     * Relink client (destroy and reinitialize)
     */
    async relinkClient(bridgeId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        console.log(`🔄 Relinking Baileys client for ${compositeKey}`);
        await this.destroyClient(bridgeId, tenantSchema);
        return await this.initializeClient(bridgeId, tenantSchema, onMessage);
    }

    /**
     * Get all active clients
     */
    getAllClients() {
        return Array.from(this.clients.entries()).map(([compositeKey, state]) => ({
            compositeKey,
            bridgeId: state.bridgeId,
            status: state.status,
            phoneNumber: state.phoneNumber,
            tenantSchema: state.tenantSchema,
            hasQR: state.qrCode !== null,
            createdAt: state.createdAt,
            lastActivity: state.lastActivity || state.createdAt
        }));
    }

    /**
     * Check if a connection is truly alive (not just marked "connected")
     * Returns: 'alive' | 'stale' | 'disconnected' | 'not_found'
     */
    checkConnectionHealth(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        const clientState = this.clients.get(compositeKey);
        
        if (!clientState) {
            return { status: 'not_found', reason: 'Client not in memory' };
        }
        
        // Check if socket exists and is open
        const sock = clientState.sock;
        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
            return { 
                status: 'stale', 
                reason: 'Socket not open',
                readyState: sock?.ws?.readyState,
                clientStatus: clientState.status
            };
        }
        
        // Check if marked as disconnected
        if (clientState.status === 'disconnected' || clientState.status === 'error') {
            return { 
                status: 'disconnected', 
                reason: `Status is ${clientState.status}`
            };
        }
        
        // Check connection age (connections older than 24 hours might be stale)
        const connectionAge = Date.now() - (clientState.createdAt || Date.now());
        const lastActivity = clientState.lastActivity || clientState.createdAt || Date.now();
        const timeSinceActivity = Date.now() - lastActivity;
        
        // If no activity for > 12 hours, mark as potentially stale
        if (timeSinceActivity > 12 * 60 * 60 * 1000) {
            return {
                status: 'stale',
                reason: 'No activity for >12 hours',
                connectionAge,
                timeSinceActivity
            };
        }
        
        return { 
            status: 'alive', 
            reason: 'Socket open and active',
            connectionAge,
            timeSinceActivity
        };
    }

    /**
     * Update last activity timestamp when messages are received
     */
    updateActivity(bridgeId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bridgeId);
        const clientState = this.clients.get(compositeKey);
        if (clientState) {
            clientState.lastActivity = Date.now();
        }
    }

    /**
     * Cleanup all clients (graceful shutdown)
     */
    async cleanup() {
        console.log('🧹 Gracefully stopping all Baileys clients...');
        const stopPromises = Array.from(this.clients.entries()).map(([compositeKey, state]) => {
            return this.stopClient(state.bridgeId, state.tenantSchema);
        });
        await Promise.all(stopPromises);
        console.log('✅ All Baileys clients stopped');
    }
}

module.exports = BaileysClientManager;
