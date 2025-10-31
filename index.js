const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const authService = require('./auth-service');
const TenantManager = require('./tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./tenant-middleware');
const BaileysClientManager = require('./baileys-client-manager');
const DiscordBotManager = require('./discord-bot-manager');
const fractalId = require('./utils/fractal-id');

// SECURITY: Enforce FRACTAL_SALT configuration before server starts
if (!process.env.FRACTAL_SALT) {
    const crypto = require('crypto');
    const autoSalt = crypto.randomBytes(32).toString('hex');
    console.error('❌ CRITICAL: FRACTAL_SALT environment variable not set!');
    console.error('');
    console.error('🔐 FRACTAL_SALT is required for secure bridge ID generation.');
    console.error('');
    console.error('📋 SETUP INSTRUCTIONS:');
    console.error('   1. Go to Replit Secrets tab');
    console.error('   2. Add a new secret: FRACTAL_SALT');
    console.error('   3. Generate a secure value: https://www.random.org/strings/?num=1&len=64&digits=on&upperalpha=on&loweralpha=on&unique=on&format=plain');
    console.error('   4. Paste the generated string as the value');
    console.error('   5. Restart the server');
    console.error('');
    console.error('⚠️  For your convenience, here\'s a pre-generated salt (use this if you prefer):');
    console.error(`   ${autoSalt}`);
    console.error('');
    console.error('🛑 Server will not start until FRACTAL_SALT is configured.');
    process.exit(1);
}

const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

// GLOBAL CONSTANTS: Nyanbook Ledger (Output #01) - centralized monitoring for all tenants
// SECURITY: Loaded from environment variable (never hardcode webhooks in source code)
const NYANBOOK_LEDGER_WEBHOOK = process.env.NYANBOOK_WEBHOOK_URL;

if (!NYANBOOK_LEDGER_WEBHOOK) {
    console.error('❌ CRITICAL: NYANBOOK_WEBHOOK_URL environment variable not set!');
    console.error('   Bridge creation will fail without Output #01 webhook configured.');
}

// PERSISTENT STORAGE: Baileys uses JSON files for auth (no browser needed)
const BAILEYS_DATA_PATH = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 20,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 30000,
    idle_in_transaction_session_timeout: 30000
});

const tenantManager = new TenantManager(pool);

// Timestamp helper function with timezone
function getTimestamp() {
    const now = new Date();
    return now.toLocaleString('en-US', { 
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
    });
}

const app = express();

// Make pool available to middleware
app.locals.pool = pool;

// Trust proxy - required for HTTPS cookie support in Replit environment
app.set('trust proxy', 1);

// SECURITY: Helmet for production-grade security headers
app.use(helmet({
    contentSecurityPolicy: false, // Disabled to allow inline scripts for SPA
    crossOriginEmbedderPolicy: false // Required for iframe embedding
}));

// SECURITY: CORS with origin whitelist
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        // Allow localhost for development
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
            return callback(null, true);
        }
        
        // Allow any Replit domain (for development and production)
        if (origin.includes('.replit.dev') || origin.includes('.repl.co')) {
            return callback(null, true);
        }
        
        // Check against whitelist (if configured)
        if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Log blocked origin for debugging
        console.error(`❌ CORS blocked origin: ${origin}`);
        
        // SECURITY: Default deny if not in Replit domains or whitelist
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true, // Required for cookie-based auth
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

// Configure session management with PostgreSQL store
const PgSession = connectPg(session);
app.use(session({
    store: new PgSession({
        pool: pool,
        tableName: 'sessions'
    }),
    secret: process.env.SESSION_SECRET || 'bridge-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // true in production, false in dev
        sameSite: 'none', // Required for cross-site iframe embedding
        partitioned: true // Required for Safari to accept cookies in iframes (CHIPS)
    },
    name: 'bridge.sid' // Custom session cookie name
}));

// Google OAuth removed - email/password authentication only

// Middleware to block HTML files from static serving
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/login.html') {
        return next(); // Let explicit routes handle HTML files
    }
    next();
});

// Serve login page without authentication (must come before requireAuth check)
app.get('/login.html', (req, res) => {
    console.log(`[${getTimestamp()}] 📱 Login page accessed - IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    res.sendFile(__dirname + '/public/login.html');
});

// Serve signup page without authentication
app.get('/signup.html', (req, res) => {
    console.log(`[${getTimestamp()}] 📝 Signup page accessed - IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    res.sendFile(__dirname + '/public/signup.html');
});

// Serve dev panel (auth happens client-side via JWT)
app.get('/dev', (req, res) => {
    console.log(`[${getTimestamp()}] 🛠️  Dev panel accessed - IP: ${req.ip}`);
    res.sendFile(__dirname + '/public/dev.html');
});

// UAT/Test route removed - use real signup flow for multi-tenant architecture

// Health check endpoint with Baileys WhatsApp client status monitoring
app.get('/health', (req, res) => {
    // Count clients by status
    const clientStats = {
        total: 0,
        connected: 0,
        qr_ready: 0,
        authenticated: 0,
        initializing: 0,
        disconnected: 0,
        other: 0
    };
    
    // Get all client statuses from BaileysClientManager
    for (const [key, clientData] of whatsappManager.clients.entries()) {
        clientStats.total++;
        const status = clientData.status || 'unknown';
        if (clientStats[status] !== undefined) {
            clientStats[status]++;
        } else {
            clientStats.other++;
        }
    }
    
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        whatsapp: clientStats,
        library: 'baileys', // Using Baileys (no Chromium needed)
        storage: {
            path: BAILEYS_DATA_PATH,
            customized: !!process.env.BAILEYS_DATA_PATH
        }
    });
});

// Serve main dashboard - client-side JWT auth will handle access control
app.get('/', (req, res) => {
    // Health check support: return 200 for HEAD requests (used by deployment health checks)
    if (req.method === 'HEAD') {
        return res.status(200).end();
    }
    
    res.sendFile(__dirname + '/public/index.html');
});

// Serve index.html - client-side JWT auth will handle access control
app.get('/index.html', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Serve only non-HTML static files without authentication
// HTML files are served through explicit authenticated routes above
app.use(express.static('public', { 
    index: false,
    ignore: ['*.html'] // Don't serve HTML files through static middleware
}));

// Apply tenant context middleware to all API routes (except auth routes)
app.use('/api/bridges', setTenantContext);
app.use('/api/messages', setTenantContext);
app.use('/api/users', setTenantContext);
app.use('/api/sessions', setTenantContext);
app.use('/api/audit', setTenantContext);
app.use('/api/analytics', setTenantContext);

// Multi-tenant WhatsApp Client Manager
// Each bridge gets its own WhatsApp session (one per tenant)
let whatsappManager = null;

// Discord Bot Manager for automatic thread creation per bridge
let discordBotManager = null;

async function initializeDatabase() {
    try {
        await tenantManager.initializeCoreSchema();
        
        // ✅ REMOVED: Legacy public schema bridges/messages tables
        // All bridge and message data now lives in tenant_X schemas (fractalized multi-tenancy)
        
        // Create users table for authentication
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE,
                phone TEXT UNIQUE,
                password_hash TEXT,
                role TEXT DEFAULT 'read-only' CHECK (role IN ('admin', 'read-only', 'write-only')),
                otp_code TEXT,
                otp_expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        
        // Create sessions table for session storage
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid VARCHAR NOT NULL PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            )
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)
        `);
        
        // Create active_sessions table for tracking session metadata
        await pool.query(`
            CREATE TABLE IF NOT EXISTS active_sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id VARCHAR NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                device_type TEXT,
                browser TEXT,
                os TEXT,
                location TEXT,
                login_time TIMESTAMPTZ DEFAULT NOW(),
                last_activity TIMESTAMPTZ DEFAULT NOW(),
                is_active BOOLEAN DEFAULT TRUE
            )
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_active_sessions_session ON active_sessions(session_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_active_sessions_active ON active_sessions(is_active, last_activity DESC)
        `);
        
        // Create audit_logs table for tracking all user and session changes
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                actor_email TEXT,
                action_type TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT,
                target_email TEXT,
                details JSONB,
                ip_address TEXT,
                user_agent TEXT
            )
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action_type)
        `);
        
        // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
        // No messages table needed - Discord threads provide permanent storage at zero cost
        
        // MIGRATION: Add media_buffer table to existing tenant schemas
        // This ensures retry-safe media delivery for all existing tenants
        const schemas = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        for (const { schema_name } of schemas.rows) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ${schema_name}.media_buffer (
                    id SERIAL PRIMARY KEY,
                    bridge_id INTEGER REFERENCES ${schema_name}.bridges(id) ON DELETE CASCADE,
                    media_data BYTEA NOT NULL,
                    media_type TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    sender_name TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    delivered_to_ledger BOOLEAN DEFAULT false,
                    delivered_to_user BOOLEAN DEFAULT false,
                    delivery_attempts INTEGER DEFAULT 0,
                    last_delivery_attempt TIMESTAMPTZ
                )
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_created_at 
                ON ${schema_name}.media_buffer(created_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_bridge 
                ON ${schema_name}.media_buffer(bridge_id)
            `);
            
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_media_buffer_pending
                ON ${schema_name}.media_buffer(delivered_to_ledger, delivered_to_user)
                WHERE delivered_to_ledger = false OR delivered_to_user = false
            `);
            
            // ALTER existing tables to convert TEXT to BYTEA (safe migration for binary files)
            await pool.query(`
                DO $$ 
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = '${schema_name}' 
                        AND table_name = 'media_buffer' 
                        AND column_name = 'media_data' 
                        AND data_type = 'text'
                    ) THEN
                        ALTER TABLE ${schema_name}.media_buffer 
                        ALTER COLUMN media_data TYPE BYTEA USING decode(media_data, 'base64');
                    END IF;
                END $$;
            `);
        }
        
        console.log('✅ Core schema initialized with security tables');
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        throw error;
    }
}

// WEBHOOK-CENTRIC ARCHITECTURE: Dual-output delivery (Bridge #01 + Bridge #0n)
// Output #01: Nyanbook Ledger (eternal, masked, Dev #01 only) via output_01_url
// Output #0n: User Discord (mutable, visible, Admin #0n only) via output_0n_url
// UI MASKING: "webhook" → "bridge" terminology everywhere except create form
// DATABASE ROLE: Stores ONLY routing metadata (webhook URLs, thread IDs) - NOT messages

// HELPER: Get file extension from MIME type (supports ALL formats)
function getFileExtension(mimetype) {
    const mimeMap = {
        // Images
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
        // Videos
        'video/mp4': 'mp4',
        'video/mpeg': 'mpeg',
        'video/quicktime': 'mov',
        'video/x-msvideo': 'avi',
        'video/webm': 'webm',
        'video/3gpp': '3gp',
        // Audio
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/ogg': 'ogg',
        'audio/opus': 'opus',
        'audio/wav': 'wav',
        'audio/webm': 'weba',
        'audio/aac': 'aac',
        'audio/x-m4a': 'm4a',
        // Documents - Microsoft Office
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        // Documents - Other
        'application/pdf': 'pdf',
        'application/zip': 'zip',
        'application/x-rar-compressed': 'rar',
        'application/x-7z-compressed': '7z',
        'text/plain': 'txt',
        'text/csv': 'csv',
        'application/json': 'json',
        'application/xml': 'xml',
        'text/html': 'html',
        'application/rtf': 'rtf',
        // Archives
        'application/gzip': 'gz',
        'application/x-tar': 'tar',
    };
    
    // Return mapped extension or extract from mimetype
    return mimeMap[mimetype] || mimetype.split('/').pop().replace(/[^a-z0-9]/gi, '');
}

// Send to Ledger (Output #01 = eternal monolith, immutable thread_id storage)
// WEBHOOK-FIRST: Accepts bridge object directly, no database queries needed
async function sendToLedger(payload, options = {}, bridge = null) {
    // WEBHOOK-FIRST: Use webhook URL directly from bridge object
    let ledgerUrl = bridge?.output_01_url;
    
    // Fallback to global constant if bridge doesn't have URL configured
    if (!ledgerUrl || !ledgerUrl.trim()) {
        ledgerUrl = NYANBOOK_LEDGER_WEBHOOK;
    }
    
    if (!ledgerUrl) {
        console.log('  ℹ️  No ledger configured - skipping Output #01');
        return null;
    }

    try {
        // Debug logging (mask webhook URL for security)
        console.log(`  🔍 Ledger URL: ${ledgerUrl ? '[MASKED_LEDGER_WEBHOOK]' : 'none'}`);
        console.log(`  🔍 Thread ID: ${options.threadId || 'none'}`);
        console.log(`  🔍 Thread Name: ${options.threadName || 'none'}`);
        
        const url = new URL(ledgerUrl);
        url.searchParams.set('wait', 'true');
        
        // CRITICAL: thread_id must be URL query parameter (Discord API requirement)
        if (options.threadId) {
            url.searchParams.set('thread_id', options.threadId);
            console.log(`  📍 Targeting thread: ${options.threadId}`);
        }

        let response;
        
        // Handle media vs text - read from media_buffer if provided
        if (options.isMedia && options.mediaBufferId) {
            // Read media from buffer table (retry-safe storage)
            // CRITICAL: Use schema-qualified queries instead of SET LOCAL search_path
            const mediaClient = await pool.connect();
            try {
                const mediaResult = await mediaClient.query(`
                    SELECT media_data, media_type, filename 
                    FROM ${options.tenantSchema}.media_buffer 
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
                if (mediaResult.rows.length === 0) {
                    throw new Error(`Media buffer ID ${options.mediaBufferId} not found`);
                }
                
                const { media_data, media_type, filename } = mediaResult.rows[0];
                const buffer = media_data;
                
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', buffer, {
                    filename: filename,
                    contentType: media_type
                });
                form.append('payload_json', JSON.stringify(payload));
                response = await axios.post(url.toString(), form, { headers: form.getHeaders() });
                
                // Mark as delivered to ledger (schema-qualified)
                await mediaClient.query(`
                    UPDATE ${options.tenantSchema}.media_buffer 
                    SET delivered_to_ledger = true, 
                        delivery_attempts = delivery_attempts + 1,
                        last_delivery_attempt = NOW()
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
            } finally {
                mediaClient.release();
            }
        } else {
            response = await axios.post(url.toString(), payload);
        }

        console.log(`  ✅ Sent to Output #01 (Ledger) - Thread: ${options.threadId || 'channel'}`);
        return response.data?.channel_id || null;
    } catch (error) {
        console.error(`  ❌ Output #01 failed: ${error.message}`);
        console.error(`  🔍 URL attempted: ${ledgerUrl?.substring(0, 50)}...`);
        return null;
    }
}

// Send to User Output (Output #0n = user's personal Discord, mutable)
// WEBHOOK-FIRST: Accepts bridge object directly, no database queries needed
async function sendToUserOutput(payload, options = {}, bridge = null) {
    if (!bridge) {
        console.log('  ℹ️  No bridge context - skipping Output #0n');
        return false;
    }

    try {
        // WEBHOOK-FIRST: Use webhook URL directly from bridge object
        const userOutputUrl = bridge.output_0n_url;
        
        if (!userOutputUrl || !userOutputUrl.trim()) {
            console.log(`  ℹ️  No Output #0n configured - skipping user Discord`);
            return false;
        }

        const url = new URL(userOutputUrl);
        // Don't add thread params to user output - let them manage their own Discord
        
        // Handle media vs text - read from media_buffer if provided
        if (options.isMedia && options.mediaBufferId) {
            // Read media from buffer table (retry-safe storage)
            // CRITICAL: Use schema-qualified queries instead of SET LOCAL search_path
            const mediaClient = await pool.connect();
            try {
                const mediaResult = await mediaClient.query(`
                    SELECT media_data, media_type, filename 
                    FROM ${options.tenantSchema}.media_buffer 
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
                if (mediaResult.rows.length === 0) {
                    throw new Error(`Media buffer ID ${options.mediaBufferId} not found`);
                }
                
                const { media_data, media_type, filename } = mediaResult.rows[0];
                const buffer = media_data;
                
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', buffer, {
                    filename: filename,
                    contentType: media_type
                });
                form.append('payload_json', JSON.stringify(payload));
                await axios.post(url.toString(), form, { headers: form.getHeaders() });
                
                // Mark as delivered to user output (schema-qualified)
                await mediaClient.query(`
                    UPDATE ${options.tenantSchema}.media_buffer 
                    SET delivered_to_user = true,
                        delivery_attempts = delivery_attempts + 1,
                        last_delivery_attempt = NOW()
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
            } finally {
                mediaClient.release();
            }
        } else {
            await axios.post(url.toString(), payload);
        }

        console.log(`  ✅ Sent to Output #0n (User Discord)`);
        return true;
    } catch (error) {
        console.error(`  ❌ Output #0n failed: ${error.message}`);
        return false;
    }
}

// DEPRECATED: Old function kept for backwards compatibility (will be removed)
async function sendToAllWebhooks(payload, options = {}, messageDbId = null, mediaData = null, bridgeId = null, tenantSchema = null, tenantClient = null) {
    try {
        if (!bridgeId || !tenantSchema || !tenantClient) {
            console.error('❌ sendToAllWebhooks called without required parameters (bridgeId, tenantSchema, tenantClient)');
            return;
        }
        
        // CRITICAL FIX: Use tenantClient instead of pool for tenant-scoped queries
        const bridgeResult = await tenantClient.query(`
            SELECT output_credentials FROM bridges WHERE id = $1 LIMIT 1
        `, [bridgeId]);
        
        if (bridgeResult.rows.length === 0) {
            console.error(`❌ No bridge configuration found for bridge ${bridgeId} in ${tenantSchema}`);
            return;
        }
        
        const webhooks = bridgeResult.rows[0].output_credentials?.webhooks || [];
        const threadName = bridgeResult.rows[0].output_credentials?.thread_name;
        let threadId = bridgeResult.rows[0].output_credentials?.thread_id;
        
        // IMMUTABILITY LOCK: Identify Nyanbook Ledger webhook (dbA = eternal monolith)
        const NYANBOOK_WEBHOOK_NAME = 'Nyanbook Ledger';
        
        // Fallback to legacy webhook_url if webhooks array is empty
        if (webhooks.length === 0 && bridgeResult.rows[0].output_credentials?.webhook_url) {
            webhooks.push({
                name: 'Main Channel',
                url: bridgeResult.rows[0].output_credentials.webhook_url
            });
        }
        
        if (webhooks.length === 0) {
            throw new Error('No Discord webhook configured. Add webhook URL in bridge settings.');
        }
        
        // Prepare payload for Discord thread
        const enhancedPayload = {
            ...payload,
            ...(threadName && !threadId && { thread_name: threadName })
        };
        
        // Send to all webhooks
        let successCount = 0;
        let failures = [];
        
        for (const webhook of webhooks) {
            if (!webhook.url) continue;
            
            // IMMUTABILITY CHECK: Is this the Nyanbook Ledger webhook (dbA)?
            const isNyanbookLedger = webhook.name === NYANBOOK_WEBHOOK_NAME;
            
            try {
                // Build Discord webhook URL with proper query parameters
                const url = new URL(webhook.url);
                
                // Add wait=true to get Discord response (needed to capture thread_id)
                url.searchParams.set('wait', 'true');
                
                // Add thread_id if available (for persistent thread targeting)
                if (threadId) {
                    url.searchParams.set('thread_id', threadId);
                }
                
                const webhookUrl = url.toString();
                let response;
                
                // For media messages, create fresh FormData for each webhook (streams are single-use)
                if (options.isMedia && options.mediaBuffer) {
                    const FormData = require('form-data');
                    const form = new FormData();
                    
                    // Create a new buffer for each webhook to avoid stream consumption issues
                    const freshBuffer = Buffer.from(options.mediaBuffer);
                    
                    form.append('file', freshBuffer, {
                        filename: options.filename,
                        contentType: options.mimetype
                    });
                    
                    form.append('payload_json', JSON.stringify(enhancedPayload));
                    
                    response = await axios.post(webhookUrl, form, {
                        headers: form.getHeaders()
                    });
                } else {
                    // For text-only messages, send JSON payload directly
                    response = await axios.post(webhookUrl, enhancedPayload);
                }
                
                // IMMUTABILITY LOCK: ONLY capture thread_id from Nyanbook Ledger webhook (dbA)
                // User webhooks (dbB) are mutable and ignored - this preserves eternal monolith
                if (isNyanbookLedger && !threadId && response.data && response.data.channel_id && threadName) {
                    threadId = response.data.channel_id;
                    console.log(`  🔒 NYANBOOK THREAD LOCKED: ${threadId} (bridge ${bridgeId})`);
                    
                    // Update bridge output_credentials with thread_id from Nyanbook Ledger only
                    await tenantClient.query(`
                        UPDATE bridges 
                        SET output_credentials = jsonb_set(output_credentials, '{thread_id}', to_jsonb($1::text))
                        WHERE id = $2
                    `, [threadId, bridgeId]);
                }
                
                successCount++;
                console.log(`  ✅ Sent to Discord: ${webhook.name || webhook.url.substring(0, 50)}`);
            } catch (error) {
                const errorMsg = `Failed to send to ${webhook.name || 'Discord'}: ${error.message}`;
                failures.push(errorMsg);
                console.error(`  ❌ ${errorMsg}`);
            }
        }
        
        // Update message status based on results
        if (messageDbId) {
            // DEAD CODE REMOVED: updateMessageStatus calls
            // Messages tracked in Discord only, no PostgreSQL status updates needed
        }
        
        console.log(`📤 Sent to ${successCount}/${webhooks.length} Discord webhooks`);
        
    } catch (error) {
        console.error('❌ Error sending to Discord:', error.message);
        // DEAD CODE REMOVED: updateMessageStatus call
        throw error;
    }
}

async function saveMessage(client, message, bridgeId = 1) {
    // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
    // This function is kept for backward compatibility but does nothing
    // Discord threads provide permanent storage, search, and UI at zero cost
    return null;
}

// DEAD CODE REMOVED: updateMessageStatus, getMessages, getMessageStats
// REASON: Messages stored ONLY in Discord (not PostgreSQL)
// Discord threads provide permanent storage, search, and message management
// No PostgreSQL messages table exists in tenant schemas

// Manager initialization moved to app.listen() to prevent race conditions
// This ensures managers are fully initialized before server accepts requests

/**
 * Get the tenant schema that owns a specific bridge
 * This ensures bridge activities are tracked in the correct tenant's database
 * 
 * FRACTALIZED ID VERSION: Parses fractal_id to extract tenant (no database query needed!)
 */
async function getBridgeTenantSchema(fractalIdOrLegacyId) {
    try {
        // Try parsing as fractalized ID first (e.g., bridge_t6_abc123 or dev_bridge_t1_abc123)
        const parsed = fractalId.parse(fractalIdOrLegacyId);
        if (parsed && parsed.tenantId) {
            const tenantSchema = `tenant_${parsed.tenantId}`;
            console.log(`✅ Parsed fractal_id: Bridge belongs to ${tenantSchema}`);
            return tenantSchema;
        }
        
        // Fallback: Legacy numeric ID - query database (slow path for backward compatibility)
        const legacyId = parseInt(fractalIdOrLegacyId);
        if (!isNaN(legacyId)) {
            console.warn(`⚠️ Using legacy bridge ID ${legacyId} - querying database (slow)`);
            const schemasResult = await pool.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);
            
            for (const row of schemasResult.rows) {
                const schema = row.schema_name;
                const bridgeCheck = await pool.query(`
                    SELECT id FROM ${schema}.bridges WHERE id = $1
                `, [legacyId]);
                
                if (bridgeCheck.rows.length > 0) {
                    console.log(`✅ Legacy bridge ${legacyId} belongs to ${schema}`);
                    return schema;
                }
            }
        }
        
        // Fallback to public if not found (shouldn't happen)
        console.warn(`⚠️ Bridge ${fractalIdOrLegacyId} not found, defaulting to public`);
        return 'public';
    } catch (error) {
        console.error(`❌ Error finding tenant for bridge ${fractalIdOrLegacyId}:`, error);
        return 'public';
    }
}

/**
 * Tenant-aware WhatsApp message handler
 * Routes messages to the correct tenant's schema based on bridgeId
 */
async function createTenantAwareMessageHandler(message, bridgeId, tenantSchema) {
    let messageDbId = null;
    
    try {
        // Get tenant-scoped database client
        const tenantClient = await pool.connect();
        try {
            await tenantClient.query('BEGIN');
            await tenantClient.query(`SET LOCAL search_path TO ${tenantSchema}`);
            
            const chat = await message.getChat();
            const contact = await message.getContact();
            
            // NYANBOOK = PERSONAL DIARY: Forward ALL non-group messages (including messages from self)
            // Only filter: Group messages (to prevent spam)
            const shouldForward = !chat.isGroup;
            if (!shouldForward) {
                await tenantClient.query('ROLLBACK');
                tenantClient.release();
                return;
            }
            
            const chatName = chat.name || contact.pushname || contact.number;
            const senderName = contact.pushname || contact.number;
            const senderContact = contact.number || contact.id.user;
            const timestamp = new Date(message.timestamp * 1000);
            const messageContent = message.body || '';
            
            // Get sender's profile picture URL
            let senderPhotoUrl = null;
            try {
                senderPhotoUrl = await contact.getProfilePicUrl();
            } catch (error) {
                // Silently fail if no profile picture
            }
            
            const messageRecord = {
                id: message.id._serialized,
                senderName,
                senderContact,
                chatName,
                messageContent,
                hasMedia: message.hasMedia,
                mediaType: null, // Will be set after downloadMedia()
                mediaData: null,
                senderPhotoUrl,
                timestamp: timestamp.toISOString(),
                discordStatus: 'pending'
            };
            
            // Save message to tenant's schema
            messageDbId = await saveMessage(tenantClient, messageRecord, bridgeId);
            
            // CRITICAL FIX: Commit immediately to prevent idle-in-transaction timeout
            // Media downloads and webhook sends can take 10+ seconds
            await tenantClient.query('COMMIT');
            tenantClient.release();
            
            // Fetch bridge data for output routing (WEBHOOK-FIRST: need webhook URLs)
            const bridgeClient = await pool.connect();
            let bridge;
            try {
                await bridgeClient.query(`SET LOCAL search_path TO ${tenantSchema}`);
                
                // CRITICAL DEBUG: Verify search_path is set correctly
                const schemaCheck = await bridgeClient.query('SELECT current_schema()');
                console.log(`🔍 SCHEMA CHECK: Current schema = ${schemaCheck.rows[0].current_schema}, expected = ${tenantSchema}`);
                
                const bridgeResult = await bridgeClient.query(
                    `SELECT id, output_01_url, output_0n_url, output_credentials FROM ${tenantSchema}.bridges WHERE id = $1`,
                    [bridgeId]
                );
                bridge = bridgeResult.rows[0];
                
                console.log(`🔍 DEBUG: Loaded bridge from DB:`, {
                    schema: tenantSchema,
                    id: bridge?.id,
                    output_01_url: bridge?.output_01_url?.substring(0, 70),
                    output_0n_url: bridge?.output_0n_url?.substring(0, 70),
                    credentials_type: typeof bridge?.output_credentials
                });
                
                // Parse JSON if needed (PostgreSQL returns JSON as string sometimes)
                if (bridge && typeof bridge.output_credentials === 'string') {
                    bridge.output_credentials = JSON.parse(bridge.output_credentials);
                }
            } finally {
                bridgeClient.release();
            }
            
            // Create Discord embed
            const embed = {
                title: `📱 WhatsApp Message from ${senderName}`,
                description: messageContent || '_(No text content)_',
                color: 0x25D366,
                fields: [
                    {
                        name: '💬 Chat',
                        value: chatName,
                        inline: true
                    },
                    {
                        name: '🕐 Time',
                        value: timestamp.toLocaleString(),
                        inline: true
                    }
                ],
                footer: {
                    text: `WhatsApp Bridge - Bridge ${bridgeId}`
                }
            };

            const discordPayload = {
                username: 'WhatsApp Bridge',
                avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg',
                embeds: [embed]
            };

            // CRITICAL MEDIA FLOW: WhatsApp → Buffer → PostgreSQL → Discord Webhooks
            // Purpose: Ensure zero media loss with retry-safe atomic storage
            // SUPPORTS ALL FORMATS: Photos, videos, audio, PDFs, Excel, Word, stickers, etc.
            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    if (media) {
                        // ✅ FULL ATTACHMENT SUPPORT: Accept ALL MIME types
                        // Baileys downloadMedia() handles everything WhatsApp sends
                        const base64Data = media.data; // Already base64 from Baileys
                        const fileExtension = getFileExtension(media.mimetype);
                        const mediaCategory = media.mimetype.split('/')[0]; // image, video, audio, application
                        const filename = `whatsapp_${mediaCategory}_${Date.now()}.${fileExtension}`;
                        
                        // ATOMIC COMMIT: Save media to buffer BEFORE webhook delivery
                        // This ensures retry safety - if webhook fails, media is still in DB
                        const mediaClient = await pool.connect();
                        let mediaBufferId = null;
                        try {
                            await mediaClient.query('BEGIN');
                            await mediaClient.query(`SET LOCAL search_path TO ${tenantSchema}`);
                            const result = await mediaClient.query(`
                                INSERT INTO media_buffer (
                                    bridge_id, media_data, media_type, filename, sender_name
                                ) VALUES ($1, $2, $3, $4, $5)
                                RETURNING id
                            `, [bridgeId, Buffer.from(base64Data, 'base64'), media.mimetype, filename, senderName]);
                            mediaBufferId = result.rows[0].id;
                            await mediaClient.query('COMMIT');
                            console.log(`💾 [Bridge ${bridgeId}] Media saved to buffer: ${media.mimetype} (ID: ${mediaBufferId})`);
                        } catch (err) {
                            await mediaClient.query('ROLLBACK');
                            console.error(`❌ Failed to save media to buffer:`, err.message);
                            throw err;
                        } finally {
                            mediaClient.release();
                        }
                        
                        // Smart attachment description based on MIME type
                        let attachmentEmoji = '📎';
                        let attachmentType = mediaCategory.toUpperCase();
                        if (media.mimetype.includes('pdf')) {
                            attachmentEmoji = '📄';
                            attachmentType = 'PDF Document';
                        } else if (media.mimetype.includes('word') || media.mimetype.includes('document')) {
                            attachmentEmoji = '📝';
                            attachmentType = 'Word Document';
                        } else if (media.mimetype.includes('excel') || media.mimetype.includes('spreadsheet')) {
                            attachmentEmoji = '📊';
                            attachmentType = 'Excel Spreadsheet';
                        } else if (media.mimetype.includes('powerpoint') || media.mimetype.includes('presentation')) {
                            attachmentEmoji = '📽️';
                            attachmentType = 'PowerPoint Presentation';
                        } else if (media.mimetype === 'image/webp') {
                            attachmentEmoji = '🎨';
                            attachmentType = 'Sticker';
                        }
                        
                        embed.fields.push({
                            name: `${attachmentEmoji} Attachment`,
                            value: `${attachmentType} (${media.mimetype})`,
                            inline: false
                        });
                        
                        // WEBHOOK-FIRST ARCHITECTURE: Dual-output delivery from media_buffer
                        const threadName = bridge.output_credentials?.thread_name;
                        const threadId = bridge.output_credentials?.thread_id;
                        
                        // Path 1: Nyanbook Ledger (Output #01) - reads from media_buffer
                        await sendToLedger(discordPayload, {
                            isMedia: true,
                            mediaBufferId: mediaBufferId,
                            tenantSchema: tenantSchema,
                            threadName,
                            threadId
                        }, bridge);
                        
                        // Path 2: User Webhook (Output #0n) - reads from media_buffer
                        await sendToUserOutput(discordPayload, {
                            isMedia: true,
                            mediaBufferId: mediaBufferId,
                            tenantSchema: tenantSchema
                        }, bridge);
                        
                        console.log(`✅ [Bridge ${bridgeId}] Forwarded ${attachmentType}: ${filename} from ${senderName}`);
                        return;
                    }
                } catch (mediaError) {
                    console.error(`❌ [Bridge ${bridgeId}] Error in media flow:`, mediaError.message);
                    return;
                }
            }

            // WEBHOOK-FIRST ARCHITECTURE: Dual-output delivery  
            // Output #01: Nyanbook Ledger (eternal, Dev #01 only)
            // Output #0n: User Discord (mutable, Admin #0n only)
            const threadName = bridge.output_credentials?.thread_name;
            const threadId = bridge.output_credentials?.thread_id;
            
            // Path 1: Nyanbook Ledger (Output #01)
            await sendToLedger(discordPayload, {
                threadName,
                threadId
            }, bridge);
            
            // Path 2: User Webhook (Output #0n)
            await sendToUserOutput(discordPayload, {}, bridge);
            
            console.log(`✅ [Bridge ${bridgeId}] Forwarded message from ${senderName}`);
        } catch (error) {
            // Transaction already committed/released above, so no ROLLBACK needed
            throw error;
        }
    } catch (error) {
        console.error(`❌ [Bridge ${bridgeId}] Error handling message:`, error.message);
        // DEAD CODE REMOVED: updateMessageStatus call
        // Messages tracked in Discord only, no PostgreSQL status updates needed
    }
}

// ============ MULTI-TENANT WHATSAPP - LEGACY FUNCTION REMOVED ============
// The old global initializeWhatsAppClient() has been replaced with bot-level management.
// Each bridge now gets its own WhatsApp session via the WhatsAppClientManager.
// See createTenantAwareMessageHandler() above and API endpoints below.

// Legacy compatibility: Remove old session directory if it exists
function cleanupLegacySession() {
    const legacyPath = './.wwebjs_auth/session';
    if (fs.existsSync(legacyPath)) {
        console.log('🧹 Cleaning up legacy WhatsApp session...');
        fs.rmSync(legacyPath, { recursive: true, force: true });
        console.log('✅ Legacy session cleaned');
    }
}

cleanupLegacySession();

// OLD initializeWhatsAppClient() function removed - replaced with per-bridge management
// See bot-level API endpoints below: POST /api/bots/:id/start, DELETE /api/bots/:id/stop, etc.
// Each bridge now has its own independent WhatsApp session managed by WhatsAppClientManager

// ============ SESSION TRACKING SYSTEM ============

// Parse user agent to extract device, browser, and OS
function parseUserAgent(userAgent) {
    const ua = userAgent || '';
    
    // Detect device type
    let deviceType = 'Desktop';
    if (/Mobile|Android|iPhone|iPod/i.test(ua)) deviceType = 'Mobile';
    else if (/iPad|Tablet/i.test(ua)) deviceType = 'Tablet';
    
    // Detect browser
    let browser = 'Unknown';
    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';
    
    // Detect OS
    let os = 'Unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iOS|iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    
    return { deviceType, browser, os };
}

// Simple location detection from IP (basic implementation)
async function getLocationFromIP(ipAddress) {
    try {
        // For local/private IPs, return Unknown
        if (!ipAddress || ipAddress === '::1' || ipAddress.startsWith('127.') || ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.')) {
            return 'Local Network';
        }
        
        // Use free ipapi.co service for geolocation (no API key needed)
        const response = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
            timeout: 3000 // 3 second timeout
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.city && data.country_name) {
                return `${data.city}, ${data.country_name}`;
            } else if (data.country_name) {
                return data.country_name;
            }
        }
        
        return 'Unknown Location';
    } catch (error) {
        console.error('Error getting location:', error.message);
        return 'Unknown Location';
    }
}

// Create session tracking record (multi-tenant)
async function createSessionRecord(userId, sessionId, req, tenantSchema) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const location = await getLocationFromIP(req.ip);
        
        // Use tenant-scoped active_sessions table
        await pool.query(`
            INSERT INTO ${tenantSchema}.active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [userId, sessionId, req.ip, userAgent, deviceType, browser, os, location]);
        
        console.log(`[${getTimestamp()}] 📱 Session created - User: ${userId}, Device: ${deviceType}, Browser: ${browser}, OS: ${os}, IP: ${req.ip}, Location: ${location}`);
    } catch (error) {
        console.error('Error creating session record:', error.message);
    }
}

// ============ AUDIT LOGGING SYSTEM ============

// Helper function to log audit events (multi-tenant)
async function logAudit(client, req, actionType, targetType, targetId, targetEmail, details = {}, tenantSchema = null) {
    try {
        // AUDIT FIX: Use req.userId (from requireAuth) first, fallback to session
        // This prevents audit gaps when session is destroyed during logout
        const actorUserId = req.userId || req.session?.userId || null;
        let actorEmail = req.userEmail || null;
        
        // Auto-detect tenant schema from req.tenantSchema if not provided
        const schema = tenantSchema || req.tenantSchema;
        
        if (!schema) {
            console.warn('⚠️ Audit logging skipped - no tenant schema available');
            return;
        }
        
        // Fetch email if we have userId but not email (from tenant-scoped users table)
        if (actorUserId && !actorEmail) {
            const userResult = await client.query(`SELECT email FROM ${schema}.users WHERE id = $1`, [actorUserId]);
            actorEmail = userResult.rows[0]?.email || null;
        }
        
        // Use tenant-scoped audit_logs table
        await client.query(`
            INSERT INTO ${schema}.audit_logs (
                actor_user_id, action_type, target_type, 
                target_id, details, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            actorUserId,
            actionType,
            targetType,
            targetId,
            JSON.stringify(details),
            req.ip || req.connection?.remoteAddress || 'unknown',
            req.get('user-agent') || 'unknown'
        ]);
    } catch (error) {
        console.error('Audit logging failed:', error);
        // Don't throw - audit logging failure shouldn't break the main operation
    }
}

// ============ AUTHENTICATION MIDDLEWARE ============

// Middleware to check if user is authenticated (supports both JWT and cookies)
async function requireAuth(req, res, next) {
    // Try JWT authentication first (Authorization header)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = authService.verifyToken(token);
        
        if (decoded && decoded.type === 'access') {
            // Valid JWT token - set user context from JWT payload
            req.userId = decoded.userId;
            req.userEmail = decoded.email;
            req.userRole = decoded.role;
            req.tenantId = decoded.tenantId;
            req.tenantSchema = `tenant_${decoded.tenantId}`; // CRITICAL: Set tenant schema for multi-tenant isolation
            req.authMethod = 'jwt';
            return next();
        } else {
            // SECURITY: Invalid JWT present - do NOT fall back to session
            // An attacker could send a bad JWT to bypass token revocation
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }
    
    // Fall back to cookie-based session auth (only if no JWT provided)
    if (req.session && req.session.userId) {
        // Lookup email → tenant mapping for session-based auth
        try {
            const mappingResult = await pool.query(
                'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                [req.session.userEmail]
            );
            
            if (mappingResult.rows.length === 0) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            const { tenant_id, tenant_schema } = mappingResult.rows[0];
            
            req.userId = req.session.userId;
            req.userEmail = req.session.userEmail;
            req.userRole = req.session.userRole;
            req.tenantId = tenant_id;
            req.tenantSchema = tenant_schema;
            req.authMethod = 'cookie';
            return next();
        } catch (error) {
            console.error('Session auth error:', error);
            return res.status(500).json({ error: 'Authentication failed' });
        }
    }
    
    // No valid authentication found
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    // Redirect to login page for browser requests
    return res.redirect('/login.html');
}

// Middleware to check roles with hierarchy: dev > admin > user
function requireRole(...allowedRoles) {
    return async (req, res, next) => {
        if (!req.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        // Get tenant schema from tenant mapping
        const mappingResult = await pool.query(
            'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
            [req.userEmail]
        );
        
        if (mappingResult.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const { tenant_schema } = mappingResult.rows[0];
        
        // Query user role from tenant-scoped table
        const result = await pool.query(
            `SELECT role FROM ${tenant_schema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const userRole = result.rows[0].role;
        
        // Role hierarchy: dev > admin > user
        // Dev has access to everything
        if (userRole === 'dev') {
            req.userRole = userRole;
            return next();
        }
        
        // Admin has access to admin and user endpoints
        if (userRole === 'admin' && (allowedRoles.includes('admin') || allowedRoles.includes('user'))) {
            req.userRole = userRole;
            return next();
        }
        
        // Otherwise check exact match
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.userRole = userRole;
        next();
    };
}

// ============ AUTHENTICATION ROUTES ============

// Check if user is logged in (supports both JWT and cookies) - TENANT-AWARE
app.get('/api/auth/status', async (req, res) => {
    try {
        // Check JWT first
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = authService.verifyToken(token);
            
            if (decoded && decoded.type === 'access') {
                // Get tenant from JWT and query tenant_X.users
                const mappingResult = await pool.query(
                    'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [decoded.email]
                );
                
                if (mappingResult.rows.length > 0) {
                    const { tenant_schema } = mappingResult.rows[0];
                    const result = await pool.query(
                        `SELECT id, email, role, google_id FROM ${tenant_schema}.users WHERE id = $1`,
                        [decoded.userId]
                    );
                    
                    if (result.rows.length > 0) {
                        return res.json({ authenticated: true, user: result.rows[0], authMethod: 'jwt' });
                    }
                }
            }
        }
        
        // Fall back to session
        if (req.session && req.session.userId && req.session.userEmail) {
            const mappingResult = await pool.query(
                'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                [req.session.userEmail]
            );
            
            if (mappingResult.rows.length > 0) {
                const { tenant_schema } = mappingResult.rows[0];
                const result = await pool.query(
                    `SELECT id, email, role, google_id FROM ${tenant_schema}.users WHERE id = $1`,
                    [req.session.userId]
                );
                
                if (result.rows.length > 0) {
                    return res.json({ authenticated: true, user: result.rows[0], authMethod: 'cookie' });
                }
            }
        }
        
        res.json({ authenticated: false });
    } catch (error) {
        console.error('Auth status error:', error);
        res.json({ authenticated: false });
    }
});

// Email/Password Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    // Log all login attempts
    console.log(`[${getTimestamp()}] 🔐 Login attempt - Email: ${email}, IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    
    try {
        // Validate input before normalization
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Normalize email for case-insensitive lookup
        const normalizedEmail = email.toLowerCase().trim();
        
        // Lookup email → tenant mapping
        const mappingResult = await pool.query(
            'SELECT tenant_id, tenant_schema, user_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
            [normalizedEmail]
        );
        
        if (mappingResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const { tenant_schema, user_id } = mappingResult.rows[0];
        
        // Query user from tenant-scoped table
        const result = await pool.query(
            `SELECT * FROM ${tenant_schema}.users WHERE id = $1 AND LOWER(email) = $2`,
            [user_id, normalizedEmail]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        req.session.userId = user.id;
        req.session.userEmail = user.email;
        req.session.userRole = user.role;
        req.session.tenantId = user.tenant_id;
        
        // Generate JWT tokens with full tenant context
        const adminId = user.is_genesis_admin ? '01' : null;
        const accessToken = authService.signAccessToken(
            user.id, 
            user.email, 
            user.role,
            user.tenant_id,
            adminId,
            user.is_genesis_admin
        );
        const { token: refreshToken, tokenId } = authService.signRefreshToken(
            user.id, 
            user.email, 
            user.role,
            user.tenant_id,
            adminId,
            user.is_genesis_admin
        );
        
        // Store refresh token in tenant-scoped database
        const deviceInfo = req.get('user-agent') || 'unknown';
        await authService.storeRefreshToken(pool, tenant_schema, user.id, tokenId, deviceInfo, req.ip);
        
        // Save session explicitly before sending response
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(user.id, req.sessionID, req, tenant_schema);
            
            // Log successful login
            logAudit(pool, req, 'LOGIN', 'USER', user.id.toString(), user.email, {
                method: 'email_password',
                role: user.role,
                authType: 'jwt+cookie'
            }, tenant_schema);
            
            console.log(`[${getTimestamp()}] ✅ Login successful - User: ${user.email}, SessionID: ${req.sessionID}, JWT issued`);
            
            res.json({ 
                success: true,
                user: { 
                    id: user.id, 
                    email: user.email, 
                    role: user.role 
                },
                // JWT tokens for token-based auth
                accessToken,
                refreshToken,
                tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check if next signup would be the genesis user (first user)
app.get('/api/auth/check-genesis', async (req, res) => {
    try {
        // Multi-tenant: Check tenant_catalog instead of public.users
        const tenantCount = await pool.query('SELECT COUNT(*) FROM core.tenant_catalog');
        const isFirstUser = parseInt(tenantCount.rows[0].count) === 0;
        res.json({ isFirstUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Public Signup Endpoint - Handles both new tenant creation and invite-based signup
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, inviteToken } = req.body;
    
    console.log(`[${getTimestamp()}] 📝 Signup attempt - Email: ${email}, IP: ${req.ip}, HasInvite: ${!!inviteToken}`);
    
    try {
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        // Normalize email to lowercase for case-insensitive uniqueness
        const normalizedEmail = email.toLowerCase().trim();
        
        // CRITICAL: Email uniqueness gatefencing - check BEFORE any writes
        // Read-Check-Bounce pattern to enforce one email = one tenant globally
        const emailCheck = await pool.query(
            'SELECT tenant_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
            [normalizedEmail]
        );
        if (emailCheck.rows.length > 0) {
            console.log(`[${getTimestamp()}] 🚫 Signup blocked - Email already exists in tenant ${emailCheck.rows[0].tenant_id}`);
            return res.status(409).json({ error: 'Email already registered' });
        }
        
        let newUser;
        let isGenesisAdmin = false;
        let tenantId = null;
        
        // BRANCH: Invite-based signup (join existing tenant)
        if (inviteToken) {
            const validation = await tenantManager.validateInviteToken(inviteToken);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.reason });
            }
            
            const invite = validation.invite;
            const passwordHash = await bcrypt.hash(password, 10);
            
            // Create user with invite's target role and tenant
            const result = await pool.query(`
                INSERT INTO users (email, password_hash, role, tenant_id, is_genesis_admin)
                VALUES ($1, $2, $3, $4, false)
                RETURNING id, email, role, tenant_id, is_genesis_admin
            `, [normalizedEmail, passwordHash, invite.target_role, invite.tenant_id]);
            
            newUser = result.rows[0];
            tenantId = invite.tenant_id;
            
            // Consume the invite token
            await tenantManager.consumeInviteToken(inviteToken);
            
            console.log(`[${getTimestamp()}] ✅ User joined tenant ${tenantId} via invite - Email: ${email}, Role: ${invite.target_role}`);
        }
        // BRANCH: Fractalized multi-tenant signup (no invite needed)
        else {
            // Check if this is the FIRST user ever (Genesis Admin #01)
            const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
            const isFirstUser = userCountResult.rows[0].count === '0';
            
            // Check Sybil attack prevention
            const sybilCheck = await tenantManager.checkSybilRisk(email, req.ip);
            if (!sybilCheck.allowed) {
                console.log(`[${getTimestamp()}] 🚫 Sybil protection blocked - Email: ${email}, Reason: ${sybilCheck.reason}`);
                return res.status(429).json({ error: sybilCheck.reason });
            }
            
            // Check rate limits
            const rateLimitEmail = await tenantManager.checkRateLimit('tenant_creation', 'email', email);
            if (!rateLimitEmail.allowed) {
                return res.status(429).json({ error: rateLimitEmail.reason });
            }
            
            const rateLimitIP = await tenantManager.checkRateLimit('tenant_creation', 'ip', req.ip);
            if (!rateLimitIP.allowed) {
                return res.status(429).json({ error: rateLimitIP.reason });
            }
            
            const passwordHash = await bcrypt.hash(password, 10);
            
            // FIRST USER EVER: Dev #01 (Genesis Admin with God view to dbA)
            // SUBSEQUENT USERS: Admin #0n (fractalized tenant with their own dbB)
            const userRole = isFirstUser ? 'dev' : 'admin';
            const isGenesis = isFirstUser;
            
            const result = await pool.query(`
                INSERT INTO users (email, password_hash, role, is_genesis_admin)
                VALUES ($1, $2, $3, $4)
                RETURNING id, email, role, is_genesis_admin
            `, [normalizedEmail, passwordHash, userRole, isGenesis]);
            
            newUser = result.rows[0];
            
            // Create new fractalized tenant schema for this user
            const tenant = await tenantManager.createTenant(newUser.id);
            tenantId = tenant.tenantId;
            
            // Record tenant creation for Sybil tracking
            await tenantManager.recordTenantCreation(email, req.ip);
            
            isGenesisAdmin = isGenesis;
            
            if (isGenesis) {
                console.log(`[${getTimestamp()}] 🌟 GENESIS ADMIN #01 created - Email: ${email}, Tenant: ${tenantId} (Dev with God view)`);
            } else {
                console.log(`[${getTimestamp()}] ✅ Admin #0${tenantId} created - Email: ${email}, Tenant: ${tenantId} (Fractalized)`);
            }
        }
        
        // Auto-login after signup
        req.session.userId = newUser.id;
        req.session.userEmail = newUser.email;
        req.session.userRole = newUser.role;
        req.session.tenantId = tenantId;
        
        // Generate JWT tokens
        const accessToken = authService.signAccessToken(newUser.id, newUser.email, newUser.role);
        const { token: refreshToken, tokenId } = authService.signRefreshToken(newUser.id, newUser.email, newUser.role);
        
        // Store refresh token
        const deviceInfo = req.get('user-agent') || 'unknown';
        await authService.storeRefreshToken(pool, newUser.id, tokenId, deviceInfo, req.ip);
        
        // Save session
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(newUser.id, req.sessionID, req);
            
            // Log signup
            logAudit(pool, req, 'SIGNUP', 'USER', newUser.id.toString(), newUser.email, {
                role: newUser.role,
                is_genesis_admin: isGenesisAdmin,
                tenant_id: tenantId,
                via_invite: !!inviteToken
            });
            
            res.json({
                success: true,
                user: {
                    id: newUser.id,
                    email: newUser.email,
                    role: newUser.role,
                    tenantId: tenantId,
                    isGenesisAdmin
                },
                accessToken,
                refreshToken,
                message: isGenesisAdmin 
                    ? '🌟 Welcome! You are a Genesis Admin with your own isolated database.' 
                    : 'Account created successfully. Welcome to the team!'
            });
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Signup failed: ' + error.message });
    }
});

// Google OAuth removed - email/password authentication only

// ===========================
// INVITE MANAGEMENT API
// ===========================

// Create invite token (admin only)
app.post('/api/invites', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'dev') {
            return res.status(403).json({ error: 'Only admins can create invites' });
        }
        
        const { targetRole = 'read-only', expiresInDays = 7, maxUses = 1 } = req.body;
        
        // Validate target role
        if (!['admin', 'read-only', 'write-only'].includes(targetRole)) {
            return res.status(400).json({ error: 'Invalid target role' });
        }
        
        const tenantContext = await tenantManager.getTenantContext(req.user.id);
        if (!tenantContext || !tenantContext.tenant_id) {
            return res.status(400).json({ error: 'User not associated with a tenant' });
        }
        
        const token = await tenantManager.generateInviteToken(
            tenantContext.tenant_id,
            req.user.id,
            targetRole,
            expiresInDays,
            maxUses
        );
        
        logAudit(pool, req, 'CREATE_INVITE', 'INVITE', token, req.user.email, {
            tenant_id: tenantContext.tenant_id,
            target_role: targetRole,
            expires_in_days: expiresInDays,
            max_uses: maxUses
        });
        
        // Generate full invite URL
        const baseUrl = `https://${req.get('host')}`;
        const inviteUrl = `${baseUrl}/signup.html?invite=${token}`;
        
        res.json({ 
            success: true, 
            token,
            inviteUrl,
            expiresInDays,
            maxUses,
            targetRole
        });
    } catch (error) {
        console.error('Create invite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Validate invite token (public)
app.get('/api/invites/validate/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const validation = await tenantManager.validateInviteToken(token);
        
        if (validation.valid) {
            res.json({
                valid: true,
                targetRole: validation.invite.target_role,
                remainingUses: validation.invite.max_uses - validation.invite.current_uses,
                expiresAt: validation.invite.expires_at
            });
        } else {
            res.json({
                valid: false,
                reason: validation.reason
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List invites for current tenant (admin only)
app.get('/api/invites', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'dev') {
            return res.status(403).json({ error: 'Only admins can list invites' });
        }
        
        const tenantContext = await tenantManager.getTenantContext(req.user.id);
        if (!tenantContext || !tenantContext.tenant_id) {
            return res.status(400).json({ error: 'User not associated with a tenant' });
        }
        
        const result = await pool.query(`
            SELECT id, token, created_by_user_id, expires_at, max_uses, current_uses, 
                   target_role, status, created_at
            FROM core.invites
            WHERE tenant_id = $1
            ORDER BY created_at DESC
        `, [tenantContext.tenant_id]);
        
        res.json({ invites: result.rows });
    } catch (error) {
        console.error('List invites error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke invite (admin only)
app.delete('/api/invites/:id', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'dev') {
            return res.status(403).json({ error: 'Only admins can revoke invites' });
        }
        
        const { id } = req.params;
        const tenantContext = await tenantManager.getTenantContext(req.user.id);
        
        await pool.query(`
            UPDATE core.invites
            SET status = 'revoked'
            WHERE id = $1 AND tenant_id = $2
        `, [id, tenantContext.tenant_id]);
        
        logAudit(pool, req, 'REVOKE_INVITE', 'INVITE', id, req.user.email, {
            tenant_id: tenantContext.tenant_id
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Revoke invite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Phone OTP auth removed - use email-based auth (/api/auth/register/public, /api/auth/login) for multi-tenant architecture

// Register new user (admin only)
app.post('/api/auth/register', requireRole('admin'), async (req, res) => {
    const { email, phone, password, role } = req.body;
    
    try {
        // SECURITY: Role hierarchy validation - prevent privilege escalation
        // Get the creator's role
        const creatorResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
        const creatorRole = creatorResult.rows[0]?.role;
        
        // Role creation rules:
        // - dev can create: dev, admin, read-only, write-only
        // - admin can create: read-only, write-only (NOT dev, NOT admin)
        // - read-only/write-only: blocked by requireRole middleware
        if (creatorRole === 'admin' && (role === 'dev' || role === 'admin')) {
            return res.status(403).json({ 
                error: 'Admins can only create read-only or write-only users. Contact a dev user to create admin accounts.',
                allowed_roles: ['read-only', 'write-only']
            });
        }
        
        // Validate role is one of the allowed values
        const validRoles = ['dev', 'admin', 'read-only', 'write-only'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role specified' });
        }
        
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        
        const result = await pool.query(`
            INSERT INTO users (email, phone, password_hash, role)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, phone, role
        `, [email || null, phone || null, passwordHash, role || 'read-only']);
        
        const newUser = result.rows[0];
        
        // Log user creation
        await logAudit(pool, req, 'CREATE_USER', 'USER', newUser.id.toString(), newUser.email || newUser.phone, {
            role: newUser.role,
            created_with: email ? 'email' : 'phone',
            created_by_role: creatorRole
        });
        
        res.json({ success: true, user: newUser });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ error: 'Email or phone already exists' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Token Refresh - Get new access token using refresh token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        
        if (!refreshToken) {
            return res.status(401).json({ error: 'Refresh token required' });
        }
        
        // Verify refresh token
        const decoded = authService.verifyToken(refreshToken);
        if (!decoded || decoded.type !== 'refresh') {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }
        
        // Get tenant schema from JWT tenantId
        const tenantSchema = `tenant_${decoded.tenantId}`;
        
        // Check if refresh token is still valid in tenant-scoped database
        const isValid = await authService.isRefreshTokenValid(pool, tenantSchema, decoded.tokenId, decoded.userId);
        if (!isValid) {
            return res.status(401).json({ error: 'Refresh token revoked or expired' });
        }
        
        // Generate new access token with full tenant context
        const accessToken = authService.signAccessToken(
            decoded.userId, 
            decoded.email, 
            decoded.role,
            decoded.tenantId,
            decoded.adminId,
            decoded.isGenesisAdmin
        );
        
        res.json({ 
            success: true,
            accessToken,
            tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logout (requires authentication)
app.post('/api/auth/logout', requireAuth, async (req, res) => {
    try {
        const userId = req.userId;
        const sessionId = req.sessionID;
        
        // Get tenant schema (from requireAuth middleware or construct from tenantId)
        const tenantSchema = req.tenantSchema || `tenant_${req.tenantId}`;
        
        // Revoke all refresh tokens for this user in tenant-scoped database (JWT logout)
        if (userId && tenantSchema) {
            await authService.revokeAllUserTokens(pool, tenantSchema, userId);
            
            // Mark session as inactive (cookie-based logout)
            if (sessionId) {
                await pool.query(`
                    UPDATE active_sessions 
                    SET is_active = FALSE
                    WHERE user_id = $1 AND session_id = $2
                `, [userId, sessionId]);
            }
        }
        
        // Log logout before destroying session
        await logAudit(pool, req, 'LOGOUT', 'USER', userId?.toString() || 'unknown', null, {});
        
        // Destroy session if it exists
        if (req.session) {
            req.session.destroy((err) => {
                if (err) {
                    return res.status(500).json({ error: 'Logout failed' });
                }
                res.json({ success: true });
            });
        } else {
            res.json({ success: true });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SESSION MANAGEMENT ROUTES ============

// Get all active sessions (admin only) with filtering and sorting
app.get('/api/sessions', requireRole('admin'), async (req, res) => {
    try {
        const { userId, sortBy = 'login_time', sortOrder = 'desc', filterDevice, filterBrowser, filterLocation } = req.query;
        
        let query = `
            SELECT 
                s.id, s.user_id, s.session_id, s.ip_address, s.user_agent,
                s.device_type, s.browser, s.os, s.location, s.login_time, s.last_activity,
                s.is_active,
                u.email, u.phone
            FROM active_sessions s
            LEFT JOIN users u ON s.user_id = u.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;
        
        // Filter by user ID
        if (userId) {
            query += ` AND s.user_id = $${paramCount}`;
            params.push(userId);
            paramCount++;
        }
        
        // Filter by device type
        if (filterDevice) {
            query += ` AND s.device_type = $${paramCount}`;
            params.push(filterDevice);
            paramCount++;
        }
        
        // Filter by browser
        if (filterBrowser) {
            query += ` AND s.browser = $${paramCount}`;
            params.push(filterBrowser);
            paramCount++;
        }
        
        // Filter by location (partial match)
        if (filterLocation) {
            query += ` AND s.location ILIKE $${paramCount}`;
            params.push(`%${filterLocation}%`);
            paramCount++;
        }
        
        // Add sorting
        const validColumns = ['login_time', 'last_activity', 'device_type', 'browser', 'ip_address', 'location'];
        const sortColumn = validColumns.includes(sortBy) ? sortBy : 'login_time';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY s.${sortColumn} ${order}`;
        
        const result = await pool.query(query, params);
        
        res.json({ sessions: result.rows });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke a specific session (admin only)
app.delete('/api/sessions/:id', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get session details before deletion for audit log
        const sessionResult = await pool.query(`
            SELECT user_id, session_id FROM active_sessions WHERE id = $1
        `, [id]);
        
        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const session = sessionResult.rows[0];
        
        // Mark session as inactive
        await pool.query(`
            UPDATE active_sessions SET is_active = FALSE WHERE id = $1
        `, [id]);
        
        // Destroy the actual session from sessions table
        await pool.query(`
            DELETE FROM sessions WHERE sid = $1
        `, [session.session_id]);
        
        // Log session revocation
        await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', id.toString(), null, {
            target_user_id: session.user_id,
            session_id: session.session_id
        });
        
        res.json({ success: true, message: 'Session revoked' });
    } catch (error) {
        console.error('Error revoking session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke all sessions for current user or all users (admin only)
app.post('/api/sessions/revoke-all', requireRole('admin'), async (req, res) => {
    try {
        const { userId } = req.body; // Optional: revoke all for specific user
        
        let sessionQuery;
        let params = [];
        
        if (userId) {
            // Revoke all sessions for specific user
            sessionQuery = 'SELECT session_id FROM active_sessions WHERE user_id = $1';
            params = [userId];
        } else {
            // Revoke ALL sessions for ALL users (except current session)
            sessionQuery = 'SELECT session_id FROM active_sessions WHERE session_id != $1';
            params = [req.sessionID];
        }
        
        const sessionsResult = await pool.query(sessionQuery, params);
        const sessionIds = sessionsResult.rows.map(row => row.session_id);
        
        if (sessionIds.length === 0) {
            return res.json({ success: true, message: 'No sessions to revoke', count: 0 });
        }
        
        // Mark all as inactive
        if (userId) {
            await pool.query(`
                UPDATE active_sessions SET is_active = FALSE WHERE user_id = $1
            `, [userId]);
        } else {
            await pool.query(`
                UPDATE active_sessions SET is_active = FALSE WHERE session_id != $1
            `, [req.sessionID]);
        }
        
        // Destroy all sessions from sessions table
        for (const sessionId of sessionIds) {
            await pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]);
        }
        
        // Log mass revocation
        await logAudit(pool, req, 'REVOKE_ALL_SESSIONS', 'SESSION', userId || 'all', null, {
            count: sessionIds.length,
            target_user_id: userId || 'all'
        });
        
        res.json({ 
            success: true, 
            message: `${sessionIds.length} session(s) revoked`,
            count: sessionIds.length
        });
    } catch (error) {
        console.error('Error revoking all sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Public registration (no auth required) - Multi-tenant architecture
app.post('/api/auth/register/public', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    
    try {
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Rate limit + sybil check
        const rateLimitCheck = await tenantManager.checkRateLimit('signup', 'email', email);
        if (!rateLimitCheck.allowed) {
            return res.status(429).json({ error: rateLimitCheck.reason });
        }

        const sybilCheck = await tenantManager.checkSybilRisk(email, ip);
        if (!sybilCheck.allowed) {
            return res.status(403).json({ error: sybilCheck.reason });
        }

        // Check if this is the first user (Genesis Admin)
        const tenantCountResult = await pool.query('SELECT COUNT(*) as count FROM core.tenant_catalog');
        const isGenesisAdmin = parseInt(tenantCountResult.rows[0].count) === 0;
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Create tenant + schema (which creates tenant_X.users table)
        const tempGenesisId = 0; // Placeholder ID (will be replaced after user creation)
        const { tenantId, schemaName } = await tenantManager.createTenant(tempGenesisId);

        // Insert genesis user into tenant_X.users
        const userResult = await pool.query(`
            INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, email, role, tenant_id, is_genesis_admin
        `, [email, passwordHash, isGenesisAdmin ? 'dev' : 'admin', tenantId, isGenesisAdmin]);

        const newUser = userResult.rows[0];

        // Insert email → tenant mapping for fast login lookups
        await pool.query(`
            INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (email) DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                tenant_schema = EXCLUDED.tenant_schema,
                user_id = EXCLUDED.user_id,
                updated_at = NOW()
        `, [email, tenantId, schemaName, newUser.id]);

        // Generate JWT tokens
        const accessToken = authService.signAccessToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            newUser.tenant_id,
            isGenesisAdmin ? '01' : null,
            newUser.is_genesis_admin
        );
        
        const refreshTokenData = authService.signRefreshToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            newUser.tenant_id,
            isGenesisAdmin ? '01' : null,
            newUser.is_genesis_admin
        );
        const refreshToken = refreshTokenData.token;

        // Record tenant creation for analytics
        await tenantManager.recordTenantCreation(email, ip);

        console.log(`${isGenesisAdmin ? '🌟 GENESIS ADMIN' : '👤 New admin'} created: ${email} (tenant_${tenantId})`);

        res.json({ 
            success: true, 
            user: {
                id: newUser.id,
                email: newUser.email,
                role: newUser.role,
                tenant_id: newUser.tenant_id,
                is_genesis_admin: newUser.is_genesis_admin
            },
            accessToken,
            refreshToken,
            message: isGenesisAdmin ? 'Genesis Admin created!' : 'Account created successfully!'
        });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Email already exists' });
        } else {
            console.error('❌ Registration error:', error);
            return res.status(500).json({ error: error.message || 'Internal server error' });
        }
    }
});

// Forgot password endpoints removed - use email-based auth for multi-tenant architecture

// ===========================
// DEV PANEL API (Admin Role Only)
// ===========================

// Get global Discord webhook (admin only)
app.get('/api/dev/webhook', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const webhook = getGlobalWebhook();
        res.json({ webhook_url: webhook || '' });
    } catch (error) {
        console.error('❌ Error fetching global webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set global Discord webhook (admin only)
app.post('/api/dev/webhook', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { webhook_url } = req.body;
        
        // Validate webhook URL
        if (!webhook_url || !webhook_url.trim()) {
            return res.status(400).send('Webhook URL is required');
        }
        
        if (!webhook_url.includes('discord.com/api/webhooks')) {
            return res.status(400).send('Invalid Discord webhook URL');
        }
        
        // Save webhook
        const success = await saveGlobalWebhook(webhook_url.trim());
        
        if (success) {
            // Log admin action
            await pool.query(`
                INSERT INTO audit_logs (actor, action, target, details, ip_address)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                req.userEmail || `user_${req.userId}`,
                'GLOBAL_WEBHOOK_UPDATE',
                'system',
                JSON.stringify({ webhook_preview: webhook_url.substring(0, 50) + '...' }),
                req.ip || req.connection?.remoteAddress || 'unknown'
            ]);
            
            res.send('OK');
        } else {
            res.status(500).send('Failed to save webhook');
        }
    } catch (error) {
        console.error('❌ Error saving global webhook:', error);
        res.status(500).send(error.message);
    }
});

// Get all bridges across all tenants (dev role only)
app.get('/api/dev/bridges', requireAuth, requireRole('dev'), async (req, res) => {
    try {
        // Use tenant schema from requireAuth middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // SECURITY CHECK: Dev Panel requires dev + genesis_admin
        const userResult = await pool.query(
            `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // Enforce security check: dev role + genesis_admin flag
        if (user.role !== 'dev' || !user.is_genesis_admin) {
            console.warn(`⚠️  SECURITY: User ${req.userId} attempted Dev Panel access without proper credentials`);
            console.warn(`   - Role: ${user.role} (needs: dev)`);
            console.warn(`   - Genesis Admin: ${user.is_genesis_admin} (needs: true)`);
            return res.status(403).json({ 
                error: 'Access denied. Dev Panel requires dev role + genesis_admin status.' 
            });
        }
        
        console.log('🔧 Dev Panel: Triple security check passed. Fetching all bridges across all tenants...');
        
        // Get all tenant schemas
        const tenantsResult = await pool.query(`
            SELECT 
                u.id as user_id,
                u.email,
                u.tenant_id,
                COUNT(DISTINCT CASE WHEN u2.tenant_id = u.tenant_id THEN u2.id END) as user_count
            FROM users u
            LEFT JOIN users u2 ON u2.tenant_id = u.tenant_id
            WHERE u.is_genesis_admin = true
            GROUP BY u.id, u.email, u.tenant_id
            ORDER BY u.tenant_id ASC
        `);
        
        const allBridges = [];
        
        // Query each tenant's bridges
        for (const tenant of tenantsResult.rows) {
            const tenantSchema = `tenant_${tenant.tenant_id}`;
            
            try {
                // DISCORD-FIRST: No message counts - Discord threads are sole storage
                const bridgesResult = await pool.query(`
                    SELECT 
                        b.*,
                        $1::integer as tenant_id,
                        $2::text as tenant_schema,
                        $3::text as tenant_owner_email
                    FROM ${tenantSchema}.bridges b
                    ORDER BY b.archived ASC, b.created_at DESC
                `, [tenant.tenant_id, tenantSchema, tenant.email]);
                
                allBridges.push(...bridgesResult.rows);
            } catch (error) {
                console.warn(`⚠️  Could not fetch bridges from ${tenantSchema}:`, error.message);
            }
        }
        
        console.log(`✅ Dev Panel: Found ${allBridges.length} bridges across ${tenantsResult.rows.length} tenants`);
        res.json(allBridges);
    } catch (error) {
        console.error('❌ Error in /api/dev/bridges:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all users (admin and dev roles)
app.get('/api/users', requireAuth, requireRole('admin', 'dev'), async (req, res) => {
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get requesting user's info
        const userResult = await pool.query(
            `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // SECURITY CHECK for Dev Panel cross-tenant access
        if (user.role === 'dev' && user.is_genesis_admin) {
            // Genesis Admin: Return users from their own tenant only (for now)
            // Cross-tenant visibility requires additional security controls
            const result = await pool.query(
                `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
            );
            res.json(result.rows);
        } else if (user.role === 'admin') {
            // Admin users only see their own tenant
            const result = await pool.query(
                `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
            );
            res.json(result.rows);
        } else {
            return res.status(403).json({ error: 'Access denied' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user role (admin only)
app.put('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get old role before update
        const oldData = await pool.query(`SELECT role, email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        const oldRole = oldData.rows[0]?.role;
        
        const result = await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET role = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, role, tenant_id, is_genesis_admin
        `, [role, id]);
        
        const updatedUser = result.rows[0];
        
        // Log role change
        await logAudit(pool, req, 'UPDATE_ROLE', 'USER', id, updatedUser.email, {
            old_role: oldRole,
            new_role: role
        }, tenantSchema);
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Prevent deleting yourself
        if (parseInt(id) === req.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        // Get user info before deletion for audit log
        const userData = await client.query(`SELECT email, role FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const deletedUser = userData.rows[0];
        
        // CRITICAL: Use dedicated client for atomic transaction
        await client.query('BEGIN');
        
        try {
            // Delete user from tenant schema
            await client.query(`DELETE FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            
            // Delete email mapping from core schema (prevents re-registration issues)
            await client.query(`DELETE FROM core.user_email_to_tenant WHERE email = $1`, [deletedUser.email]);
            
            await client.query('COMMIT');
            
            // Log user deletion (outside transaction)
            await logAudit(pool, req, 'DELETE_USER', 'USER', id, deletedUser.email, {
                role: deletedUser.role
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Update user email (admin only)
app.put('/api/users/:id/email', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Validate email presence and format
        if (!email || !email.trim()) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        // Check if email already exists in this tenant
        const existingUser = await pool.query(`SELECT id FROM ${tenantSchema}.users WHERE email = $1 AND id != $2`, [email, id]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        // Get old email before update
        const oldData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        const oldEmail = oldData.rows[0]?.email;
        
        const result = await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET email = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, role
        `, [email, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const updatedUser = result.rows[0];
        
        // Update email mapping in core schema
        await pool.query(`
            UPDATE core.user_email_to_tenant 
            SET email = $1, updated_at = NOW()
            WHERE email = $2
        `, [email, oldEmail]);
        
        // Log email change
        await logAudit(pool, req, 'UPDATE_EMAIL', 'USER', id, updatedUser.email, {
            old_email: oldEmail,
            new_email: email
        }, tenantSchema);
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user password (admin only)
app.put('/api/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Validate password presence and strength
        if (!password || !password.trim()) {
            return res.status(400).json({ error: 'Password is required' });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }
        
        // Get user info for audit log
        const userData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userData.rows[0];
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET password_hash = $1, updated_at = NOW()
            WHERE id = $2
        `, [hashedPassword, id]);
        
        // Log password change
        await logAudit(pool, req, 'UPDATE_PASSWORD', 'USER', id, user.email, {
            updated_by_admin: true
        }, tenantSchema);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all active sessions (admin only)
app.get('/api/sessions', requireRole('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                s.sid,
                s.sess->>'userId' as user_id,
                u.email,
                u.role,
                s.expire as expires_at,
                EXTRACT(EPOCH FROM (s.expire - NOW())) as seconds_until_expire
            FROM sessions s
            LEFT JOIN users u ON (s.sess->>'userId')::integer = u.id
            WHERE s.expire > NOW()
            ORDER BY s.expire DESC
        `);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get audit logs (admin only)
app.get('/api/audit-logs', requireRole('admin'), async (req, res) => {
    try {
        const { limit = 100, offset = 0, action_type, target_type } = req.query;
        
        let query = `
            SELECT 
                id, timestamp, actor_email, action_type, target_type, 
                target_id, target_email, details, ip_address
            FROM audit_logs
        `;
        
        const conditions = [];
        const params = [];
        let paramIndex = 1;
        
        if (action_type) {
            conditions.push(`action_type = $${paramIndex++}`);
            params.push(action_type);
        }
        
        if (target_type) {
            conditions.push(`target_type = $${paramIndex++}`);
            params.push(target_type);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
        params.push(limit, offset);
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Revoke session (admin only)
app.delete('/api/sessions/:sid', requireRole('admin'), async (req, res) => {
    const { sid } = req.params;
    
    try {
        // Prevent revoking your own session
        if (sid === req.sessionID) {
            return res.status(400).json({ error: 'Cannot revoke your own session' });
        }
        
        // Get session info before deletion for audit log
        const sessionData = await pool.query(`
            SELECT s.sess->>'userId' as user_id, u.email, u.phone
            FROM sessions s
            LEFT JOIN users u ON (s.sess->>'userId')::integer = u.id
            WHERE s.sid = $1
        `, [sid]);
        
        const result = await pool.query('DELETE FROM sessions WHERE sid = $1 RETURNING sid', [sid]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const sessionInfo = sessionData.rows[0];
        
        // Log session revocation
        await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', sid, sessionInfo?.email || sessionInfo?.phone, {
            target_user_id: sessionInfo?.user_id
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PROTECTED API ROUTES ============
// All routes below require authentication, with role-based access where specified

app.get('/api/status', requireAuth, async (req, res) => {
    try {
        const allClients = whatsappManager.getAllClients();
        
        // Aggregate status across all active bridges
        const activeCount = allClients.filter(c => c.status === 'ready').length;
        const qrPendingCount = allClients.filter(c => c.status === 'qr_ready').length;
        
        res.json({
            messagesCount: 0, // Messages tracked in Discord only, not in PostgreSQL
            activeBots: activeCount,
            qrPending: qrPendingCount,
            totalClients: allClients.length,
            multiTenantMode: true
        });
    } catch (error) {
        console.error('❌ Error in /api/status:', error);
        res.status(500).json({ error: error.message });
    }
});

// DEPRECATED: Use /api/bots/:id/qr instead (kept for backward compatibility)
app.get('/api/qr', requireAuth, (req, res) => {
    res.status(410).json({ 
        error: 'This endpoint is deprecated. Use /api/bots/:id/qr for bot-specific QR codes.',
        migration: 'Each bridge now has its own WhatsApp session. Start a bridge with POST /api/bots/:id/start and get its QR with GET /api/bots/:id/qr'
    });
});

// DEPRECATED: Use /api/bots/:id/relink instead (kept for backward compatibility)
app.post('/api/relink', requireRole('admin', 'write-only'), async (req, res) => {
    res.status(410).json({ 
        error: 'This endpoint is deprecated. Use /api/bots/:id/relink for bot-specific relinking.',
        migration: 'Each bridge now has its own WhatsApp session. Relink a specific bridge with POST /api/bots/:id/relink'
    });
});

// DISCORD-FIRST: Messages stored in Discord threads, not PostgreSQL
app.get('/api/messages', requireAuth, async (req, res) => {
    try {
        // Return empty messages array - Discord threads are the sole storage
        res.json({ 
            messages: [], 
            total: 0, 
            page: 1, 
            limit: 50, 
            totalPages: 0,
            note: 'Messages are stored in Discord threads. Use the Discord UI to view message history.'
        });
    } catch (error) {
        console.error('❌ Error in /api/messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// DISCORD-FIRST: Stats not available - Discord threads are sole storage
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        // Return zero stats - Discord manages all message data
        res.json({ 
            total: 0, 
            success: 0, 
            failed: 0, 
            pending: 0,
            note: 'Message statistics are not tracked in PostgreSQL. View full history in Discord threads.'
        });
    } catch (error) {
        console.error('❌ Error in /api/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Bridge management endpoints
// CRITICAL: Complete horizontal tenant isolation with EXPLICIT SCHEMA INDEXING
// Uses dynamic schema names via variable placeholders (fractalized architecture)
app.get('/api/bridges', requireAuth, async (req, res) => {
    console.log(`🔍 /api/bridges called by user ${req.userId}`);
    
    try {
        // Use tenant schema from requireAuth middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            console.error(`❌ No tenant schema set for user ${req.userId}`);
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get user info from tenant-scoped table
        const userResult = await pool.query(
            `SELECT id, email, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            console.error(`❌ User ${req.userId} not found in ${tenantSchema}`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const tenantId = user.tenant_id;
        
        console.log(`📊 Loading bridges for ${user.email} (user_id=${req.userId}) from ${tenantSchema}`);
        
        // EXPLICIT SCHEMA INDEXING: Use parameterized schema names (fractalized architecture)
        // ALL users (including dev) only see non-archived bridges in main UI
        // DISCORD-FIRST: No message counts - Discord threads are sole storage
        const result = await pool.query(`
            SELECT b.*
            FROM ${tenantSchema}.bridges b
            WHERE b.archived = false
            ORDER BY b.created_at DESC
        `);
        
        console.log(`✅ Found ${result.rows.length} active bridges in ${tenantSchema} for ${user.email}`);
        
        // PHASE 2 TRANSITION: Include both id and fractal_id during migration period
        // TODO: Remove raw id once ALL endpoints and frontend are migrated to fractal_id
        const bridgesWithFractalIds = result.rows.map(bridge => {
            // Generate fractal_id if missing (for backward compatibility)
            if (!bridge.fractal_id) {
                bridge.fractal_id = fractalId.generate('bridge', tenantId, bridge.id, bridge.created_by_admin_id);
            }
            // Keep id for backward compatibility during transition
            return bridge;
        });
        
        // SECURITY: Strip raw IDs for non-dev users (IDOR protection)
        const sanitized = sanitizeForRole(bridgesWithFractalIds, user.role);
        res.json(sanitized);
    } catch (error) {
        console.error(`❌ Error in /api/bridges for user ${req.userId}:`, error);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bridges', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const tenantId = req.tenantContext?.tenantId;
        const isGenesisAdmin = req.tenantContext?.isGenesisAdmin || false;
        const { name, inputPlatform, userOutputUrl, contactInfo, tags } = req.body;
        
        if (!tenantId) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        
        // WEBHOOK-CENTRIC: Dual-output architecture
        // Output #01: Nyanbook Ledger (eternal, automatic, masked from Admin #0n)
        const output01Url = NYANBOOK_LEDGER_WEBHOOK;
        
        // Output #0n: User's Discord (mutable, optional, visible to owner)
        const output0nUrl = userOutputUrl || null;
        
        // SECURITY: Prevent user webhook from being same as Ledger webhook (privacy breach)
        if (output0nUrl && output0nUrl === NYANBOOK_LEDGER_WEBHOOK) {
            return res.status(400).json({ 
                error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook. This would expose all tenant messages to your webhook.'
            });
        }
        
        // Tag dev-created bridges with admin_id='01' for fractalized ID generation
        const createdByAdminId = (userRole === 'dev' && isGenesisAdmin) ? '01' : null;
        
        // Generate unique Discord thread name for ledger tracking
        const threadName = `bridge-t${tenantId}-${Date.now()}`;
        
        // Store thread metadata in output_credentials
        const outputCredentials = {
            thread_name: threadName
        };
        
        const result = await client.query(
            `INSERT INTO bridges (name, input_platform, output_platform, input_credentials, output_credentials, output_01_url, output_0n_url, contact_info, tags, status, archived, created_by_admin_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [name, inputPlatform, 'discord', {}, outputCredentials, output01Url, output0nUrl, contactInfo || null, tags || [], 'inactive', false, createdByAdminId]
        );
        
        const bridge = result.rows[0];
        
        // Generate fractalized ID (opaque, tenant-scoped, non-enumerable)
        // Dev admin (admin_id='01') gets special prefix: dev_bridge_t1_...
        const generatedFractalId = fractalId.generate('bridge', tenantId, bridge.id, bridge.created_by_admin_id);
        
        // Update bridge with fractalized ID
        await client.query(
            `UPDATE bridges SET fractal_id = $1 WHERE id = $2`,
            [generatedFractalId, bridge.id]
        );
        
        bridge.fractal_id = generatedFractalId;
        
        // AUTO-CREATE DISCORD THREAD VIA BOT (one thread per bridge)
        if (discordBotManager && discordBotManager.isReady() && output01Url) {
            try {
                const threadInfo = await discordBotManager.createThreadForBridge(
                    output01Url,
                    name,
                    tenantId,
                    bridge.id
                );
                
                await client.query(
                    `UPDATE bridges 
                     SET output_credentials = output_credentials || $1::jsonb
                     WHERE id = $2`,
                    [JSON.stringify({ thread_id: threadInfo.threadId, thread_name: threadInfo.threadName }), bridge.id]
                );
                
                bridge.output_credentials.thread_id = threadInfo.threadId;
                bridge.output_credentials.thread_name = threadInfo.threadName;
                
                try {
                    await discordBotManager.sendInitialMessage(threadInfo.threadId, name, output01Url);
                } catch (msgError) {
                    console.error(`⚠️  Failed to send initial message (non-critical):`, msgError.message);
                }
                
                console.log(`🧵 Auto-created Discord thread for bridge ${generatedFractalId}: ${threadInfo.threadName}`);
            } catch (error) {
                console.error(`⚠️  Failed to auto-create thread for bridge ${generatedFractalId}:`, error.message);
                
                if (discordBotManager.isTransientError(error)) {
                    console.log(`📝 Queueing retry for transient error...`);
                    discordBotManager.queueRetry(bridge.id, tenantId, output01Url, name, client, 60000);
                } else {
                    console.log(`❌ Permanent error - bridge will use webhook-only mode`);
                }
            }
        }
        
        // Return sanitized bridge data (output_01_url is automatically stripped for non-dev users)
        const sanitized = sanitizeForRole(bridge, userRole);
        
        console.log(`✅ Created bridge ${generatedFractalId} (Output #01: ${output01Url ? '[LEDGER]' : 'None'}, Output #0n: ${output0nUrl ? '[USER_WEBHOOK]' : 'None'})`);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in POST /api/bridges:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/bridges/:id', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const { id } = req.params; // fractal_id
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags, status, userOutputUrl } = req.body;
        
        // SECURITY: Prevent user webhook from being same as Ledger webhook (privacy breach)
        if (userOutputUrl && userOutputUrl === NYANBOOK_LEDGER_WEBHOOK) {
            return res.status(400).json({ 
                error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook. This would expose all tenant messages to your webhook.'
            });
        }
        
        // Build update query dynamically based on what's provided
        const updates = [];
        const values = [];
        let paramCount = 1;
        
        if (name !== undefined) {
            updates.push(`name = $${paramCount++}`);
            values.push(name);
        }
        if (inputPlatform !== undefined) {
            updates.push(`input_platform = $${paramCount++}`);
            values.push(inputPlatform);
        }
        if (outputPlatform !== undefined) {
            updates.push(`output_platform = $${paramCount++}`);
            values.push(outputPlatform);
        }
        if (inputCredentials !== undefined) {
            updates.push(`input_credentials = $${paramCount++}`);
            values.push(inputCredentials);
        }
        if (outputCredentials !== undefined) {
            updates.push(`output_credentials = $${paramCount++}`);
            values.push(outputCredentials);
        }
        if (contactInfo !== undefined) {
            updates.push(`contact_info = $${paramCount++}`);
            values.push(contactInfo || null);
        }
        if (tags !== undefined) {
            updates.push(`tags = $${paramCount++}`);
            values.push(tags || []);
        }
        if (status !== undefined) {
            updates.push(`status = $${paramCount++}`);
            values.push(status);
        }
        if (userOutputUrl !== undefined) {
            updates.push(`output_0n_url = $${paramCount++}`);
            values.push(userOutputUrl);
        }
        
        updates.push(`updated_at = NOW()`);
        values.push(id); // fractal_id at end
        
        const result = await client.query(
            `UPDATE bridges 
             SET ${updates.join(', ')}
             WHERE fractal_id = $${paramCount} RETURNING *`,
            values
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const sanitized = sanitizeForRole(result.rows[0], userRole);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in PUT /api/bridges/:id:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete bridge (soft delete - archives bridge preserving all data)
app.delete('/api/bridges/:id', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    const { id } = req.params; // fractal_id
    
    try {
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        // CRITICAL: Get webhook URLs BEFORE archiving so we can delete them
        const bridgeResult = await client.query(
            `SELECT id, fractal_id, output_01_url, output_0n_url FROM bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to delete bridge ${id} outside their tenant`);
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const bridge = bridgeResult.rows[0];
        const internalId = bridge.id;
        console.log(`🗄️  Archiving bridge ${id} (internal ${internalId}) from ${tenantSchema} (soft delete)...`);
        
        // SECURITY: Delete Discord webhooks to prevent ghost messages (NYAN TRUTH)
        // ONE BRIDGE = ONE WEBHOOK URL. On delete: DESTROY + DELETE WEBHOOK.
        const webhooksToDelete = [];
        if (bridge.output_0n_url) webhooksToDelete.push({ url: bridge.output_0n_url, name: 'User Discord' });
        
        for (const webhook of webhooksToDelete) {
            try {
                await axios.delete(webhook.url);
                console.log(`🗑️  Discord webhook deleted for bridge ${id} (${webhook.name})`);
            } catch (err) {
                // Webhook might already be deleted or invalid - log but don't fail
                console.warn(`⚠️  Failed to delete ${webhook.name} webhook (maybe already gone):`, err.message);
            }
        }
        
        // NOTE: output_01_url (Nyanbook Ledger) is ETERNAL and shared - never delete it
        if (bridge.output_01_url) {
            console.log(`ℹ️  Preserving output_01_url (Nyanbook Ledger) - eternal webhook, not bridge-specific`);
        }
        
        // SCRIBE OF SCRIBE PRINCIPLE: Discord threads are PERMANENT and IMMUTABLE
        // NEVER delete or archive threads - they are the eternal record
        if (bridge.output_credentials?.thread_id) {
            console.log(`📜 Preserving Discord thread ${bridge.output_credentials.thread_id} - eternal ledger, never deleted`);
        }
        
        // Stop WhatsApp client if active (but keep session files for potential restoration)
        try {
            const whatsappClient = whatsappManager.getClient(internalId, tenantSchema);
            if (whatsappClient) {
                await whatsappManager.stopClient(internalId, tenantSchema);
                console.log(`✅ WhatsApp client stopped for bridge ${id} (session files preserved)`);
            }
        } catch (error) {
            console.warn(`⚠️  Could not stop WhatsApp client for bridge ${id}:`, error.message);
        }
        
        // SOFT DELETE: Set archived=true and archived_at=NOW() (preserves all data)
        const result = await client.query(`
            UPDATE bridges 
            SET archived = true, archived_at = NOW(), status = 'archived' 
            WHERE fractal_id = $1 
            RETURNING *
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        console.log(`✅ Bridge ${id} archived successfully by user ${req.userId}`);
        res.json({ 
            success: true, 
            message: 'Bridge deleted successfully'
        });
        
        // Log audit AFTER response (don't block transaction commit)
        setImmediate(() => {
            logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
                message: 'Bridge archived (soft delete) - all messages and session preserved',
                tenant_schema: tenantSchema,
                archived_at: new Date().toISOString()
            }).catch(err => console.error('Audit log failed:', err.message));
        });
    } catch (error) {
        console.error(`❌ Error archiving bridge ${id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Archive bridge (soft delete - keeps all message history)
app.post('/api/bridges/:id/archive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Prevent archiving the default active bot
        if (parseInt(id) === 1) {
            return res.status(400).json({ 
                error: 'Cannot archive the default bridge (currently active). Create and activate a new bridge first.' 
            });
        }
        
        await pool.query('UPDATE bridges SET archived = true, status = $1 WHERE id = $2', ['archived', id]);
        
        logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
            message: 'Bridge archived - message history preserved'
        });
        
        res.json({ success: true, message: 'Bridge archived. All message history preserved.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Unarchive bridge (restore archived bot)
app.post('/api/bridges/:id/unarchive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE bridges SET archived = false, status = $1 WHERE id = $2', ['inactive', id]);
        
        logAudit(pool, req, 'UNARCHIVE', 'BOT', id, null, {
            message: 'Bridge unarchive and restored'
        });
        
        res.json({ success: true, message: 'Bridge restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ WEBHOOK INPUT ENDPOINT (HYBRID MODEL) ============
// Support ANY input: Telegram bot, Twitter/X, SMS, Email → Discord
// Example: POST /api/webhook/bridge_t6_abc123 with { text, username, avatar_url, media_url }
app.post('/api/webhook/:fractalId', async (req, res) => {
    try {
        const fractalIdParam = req.params.fractalId;
        const { text, username = 'External', avatar_url, media_url, phone, email } = req.body;
        
        // Parse fractal_id to get tenant
        const parsed = fractalId.parse(fractalIdParam);
        if (!parsed || !parsed.tenantId) {
            return res.status(400).json({ error: 'Invalid bridge ID format' });
        }
        
        const tenantSchema = `tenant_${parsed.tenantId}`;
        
        // Get tenant-scoped database client
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL search_path TO ${tenantSchema}`);
            
            // Find bridge by fractal_id
            const bridgeResult = await client.query(
                'SELECT id, fractal_id, output_01_url, output_0n_url, output_credentials FROM bridges WHERE fractal_id = $1',
                [fractalIdParam]
            );
            
            if (bridgeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: 'Bridge not found' });
            }
            
            const bridge = bridgeResult.rows[0];
            const internalId = bridge.id;
            
            // Parse JSON if needed (PostgreSQL returns JSON as string sometimes)
            if (bridge && typeof bridge.output_credentials === 'string') {
                bridge.output_credentials = JSON.parse(bridge.output_credentials);
            }
            
            // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
            const senderName = username || phone || email || 'External';
            
            // Prepare Discord payload
            const discordPayload = {
                username: senderName,
                avatar_url: avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
                content: text || '',
                embeds: []
            };
            
            // Add media embed if provided
            if (media_url) {
                discordPayload.embeds.push({
                    image: { url: media_url }
                });
            }
            
            // WEBHOOK-FIRST ARCHITECTURE: Dual-output delivery
            // Output #01: Nyanbook Ledger (eternal, Dev #01 only)
            // Output #0n: User Discord (mutable, Admin #0n only)
            const threadName = bridge.output_credentials?.thread_name;
            const threadId = bridge.output_credentials?.thread_id;
            
            // Path 1: Nyanbook Ledger (Output #01)
            await sendToLedger(discordPayload, {
                isMedia: !!media_url,
                threadName,
                threadId
            }, bridge);
            
            // Path 2: User Webhook (Output #0n)
            await sendToUserOutput(discordPayload, {
                isMedia: !!media_url
            }, bridge);
            
            await client.query('COMMIT');
            client.release();
            
            console.log(`✅ [Webhook] Forwarded message from ${senderName} to bridge ${fractalIdParam}`);
            res.json({ success: true, message: 'Message forwarded to Discord' });
            
        } catch (error) {
            await client.query('ROLLBACK');
            client.release();
            throw error;
        }
    } catch (error) {
        console.error(`❌ [Webhook] Error processing webhook:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ============ BOT-LEVEL WHATSAPP MANAGEMENT ENDPOINTS ============
// Multi-tenant WhatsApp: Each bridge gets its own WhatsApp session

// Start WhatsApp session for a bot
app.post('/api/bridges/:id/start', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        const bridgeResult = await client.query(
            `SELECT id, fractal_id FROM bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to start bridge ${id} outside their tenant`);
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const internalId = bridgeResult.rows[0].id;
        console.log(`🔍 Bridge ${id} (internal ${internalId}) belongs to ${tenantSchema}`);
        
        // Check if already running (use composite key)
        const existingClient = whatsappManager.getClient(internalId, tenantSchema);
        if (existingClient && (existingClient.status === 'ready' || existingClient.status === 'qr_ready')) {
            return res.json({ 
                success: true, 
                message: 'WhatsApp session already active',
                status: existingClient.status,
                qrCode: existingClient.qrCode
            });
        }
        
        // Initialize WhatsApp client for this bot
        const clientState = await whatsappManager.initializeClient(
            internalId, 
            tenantSchema, 
            createTenantAwareMessageHandler
        );
        
        // QR-FIRST ARCHITECTURE: Return QR code immediately for popup display
        let qrCodeDataUrl = null;
        if (clientState.qrCode) {
            qrCodeDataUrl = await QRCode.toDataURL(clientState.qrCode);
        }
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session starting...',
            status: clientState.status,
            qrCode: qrCodeDataUrl, // Include QR code for instant display
            bridgeId: id // Return fractal_id to frontend
        });
    } catch (error) {
        console.error(`❌ Error starting WhatsApp for bridge ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Stop WhatsApp session for a bridge (preserves session)
app.delete('/api/bridges/:id/stop', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        const bridgeResult = await client.query(
            `SELECT id, fractal_id FROM bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to stop bridge ${id} outside their tenant`);
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const internalId = bridgeResult.rows[0].id;
        await whatsappManager.stopClient(internalId, tenantSchema);
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session stopped (will auto-reconnect on restart)',
            bridgeId: id
        });
    } catch (error) {
        console.error(`❌ Error stopping WhatsApp for bridge ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Get QR code for a bot
app.get('/api/bridges/:id/qr', requireAuth, async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        console.log(`📱 /api/bridges/:id/qr called for ${id} by user ${req.userId}`);
        
        // Use tenant schema from requireAuth middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get user's tenant_id for bridge indexing
        const userResult = await pool.query(
            `SELECT tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            console.error(`❌ User ${req.userId} not found for QR request`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userTenantId = userResult.rows[0].tenant_id;
        const userTenantSchema = tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        const bridgeResult = await pool.query(
            `SELECT id, fractal_id, name FROM ${userTenantSchema}.bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to access bridge ${id} outside their tenant`);
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const internalId = bridgeResult.rows[0].id;
        const bridgeName = bridgeResult.rows[0].name;
        
        // Get WhatsApp client state using dynamic indexing (tenant:bridge)
        const clientState = whatsappManager.getClient(internalId, userTenantSchema);
        const qrCode = whatsappManager.getQRCode(internalId, userTenantSchema);
        
        if (!qrCode && !clientState) {
            console.log(`  ℹ️  No QR/client for ${userTenantSchema}:${internalId} (${bridgeName})`);
            const response = { 
                qr: null, 
                status: 'inactive',
                message: 'No QR code available. Start the bridge first.' 
            };
            console.log(`  ↳ Returning status: ${response.status}`);
            return res.json(response);
        }
        
        // Return status and QR code with dynamic indexing reference
        const response = {
            qr: qrCode ? await QRCode.toDataURL(qrCode) : null,
            status: clientState?.status || 'inactive',
            phoneNumber: clientState?.phoneNumber || null,
            hasQR: !!qrCode,
            bridgeId: id // Fractal ID (webhook-centric reference)
        };
        
        console.log(`  ✅ QR response for ${userTenantSchema}:${internalId} - status: ${response.status}, hasQR: ${response.hasQR}`);
        res.json(response);
    } catch (error) {
        console.error(`❌ Error getting QR for bridge ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Relink WhatsApp session for a bridge (destroy and create new QR)
app.post('/api/bridges/:id/relink', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    const { id } = req.params; // fractal_id
    
    try {
        console.log(`🔄 Starting relink for bridge ${id}...`);
        
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        const bridgeResult = await client.query(
            `SELECT id, fractal_id FROM bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to relink bridge ${id} outside their tenant`);
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const internalId = bridgeResult.rows[0].id;
        console.log(`🔍 Bridge ${id} (internal ${internalId}) belongs to ${tenantSchema} (relink)`);
        
        const clientState = await whatsappManager.relinkClient(
            internalId, 
            tenantSchema, 
            createTenantAwareMessageHandler
        );
        
        console.log(`✅ Relink initiated for bridge ${id}, status: ${clientState.status}`);
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session relinking... New QR code will be available shortly.',
            status: clientState.status,
            bridgeId: id
        });
    } catch (error) {
        console.error(`❌ Error relinking WhatsApp for bridge ${id}:`, error);
        console.error('Stack trace:', error.stack);
        
        // Ensure JSON response even on error
        if (!res.headersSent) {
            res.status(500).json({ 
                error: error.message || 'Unknown error occurred during relink',
                bridgeId: id
            });
        }
    }
});

// Get WhatsApp session status for a bot
app.get('/api/bridges/:id/status', requireAuth, setTenantContext, async (req, res) => {
    try {
        const { id } = req.params; // This is fractal_id
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify bridge belongs to user's tenant using fractal_id
        const bridgeResult = await client.query(
            `SELECT id, fractal_id FROM bridges WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bridgeResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to access bridge ${id} outside their tenant`);
            return res.json({ 
                status: 'inactive', 
                message: 'Bridge not found in your tenant'
            });
        }
        
        const internalId = bridgeResult.rows[0].id;
        
        // Get status using composite key (tenant:bridge)
        const clientState = whatsappManager.getClient(internalId, tenantSchema);
        
        if (!clientState) {
            return res.json({ 
                status: 'inactive', 
                message: 'No WhatsApp session for this bridge'
            });
        }
        
        res.json({ 
            status: clientState.status,
            phoneNumber: clientState.phoneNumber,
            hasQR: clientState.qrCode !== null,
            bridgeId: id // Return fractal_id to frontend
        });
    } catch (error) {
        console.error(`❌ Error getting status for bridge ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Get archived bridges (with message history)
app.get('/api/bridges/archived', requireAuth, async (req, res) => {
    try {
        // Get tenant schema from authenticated user
        const userResult = await pool.query(
            'SELECT id, email, tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tenantId = userResult.rows[0].tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        // TENANT-AWARE: Query from tenant schema
        const result = await pool.query(`
            SELECT 
                b.*,
                COUNT(m.id) as message_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as forwarded_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count
            FROM ${tenantSchema}.bridges b
            LEFT JOIN ${tenantSchema}.messages m ON b.id = m.bridge_id
            WHERE b.archived = true
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error in /api/bridges/archived:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bridges/:id/stats', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get tenant schema from authenticated user
        const userResult = await pool.query(
            'SELECT id, email, tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tenantId = userResult.rows[0].tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        // TENANT-AWARE: Query from tenant schema
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'success') as success,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE discord_status = 'pending') as pending
            FROM ${tenantSchema}.messages WHERE bridge_id = $1
        `, [id]);
        res.json(result.rows[0]);
    } catch (error) {
        console.error('❌ Error in /api/bridges/:id/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// REMOVED: Duplicate QR endpoint - using the multi-instance version above (line ~2741)

// DISCORD-FIRST: Media stored in Discord threads, not PostgreSQL  
// Frontend should use Discord CDN URLs directly (from message.media_url)
app.get('/api/messages/:id/media', requireAuth, async (req, res) => {
    try {
        // Media is stored in Discord threads
        // The frontend should use message.media_url (Discord CDN URL) directly
        res.status(404).json({ 
            error: 'Media not available via this endpoint',
            note: 'Use message.media_url (Discord CDN URL) directly from message data'
        });
    } catch (error) {
        console.error(`❌ Error in /api/messages/:id/media:`, error);
        res.status(500).json({ error: error.message });
    }
});

// DISCORD-FIRST: Messages stored in Discord threads - fetch from Discord API
app.get('/api/bridges/:id/messages', requireAuth, setTenantContext, async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        const client = req.dbClient || pool;
        const limit = parseInt(req.query.limit) || 50;
        const before = req.query.before; // Discord message ID for pagination
        
        // Get bridge with thread info
        const bridgeResult = await client.query(
            'SELECT id, name, output_credentials FROM bridges WHERE fractal_id = $1',
            [id]
        );
        
        if (bridgeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const bridge = bridgeResult.rows[0];
        
        // Parse JSON if needed
        let outputCredentials = bridge.output_credentials;
        if (typeof outputCredentials === 'string') {
            outputCredentials = JSON.parse(outputCredentials);
        }
        
        const threadId = outputCredentials?.thread_id;
        
        if (!threadId) {
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                note: 'No Discord thread configured for this bridge yet'
            });
        }
        
        // Fetch messages from Discord thread using bot
        if (!discordBotManager.client || !discordBotManager.ready) {
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                note: 'Discord bot not ready - messages temporarily unavailable'
            });
        }
        
        try {
            const thread = await discordBotManager.client.channels.fetch(threadId);
            
            if (!thread) {
                return res.json({ 
                    messages: [], 
                    total: 0,
                    hasMore: false,
                    note: 'Discord thread not found'
                });
            }
            
            // Fetch messages from Discord
            const options = { limit };
            if (before) options.before = before;
            
            const discordMessages = await thread.messages.fetch(options);
            
            // Transform Discord messages to UI format
            const messages = Array.from(discordMessages.values()).map(msg => {
                const attachment = msg.attachments.size > 0 ? msg.attachments.first() : null;
                return {
                    id: msg.id,
                    sender_name: msg.author.username,
                    sender_avatar: msg.author.displayAvatarURL(),
                    message_content: msg.content || '',
                    timestamp: msg.createdAt.toISOString(),
                    has_media: msg.attachments.size > 0,
                    media_url: attachment ? attachment.url : null,
                    media_type: attachment ? attachment.contentType : null,
                    embeds: msg.embeds.map(e => ({
                        title: e.title,
                        description: e.description,
                        color: e.color,
                        fields: e.fields
                    }))
                };
            });
            
            res.json({ 
                messages,
                total: messages.length,
                hasMore: discordMessages.size === limit,
                oldestMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
            });
        } catch (discordError) {
            console.error('❌ Failed to fetch from Discord:', discordError.message);
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                error: 'Failed to fetch messages from Discord: ' + discordError.message
            });
        }
    } catch (error) {
        console.error('❌ Error in /api/bridges/:id/messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// ONBOARDING API
// ===========================

// Get onboarding status
app.get('/api/onboarding/status', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT onboarding_completed, settings FROM user_settings WHERE user_id = $1',
            [req.userId]
        );
        
        if (result.rows.length === 0) {
            return res.json({ completed: false, state: {} });
        }
        
        res.json({
            completed: result.rows[0].onboarding_completed,
            state: result.rows[0].settings || {}
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save onboarding progress
app.post('/api/onboarding/status', requireAuth, async (req, res) => {
    const { completed, state } = req.body;
    
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, onboarding_completed, settings)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id)
            DO UPDATE SET 
                onboarding_completed = $2,
                settings = $3,
                updated_at = NOW()
        `, [req.userId, completed || false, JSON.stringify(state || {})]);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// ENHANCED SEARCH API
// ===========================

app.get('/api/messages/search', requireAuth, async (req, res) => {
    const {
        bridgeId,
        q,
        dateFrom,
        dateTo,
        senderId,
        messageType,
        status,
        regex
    } = req.query;
    
    if (!bridgeId) {
        return res.status(400).json({ error: 'Bridge ID is required' });
    }
    
    try {
        // Get tenant schema from authenticated user
        const userResult = await pool.query(
            'SELECT id, email, tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tenantId = userResult.rows[0].tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        // TENANT-AWARE: Query from tenant schema
        let query = `SELECT * FROM ${tenantSchema}.messages WHERE bridge_id = $1`;
        const params = [bridgeId];
        let paramCount = 1;
        
        // Text search
        if (q) {
            paramCount++;
            if (regex === 'true' && req.userRole === 'admin') {
                // Admin-only regex search with timeout
                query += ` AND (message_content ~* $${paramCount} OR sender_name ~* $${paramCount} OR sender_contact ~* $${paramCount})`;
                params.push(q);
                
                // Set statement timeout for regex queries (prevent expensive queries)
                await pool.query('SET statement_timeout = 5000'); // 5 second timeout
            } else {
                // Standard LIKE search
                query += ` AND (LOWER(message_content) LIKE $${paramCount} OR LOWER(sender_name) LIKE $${paramCount} OR sender_contact LIKE $${paramCount})`;
                params.push(`%${q.toLowerCase()}%`);
            }
        }
        
        // Date range filter
        if (dateFrom) {
            paramCount++;
            query += ` AND timestamp >= $${paramCount}`;
            params.push(dateFrom);
        }
        
        if (dateTo) {
            paramCount++;
            query += ` AND timestamp <= $${paramCount}`;
            params.push(dateTo);
        }
        
        // Sender filter
        if (senderId) {
            paramCount++;
            query += ` AND sender_contact LIKE $${paramCount}`;
            params.push(`%${senderId}%`);
        }
        
        // Message type filter
        if (messageType && messageType !== 'all') {
            paramCount++;
            query += ` AND media_type = $${paramCount}`;
            params.push(messageType);
        }
        
        // Status filter
        if (status && status !== 'all') {
            paramCount++;
            query += ` AND discord_status = $${paramCount}`;
            params.push(status);
        }
        
        query += ' ORDER BY timestamp DESC LIMIT 500';
        
        const result = await pool.query(query, params);
        
        // Reset timeout
        if (regex === 'true') {
            await pool.query('SET statement_timeout = 0');
        }
        
        res.json(result.rows);
    } catch (error) {
        // Reset timeout on error
        await pool.query('SET statement_timeout = 0').catch(() => {});
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// ANALYTICS API
// ===========================

app.get('/api/analytics/daily', requireAuth, async (req, res) => {
    const { days = 30, bridge_id } = req.query;
    
    try {
        // Get tenant schema from authenticated user
        const userResult = await pool.query(
            'SELECT id, email, tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const tenantId = user.tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        console.log(`📊 Analytics request from ${user.email} (tenant: ${tenantSchema}, bridge: ${bridge_id || 'all'})`);
        
        // Build WHERE clause for bridge filter
        const bridgeFilter = bridge_id ? `AND bridge_id = ${parseInt(bridge_id)}` : '';
        
        // TENANT-AWARE: Get daily aggregates from tenant schema
        const result = await pool.query(`
            SELECT 
                date,
                SUM(total_messages) as total_messages,
                SUM(failed_messages) as failed_messages,
                SUM(rate_limit_events) as rate_limit_events,
                AVG(avg_response_time_ms) as avg_response_time_ms
            FROM ${tenantSchema}.message_analytics
            WHERE date >= CURRENT_DATE - $1::integer ${bridgeFilter}
            GROUP BY date
            ORDER BY date ASC
        `, [days]);
        
        // TENANT-AWARE: Get summary totals from tenant schema
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed_messages
            FROM ${tenantSchema}.messages
            WHERE timestamp >= CURRENT_DATE - $1::integer ${bridgeFilter}
        `, [days]);
        
        // TENANT-AWARE: Get rate limit events from tenant schema
        const rateLimitResult = await pool.query(`
            SELECT SUM(rate_limit_events) as rate_limit_events
            FROM ${tenantSchema}.message_analytics
            WHERE date >= CURRENT_DATE - $1::integer ${bridgeFilter}
        `, [days]);
        
        // Get bridge info if filtering by specific bridge
        let bridgeInfo = null;
        if (bridge_id) {
            const bridgeResult = await pool.query(`
                SELECT id, name, input_platform, output_platform
                FROM ${tenantSchema}.bridges
                WHERE id = $1
            `, [bridge_id]);
            bridgeInfo = bridgeResult.rows[0] || null;
        }
        
        console.log(`✅ Analytics data loaded: ${summaryResult.rows[0]?.total_messages || 0} total messages`);
        
        res.json({
            daily: result.rows,
            summary: {
                total_messages: parseInt(summaryResult.rows[0]?.total_messages || 0),
                failed_messages: parseInt(summaryResult.rows[0]?.failed_messages || 0),
                rate_limit_events: parseInt(rateLimitResult.rows[0]?.rate_limit_events || 0)
            },
            bridge: bridgeInfo
        });
    } catch (error) {
        console.error(`❌ Analytics error for user ${req.userId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Update analytics (called periodically or on message insert)
async function updateAnalytics(bridgeId) {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed
            FROM messages
            WHERE bridge_id = $1 AND DATE(timestamp) = $2
        `, [bridgeId, today]);
        
        await pool.query(`
            INSERT INTO message_analytics (date, bridge_id, total_messages, failed_messages)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (date, bridge_id)
            DO UPDATE SET
                total_messages = $3,
                failed_messages = $4
        `, [today, bridgeId, stats.rows[0].total, stats.rows[0].failed]);
    } catch (error) {
        console.error('Failed to update analytics:', error);
    }
}

// Clean up stale Chromium lock files and orphaned processes to prevent launch failures
async function cleanupChromiumLockFiles() {
    try {
        // CRITICAL: Use persistent storage path
        const sessionDir = WWEBJS_DATA_PATH;
        
        if (!fs.existsSync(sessionDir)) {
            console.log('🧹 No session directory found - skipping lock file cleanup');
            return;
        }
        
        const sessionFolders = fs.readdirSync(sessionDir)
            .filter(name => name.startsWith('session-'))
            .map(name => path.join(sessionDir, name));
        
        console.log(`🔍 Scanning ${sessionFolders.length} session folders for stale lock files and orphaned processes...`);
        
        // Step 1: Kill orphaned Chromium processes
        try {
            const { execSync } = require('child_process');
            
            // Find and kill Chromium processes related to our session directories
            const chromiumProcesses = execSync('ps aux | grep chromium | grep -v grep || true', { encoding: 'utf8' });
            
            if (chromiumProcesses.trim()) {
                console.log('🔍 Found running Chromium processes - checking for orphaned sessions...');
                
                // Kill all Chromium processes (they'll be restarted if needed)
                try {
                    execSync('pkill -9 chromium || true', { encoding: 'utf8' });
                    console.log('✅ Terminated orphaned Chromium processes');
                    // Wait for processes to fully terminate
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (killErr) {
                    console.log('⚠️  No Chromium processes to kill or already terminated');
                }
            }
        } catch (psErr) {
            // No processes found or ps command failed - continue with cleanup
            console.log('✅ No orphaned Chromium processes found');
        }
        
        // Step 2: Clean up lock files and Chromium metadata that caches PIDs
        let cleanedCount = 0;
        const lockFileNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
        const metadataFiles = ['DevToolsActivePort', 'Last Version'];
        
        for (const folder of sessionFolders) {
            if (!fs.existsSync(folder)) continue;
            
            // Remove lock files
            for (const lockFile of lockFileNames) {
                const lockPath = path.join(folder, lockFile);
                if (fs.existsSync(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                        cleanedCount++;
                        console.log(`🗑️  Removed lock: ${lockPath}`);
                    } catch (err) {
                        console.error(`⚠️  Failed to remove ${lockPath}:`, err.message);
                    }
                }
            }
            
            // Remove metadata files that cache process info
            for (const metaFile of metadataFiles) {
                const metaPath = path.join(folder, metaFile);
                if (fs.existsSync(metaPath)) {
                    try {
                        fs.unlinkSync(metaPath);
                        cleanedCount++;
                        console.log(`🗑️  Removed metadata: ${metaPath}`);
                    } catch (err) {
                        console.error(`⚠️  Failed to remove ${metaPath}:`, err.message);
                    }
                }
            }
            
            // Remove Default profile's singleton lock files if they exist
            const defaultDir = path.join(folder, 'Default');
            if (fs.existsSync(defaultDir)) {
                for (const lockFile of lockFileNames) {
                    const lockPath = path.join(defaultDir, lockFile);
                    if (fs.existsSync(lockPath)) {
                        try {
                            fs.unlinkSync(lockPath);
                            cleanedCount++;
                            console.log(`🗑️  Removed Default lock: ${lockPath}`);
                        } catch (err) {
                            console.error(`⚠️  Failed to remove ${lockPath}:`, err.message);
                        }
                    }
                }
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`✅ Cleaned up ${cleanedCount} stale Chromium lock files`);
            // Small delay to ensure filesystem sync
            await new Promise(resolve => setTimeout(resolve, 500));
        } else {
            console.log('✅ No stale lock files found');
        }
    } catch (error) {
        console.error('⚠️  Lock file cleanup failed:', error.message);
    }
}

// Auto-restore all bridges with saved WhatsApp sessions on server startup
async function autoRestoreWhatsAppSessions() {
    try {
        console.log('🔄 Auto-restoring Baileys WhatsApp sessions from saved data...');
        
        // Get all tenant schemas
        const schemas = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        let restoredCount = 0;
        let skippedCount = 0;
        
        // For each tenant schema, find all bridges with saved sessions
        for (const { schema_name } of schemas.rows) {
            try {
                const bridges = await pool.query(`
                    SELECT id, name, status 
                    FROM ${schema_name}.bridges 
                    WHERE status != 'deleted'
                `);
                
                for (const bridge of bridges.rows) {
                    // Check if this bridge has a saved Baileys session
                    // Baileys stores auth in a directory with JSON files (creds.json, etc.)
                    const sessionClientId = `${schema_name}_bridge_${bridge.id}`;
                    // CRITICAL: Use persistent Baileys storage path with "session-" prefix
                    const sessionPath = path.join(BAILEYS_DATA_PATH, `session-${sessionClientId}`);
                    
                    // Check if Baileys session exists (directory with creds.json)
                    const hasSession = fs.existsSync(sessionPath) && 
                                      fs.existsSync(path.join(sessionPath, 'creds.json'));
                    
                    if (hasSession) {
                        console.log(`🔗 Auto-restoring ${schema_name}:${bridge.id} (${bridge.name})...`);
                        
                        try {
                            // Initialize Baileys client with saved session
                            // Uses composite tenant:bridge key for tracking
                            await whatsappManager.initializeClient(
                                bridge.id,
                                schema_name,
                                createTenantAwareMessageHandler
                            );
                            restoredCount++;
                            console.log(`✅ ${schema_name}:${bridge.id} restored successfully`);
                            
                            // THROTTLE: Prevent resource explosion from opening 100+ WebSockets at once
                            // Stagger initialization by 500ms to avoid overwhelming system resources
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (error) {
                            console.error(`⚠️  Failed to restore ${schema_name}:${bridge.id}:`, error.message);
                            skippedCount++;
                        }
                    } else {
                        console.log(`⏭️  Skipping ${schema_name}:${bridge.id} (${bridge.name}) - no saved session`);
                        skippedCount++;
                    }
                }
            } catch (error) {
                console.error(`⚠️  Error processing ${schema_name}:`, error.message);
            }
        }
        
        console.log(`✅ Auto-restore complete: ${restoredCount} bridges restored, ${skippedCount} skipped`);
    } catch (error) {
        console.error('❌ Auto-restore failed:', error.message);
    }
}

// Global error handlers to prevent WhatsApp disconnection from killing the app
process.on('unhandledRejection', (reason, promise) => {
    // Check if it's a Baileys/WhatsApp error
    if (reason && typeof reason === 'object') {
        const errorMsg = reason.message || String(reason);
        
        // Ignore connection errors (these happen during disconnect)
        if (errorMsg.includes('Connection closed') ||
            errorMsg.includes('Connection terminated') ||
            errorMsg.includes('Session closed')) {
            console.log('⚠️  Ignoring WhatsApp disconnect error (expected during logout)');
            return;
        }
    }
    
    // Log other unhandled rejections
    console.error('❌ Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
    // Check if it's a Baileys connection error
    const errorMsg = error.message || String(error);
    
    if (errorMsg.includes('Connection closed') ||
        errorMsg.includes('Connection terminated') ||
        errorMsg.includes('Session closed')) {
        console.log('⚠️  Ignoring WhatsApp exception (expected during logout)');
        return;
    }
    
    // Log and exit for other uncaught exceptions
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
});

// INTERNAL API: Create Discord thread manually (for recovery/debugging)
app.post('/api/internal/create-thread', async (req, res) => {
    try {
        const { bridgeId, tenantId } = req.body;
        
        if (!bridgeId || !tenantId) {
            return res.status(400).json({ error: 'bridgeId and tenantId required' });
        }
        
        const tenantSchema = `tenant_${tenantId}`;
        const bridge = await pool.query(
            `SELECT id, name, output_01_url, output_credentials FROM ${tenantSchema}.bridges WHERE id = $1`,
            [bridgeId]
        );
        
        if (!bridge.rows.length) {
            return res.status(404).json({ error: 'Bridge not found' });
        }
        
        const bridgeData = bridge.rows[0];
        
        if (!discordBotManager || !discordBotManager.isReady()) {
            return res.status(503).json({ error: 'Discord bot not ready' });
        }
        
        const threadInfo = await discordBotManager.createThreadForBridge(
            bridgeData.output_01_url,
            bridgeData.name,
            tenantId,
            bridgeData.id
        );
        
        await pool.query(
            `UPDATE ${tenantSchema}.bridges 
             SET output_credentials = output_credentials || $1::jsonb
             WHERE id = $2`,
            [JSON.stringify({ thread_id: threadInfo.threadId, thread_name: threadInfo.threadName }), bridgeData.id]
        );
        
        await discordBotManager.sendInitialMessage(threadInfo.threadId, bridgeData.name, bridgeData.output_01_url);
        
        res.json({ success: true, threadInfo });
    } catch (error) {
        console.error('❌ Internal thread creation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ADMIN API: Get Nyanbook Ledger Settings (Dev #01 only)
app.get('/api/admin/ledger-settings', requireAuth, requireRole('dev'), async (req, res) => {
    try {
        // Return current settings (masked for security display)
        const webhookUrl = process.env.NYANBOOK_WEBHOOK_URL || '';
        const botToken = process.env.DISCORD_BOT_TOKEN || '';
        
        res.json({
            webhookUrl: webhookUrl ? '[SET - Click to update]' : '[NOT SET]',
            botToken: botToken ? '[SET - Click to update]' : '[NOT SET]',
            _note: 'Values are masked for security. Enter new values to update.'
        });
    } catch (error) {
        console.error('❌ Error fetching ledger settings:', error);
        res.status(500).json({ error: error.message });
    }
});

// ADMIN API: Update Nyanbook Ledger Settings (Dev #01 only)
app.post('/api/admin/ledger-settings', requireAuth, requireRole('dev'), async (req, res) => {
    try {
        const { webhookUrl, botToken } = req.body;
        
        if (!webhookUrl && !botToken) {
            return res.status(400).json({ error: 'At least one setting must be provided' });
        }
        
        const fs = require('fs');
        const path = require('path');
        
        // Read current .env file (if exists)
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        
        try {
            if (fs.existsSync(envPath)) {
                envContent = fs.readFileSync(envPath, 'utf8');
            }
        } catch (readError) {
            console.warn('⚠️  Could not read .env file, will create new one');
        }
        
        // Parse existing .env into a map
        const envVars = new Map();
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key) {
                    envVars.set(key.trim(), valueParts.join('=').trim());
                }
            }
        });
        
        // Update values
        if (webhookUrl) {
            envVars.set('NYANBOOK_WEBHOOK_URL', webhookUrl);
            console.log('🔗 Updated NYANBOOK_WEBHOOK_URL');
        }
        
        if (botToken) {
            envVars.set('DISCORD_BOT_TOKEN', botToken);
            console.log('🤖 Updated DISCORD_BOT_TOKEN');
        }
        
        // Write back to .env file
        const newEnvContent = Array.from(envVars.entries())
            .map(([key, value]) => `${key}=${value}`)
            .join('\n') + '\n';
        
        fs.writeFileSync(envPath, newEnvContent, 'utf8');
        
        // Also update process.env for immediate effect (partial - requires restart for full effect)
        if (webhookUrl) {
            process.env.NYANBOOK_WEBHOOK_URL = webhookUrl;
        }
        if (botToken) {
            process.env.DISCORD_BOT_TOKEN = botToken;
        }
        
        console.log(`✅ Ledger settings updated by ${req.session?.email || 'dev user'}`);
        
        res.json({
            success: true,
            message: 'Settings updated successfully',
            updated: {
                webhookUrl: !!webhookUrl,
                botToken: !!botToken
            },
            requiresRestart: true,
            _note: 'Server restart required for Discord bot changes to take full effect'
        });
        
    } catch (error) {
        console.error('❌ Error updating ledger settings:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🌐 Dashboard available at http://localhost:${PORT}`);
    
    // CRITICAL: Initialize managers BEFORE database/session restore
    // This prevents race conditions where routes try to access null managers
    whatsappManager = new BaileysClientManager(pool);
    console.log('✅ Baileys WhatsApp Client Manager initialized (no Chromium required)');
    
    discordBotManager = new DiscordBotManager();
    try {
        await discordBotManager.initialize();
        console.log('🤖 Discord bot ready for thread management');
    } catch (error) {
        console.error('❌ Discord bot initialization failed:', error.message);
        console.error('   Bridge thread creation will be unavailable');
    }
    
    await initializeDatabase();
    console.log('✅ Multi-tenant WhatsApp Bridge ready');
    
    // Auto-restore WhatsApp sessions for 24/7 uptime
    await autoRestoreWhatsAppSessions();
    console.log('📱 All bridges with saved sessions are now active');
    
    // 3-DAY MEDIA PURGE: Clean up old media from buffer
    // Nyanbook Ledger has permanent copy, so buffer only needed for retry safety
    async function purgeOldMedia() {
        try {
            console.log('🧹 Starting 3-day media purge...');
            
            // Get all tenant schemas
            const schemas = await pool.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);
            
            let totalPurged = 0;
            
            for (const { schema_name } of schemas.rows) {
                const result = await pool.query(`
                    DELETE FROM ${schema_name}.media_buffer 
                    WHERE created_at < NOW() - INTERVAL '3 days'
                    RETURNING id
                `);
                
                if (result.rowCount > 0) {
                    console.log(`  🗑️  Purged ${result.rowCount} media entries from ${schema_name}`);
                    totalPurged += result.rowCount;
                }
            }
            
            console.log(`✅ Media purge complete: ${totalPurged} total entries removed`);
        } catch (error) {
            console.error('❌ Media purge failed:', error.message);
        }
    }
    
    // Run purge immediately on startup
    await purgeOldMedia();
    
    // Schedule purge every 24 hours
    setInterval(purgeOldMedia, 24 * 60 * 60 * 1000);
    console.log('⏰ 3-day media purge scheduled (runs every 24 hours)');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await whatsappManager.cleanup();
    process.exit(0);
});
