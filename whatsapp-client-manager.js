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
            // Create tenant-scoped session directory (prevents cross-tenant collisions)
            // LocalAuth will automatically prefix with "session-", creating: session-tenant_X_bridge_Y
            const sessionClientId = `${tenantSchema}_bridge_${bridgeId}`;

            // CRITICAL: Use persistent storage to survive restarts
            // Without this, sessions are wiped on restart → QR every time → "cannot sustain login"
            // Use env var for portability (Docker, Render, Fly.io, etc.)
            const persistentPath = process.env.WWEBJS_DATA_PATH || '/home/runner/workspace/.wwebjs_auth_persistent';
            
            // Ensure directory exists
            if (!fs.existsSync(persistentPath)) {
                fs.mkdirSync(persistentPath, { recursive: true });
                console.log(`📁 Created persistent storage directory: ${persistentPath}`);
            }
            
            // Create WhatsApp client with tenant-scoped LocalAuth
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: sessionClientId,
                    dataPath: persistentPath
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
                        '--disable-gpu',
                        '--disable-features=ProcessSingleton'
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

            // QR Code event (can fire multiple times as QR refreshes)
            client.on('qr', async (qr) => {
                try {
                    console.log(`📱 QR Code generated for ${compositeKey}`);
                    clientState.qrCode = qr;
                    clientState.status = 'qr_ready';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'qr_ready', qr, null);
                } catch (error) {
                    console.error(`⚠️  Error handling QR for ${compositeKey}:`, error.message);
                }
            });

            // Authenticated event (fires once when QR is scanned)
            client.once('authenticated', async () => {
                try {
                    console.log(`🔐 ${compositeKey} authenticated successfully`);
                    clientState.status = 'authenticated';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'authenticated', null, null);
                } catch (error) {
                    console.error(`⚠️  Error handling authenticated for ${compositeKey}:`, error.message);
                }
            });

            // Ready event (fires once when client is fully ready)
            client.once('ready', async () => {
                try {
                    console.log(`✅ WhatsApp client ready for ${compositeKey}`);
                    const info = client.info;
                    const phoneNumber = info.wid.user;
                    
                    clientState.status = 'connected';
                    clientState.phoneNumber = `+${phoneNumber}`;
                    clientState.qrCode = null;
                    clientState.reconnectAttempts = 0; // Reset reconnect counter on successful connection
                    
                    // Track session creation time (for anti-spam detection)
                    if (!clientState.createdAt) {
                        clientState.createdAt = Date.now();
                    }

                    // Update bridge with connected status and admin number
                    await this.updateBotStatus(bridgeId, tenantSchema, 'connected', null, `+${phoneNumber}`);
                    
                    console.log(`📱 ${compositeKey} connected with number: +${phoneNumber}`);
                } catch (error) {
                    console.error(`⚠️  Error handling ready for ${compositeKey}:`, error.message);
                }
            });

            // Auth failure event (fires once on failure)
            client.once('auth_failure', async (error) => {
                try {
                    console.error(`❌ Authentication failed for ${compositeKey}:`, error);
                    clientState.status = 'auth_failed';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'auth_failed', null, null, error.message);
                } catch (err) {
                    console.error(`⚠️  Error handling auth_failure for ${compositeKey}:`, err.message);
                }
            });

            // Disconnected event (can fire multiple times)
            client.on('disconnected', async (reason) => {
                try {
                    console.log(`🔌 ${compositeKey} disconnected: ${reason}`);
                    
                    // Update status to disconnected
                    clientState.status = 'disconnected';
                    await this.updateBotStatus(bridgeId, tenantSchema, 'disconnected', null, null, reason);
                    
                    // Calculate session age (must be set during ready event)
                    const sessionAge = clientState.createdAt ? (Date.now() - clientState.createdAt) : 0;
                    const isNewSession = sessionAge < 5 * 60 * 1000; // Less than 5 minutes old
                    
                    // SMART RECONNECT: Distinguish user logout vs WhatsApp anti-spam kick
                    let shouldDestroy = false;
                    
                    if (clientState.intentionalStop) {
                        // User clicked Stop button - permanent destroy
                        shouldDestroy = true;
                        console.log(`🗑️  Intentional stop for ${compositeKey} - destroying client`);
                    } else if (reason === 'NAVIGATION') {
                        // WhatsApp Web navigated away - permanent destroy
                        shouldDestroy = true;
                        console.log(`🗑️  Navigation detected for ${compositeKey} - destroying client`);
                    } else if (reason === 'LOGOUT' && !isNewSession) {
                        // LOGOUT on established session (>5 mins) = real user logout - permanent destroy
                        shouldDestroy = true;
                        console.log(`🗑️  User logout detected for ${compositeKey} (session age: ${Math.round(sessionAge/1000)}s) - destroying client`);
                    } else if (reason === 'LOGOUT' && isNewSession) {
                        // LOGOUT on new session (<5 mins) = likely WhatsApp anti-spam kick - try reconnect
                        shouldDestroy = false;
                        console.log(`🔄 Anti-spam kick detected for ${compositeKey} (session age: ${Math.round(sessionAge/1000)}s) - will auto-reconnect`);
                    }
                    
                    if (shouldDestroy) {
                        this.clients.delete(compositeKey);
                        this.messageHandlers.delete(compositeKey);
                        setImmediate(async () => {
                            try {
                                if (clientState.client) {
                                    await clientState.client.destroy();
                                }
                            } catch (destroyError) {
                                // Silently ignore - Puppeteer might have already closed
                            }
                        });
                    } else {
                        // AUTO-RECONNECT: Network issue, temporary disconnect, or anti-spam kick
                        console.log(`🔄 Temporary disconnect for ${compositeKey} (reason: ${reason}) - will auto-reconnect in 10s`);
                        
                        // Destroy old Puppeteer instance
                        setImmediate(async () => {
                            try {
                                if (clientState.client) {
                                    await clientState.client.destroy();
                                }
                            } catch (destroyError) {
                                // Ignore
                            }
                        });
                        
                        // Schedule reconnection with exponential backoff
                        const reconnectDelay = clientState.reconnectAttempts ? Math.min(60000, 10000 * Math.pow(2, clientState.reconnectAttempts)) : 10000;
                        clientState.reconnectAttempts = (clientState.reconnectAttempts || 0) + 1;
                        
                        setTimeout(async () => {
                            try {
                                console.log(`🔄 Auto-reconnecting ${compositeKey} (attempt ${clientState.reconnectAttempts})...`);
                                await this.updateBotStatus(bridgeId, tenantSchema, 'reconnecting', null, null, `Auto-reconnect attempt ${clientState.reconnectAttempts}`);
                                
                                // Reinitialize with saved session (no QR needed)
                                const messageHandler = this.messageHandlers.get(compositeKey);
                                await this.initializeClient(bridgeId, tenantSchema, messageHandler);
                            } catch (reconnectError) {
                                console.error(`❌ Auto-reconnect failed for ${compositeKey}:`, reconnectError.message);
                                // Will retry on next disconnect event if it keeps failing
                            }
                        }, reconnectDelay);
                    }
                } catch (error) {
                    console.error(`⚠️  Error handling disconnect for ${compositeKey}:`, error.message);
                }
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

            // Store message handler for auto-reconnect
            if (onMessage) {
                this.messageHandlers.set(compositeKey, onMessage);
            }

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
                    UPDATE bridges 
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
            
            // Delete tenant-scoped session directory (for relink/reset only)
            // LocalAuth stores sessions with "session-" prefix
            const sessionClientId = `${tenantSchema}_bridge_${bridgeId}`;
            const persistentPath = process.env.WWEBJS_DATA_PATH || '/home/runner/workspace/.wwebjs_auth_persistent';
            const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
            
            // Also check legacy paths for cleanup (ephemeral storage, pre-migration)
            const legacyPath1 = path.join('.wwebjs_auth', `session-${sessionClientId}`);
            const legacyPath2 = path.join('.wwebjs_auth', `session-bridge_${bridgeId}`);
            const legacyPath3 = path.join('.wwebjs_auth', `bridge_${bridgeId}`);
            
            // CRITICAL: Delete from persistent storage first (current location)
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️  Session deleted from persistent storage: ${compositeKey}`);
            }
            
            // Clean up legacy paths (ephemeral storage, backward compatibility)
            if (fs.existsSync(legacyPath1)) {
                fs.rmSync(legacyPath1, { recursive: true, force: true });
                console.log(`🗑️  Legacy session deleted (ephemeral storage) for ${compositeKey}`);
            }
            
            if (fs.existsSync(legacyPath2)) {
                fs.rmSync(legacyPath2, { recursive: true, force: true });
                console.log(`🗑️  Legacy session deleted (path1) for bridge ${bridgeId}`);
            }
            
            if (fs.existsSync(legacyPath3)) {
                fs.rmSync(legacyPath3, { recursive: true, force: true });
                console.log(`🗑️  Legacy session deleted (path2) for bridge ${bridgeId}`);
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
