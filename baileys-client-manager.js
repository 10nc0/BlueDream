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
     * GROK PROTOCOL v2 — SESSION CORRUPTION DETECTION
     * Validates Baileys auth state before use - auto-deletes poisoned sessions
     * Prevents "Unsupported state or unable to authenticate data" crashes
     */
    async safeLoadAuthState(sessionPath, compositeKey) {
        const credsPath = path.join(sessionPath, 'creds.json');
        
        // Helper: Validate Buffer data with minimum byte length
        const isValidBuffer = (obj, minBytes = 32) => {
            if (!obj) return false;
            
            // Direct Buffer object
            if (Buffer.isBuffer(obj)) {
                return obj.length >= minBytes;
            }
            
            // Serialized Buffer {type: 'Buffer', data: [...]}
            if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
                return obj.data.length >= minBytes;
            }
            
            // Base64 or hex string - decode and check actual byte length
            if (typeof obj === 'string' && obj.length > 0) {
                try {
                    // Try base64 decode
                    const decoded = Buffer.from(obj, 'base64');
                    if (decoded.length >= minBytes) return true;
                    
                    // Try hex decode
                    const hexDecoded = Buffer.from(obj, 'hex');
                    return hexDecoded.length >= minBytes;
                } catch {
                    return false; // Failed to decode - corrupted
                }
            }
            
            return false;
        };
        
        // Helper: Validate key pair structure
        const isValidKeyPair = (key) => {
            return key && isValidBuffer(key.private) && isValidBuffer(key.public);
        };
        
        try {
            // 1. Ensure directory exists
            if (!fs.existsSync(sessionPath)) {
                console.log(`📁 Session path ${sessionPath} missing — creating fresh`);
                fs.mkdirSync(sessionPath, { recursive: true });
                return await useMultiFileAuthState(sessionPath);
            }
            
            // 2. Load creds.json with error handling
            if (!fs.existsSync(credsPath)) {
                console.log(`📄 No creds.json found — fresh session for ${compositeKey}`);
                return await useMultiFileAuthState(sessionPath);
            }
            
            let parsedCreds = null;
            try {
                const credsData = fs.readFileSync(credsPath, 'utf8');
                parsedCreds = JSON.parse(credsData);
            } catch (parseError) {
                // Filesystem or JSON parse error
                if (parseError.code) {
                    // Filesystem error - preserve session
                    console.error(`❌ Filesystem error reading ${compositeKey} (${parseError.code}): ${parseError.message}`);
                    console.error(`   Session preserved - fix filesystem issue and retry`);
                    throw parseError;
                } else {
                    // JSON parse error - corruption
                    console.warn(`⚠️  JSON corruption in ${compositeKey} creds.json — purging`);
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    fs.mkdirSync(sessionPath, { recursive: true });
                    console.log(`✨ Session purged — fresh QR required`);
                    return await useMultiFileAuthState(sessionPath);
                }
            }
            
            // 3. GROK VALIDATION — STRUCTURAL INTEGRITY
            const validationResults = [];
            
            // Check me identity
            const validMe = parsedCreds.me && 
                           parsedCreds.me.id && 
                           parsedCreds.me.name;
            validationResults.push(`Me: ${validMe ? 'OK' : 'BAD'}`);
            
            // Check registration ID
            const validReg = typeof parsedCreds.registrationId === 'number' && 
                            parsedCreds.registrationId > 0;
            validationResults.push(`Reg: ${validReg ? 'OK' : 'BAD'}`);
            
            // Check noiseKey
            const validNoise = isValidKeyPair(parsedCreds.noiseKey);
            validationResults.push(`Noise: ${validNoise ? 'OK' : 'BAD'}`);
            
            // Check signedIdentityKey
            const validSignedId = isValidKeyPair(parsedCreds.signedIdentityKey);
            validationResults.push(`SignedID: ${validSignedId ? 'OK' : 'BAD'}`);
            
            // Check signedPreKey
            const validSignedPre = parsedCreds.signedPreKey && 
                                  isValidKeyPair(parsedCreds.signedPreKey.keyPair) &&
                                  isValidBuffer(parsedCreds.signedPreKey.signature);
            validationResults.push(`SignedPre: ${validSignedPre ? 'OK' : 'BAD'}`);
            
            // Check advSecretKey
            const validAdv = isValidBuffer(parsedCreds.advSecretKey);
            validationResults.push(`Adv: ${validAdv ? 'OK' : 'BAD'}`);
            
            // Check account signatures (including device signatures)
            const validAccount = parsedCreds.account && 
                                isValidBuffer(parsedCreds.account.details) &&
                                isValidBuffer(parsedCreds.account.accountSignature) &&
                                isValidBuffer(parsedCreds.account.accountSignatureKey) &&
                                isValidBuffer(parsedCreds.account.deviceSignature) &&
                                isValidBuffer(parsedCreds.account.deviceSignatureKey);
            validationResults.push(`Account: ${validAccount ? 'OK' : 'BAD'}`);
            
            // Check platform
            const validPlatform = parsedCreds.platform && 
                                 typeof parsedCreds.platform === 'string';
            validationResults.push(`Platform: ${validPlatform ? 'OK' : 'BAD'}`);
            
            // 4. CORRUPTION DETECTED — NUKE & RESTART
            const allValid = validMe && validReg && validNoise && validSignedId && 
                           validSignedPre && validAdv && validAccount && validPlatform;
            
            if (!allValid) {
                console.warn(`⚠️  CORRUPTION DETECTED in ${compositeKey} — purging`);
                console.warn(`   Validation: ${validationResults.join(' | ')}`);
                console.warn(`   Session path: ${sessionPath}`);
                
                fs.rmSync(sessionPath, { recursive: true, force: true });
                fs.mkdirSync(sessionPath, { recursive: true });
                console.log(`✨ Session purged — fresh QR required`);
                return await useMultiFileAuthState(sessionPath);
            }
            
            // 5. ALL CLEAR — LOAD CLEAN STATE
            console.log(`✅ Session ${compositeKey} validated — loading clean state`);
            return await useMultiFileAuthState(sessionPath);
            
        } catch (error) {
            // Final fallback for unexpected errors
            console.error(`❌ FATAL: Failed to validate session ${compositeKey}:`, error.message);
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            } catch {}
            fs.mkdirSync(sessionPath, { recursive: true });
            console.log(`🔄 Session reset after fatal error — fresh QR required`);
            return await useMultiFileAuthState(sessionPath);
        }
    }

    /**
     * Generate composite key for tenant-aware book tracking
     */
    getCompositeKey(tenantSchema, bookId, isShadow = false) {
        const baseKey = `${tenantSchema}:${bookId}`;
        return isShadow ? `${baseKey}:shadow` : baseKey;
    }
    
    /**
     * Check if a composite key represents a shadow session
     */
    isShadowSession(compositeKey) {
        return compositeKey.endsWith(':shadow');
    }
    
    /**
     * Get primary key from shadow key
     */
    getPrimaryKey(compositeKey) {
        return compositeKey.replace(':shadow', '');
    }
    
    /**
     * Get shadow key from primary key
     */
    getShadowKey(compositeKey) {
        return `${compositeKey}:shadow`;
    }

    /**
     * Initialize a WhatsApp client for a specific book
     */
    async initializeClient(bookId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
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
            const sessionClientId = `${tenantSchema}_book_${bookId}`;
            const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
            const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
            
            // Ensure directory exists
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
                console.log(`📁 Created Baileys session directory: ${sessionPath}`);
            }

            // Load auth state with corruption detection (Grok Protocol)
            const { state, saveCreds } = await this.safeLoadAuthState(sessionPath, compositeKey);
            
            // Fetch latest Baileys version
            const { version } = await fetchLatestBaileysVersion();

            // Create Baileys socket
            const sock = makeWASocket({
                version,
                logger: this.logger,
                printQRInTerminal: false, // We handle QR display ourselves
                auth: state,
                // Mobile connection (more reliable than browser)
                browser: ['Nyanbook Book', 'Chrome', '110.0.0'],
                syncFullHistory: false, // Don't sync old messages on connect
            });

            // Store client state
            const clientState = {
                sock,
                status: 'initializing',
                qrCode: null,
                phoneNumber: null,
                tenantSchema,
                bookId,
                compositeKey,
                createdAt: Date.now(),
                reconnectAttempts: 0,
                failedReconnectCount: 0,  // Track consecutive failed reconnects
                lastReconnectTime: null
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
                    await this.updateBotStatus(bookId, tenantSchema, 'qr_ready', qr, null);
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
                    clientState.failedReconnectCount = 0;  // Reset on successful connection
                    clientState.lastReconnectTime = null;
                    
                    await this.updateBotStatus(bookId, tenantSchema, 'connected', null, `+${phoneNumber}`);
                    console.log(`📱 ${compositeKey} connected with number: +${phoneNumber}`);
                }

                // CONNECTION CLOSED
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const reason = statusCode || 'unknown';
                    
                    console.log(`🔌 ${compositeKey} disconnected: ${reason}`);
                    
                    // DETECT FAILED RECONNECT: If we just reconnected and immediately disconnected
                    const timeSinceReconnect = clientState.lastReconnectTime ? (Date.now() - clientState.lastReconnectTime) : Infinity;
                    const isFailedReconnect = timeSinceReconnect < 15000; // Failed if disconnect within 15 seconds of reconnect
                    
                    if (isFailedReconnect) {
                        clientState.failedReconnectCount = (clientState.failedReconnectCount || 0) + 1;
                        console.log(`❌ Reconnect failed for ${compositeKey} (${clientState.failedReconnectCount}/3 consecutive failures)`);
                        
                        // STOP AFTER 3 CONSECUTIVE FAILURES
                        if (clientState.failedReconnectCount >= 3) {
                            console.error(`🛑 ${compositeKey} exceeded 3 consecutive reconnect failures - marking as needs_qr`);
                            clientState.status = 'needs_qr';
                            await this.updateBotStatus(bookId, tenantSchema, 'needs_qr', null, null, 'Reconnection failed - scan QR code');
                            this.clients.delete(compositeKey);
                            this.messageHandlers.delete(compositeKey);
                            return;
                        }
                    }
                    
                    clientState.status = 'disconnected';
                    await this.updateBotStatus(bookId, tenantSchema, 'disconnected', null, null, `Reason: ${reason}`);

                    // Calculate session age
                    const sessionAge = clientState.createdAt ? (Date.now() - clientState.createdAt) : 0;
                    const isNewSession = sessionAge < 5 * 60 * 1000;

                    // SMART RECONNECT LOGIC
                    let shouldDestroy = false;
                    let shouldReconnect = false;

                    if (clientState.intentionalStop) {
                        shouldDestroy = true;
                        shouldReconnect = false;
                        console.log(`🗑️  Intentional stop for ${compositeKey} - destroying client`);
                    } else if (reason === DisconnectReason.loggedOut && !isNewSession) {
                        shouldDestroy = true;
                        shouldReconnect = false;
                        console.log(`🗑️  User logout detected for ${compositeKey} - destroying client`);
                    } else if (reason === DisconnectReason.loggedOut && isNewSession) {
                        shouldDestroy = false;
                        shouldReconnect = true;  // FIX: Anti-spam kicks SHOULD reconnect
                        console.log(`🔄 Anti-spam kick detected for ${compositeKey} (session age: ${Math.round(sessionAge/1000)}s) - will auto-reconnect`);
                    } else if (reason !== DisconnectReason.loggedOut) {
                        // Other disconnections (network errors, etc.)
                        shouldDestroy = false;
                        shouldReconnect = true;
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
                            await this.updateBotStatus(bookId, tenantSchema, 'disconnected', null, null, 'Max reconnect attempts exceeded');
                            this.clients.delete(compositeKey);
                            this.messageHandlers.delete(compositeKey);
                            return;
                        }
                        
                        const reconnectDelay = Math.min(60000, 10000 * Math.pow(2, currentAttempts));
                        clientState.reconnectAttempts = currentAttempts + 1;
                        
                        console.log(`🔄 Temporary disconnect for ${compositeKey} - will auto-reconnect in ${reconnectDelay/1000}s (attempt ${clientState.reconnectAttempts}/5)`);
                        console.log(`⏰ Scheduling reconnect setTimeout for ${compositeKey} - delay: ${reconnectDelay}ms, bookId: ${bookId}, schema: ${tenantSchema}`);
                        
                        setTimeout(async () => {
                            console.log(`⏰ setTimeout FIRED for ${compositeKey} - starting reconnection...`);
                            try {
                                console.log(`🔄 Auto-reconnecting ${compositeKey} (attempt ${clientState.reconnectAttempts}/5)...`);
                                await this.updateBotStatus(bookId, tenantSchema, 'reconnecting', null, null, `Auto-reconnect attempt ${clientState.reconnectAttempts}/5`);
                                
                                // PRESERVE failure tracking values across initializeClient (which creates new state)
                                const reconnectTime = Date.now();
                                const savedFailedCount = clientState.failedReconnectCount || 0;
                                
                                const messageHandler = this.messageHandlers.get(compositeKey);
                                const reconnectedState = await this.initializeClient(bookId, tenantSchema, messageHandler);
                                
                                // RESTORE failure tracking to new clientState
                                if (reconnectedState) {
                                    reconnectedState.failedReconnectCount = savedFailedCount;
                                    reconnectedState.lastReconnectTime = reconnectTime;
                                    console.log(`✅ Auto-reconnect SUCCESS for ${compositeKey} - Status: ${reconnectedState.status}, Phone: ${reconnectedState.phoneNumber || 'pending'}`);
                                    console.log(`📊 ${compositeKey} reconnect stats: Attempt ${clientState.reconnectAttempts}/5, Total reconnects: ${clientState.reconnectAttempts}`);
                                } else {
                                    console.warn(`⚠️  Auto-reconnect returned no state for ${compositeKey} - may need QR scan`);
                                }
                            } catch (reconnectError) {
                                console.error(`❌ Auto-reconnect FAILED for ${compositeKey} (attempt ${clientState.reconnectAttempts}/5):`, reconnectError.message);
                                console.error(`🔍 Error details:`, {
                                    name: reconnectError.name,
                                    code: reconnectError.code,
                                    stack: reconnectError.stack?.split('\n')[0]
                                });
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
                        // CRITICAL: Skip if this is a shadow session (safety check)
                        if (this.isShadowSession(compositeKey)) {
                            console.warn(`⚠️  Ignoring message on shadow session: ${compositeKey}`);
                            continue;
                        }
                        
                        // NYANBOOK = PERSONAL DIARY: Forward ALL messages (including from self)
                        // Only skip broadcasts (status updates)
                        if (msg.key.remoteJid === 'status@broadcast') continue;

                        // Update activity timestamp for health monitoring
                        clientState.lastActivity = Date.now();

                        if (onMessage) {
                            // Wrap Baileys message with adapter to make it compatible with whatsapp-web.js format
                            const adaptedMessage = new BaileysMessageAdapter(msg, sock);
                            await onMessage(adaptedMessage, bookId, tenantSchema);
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
            console.error(`❌ Failed to initialize Baileys client for book ${bookId}:`, error);
            await this.updateBotStatus(bookId, tenantSchema, 'error', null, null, error.message);
            throw error;
        }
    }

    /**
     * Create shadow session for zero-downtime reconnection
     * Primary session stays active, shadow gets new QR code
     */
    async createShadowSession(bookId, tenantSchema, onMessage) {
        const shadowKey = this.getCompositeKey(tenantSchema, bookId, true);
        console.log(`👻 Creating shadow session: ${shadowKey}`);
        
        // Check if shadow already exists
        if (this.clients.has(shadowKey)) {
            console.log(`⚠️  Shadow session already exists for ${shadowKey}`);
            return this.clients.get(shadowKey);
        }
        
        try {
            // Create TEMPORARY session directory for shadow
            const sessionClientId = `${tenantSchema}_book_${bookId}_shadow`;
            const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
            const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
            
            // Clean existing shadow session data (force fresh QR)
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            fs.mkdirSync(sessionPath, { recursive: true });
            console.log(`📁 Created shadow session directory: ${sessionPath}`);
            
            // Load auth state with corruption detection (will be empty for fresh shadow)
            const { state, saveCreds } = await this.safeLoadAuthState(sessionPath, shadowKey);
            const { version } = await fetchLatestBaileysVersion();
            
            // Create shadow socket
            const sock = makeWASocket({
                version,
                logger: this.logger,
                printQRInTerminal: false,
                auth: state,
                browser: ['Nyanbook Book (Reconnecting)', 'Chrome', '110.0.0'],
                syncFullHistory: false,
            });
            
            // Store shadow client state
            const clientState = {
                sock,
                status: 'initializing',
                qrCode: null,
                phoneNumber: null,
                tenantSchema,
                bookId,
                compositeKey: shadowKey,
                createdAt: Date.now(),
                reconnectAttempts: 0,
                isShadow: true,
                shadowTimeout: null  // Will hold cleanup timeout
            };
            this.clients.set(shadowKey, clientState);
            
            // Save credentials on update
            sock.ev.on('creds.update', saveCreds);
            
            // CONNECTION UPDATES: Monitor shadow session
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                // QR CODE GENERATION
                if (qr) {
                    console.log(`📱 Shadow QR generated for ${shadowKey}`);
                    clientState.qrCode = qr;
                    clientState.status = 'qr_ready';
                }
                
                // CONNECTION ESTABLISHED - SWAP TIME!
                if (connection === 'open') {
                    console.log(`✅ Shadow session authenticated for ${shadowKey}`);
                    const phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';
                    clientState.status = 'connected';
                    clientState.phoneNumber = `+${phoneNumber}`;
                    clientState.qrCode = null;
                    
                    // ATOMIC SWAP: Replace primary with shadow
                    console.log(`🔄 Swapping shadow to primary for book ${bookId}...`);
                    await this.swapShadowToPrimary(bookId, tenantSchema);
                }
                
                // CONNECTION CLOSED
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`🔌 Shadow ${shadowKey} disconnected: ${statusCode}`);
                    
                    // Clean up shadow if it fails
                    await this.destroyShadowSession(bookId, tenantSchema);
                }
            });
            
            // NO MESSAGE HANDLING FOR SHADOW - Messages only go to primary!
            
            // Auto-cleanup: Destroy shadow after 5 minutes if not authenticated
            clientState.shadowTimeout = setTimeout(async () => {
                if (clientState.status !== 'connected') {
                    console.log(`⏰ Shadow session timeout: ${shadowKey}`);
                    await this.destroyShadowSession(bookId, tenantSchema);
                }
            }, 5 * 60 * 1000); // 5 minutes
            
            console.log(`👻 Shadow session created, will timeout in 5 minutes if not used`);
            return clientState;
        } catch (error) {
            console.error(`❌ Failed to create shadow session for book ${bookId}:`, error);
            throw error;
        }
    }
    
    /**
     * Destroy shadow session only (cleanup)
     */
    async destroyShadowSession(bookId, tenantSchema) {
        const shadowKey = this.getCompositeKey(tenantSchema, bookId, true);
        console.log(`🗑️  Destroying shadow session: ${shadowKey}`);
        
        const clientState = this.clients.get(shadowKey);
        if (clientState) {
            // Clear timeout
            if (clientState.shadowTimeout) {
                clearTimeout(clientState.shadowTimeout);
            }
            
            try {
                clientState.intentionalStop = true;
                await clientState.sock.end();
            } catch (error) {
                // Ignore errors during shadow cleanup
            }
            
            this.clients.delete(shadowKey);
        }
        
        // Delete shadow session directory
        const sessionClientId = `${tenantSchema}_book_${bookId}_shadow`;
        const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
        const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
        
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️  Shadow session directory deleted: ${sessionPath}`);
        }
    }
    
    /**
     * Atomic swap: Replace primary with shadow (zero-downtime reconnection)
     * CRITICAL: Does NOT modify database output_credentials - only swaps in-memory client
     */
    async swapShadowToPrimary(bookId, tenantSchema) {
        const primaryKey = this.getCompositeKey(tenantSchema, bookId, false);
        const shadowKey = this.getCompositeKey(tenantSchema, bookId, true);
        
        const shadowState = this.clients.get(shadowKey);
        if (!shadowState || shadowState.status !== 'connected') {
            console.error(`❌ Cannot swap: Shadow session not authenticated`);
            return false;
        }
        
        console.log(`🔄 ATOMIC SWAP: ${shadowKey} → ${primaryKey}`);
        
        // Step 1: Destroy old primary (if exists)
        const oldPrimary = this.clients.get(primaryKey);
        if (oldPrimary) {
            console.log(`  📤 Stopping old primary session...`);
            try {
                oldPrimary.intentionalStop = true;
                await oldPrimary.sock.end();
            } catch (error) {
                console.error(`  ⚠️  Error stopping old primary:`, error.message);
            }
            this.clients.delete(primaryKey);
            
            // Delete old primary session directory
            const oldSessionId = `${tenantSchema}_book_${bookId}`;
            const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
            const oldSessionPath = path.join(persistentPath, `session-${oldSessionId}`);
            if (fs.existsSync(oldSessionPath)) {
                fs.rmSync(oldSessionPath, { recursive: true, force: true });
            }
        }
        
        // Step 2: Promote shadow to primary
        console.log(`  📥 Promoting shadow to primary...`);
        
        // Clear shadow timeout
        if (shadowState.shadowTimeout) {
            clearTimeout(shadowState.shadowTimeout);
        }
        
        // Update composite key
        shadowState.compositeKey = primaryKey;
        shadowState.isShadow = false;
        delete shadowState.shadowTimeout;
        
        // Move shadow client to primary key
        this.clients.set(primaryKey, shadowState);
        this.clients.delete(shadowKey);
        
        // Step 3: Rename shadow session directory to primary
        const shadowSessionId = `${tenantSchema}_book_${bookId}_shadow`;
        const primarySessionId = `${tenantSchema}_book_${bookId}`;
        const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
        const shadowPath = path.join(persistentPath, `session-${shadowSessionId}`);
        const primaryPath = path.join(persistentPath, `session-${primarySessionId}`);
        
        if (fs.existsSync(shadowPath)) {
            fs.renameSync(shadowPath, primaryPath);
            console.log(`  📂 Renamed session directory: ${shadowSessionId} → ${primarySessionId}`);
        }
        
        // Step 4: Update database status (ONLY status, NOT output_credentials!)
        await this.updateBotStatus(bookId, tenantSchema, 'connected', null, shadowState.phoneNumber);
        
        console.log(`✅ Swap complete: Shadow promoted to primary (${shadowState.phoneNumber})`);
        console.log(`  🔒 Output threads/webhooks unchanged (preserved)`);
        return true;
    }

    /**
     * Update book status in database
     */
    async updateBotStatus(bookId, tenantSchema, status, qrCode, contactInfo, errorMessage) {
        try {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`SET LOCAL search_path TO ${tenantSchema}`);
                
                await client.query(`
                    UPDATE books 
                    SET status = $1, 
                        updated_at = NOW()
                    WHERE id = $2
                `, [status, bookId]);
                
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`Error updating book ${bookId} status:`, error);
        }
    }

    /**
     * Get client state
     */
    getClient(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
        return this.clients.get(compositeKey);
    }

    /**
     * Get QR code
     */
    getQRCode(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
        const clientState = this.clients.get(compositeKey);
        return clientState?.qrCode || null;
    }

    /**
     * Stop client (preserve session - graceful shutdown without revoking credentials)
     */
    async stopClient(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
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
            await this.updateBotStatus(bookId, tenantSchema, 'inactive', null, null, null);
            
            console.log(`✅ Baileys client stopped for ${compositeKey} (session preserved)`);
        } catch (error) {
            console.error(`❌ Error stopping client for ${compositeKey}:`, error);
        }
    }

    /**
     * Destroy client and delete session
     * IMPORTANT: Uses sock.logout() (not sock.end()) to intentionally revoke WhatsApp credentials
     * This ensures the session cannot be reused after deletion, which is the desired behavior
     * when a book is permanently removed (unlike stopClient which preserves credentials)
     */
    async destroyClient(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
        console.log(`🗑️  Destroying Baileys client for ${compositeKey}`);
        
        const clientState = this.clients.get(compositeKey);
        if (clientState) {
            try {
                clientState.intentionalStop = true;
                // logout() revokes credentials (correct for book deletion)
                await clientState.sock.logout();
            } catch (error) {
                // Ignore logout errors
            }
            this.clients.delete(compositeKey);
        }

        // Delete session directory
        const sessionClientId = `${tenantSchema}_book_${bookId}`;
        const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
        const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
        
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️  Session deleted: ${compositeKey}`);
        }

        await this.updateBotStatus(bookId, tenantSchema, 'inactive', null, null, null);
        console.log(`✅ Baileys client destroyed for ${compositeKey}`);
    }

    /**
     * Relink client (destroy and reinitialize)
     */
    async relinkClient(bookId, tenantSchema, onMessage) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
        console.log(`🔄 Relinking Baileys client for ${compositeKey}`);
        await this.destroyClient(bookId, tenantSchema);
        return await this.initializeClient(bookId, tenantSchema, onMessage);
    }

    /**
     * Get all active clients
     */
    getAllClients() {
        return Array.from(this.clients.entries()).map(([compositeKey, state]) => ({
            compositeKey,
            bookId: state.bookId,
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
    checkConnectionHealth(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
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
    updateActivity(bookId, tenantSchema) {
        const compositeKey = this.getCompositeKey(tenantSchema, bookId);
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
            return this.stopClient(state.bookId, state.tenantSchema);
        });
        await Promise.all(stopPromises);
        console.log('✅ All Baileys clients stopped');
    }
}

module.exports = BaileysClientManager;
