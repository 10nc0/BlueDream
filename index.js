const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcrypt');
const twilio = require('twilio');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const authService = require('./auth-service');
const TenantManager = require('./tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./tenant-middleware');
const WhatsAppClientManager = require('./whatsapp-client-manager');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

if (!DISCORD_WEBHOOK_URL) {
    console.error('❌ ERROR: DISCORD_WEBHOOK_URL environment variable is required!');
    console.error('Please set your Discord webhook URL in the Secrets tab.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
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
        secure: true, // Required for Safari/iPad over HTTPS
        sameSite: 'none', // Required for cross-site iframe embedding
        partitioned: true // Required for Safari to accept cookies in iframes (CHIPS)
    },
    name: 'bridge.sid' // Custom session cookie name
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT id, email, role, google_id FROM users WHERE id = $1', [id]);
        done(null, result.rows[0]);
    } catch (error) {
        done(error, null);
    }
});

// Google OAuth Strategy (only if credentials are provided)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'https://whats-app-discord-bridge.replit.app/api/auth/google/callback';
    
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const googleId = profile.id;
            const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
            
            // Check if user exists by Google ID
            let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
            
            if (result.rows.length > 0) {
                // Existing user - log in
                return done(null, result.rows[0]);
            }
            
            // Check if user exists by email
            if (email) {
                result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
                if (result.rows.length > 0) {
                    // Link Google ID to existing email account
                    await pool.query('UPDATE users SET google_id = $1, provider = $2 WHERE id = $3', 
                        [googleId, 'google', result.rows[0].id]);
                    return done(null, result.rows[0]);
                }
            }
            
            // New user via Google OAuth - create as genesis admin with new tenant
            // Note: Invite-based Google OAuth not supported yet (user must use email signup for invites)
            result = await pool.query(`
                INSERT INTO users (email, google_id, provider, role, is_genesis_admin)
                VALUES ($1, $2, 'google', 'admin', true)
                RETURNING id, email, google_id, role
            `, [email, googleId]);
            
            const newUser = result.rows[0];
            
            // Create tenant for new Google OAuth user
            const tenant = await tenantManager.createTenant(newUser.id);
            console.log(`[${getTimestamp()}] 🌟 GENESIS ADMIN created via Google OAuth - Email: ${email}, Tenant: ${tenant.tenantId}`);
            
            return done(null, newUser);
        } catch (error) {
            return done(error, null);
        }
    }));
    
    console.log('✅ Google OAuth configured');
} else {
    console.log('ℹ️  Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)');
}

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

// UAT/Test route: LOCALHOST ONLY for testing and screenshots
app.get('/uat', async (req, res) => {
    // SECURITY: Check socket address (cannot be spoofed) instead of X-Forwarded-For
    const socketIP = req.socket.remoteAddress;
    const isLocalhost = socketIP === '127.0.0.1' || 
                       socketIP === '::1' || 
                       socketIP === '::ffff:127.0.0.1' ||
                       (socketIP && socketIP.startsWith('127.'));
    
    if (!isLocalhost) {
        console.warn(`[${getTimestamp()}] ⚠️  UAT access denied - Socket IP: ${socketIP}`);
        return res.status(403).send('UAT mode is only available from localhost');
    }
    
    try {
        const userResult = await pool.query('SELECT id, email, role FROM users WHERE email = $1', ['admin@bridge.local']);
        const user = userResult.rows.length > 0 ? userResult.rows[0] : { id: 1, email: 'admin@bridge.local', role: 'admin' };
        
        const accessToken = authService.signAccessToken(user.id, user.email, user.role);
        const { token: refreshToken } = authService.signRefreshToken(user.id, user.email, user.role);
        
        console.log(`[${getTimestamp()}] 🧪 UAT mode accessed - Socket IP: ${socketIP}`);
        
        const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
        const injectedHtml = html.replace(
            '</head>',
            `<script>
                // UAT mode: inject real auth tokens for testing (LOCALHOST ONLY)
                localStorage.setItem('accessToken', '${accessToken}');
                localStorage.setItem('refreshToken', '${refreshToken}');
            </script></head>`
        );
        res.send(injectedHtml);
    } catch (error) {
        console.error('UAT mode error:', error);
        res.status(500).send('UAT mode initialization failed');
    }
});

// Health check endpoint for deployment health checks
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Serve main dashboard - client-side JWT auth will handle access control
app.get('/', async (req, res) => {
    // Health check support: return 200 for HEAD requests (used by deployment health checks)
    if (req.method === 'HEAD') {
        return res.status(200).end();
    }
    
    // Test/UAT mode: LOCALHOST ONLY to prevent unauthorized admin access
    if (req.query.test === '1' || req.query.uat === '1') {
        // SECURITY: Check socket address (cannot be spoofed) instead of X-Forwarded-For
        const socketIP = req.socket.remoteAddress;
        const isLocalhost = socketIP === '127.0.0.1' || 
                           socketIP === '::1' || 
                           socketIP === '::ffff:127.0.0.1' ||
                           (socketIP && socketIP.startsWith('127.'));
        
        if (!isLocalhost) {
            console.warn(`[${getTimestamp()}] ⚠️  Test mode denied - Socket IP: ${socketIP}`);
            return res.sendFile(__dirname + '/public/index.html');
        }
        
        try {
            const userResult = await pool.query('SELECT id, email, role FROM users WHERE email = $1', ['admin@bridge.local']);
            const user = userResult.rows.length > 0 ? userResult.rows[0] : { id: 1, email: 'admin@bridge.local', role: 'admin' };
            
            const accessToken = authService.signAccessToken(user.id, user.email, user.role);
            const { token: refreshToken } = authService.signRefreshToken(user.id, user.email, user.role);
            
            console.log(`[${getTimestamp()}] 🧪 Test mode accessed - Socket IP: ${socketIP}`);
            
            const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
            const injectedHtml = html.replace(
                '</head>',
                `<script>
                    // Test/UAT mode: inject real auth tokens (LOCALHOST ONLY)
                    localStorage.setItem('accessToken', '${accessToken}');
                    localStorage.setItem('refreshToken', '${refreshToken}');
                </script></head>`
            );
            return res.send(injectedHtml);
        } catch (error) {
            console.error('Test mode error:', error);
        }
    }
    res.sendFile(__dirname + '/public/index.html');
});

// Serve index.html - client-side JWT auth will handle access control
app.get('/index.html', async (req, res) => {
    // Test/UAT mode: LOCALHOST ONLY to prevent unauthorized admin access
    if (req.query.test === '1' || req.query.uat === '1') {
        // SECURITY: Check socket address (cannot be spoofed) instead of X-Forwarded-For
        const socketIP = req.socket.remoteAddress;
        const isLocalhost = socketIP === '127.0.0.1' || 
                           socketIP === '::1' || 
                           socketIP === '::ffff:127.0.0.1' ||
                           (socketIP && socketIP.startsWith('127.'));
        
        if (!isLocalhost) {
            console.warn(`[${getTimestamp()}] ⚠️  Test mode denied - Socket IP: ${socketIP}`);
            return res.sendFile(__dirname + '/public/index.html');
        }
        
        try {
            const userResult = await pool.query('SELECT id, email, role FROM users WHERE email = $1', ['admin@bridge.local']);
            const user = userResult.rows.length > 0 ? userResult.rows[0] : { id: 1, email: 'admin@bridge.local', role: 'admin' };
            
            const accessToken = authService.signAccessToken(user.id, user.email, user.role);
            const { token: refreshToken } = authService.signRefreshToken(user.id, user.email, user.role);
            
            console.log(`[${getTimestamp()}] 🧪 Test mode accessed - Socket IP: ${socketIP}`);
            
            const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
            const injectedHtml = html.replace(
                '</head>',
                `<script>
                    // Test/UAT mode: inject real auth tokens (LOCALHOST ONLY)
                    localStorage.setItem('accessToken', '${accessToken}');
                    localStorage.setItem('refreshToken', '${refreshToken}');
                </script></head>`
            );
            return res.send(injectedHtml);
        } catch (error) {
            console.error('Test mode error:', error);
        }
    }
    res.sendFile(__dirname + '/public/index.html');
});

// Serve only non-HTML static files without authentication
// HTML files are served through explicit authenticated routes above
app.use(express.static('public', { 
    index: false,
    ignore: ['*.html'] // Don't serve HTML files through static middleware
}));

// Apply tenant context middleware to all API routes (except auth routes)
app.use('/api/bots', setTenantContext);
app.use('/api/messages', setTenantContext);
app.use('/api/users', setTenantContext);
app.use('/api/sessions', setTenantContext);
app.use('/api/audit', setTenantContext);
app.use('/api/analytics', setTenantContext);

// Multi-tenant WhatsApp Client Manager
// Each bot gets its own WhatsApp session (one per tenant)
let whatsappManager = null;

async function initializeDatabase() {
    try {
        await tenantManager.initializeCoreSchema();
        
        // Create bots table first (in public schema for backwards compatibility)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bots (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                input_platform TEXT NOT NULL,
                output_platform TEXT NOT NULL,
                input_credentials JSONB,
                output_credentials JSONB,
                status TEXT DEFAULT 'inactive',
                contact_info TEXT,
                tags TEXT[],
                archived BOOLEAN DEFAULT false NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        
        // Create default bot if none exists (needed before messages migration)
        const botsCount = await pool.query('SELECT COUNT(*) FROM bots');
        if (parseInt(botsCount.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO bots (name, input_platform, output_platform, input_credentials, output_credentials, status)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                'WhatsApp → Discord Bridge',
                'WhatsApp',
                'Discord',
                JSON.stringify({}),
                JSON.stringify({ webhook_url: process.env.DISCORD_WEBHOOK_URL || '' }),
                'active'
            ]);
            console.log('✅ Created default bot');
        }
        
        // Create messages table if it doesn't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                sender_name TEXT NOT NULL,
                sender_contact TEXT NOT NULL,
                message_content TEXT NOT NULL,
                discord_status TEXT NOT NULL,
                discord_error TEXT,
                has_media BOOLEAN DEFAULT FALSE,
                media_type TEXT,
                media_data TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        
        // Add bot_id column if it doesn't exist (migration for existing tables)
        const columnCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='messages' AND column_name='bot_id'
        `);
        
        if (columnCheck.rows.length === 0) {
            console.log('📝 Adding bot_id column to messages table...');
            await pool.query(`
                ALTER TABLE messages 
                ADD COLUMN bot_id INTEGER DEFAULT 1 REFERENCES bots(id) ON DELETE CASCADE
            `);
            console.log('✅ Added bot_id column');
        }
        
        // Add contact_info column if it doesn't exist
        const contactCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='bots' AND column_name='contact_info'
        `);
        
        if (contactCheck.rows.length === 0) {
            console.log('📝 Adding contact_info and tags columns to bots table...');
            await pool.query(`
                ALTER TABLE bots 
                ADD COLUMN contact_info TEXT,
                ADD COLUMN tags TEXT[]
            `);
            console.log('✅ Added contact_info and tags columns');
        }
        
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
        
        // Create performance indexes for frequently queried columns
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_bot_id ON messages(bot_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(discord_status)
        `);
        
        // Composite index for bot + timestamp (most common query pattern)
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_bot_timestamp ON messages(bot_id, timestamp DESC)
        `);
        
        // Create dev user (phi_dao@pm.me) with system-level access
        const devCheck = await pool.query('SELECT id FROM users WHERE email = $1', ['phi_dao@pm.me']);
        if (devCheck.rows.length === 0) {
            const devPassword = await bcrypt.hash('dev_secure_2024', 10);
            await pool.query(`
                INSERT INTO users (email, password_hash, role, is_genesis_admin)
                VALUES ($1, $2, 'dev', false)
            `, ['phi_dao@pm.me', devPassword]);
            console.log('✅ Created dev user: phi_dao@pm.me (role: dev)');
            console.log('🔧 Dev role has system-level access across all tenants');
        }
        
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        throw error;
    }
}

// Helper function to send message to all configured webhooks (1-to-many support)
// CRITICAL: Uses tenant-aware lookup to get the correct bot's webhooks
async function sendToAllWebhooks(payload, options = {}, messageDbId = null, mediaData = null, botId = null, tenantSchema = null) {
    try {
        if (!botId || !tenantSchema) {
            console.error('❌ sendToAllWebhooks called without botId or tenantSchema');
            return;
        }
        
        // Get webhooks from bot configuration (tenant-aware)
        const botResult = await pool.query(`
            SELECT output_credentials FROM ${tenantSchema}.bots WHERE id = $1 LIMIT 1
        `, [botId]);
        
        if (botResult.rows.length === 0) {
            console.error(`❌ No bot configuration found for bot ${botId} in ${tenantSchema}`);
            return;
        }
        
        const webhooks = botResult.rows[0].output_credentials?.webhooks || [];
        
        // Fallback to legacy webhook_url if webhooks array is empty
        if (webhooks.length === 0 && botResult.rows[0].output_credentials?.webhook_url) {
            webhooks.push({
                name: 'Main Channel',
                url: botResult.rows[0].output_credentials.webhook_url
            });
        }
        
        // Fallback to DISCORD_WEBHOOK_URL if still no webhooks
        if (webhooks.length === 0 && DISCORD_WEBHOOK_URL) {
            webhooks.push({
                name: 'Default Channel',
                url: DISCORD_WEBHOOK_URL
            });
        }
        
        if (webhooks.length === 0) {
            throw new Error('No webhooks configured');
        }
        
        // Send to all webhooks
        let successCount = 0;
        let failures = [];
        
        for (const webhook of webhooks) {
            if (!webhook.url) continue;
            
            try {
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
                    
                    form.append('payload_json', JSON.stringify(payload));
                    
                    await axios.post(webhook.url, form, {
                        headers: form.getHeaders()
                    });
                } else {
                    // For text-only messages, send JSON payload directly
                    await axios.post(webhook.url, payload);
                }
                
                successCount++;
                console.log(`  ✅ Sent to webhook: ${webhook.name || webhook.url.substring(0, 50)}`);
            } catch (error) {
                const errorMsg = `Failed to send to ${webhook.name || 'webhook'}: ${error.message}`;
                failures.push(errorMsg);
                console.error(`  ❌ ${errorMsg}`);
            }
        }
        
        // Update message status based on results
        if (messageDbId) {
            if (successCount > 0) {
                await updateMessageStatus(pool, messageDbId, 'success', null, mediaData, options.mimetype);
            } else if (failures.length > 0) {
                await updateMessageStatus(pool, messageDbId, 'failed', failures.join('; '));
            }
        }
        
        console.log(`📤 Sent to ${successCount}/${webhooks.length} webhooks`);
        
    } catch (error) {
        console.error('❌ Error sending to webhooks:', error.message);
        if (messageDbId) {
            await updateMessageStatus(pool, messageDbId, 'failed', error.message);
        }
        throw error;
    }
}

async function saveMessage(client, message, botId = 1) {
    try {
        const result = await client.query(
            `INSERT INTO messages (bot_id, timestamp, sender_name, sender_contact, message_content, discord_status, discord_error, has_media, media_type, media_data, sender_photo_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
                botId,
                message.timestamp,
                message.senderName,
                message.senderContact,
                message.messageContent,
                message.discordStatus,
                message.discordError || null,
                message.hasMedia || false,
                message.mediaType || null,
                message.mediaData || null,
                message.senderPhotoUrl || null
            ]
        );
        return result.rows[0].id;
    } catch (error) {
        console.error('Error saving message to database:', error.message);
        return null;
    }
}

async function updateMessageStatus(client, messageId, status, errorMessage = null, mediaData = null, mediaType = null) {
    try {
        await client.query(
            `UPDATE messages 
             SET discord_status = $1, 
                 discord_error = $2, 
                 media_data = COALESCE($3, media_data),
                 media_type = COALESCE($5, media_type),
                 has_media = CASE WHEN $3 IS NOT NULL THEN true ELSE has_media END
             WHERE id = $4`,
            [status, errorMessage, mediaData, messageId, mediaType]
        );
    } catch (error) {
        console.error('Error updating message status:', error.message);
    }
}

async function getMessages(client, searchFilter = null, statusFilter = null) {
    try {
        let query = 'SELECT * FROM messages';
        const conditions = [];
        const params = [];
        let paramCount = 1;
        
        if (searchFilter) {
            conditions.push(`(
                LOWER(sender_name) LIKE $${paramCount} OR
                sender_contact LIKE $${paramCount} OR
                LOWER(message_content) LIKE $${paramCount}
            )`);
            params.push(`%${searchFilter.toLowerCase()}%`);
            paramCount++;
        }
        
        if (statusFilter && statusFilter !== 'all') {
            conditions.push(`discord_status = $${paramCount}`);
            params.push(statusFilter);
            paramCount++;
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY timestamp DESC LIMIT 1000';
        
        const result = await client.query(query, params);
        
        return result.rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            sender_name: row.sender_name,
            sender_contact: row.sender_contact,
            message_content: row.message_content,
            discord_status: row.discord_status,
            discord_error: row.discord_error,
            has_media: row.has_media,
            media_type: row.media_type,
            media_data: row.media_data,
            sender_photo_url: row.sender_photo_url
        }));
    } catch (error) {
        console.error('Error retrieving messages from database:', error.message);
        return [];
    }
}

async function getMessageStats(client) {
    try {
        const result = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'success') as success,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE discord_status = 'pending') as pending
            FROM messages
        `);
        
        return {
            total: parseInt(result.rows[0].total),
            success: parseInt(result.rows[0].success),
            failed: parseInt(result.rows[0].failed),
            pending: parseInt(result.rows[0].pending)
        };
    } catch (error) {
        console.error('Error retrieving stats from database:', error.message);
        return { total: 0, success: 0, failed: 0, pending: 0 };
    }
}

function getChromiumPath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    try {
        const path = execSync('which chromium-browser || which chromium', { encoding: 'utf8' }).trim();
        if (path && fs.existsSync(path)) {
            return path;
        }
    } catch (error) {
        console.warn('Warning: Could not auto-detect Chromium path');
    }
    
    return undefined;
}

const chromiumPath = getChromiumPath();
if (!chromiumPath) {
    console.error('❌ ERROR: Could not find Chromium executable!');
    console.error('Please set PUPPETEER_EXECUTABLE_PATH environment variable.');
    process.exit(1);
}

console.log(`✅ Using Chromium at: ${chromiumPath}`);

// Initialize multi-tenant WhatsApp Client Manager
whatsappManager = new WhatsAppClientManager(pool, chromiumPath);

/**
 * Get the tenant schema that owns a specific bot
 * This ensures bot activities are tracked in the correct tenant's database
 */
async function getBotTenantSchema(botId) {
    try {
        // Query all tenant schemas to find which one owns this bot
        const schemasResult = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        for (const row of schemasResult.rows) {
            const schema = row.schema_name;
            const botCheck = await pool.query(`
                SELECT id FROM ${schema}.bots WHERE id = $1
            `, [botId]);
            
            if (botCheck.rows.length > 0) {
                console.log(`✅ Bot ${botId} belongs to ${schema}`);
                return schema;
            }
        }
        
        // Fallback to public if not found (shouldn't happen)
        console.warn(`⚠️ Bot ${botId} not found in any tenant schema, defaulting to public`);
        return 'public';
    } catch (error) {
        console.error(`❌ Error finding tenant for bot ${botId}:`, error);
        return 'public';
    }
}

/**
 * Tenant-aware WhatsApp message handler
 * Routes messages to the correct tenant's schema based on botId
 */
async function createTenantAwareMessageHandler(message, botId, tenantSchema) {
    let messageDbId = null;
    
    try {
        // Get tenant-scoped database client
        const tenantClient = await pool.connect();
        try {
            await tenantClient.query('BEGIN');
            await tenantClient.query(`SET LOCAL search_path TO ${tenantSchema}`);
            
            const chat = await message.getChat();
            const contact = await message.getContact();
            
            // Check if we should forward this message (basic filtering)
            const shouldForward = !chat.isGroup && message.fromMe === false;
            if (!shouldForward) {
                await tenantClient.query('COMMIT');
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
                mediaType: message.hasMedia ? 'image' : null,
                mediaData: null,
                senderPhotoUrl,
                timestamp: timestamp.toISOString(),
                discordStatus: 'pending'
            };
            
            // Save message to tenant's schema
            messageDbId = await saveMessage(tenantClient, messageRecord, botId);
            
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
                    text: `WhatsApp Bridge - Bot ${botId}`
                }
            };

            const discordPayload = {
                username: 'WhatsApp Bridge',
                avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg',
                embeds: [embed]
            };

            // Handle media messages
            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    if (media && media.mimetype.startsWith('image/')) {
                        const mediaData = `data:${media.mimetype};base64,${media.data}`;
                        const buffer = Buffer.from(media.data, 'base64');
                        const filename = `whatsapp_image_${Date.now()}.${media.mimetype.split('/')[1]}`;
                        
                        // CRITICAL: Save media to database so it can be viewed in the dashboard
                        await tenantClient.query(`
                            UPDATE messages 
                            SET media_data = $1, media_type = $2 
                            WHERE id = $3
                        `, [mediaData, media.mimetype, messageDbId]);
                        
                        console.log(`💾 Saved media to database for message ${messageDbId}`);
                        
                        embed.fields.push({
                            name: '📎 Attachment',
                            value: `Image (${media.mimetype})`,
                            inline: false
                        });
                        
                        // Send to Discord with media
                        await sendToAllWebhooks(discordPayload, {
                            isMedia: true,
                            mediaBuffer: buffer,
                            filename: filename,
                            mimetype: media.mimetype
                        }, messageDbId, mediaData, botId, tenantSchema);
                        
                        await tenantClient.query('COMMIT');
                        tenantClient.release();
                        console.log(`✅ [Bot ${botId}] Forwarded media message from ${senderName}`);
                        return;
                    }
                } catch (mediaError) {
                    console.error(`❌ [Bot ${botId}] Error downloading media:`, mediaError.message);
                    if (messageDbId) {
                        await updateMessageStatus(tenantClient, messageDbId, 'failed', mediaError.message);
                    }
                    await tenantClient.query('COMMIT');
                    tenantClient.release();
                    return;
                }
            }

            // Send text-only message to Discord
            await sendToAllWebhooks(discordPayload, {}, messageDbId, null, botId, tenantSchema);
            console.log(`✅ [Bot ${botId}] Forwarded message from ${senderName}`);
            
            await tenantClient.query('COMMIT');
            tenantClient.release();
        } catch (error) {
            await tenantClient.query('ROLLBACK');
            tenantClient.release();
            throw error;
        }
    } catch (error) {
        console.error(`❌ [Bot ${botId}] Error handling message:`, error.message);
        if (messageDbId) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`SET LOCAL search_path TO ${tenantSchema}`);
                await updateMessageStatus(client, messageDbId, 'failed', error.message);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
            } finally {
                client.release();
            }
        }
    }
}

// ============ MULTI-TENANT WHATSAPP - LEGACY FUNCTION REMOVED ============
// The old global initializeWhatsAppClient() has been replaced with bot-level management.
// Each bot now gets its own WhatsApp session via the WhatsAppClientManager.
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

// OLD initializeWhatsAppClient() function removed - replaced with per-bot management
// See bot-level API endpoints below: POST /api/bots/:id/start, DELETE /api/bots/:id/stop, etc.
// Each bot now has its own independent WhatsApp session managed by WhatsAppClientManager

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

// Create session tracking record
async function createSessionRecord(userId, sessionId, req) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const location = await getLocationFromIP(req.ip);
        
        await pool.query(`
            INSERT INTO active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [userId, sessionId, req.ip, userAgent, deviceType, browser, os, location]);
        
        console.log(`[${getTimestamp()}] 📱 Session created - User: ${userId}, Device: ${deviceType}, Browser: ${browser}, OS: ${os}, IP: ${req.ip}, Location: ${location}`);
    } catch (error) {
        console.error('Error creating session record:', error.message);
    }
}

// ============ AUDIT LOGGING SYSTEM ============

// Helper function to log audit events
async function logAudit(client, req, actionType, targetType, targetId, targetEmail, details = {}) {
    try {
        const actorUserId = req.session?.userId || null;
        let actorEmail = null;
        
        if (actorUserId) {
            const userResult = await client.query('SELECT email FROM users WHERE id = $1', [actorUserId]);
            actorEmail = userResult.rows[0]?.email || null;
        }
        
        await client.query(`
            INSERT INTO audit_logs (
                actor_user_id, actor_email, action_type, target_type, 
                target_id, target_email, details, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            actorUserId,
            actorEmail,
            actionType,
            targetType,
            targetId,
            targetEmail,
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
function requireAuth(req, res, next) {
    // Try JWT authentication first (Authorization header)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = authService.verifyToken(token);
        
        if (decoded && decoded.type === 'access') {
            // Valid JWT token
            req.userId = decoded.userId;
            req.userEmail = decoded.email;
            req.userRole = decoded.role;
            req.authMethod = 'jwt';
            return next();
        }
    }
    
    // Fall back to cookie-based session auth
    if (req.session && req.session.userId) {
        req.userId = req.session.userId;
        req.userEmail = req.session.userEmail;
        req.userRole = req.session.userRole;
        req.authMethod = 'cookie';
        return next();
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
        
        const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
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

// Check if user is logged in (supports both JWT and cookies)
app.get('/api/auth/status', async (req, res) => {
    // Check JWT first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = authService.verifyToken(token);
        
        if (decoded && decoded.type === 'access') {
            const result = await pool.query('SELECT id, email, role, google_id FROM users WHERE id = $1', [decoded.userId]);
            if (result.rows.length > 0) {
                return res.json({ authenticated: true, user: result.rows[0], authMethod: 'jwt' });
            }
        }
    }
    
    // Fall back to session
    if (req.session && req.session.userId) {
        const result = await pool.query('SELECT id, email, role, google_id FROM users WHERE id = $1', [req.session.userId]);
        if (result.rows.length > 0) {
            return res.json({ authenticated: true, user: result.rows[0], authMethod: 'cookie' });
        }
    }
    res.json({ authenticated: false });
});

// Email/Password Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    // Log all login attempts
    console.log(`[${getTimestamp()}] 🔐 Login attempt - Email: ${email}, IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
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
        
        // Generate JWT tokens
        const accessToken = authService.signAccessToken(user.id, user.email, user.role);
        const { token: refreshToken, tokenId } = authService.signRefreshToken(user.id, user.email, user.role);
        
        // Store refresh token in database
        const deviceInfo = req.get('user-agent') || 'unknown';
        await authService.storeRefreshToken(pool, user.id, tokenId, deviceInfo, req.ip);
        
        // Save session explicitly before sending response
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(user.id, req.sessionID, req);
            
            // Log successful login
            logAudit(pool, req, 'LOGIN', 'USER', user.id.toString(), user.email, {
                method: 'email_password',
                role: user.role,
                authType: 'jwt+cookie'
            });
            
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
        const userCount = await pool.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCount.rows[0].count) === 0;
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
        
        // Check if email already exists
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
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
            `, [email, passwordHash, invite.target_role, invite.tenant_id]);
            
            newUser = result.rows[0];
            tenantId = invite.tenant_id;
            
            // Consume the invite token
            await tenantManager.consumeInviteToken(inviteToken);
            
            console.log(`[${getTimestamp()}] ✅ User joined tenant ${tenantId} via invite - Email: ${email}, Role: ${invite.target_role}`);
        }
        // BRANCH: New tenant creation (no invite = genesis admin)
        else {
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
            
            // Create user as genesis admin (no tenant yet)
            const result = await pool.query(`
                INSERT INTO users (email, password_hash, role, is_genesis_admin)
                VALUES ($1, $2, 'admin', true)
                RETURNING id, email, role, is_genesis_admin
            `, [email, passwordHash]);
            
            newUser = result.rows[0];
            
            // Create new tenant and schema
            const tenant = await tenantManager.createTenant(newUser.id);
            tenantId = tenant.tenantId;
            
            // Record tenant creation for Sybil tracking
            await tenantManager.recordTenantCreation(email, req.ip);
            
            isGenesisAdmin = true;
            console.log(`[${getTimestamp()}] 🌟 GENESIS ADMIN created new tenant ${tenantId} - Email: ${email}`);
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

// Google OAuth Routes (only if configured)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    app.get('/api/auth/google', passport.authenticate('google', { 
        scope: ['profile', 'email'] 
    }));

    app.get('/api/auth/google/callback', 
        passport.authenticate('google', { failureRedirect: '/login.html' }),
        async (req, res) => {
            try {
                const user = req.user;
                
                // Generate JWT tokens
                const accessToken = authService.signAccessToken(user.id, user.email, user.role);
                const { token: refreshToken, tokenId } = authService.signRefreshToken(user.id, user.email, user.role);
                
                // Store refresh token
                const deviceInfo = req.get('user-agent') || 'unknown';
                await authService.storeRefreshToken(pool, user.id, tokenId, deviceInfo, req.ip);
                
                // Create session tracking record
                await createSessionRecord(user.id, req.sessionID, req);
                
                // Log Google OAuth login
                logAudit(pool, req, 'LOGIN', 'USER', user.id.toString(), user.email, {
                    method: 'google_oauth',
                    role: user.role,
                    authType: 'jwt+cookie'
                });
                
                console.log(`[${getTimestamp()}] ✅ Google OAuth login - User: ${user.email}, Role: ${user.role}`);
                
                // Redirect to dashboard with tokens in URL (will be saved to localStorage by client)
                const redirectUrl = `/?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`;
                res.redirect(redirectUrl);
            } catch (error) {
                console.error('Google OAuth callback error:', error);
                res.redirect('/login.html?error=oauth_failed');
            }
        }
    );
} else {
    // Google OAuth not configured - return error
    app.get('/api/auth/google', (req, res) => {
        res.status(503).json({ 
            error: 'Google OAuth is not configured on this server',
            message: 'Please contact the administrator or use email/password signup'
        });
    });
    
    app.get('/api/auth/google/callback', (req, res) => {
        res.redirect('/login.html?error=oauth_not_configured');
    });
}

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

// Phone OTP: Request OTP
app.post('/api/auth/otp/request', async (req, res) => {
    const { phone } = req.body;
    
    try {
        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        
        // Check if user exists, if not create one
        const existingUser = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        
        if (existingUser.rows.length === 0) {
            await pool.query(`
                INSERT INTO users (phone, otp_code, otp_expires_at)
                VALUES ($1, $2, $3)
            `, [phone, otpCode, otpExpiresAt]);
        } else {
            await pool.query(`
                UPDATE users 
                SET otp_code = $1, otp_expires_at = $2
                WHERE phone = $3
            `, [otpCode, otpExpiresAt, phone]);
        }
        
        // TODO: Send OTP via Twilio (requires TWILIO credentials in env)
        // For now, return OTP in response (DEV ONLY - remove in production!)
        console.log(`📱 OTP for ${phone}: ${otpCode}`);
        
        res.json({ 
            success: true, 
            message: 'OTP sent',
            // DEV ONLY - remove this in production!
            devOtp: otpCode 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Phone OTP: Verify OTP
app.post('/api/auth/otp/verify', async (req, res) => {
    const { phone, otp } = req.body;
    
    try {
        const result = await pool.query(`
            SELECT * FROM users 
            WHERE phone = $1 AND otp_code = $2 AND otp_expires_at > NOW()
        `, [phone, otp]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired OTP' });
        }
        
        const user = result.rows[0];
        
        // Clear OTP after successful verification
        await pool.query(`
            UPDATE users 
            SET otp_code = NULL, otp_expires_at = NULL
            WHERE id = $1
        `, [user.id]);
        
        req.session.userId = user.id;
        req.session.userEmail = user.email;
        req.session.userRole = user.role;
        
        // Generate JWT tokens
        const accessToken = authService.signAccessToken(user.id, user.email || user.phone, user.role);
        const { token: refreshToken, tokenId } = authService.signRefreshToken(user.id, user.email || user.phone, user.role);
        
        // Store refresh token in database
        const deviceInfo = req.get('user-agent') || 'unknown';
        await authService.storeRefreshToken(pool, user.id, tokenId, deviceInfo, req.ip);
        
        // Save session explicitly before sending response
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(user.id, req.sessionID, req);
            
            // Log successful OTP login
            logAudit(req, 'LOGIN', 'USER', user.id.toString(), user.phone, {
                method: 'phone_otp',
                role: user.role,
                authType: 'jwt+cookie'
            });
            
            res.json({ 
                success: true, 
                user: { 
                    id: user.id, 
                    phone: user.phone, 
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
        
        // Check if refresh token is still valid in database
        const isValid = await authService.isRefreshTokenValid(pool, decoded.tokenId, decoded.userId);
        if (!isValid) {
            return res.status(401).json({ error: 'Refresh token revoked or expired' });
        }
        
        // Generate new access token
        const accessToken = authService.signAccessToken(decoded.userId, decoded.email, decoded.role);
        
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
        
        // Revoke all refresh tokens for this user (JWT logout)
        if (userId) {
            await authService.revokeAllUserTokens(pool, userId);
            
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

// Public registration (no auth required)
app.post('/api/auth/register/public', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(`
            INSERT INTO users (email, password_hash, role)
            VALUES ($1, $2, $3)
            RETURNING id, email, role
        `, [email, passwordHash, 'user']);
        
        const newUser = result.rows[0];
        
        // Log user registration (no req session yet, so use a special log)
        await pool.query(`
            INSERT INTO audit_logs (actor, action, target, details, ip_address)
            VALUES ($1, $2, $3, $4, $5)
        `, [
            newUser.email,
            'SELF_REGISTER',
            newUser.id.toString(),
            JSON.stringify({ role: newUser.role }),
            req.ip || req.connection?.remoteAddress || 'unknown'
        ]);
        
        res.json({ success: true, user: newUser });
    } catch (error) {
        if (error.code === '23505') {
            res.status(400).json({ error: 'Email already exists' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Forgot password: Request reset code
app.post('/api/auth/forgot-password/request', async (req, res) => {
    const { phone } = req.body;
    
    try {
        // Check if user exists
        const existingUser = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        
        if (existingUser.rows.length === 0) {
            return res.status(404).json({ error: 'No account found with this phone number' });
        }

        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        
        await pool.query(`
            UPDATE users 
            SET otp_code = $1, otp_expires_at = $2
            WHERE phone = $3
        `, [otpCode, otpExpiresAt, phone]);
        
        console.log(`🔑 Password Reset OTP for ${phone}: ${otpCode}`);
        
        res.json({ 
            success: true, 
            message: 'Reset code sent',
            devOtp: otpCode
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Forgot password: Reset password with OTP
app.post('/api/auth/forgot-password/reset', async (req, res) => {
    const { phone, otp, newPassword } = req.body;
    
    try {
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Verify OTP
        const result = await pool.query(`
            SELECT * FROM users 
            WHERE phone = $1 AND otp_code = $2 AND otp_expires_at > NOW()
        `, [phone, otp]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired reset code' });
        }
        
        const user = result.rows[0];
        const passwordHash = await bcrypt.hash(newPassword, 10);
        
        // Update password and clear OTP
        await pool.query(`
            UPDATE users 
            SET password_hash = $1, otp_code = NULL, otp_expires_at = NULL
            WHERE id = $2
        `, [passwordHash, user.id]);
        
        // Log password reset
        await pool.query(`
            INSERT INTO audit_logs (actor, action, target, details, ip_address)
            VALUES ($1, $2, $3, $4, $5)
        `, [
            user.email || user.phone,
            'PASSWORD_RESET',
            user.id.toString(),
            JSON.stringify({ method: 'phone_otp' }),
            req.ip || req.connection?.remoteAddress || 'unknown'
        ]);
        
        res.json({ success: true, message: 'Password reset successful' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// DEV PANEL API (Dev Role Only)
// ===========================

// Get all bridges across all tenants (dev role only)
app.get('/api/dev/bridges', requireAuth, requireRole('dev'), async (req, res) => {
    try {
        console.log('🔧 Dev Panel: Fetching all bridges across all tenants...');
        
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
                const bridgesResult = await pool.query(`
                    SELECT 
                        b.*,
                        COUNT(m.id) as message_count,
                        COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as forwarded_count,
                        COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                        COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count,
                        $1::integer as tenant_id,
                        $2::text as tenant_schema,
                        $3::text as tenant_owner_email
                    FROM ${tenantSchema}.bots b
                    LEFT JOIN ${tenantSchema}.messages m ON b.id = m.bot_id
                    WHERE b.archived = false
                    GROUP BY b.id
                    ORDER BY b.created_at DESC
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
        // Dev users get global view across all tenants
        // Admin users only see their own tenant (handled by setTenantContext middleware)
        const result = await pool.query('SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user role (admin only)
app.put('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    
    try {
        // Get old role before update
        const oldData = await pool.query('SELECT role, email FROM users WHERE id = $1', [id]);
        const oldRole = oldData.rows[0]?.role;
        
        const result = await pool.query(`
            UPDATE users 
            SET role = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, role, tenant_id, is_genesis_admin
        `, [role, id]);
        
        const updatedUser = result.rows[0];
        
        // Log role change
        await logAudit(pool, req, 'UPDATE_ROLE', 'USER', id, updatedUser.email, {
            old_role: oldRole,
            new_role: role
        });
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    
    try {
        // Prevent deleting yourself
        if (parseInt(id) === req.session.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        // Get user info before deletion for audit log
        const userData = await pool.query('SELECT email, role FROM users WHERE id = $1', [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const deletedUser = userData.rows[0];
        
        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
        
        // Log user deletion
        await logAudit(pool, req, 'DELETE_USER', 'USER', id, deletedUser.email, {
            role: deletedUser.role
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user email (admin only)
app.put('/api/users/:id/email', requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    
    try {
        // Validate email presence and format
        if (!email || !email.trim()) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        // Check if email already exists
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, id]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        // Get old email before update
        const oldData = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
        const oldEmail = oldData.rows[0]?.email;
        
        const result = await pool.query(`
            UPDATE users 
            SET email = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, phone, role
        `, [email, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const updatedUser = result.rows[0];
        
        // Log email change
        await logAudit(pool, req, 'UPDATE_EMAIL', 'USER', id, updatedUser.email, {
            old_email: oldEmail,
            new_email: email
        });
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user password (admin only)
app.put('/api/users/:id/password', requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    
    try {
        // Validate password presence and strength
        if (!password || !password.trim()) {
            return res.status(400).json({ error: 'Password is required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }
        
        // Get user info for audit log
        const userData = await pool.query('SELECT email, phone FROM users WHERE id = $1', [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userData.rows[0];
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.query(`
            UPDATE users 
            SET password = $1, updated_at = NOW()
            WHERE id = $2
        `, [hashedPassword, id]);
        
        // Log password change
        await logAudit(pool, req, 'UPDATE_PASSWORD', 'USER', id, user.email || user.phone, {
            updated_by_admin: true
        });
        
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
        const client = req.dbClient || pool;
        const stats = await getMessageStats(client);
        const allClients = whatsappManager.getAllClients();
        
        // Aggregate status across all active bots
        const activeCount = allClients.filter(c => c.status === 'ready').length;
        const qrPendingCount = allClients.filter(c => c.status === 'qr_ready').length;
        
        res.json({
            messagesCount: stats.total,
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
        migration: 'Each bot now has its own WhatsApp session. Start a bot with POST /api/bots/:id/start and get its QR with GET /api/bots/:id/qr'
    });
});

// DEPRECATED: Use /api/bots/:id/relink instead (kept for backward compatibility)
app.post('/api/relink', requireRole('admin', 'write-only'), async (req, res) => {
    res.status(410).json({ 
        error: 'This endpoint is deprecated. Use /api/bots/:id/relink for bot-specific relinking.',
        migration: 'Each bot now has its own WhatsApp session. Relink a specific bot with POST /api/bots/:id/relink'
    });
});

app.get('/api/messages', requireAuth, async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const { search, status } = req.query;
        
        const filtered = await getMessages(client, search, status);
        const sanitized = sanitizeForRole(filtered, userRole);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in /api/messages:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const stats = await getMessageStats(client);
        res.json(stats);
    } catch (error) {
        console.error('❌ Error in /api/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Bot management endpoints
// CRITICAL: Complete horizontal tenant isolation with EXPLICIT SCHEMA INDEXING
// Uses dynamic schema names via variable placeholders (fractalized architecture)
app.get('/api/bots', requireAuth, async (req, res) => {
    console.log(`🔍 /api/bots called by user ${req.userId}`);
    
    try {
        // Get tenant schema from authenticated user
        const userResult = await pool.query(
            'SELECT id, email, tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            console.error(`❌ User ${req.userId} not found in database`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const tenantId = user.tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        console.log(`📊 Loading bridges for ${user.email} (user_id=${req.userId}) from ${tenantSchema}`);
        
        // EXPLICIT SCHEMA INDEXING: Use parameterized schema names (fractalized architecture)
        const result = await pool.query(`
            SELECT 
                b.*,
                COUNT(m.id) as message_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as forwarded_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count
            FROM ${tenantSchema}.bots b
            LEFT JOIN ${tenantSchema}.messages m ON b.id = m.bot_id
            WHERE b.archived = false
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `);
        
        console.log(`✅ Found ${result.rows.length} bridges in ${tenantSchema} for ${user.email}`);
        res.json(result.rows);
    } catch (error) {
        console.error(`❌ Error in /api/bots for user ${req.userId}:`, error);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bots', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags } = req.body;
        
        const result = await client.query(
            `INSERT INTO bots (name, input_platform, output_platform, input_credentials, output_credentials, contact_info, tags, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [name, inputPlatform, outputPlatform, inputCredentials || {}, outputCredentials || {}, contactInfo || null, tags || [], 'inactive']
        );
        
        const sanitized = sanitizeForRole(result.rows[0], userRole);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in POST /api/bots:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/bots/:id', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const { id } = req.params;
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags, status } = req.body;
        
        const result = await client.query(
            `UPDATE bots 
             SET name = $1, input_platform = $2, output_platform = $3, 
                 input_credentials = $4, output_credentials = $5, contact_info = $6, tags = $7, status = $8, updated_at = NOW()
             WHERE id = $9 RETURNING *`,
            [name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo || null, tags || [], status, id]
        );
        
        const sanitized = sanitizeForRole(result.rows[0], userRole);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in PUT /api/bots/:id:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete bot (hard delete - removes bot and all messages)
app.delete('/api/bots/:id', requireAuth, setTenantContext, requireRole('admin', 'dev'), async (req, res) => {
    const { id } = req.params;
    const botId = parseInt(id);
    
    try {
        const client = req.dbClient || pool;
        
        // CRITICAL: Get the bot's tenant schema before deletion
        const tenantSchema = await getBotTenantSchema(botId);
        console.log(`🗑️  Deleting bot ${botId} from ${tenantSchema}...`);
        
        // Stop and destroy WhatsApp client if active
        try {
            await whatsappManager.destroyClient(botId, tenantSchema);
            console.log(`✅ WhatsApp client destroyed for bot ${botId}`);
        } catch (error) {
            console.warn(`⚠️  Could not destroy WhatsApp client for bot ${botId}:`, error.message);
        }
        
        // Delete all messages first (foreign key constraint)
        await client.query('DELETE FROM messages WHERE bot_id = $1', [botId]);
        console.log(`✅ Deleted messages for bot ${botId}`);
        
        // Delete the bot
        const result = await client.query('DELETE FROM bots WHERE id = $1 RETURNING *', [botId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }
        
        logAudit(client, req, 'DELETE', 'BOT', botId, null, {
            message: 'Bot and all associated messages deleted',
            tenant_schema: tenantSchema
        });
        
        console.log(`✅ Bot ${botId} deleted successfully by user ${req.userId}`);
        res.json({ success: true, message: 'Bot deleted successfully' });
    } catch (error) {
        console.error(`❌ Error deleting bot ${botId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Archive bot (soft delete - keeps all message history)
app.post('/api/bots/:id/archive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Prevent archiving the default active bot
        if (parseInt(id) === 1) {
            return res.status(400).json({ 
                error: 'Cannot archive the default bot (currently active). Create and activate a new bot first.' 
            });
        }
        
        await pool.query('UPDATE bots SET archived = true, status = $1 WHERE id = $2', ['archived', id]);
        
        logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
            message: 'Bot archived - message history preserved'
        });
        
        res.json({ success: true, message: 'Bot archived. All message history preserved.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Unarchive bot (restore archived bot)
app.post('/api/bots/:id/unarchive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE bots SET archived = false, status = $1 WHERE id = $2', ['inactive', id]);
        
        logAudit(pool, req, 'UNARCHIVE', 'BOT', id, null, {
            message: 'Bot unarchive and restored'
        });
        
        res.json({ success: true, message: 'Bot restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ BOT-LEVEL WHATSAPP MANAGEMENT ENDPOINTS ============
// Multi-tenant WhatsApp: Each bot gets its own WhatsApp session

// Start WhatsApp session for a bot
app.post('/api/bots/:id/start', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const { id } = req.params;
        const botId = parseInt(id);
        
        // CRITICAL: Get the correct tenant schema for this bot
        // This ensures messages are stored in the right tenant's database
        const tenantSchema = await getBotTenantSchema(botId);
        console.log(`🔍 Bot ${id} belongs to ${tenantSchema}`);
        
        // Check if already running
        const existingClient = whatsappManager.getClient(botId);
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
            botId, 
            tenantSchema, 
            createTenantAwareMessageHandler
        );
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session starting...',
            status: clientState.status,
            botId: id
        });
    } catch (error) {
        console.error(`❌ Error starting WhatsApp for bot ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Stop WhatsApp session for a bot (preserves session)
app.delete('/api/bots/:id/stop', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenant_schema || 'public';
        const { id } = req.params;
        
        await whatsappManager.stopClient(parseInt(id), tenantSchema);
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session stopped (will auto-reconnect on restart)',
            botId: id
        });
    } catch (error) {
        console.error(`❌ Error stopping WhatsApp for bot ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Get QR code for a bot
app.get('/api/bots/:id/qr', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const qrCode = whatsappManager.getQRCode(parseInt(id));
        
        if (!qrCode) {
            return res.json({ qr: null, message: 'No QR code available. Start the bot first.' });
        }
        
        // Convert to data URL if needed
        const qrDataUrl = await QRCode.toDataURL(qrCode);
        res.json({ qr: qrDataUrl });
    } catch (error) {
        console.error(`❌ Error getting QR for bot ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Relink WhatsApp session for a bot (destroy and create new QR)
app.post('/api/bots/:id/relink', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    const { id } = req.params;
    const botId = parseInt(id);
    
    try {
        console.log(`🔄 Starting relink for bot ${botId}...`);
        
        // CRITICAL: Get the correct tenant schema for this bot
        const tenantSchema = await getBotTenantSchema(botId);
        console.log(`🔍 Bot ${botId} belongs to ${tenantSchema} (relink)`);
        
        if (!tenantSchema) {
            throw new Error('Unable to determine tenant schema for bot');
        }
        
        const clientState = await whatsappManager.relinkClient(
            botId, 
            tenantSchema, 
            createTenantAwareMessageHandler
        );
        
        console.log(`✅ Relink initiated for bot ${botId}, status: ${clientState.status}`);
        
        res.json({ 
            success: true, 
            message: 'WhatsApp session relinking... New QR code will be available shortly.',
            status: clientState.status,
            botId: botId
        });
    } catch (error) {
        console.error(`❌ Error relinking WhatsApp for bot ${botId}:`, error);
        console.error('Stack trace:', error.stack);
        
        // Ensure JSON response even on error
        if (!res.headersSent) {
            res.status(500).json({ 
                error: error.message || 'Unknown error occurred during relink',
                botId: botId
            });
        }
    }
});

// Get WhatsApp session status for a bot
app.get('/api/bots/:id/status', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const clientState = whatsappManager.getClient(parseInt(id));
        
        if (!clientState) {
            return res.json({ 
                status: 'inactive', 
                message: 'No WhatsApp session for this bot'
            });
        }
        
        res.json({ 
            status: clientState.status,
            phoneNumber: clientState.phoneNumber,
            hasQR: clientState.qrCode !== null,
            botId: id
        });
    } catch (error) {
        console.error(`❌ Error getting status for bot ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Get archived bots (with message history)
app.get('/api/bots/archived', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                b.*,
                COUNT(m.id) as message_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as forwarded_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count
            FROM bots b
            LEFT JOIN messages m ON b.id = m.bot_id
            WHERE b.archived = true
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bots/:id/stats', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'success') as success,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE discord_status = 'pending') as pending
            FROM messages WHERE bot_id = $1
        `, [id]);
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// REMOVED: Duplicate QR endpoint - using the multi-instance version above (line ~2741)

// Get media for a specific message
// CRITICAL: Uses explicit schema indexing for fractalized architecture
app.get('/api/messages/:id/media', requireAuth, async (req, res) => {
    const { id } = req.params;
    console.log(`🖼️ Media request for message ${id} by user ${req.userId}`);
    
    try {
        // Get user's tenant schema
        const userResult = await pool.query(
            'SELECT tenant_id, email FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            console.error(`❌ User ${req.userId} not found`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tenantId = userResult.rows[0].tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        const userEmail = userResult.rows[0].email;
        
        console.log(`🔍 Looking for message ${id} in ${tenantSchema} for ${userEmail}`);
        
        // EXPLICIT SCHEMA INDEXING: Query tenant-specific messages table
        const result = await pool.query(
            `SELECT media_data, media_type, sender_name FROM ${tenantSchema}.messages WHERE id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            console.error(`❌ Message ${id} not found in ${tenantSchema}`);
            return res.status(404).json({ error: 'Message not found' });
        }
        
        const message = result.rows[0];
        if (!message.media_data) {
            console.error(`❌ Message ${id} has no media attached`);
            return res.status(404).json({ error: 'No media attached to this message' });
        }
        
        console.log(`✅ Media found for message ${id} in ${tenantSchema} (type: ${message.media_type})`);
        res.json({
            media_data: message.media_data,
            media_type: message.media_type,
            sender_name: message.sender_name
        });
    } catch (error) {
        console.error(`❌ Error loading media for message ${id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// OPTIMIZED: Added pagination to prevent loading 1000 messages at once
// CRITICAL: Uses explicit schema indexing for fractalized architecture
app.get('/api/bots/:id/messages', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { search, status, page = 1, limit = 50 } = req.query;
        
        // Get user's tenant schema
        const userResult = await pool.query(
            'SELECT tenant_id FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tenantId = userResult.rows[0].tenant_id;
        const tenantSchema = `tenant_${tenantId}`;
        
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        // EXPLICIT SCHEMA INDEXING: Build query with tenant-specific schema
        let query = `SELECT * FROM ${tenantSchema}.messages WHERE bot_id = $1`;
        const params = [id];
        let paramCount = 2;
        
        if (search) {
            query += ` AND (LOWER(sender_name) LIKE $${paramCount} OR sender_contact LIKE $${paramCount} OR LOWER(message_content) LIKE $${paramCount})`;
            params.push(`%${search.toLowerCase()}%`);
            paramCount++;
        }
        
        if (status && status !== 'all') {
            query += ` AND discord_status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        
        query += ` ORDER BY timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);
        
        const result = await pool.query(query, params);
        
        // Get total count for pagination with explicit schema indexing
        let countQuery = `SELECT COUNT(*) FROM ${tenantSchema}.messages WHERE bot_id = $1`;
        const countParams = [id];
        if (search) {
            countQuery += ` AND (LOWER(sender_name) LIKE $2 OR sender_contact LIKE $2 OR LOWER(message_content) LIKE $2)`;
            countParams.push(`%${search.toLowerCase()}%`);
        }
        if (status && status !== 'all') {
            countQuery += ` AND discord_status = $${countParams.length + 1}`;
            countParams.push(status);
        }
        const countResult = await pool.query(countQuery, countParams);
        
        res.json({
            messages: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit))
        });
    } catch (error) {
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
        botId,
        q,
        dateFrom,
        dateTo,
        senderId,
        messageType,
        status,
        regex
    } = req.query;
    
    if (!botId) {
        return res.status(400).json({ error: 'Bot ID is required' });
    }
    
    try {
        let query = 'SELECT * FROM messages WHERE bot_id = $1';
        const params = [botId];
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
    const { days = 30 } = req.query;
    
    try {
        // Get daily aggregates
        const result = await pool.query(`
            SELECT 
                date,
                SUM(total_messages) as total_messages,
                SUM(failed_messages) as failed_messages,
                SUM(rate_limit_events) as rate_limit_events,
                AVG(avg_response_time_ms) as avg_response_time_ms
            FROM message_analytics
            WHERE date >= CURRENT_DATE - $1::integer
            GROUP BY date
            ORDER BY date ASC
        `, [days]);
        
        // Get summary totals
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed_messages
            FROM messages
            WHERE timestamp >= CURRENT_DATE - $1::integer
        `, [days]);
        
        const rateLimitResult = await pool.query(`
            SELECT SUM(rate_limit_events) as rate_limit_events
            FROM message_analytics
            WHERE date >= CURRENT_DATE - $1::integer
        `, [days]);
        
        res.json({
            daily: result.rows,
            summary: {
                total_messages: parseInt(summaryResult.rows[0]?.total_messages || 0),
                failed_messages: parseInt(summaryResult.rows[0]?.failed_messages || 0),
                rate_limit_events: parseInt(rateLimitResult.rows[0]?.rate_limit_events || 0)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update analytics (called periodically or on message insert)
async function updateAnalytics(botId) {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed
            FROM messages
            WHERE bot_id = $1 AND DATE(timestamp) = $2
        `, [botId, today]);
        
        await pool.query(`
            INSERT INTO message_analytics (date, bot_id, total_messages, failed_messages)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (date, bot_id)
            DO UPDATE SET
                total_messages = $3,
                failed_messages = $4
        `, [today, botId, stats.rows[0].total, stats.rows[0].failed]);
    } catch (error) {
        console.error('Failed to update analytics:', error);
    }
}

// Auto-restore all bots with saved WhatsApp sessions on server startup
async function autoRestoreWhatsAppSessions() {
    try {
        console.log('🔄 Auto-restoring WhatsApp sessions from saved data...');
        
        // Get all tenant schemas
        const schemas = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        let restoredCount = 0;
        let skippedCount = 0;
        
        // For each tenant schema, find all bots with saved sessions
        for (const { schema_name } of schemas.rows) {
            try {
                const bots = await pool.query(`
                    SELECT id, name, status 
                    FROM ${schema_name}.bots 
                    WHERE status != 'deleted'
                `);
                
                for (const bot of bots.rows) {
                    // Check if this bot has a saved WhatsApp session
                    const sessionPath = path.join('.wwebjs_auth', `session-bot_${bot.id}`);
                    if (fs.existsSync(sessionPath)) {
                        console.log(`🔗 Auto-restoring bot ${bot.id} (${bot.name}) from ${schema_name}...`);
                        
                        try {
                            // Initialize WhatsApp client with saved session
                            await whatsappManager.initializeClient(
                                bot.id,
                                schema_name,
                                createTenantAwareMessageHandler
                            );
                            restoredCount++;
                            console.log(`✅ Bot ${bot.id} restored successfully`);
                        } catch (error) {
                            console.error(`⚠️  Failed to restore bot ${bot.id}:`, error.message);
                            skippedCount++;
                        }
                    } else {
                        console.log(`⏭️  Skipping bot ${bot.id} (${bot.name}) - no saved session`);
                        skippedCount++;
                    }
                }
            } catch (error) {
                console.error(`⚠️  Error processing ${schema_name}:`, error.message);
            }
        }
        
        console.log(`✅ Auto-restore complete: ${restoredCount} bots restored, ${skippedCount} skipped`);
    } catch (error) {
        console.error('❌ Auto-restore failed:', error.message);
    }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🌐 Dashboard available at http://localhost:${PORT}`);
    await initializeDatabase();
    console.log('✅ Multi-tenant WhatsApp Bridge ready');
    
    // Auto-restore WhatsApp sessions for 24/7 uptime
    await autoRestoreWhatsAppSessions();
    console.log('📱 All bots with saved sessions are now active');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await whatsappManager.cleanup();
    process.exit(0);
});
