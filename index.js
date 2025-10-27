const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcrypt');
const twilio = require('twilio');

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

const app = express();
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
        secure: false // Set to true in production with HTTPS
    }
}));

// Middleware to block HTML files from static serving
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/login.html') {
        return next(); // Let explicit routes handle HTML files
    }
    next();
});

// Serve login page without authentication (must come before requireAuth check)
app.get('/login.html', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// Protect main dashboard - require authentication
app.get('/', requireAuth, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Block direct access to index.html - require authentication
app.get('/index.html', requireAuth, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Serve only non-HTML static files without authentication
// HTML files are served through explicit authenticated routes above
app.use(express.static('public', { 
    index: false,
    ignore: ['*.html'] // Don't serve HTML files through static middleware
}));

let currentQR = null;
let botNumber = null;
let whatsappReady = false;
let client = null;

async function initializeDatabase() {
    try {
        // Create bots table first
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bots (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                input_platform TEXT NOT NULL,
                output_platform TEXT NOT NULL,
                input_credentials JSONB,
                output_credentials JSONB,
                status TEXT DEFAULT 'inactive',
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
        
        // Create default admin user if none exists
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        if (parseInt(usersCount.rows[0].count) === 0) {
            const bcrypt = require('bcrypt');
            const defaultPassword = await bcrypt.hash('admin123', 10);
            await pool.query(`
                INSERT INTO users (email, password_hash, role)
                VALUES ($1, $2, $3)
            `, ['admin@bridge.local', defaultPassword, 'admin']);
            console.log('✅ Created default admin user (email: admin@bridge.local, password: admin123)');
        }
        
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
        
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        throw error;
    }
}

async function saveMessage(message, botId = 1) {
    try {
        const result = await pool.query(
            `INSERT INTO messages (bot_id, timestamp, sender_name, sender_contact, message_content, discord_status, discord_error, has_media, media_type, media_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
                message.mediaData || null
            ]
        );
        return result.rows[0].id;
    } catch (error) {
        console.error('Error saving message to database:', error.message);
        return null;
    }
}

async function updateMessageStatus(messageId, status, errorMessage = null, mediaData = null) {
    try {
        await pool.query(
            `UPDATE messages 
             SET discord_status = $1, discord_error = $2, media_data = COALESCE($3, media_data)
             WHERE id = $4`,
            [status, errorMessage, mediaData, messageId]
        );
    } catch (error) {
        console.error('Error updating message status:', error.message);
    }
}

async function getMessages(searchFilter = null, statusFilter = null) {
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
        
        const result = await pool.query(query, params);
        
        return result.rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            senderName: row.sender_name,
            senderContact: row.sender_contact,
            messageContent: row.message_content,
            discordStatus: row.discord_status,
            discordError: row.discord_error,
            hasMedia: row.has_media,
            mediaType: row.media_type,
            mediaData: row.media_data
        }));
    } catch (error) {
        console.error('Error retrieving messages from database:', error.message);
        return [];
    }
}

async function getMessageStats() {
    try {
        const result = await pool.query(`
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

function initializeWhatsAppClient() {
    if (client) {
        client.removeAllListeners();
    }

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: chromiumPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions'
            ],
            headless: true,
            timeout: 60000
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR Code received! Scan this with WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log('\nOr scan the QR code above with your WhatsApp mobile app.');
        
        try {
            currentQR = await QRCode.toDataURL(qr);
        } catch (err) {
            console.error('Error generating QR code:', err);
        }
    });

    client.on('ready', async () => {
        whatsappReady = true;
        currentQR = null;
        console.log('✅ WhatsApp client is ready!');
        console.log('🔗 Connected to Discord webhook');
        
        try {
            const info = await client.info;
            botNumber = info.wid.user;
            const formattedNumber = `+${botNumber}`;
            console.log(`📱 Bot WhatsApp Number: ${formattedNumber}`);
            
            // Auto-populate contact_info for the active bot (bot id=1)
            await pool.query(`
                UPDATE bots 
                SET contact_info = $1, status = 'active'
                WHERE id = 1
            `, [formattedNumber]);
            console.log(`✅ Auto-updated bot #1 contact info: ${formattedNumber}`);
        } catch (error) {
            console.error('Could not retrieve bot number:', error.message);
        }
        
        if (ALLOWED_GROUPS.length > 0) {
            console.log(`🔍 Monitoring specific groups: ${ALLOWED_GROUPS.join(', ')}`);
        }
        if (ALLOWED_NUMBERS.length > 0) {
            console.log(`🔍 Monitoring specific numbers: ${ALLOWED_NUMBERS.join(', ')}`);
        }
        if (ALLOWED_GROUPS.length === 0 && ALLOWED_NUMBERS.length === 0) {
            console.log('📬 Only forwarding messages sent TO this bot number');
        }
        
        console.log('📱 Listening for WhatsApp messages...\n');
    });

    client.on('authenticated', () => {
        console.log('✅ WhatsApp authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        whatsappReady = false;
        console.error('❌ Authentication failed:', msg);
    });

    client.on('disconnected', (reason) => {
        whatsappReady = false;
        console.log('❌ WhatsApp client disconnected:', reason);
    });

    function shouldForwardMessage(message, chat, contact) {
        if (ALLOWED_GROUPS.length > 0 && chat.isGroup) {
            const groupName = chat.name || '';
            if (ALLOWED_GROUPS.some(g => groupName.toLowerCase().includes(g.toLowerCase()))) {
                return true;
            }
        }
        
        if (ALLOWED_NUMBERS.length > 0) {
            const contactNumber = contact.number || contact.id.user;
            if (ALLOWED_NUMBERS.some(n => contactNumber.includes(n))) {
                return true;
            }
        }
        
        if (ALLOWED_GROUPS.length === 0 && ALLOWED_NUMBERS.length === 0) {
            if (!chat.isGroup && message.fromMe === false) {
                return true;
            }
        }
        
        return false;
    }

    client.on('message', async (message) => {
        let messageDbId = null;
        
        try {
            const chat = await message.getChat();
            const contact = await message.getContact();
            
            if (!shouldForwardMessage(message, chat, contact)) {
                return;
            }
            
            const chatName = chat.name || contact.pushname || contact.number;
            const senderName = contact.pushname || contact.number;
            const senderContact = contact.number || contact.id.user;
            const timestamp = new Date(message.timestamp * 1000);
            const messageContent = message.body || '';
            
            const messageRecord = {
                id: message.id._serialized,
                senderName,
                senderContact,
                chatName,
                messageContent,
                hasMedia: message.hasMedia,
                mediaType: message.hasMedia ? 'image' : null,
                mediaData: null,
                timestamp: timestamp.toISOString(),
                discordStatus: 'pending'
            };
            
            messageDbId = await saveMessage(messageRecord);
            
            // Check if this is an annotation for a recent media message
            let isAnnotation = false;
            if (!message.hasMedia && messageContent && (messageContent.includes('#') || messageContent.toLowerCase().includes('note:'))) {
                // Check if user sent media in the last 5 minutes
                const recentMediaCheck = await pool.query(`
                    SELECT id FROM messages 
                    WHERE sender_contact = $1 
                    AND has_media = true 
                    AND timestamp > NOW() - INTERVAL '5 minutes'
                    ORDER BY timestamp DESC LIMIT 1
                `, [senderContact]);
                
                if (recentMediaCheck.rows.length > 0) {
                    isAnnotation = true;
                    // Update the media message with the annotation
                    await pool.query(`
                        UPDATE messages 
                        SET message_content = CASE 
                            WHEN message_content = '' THEN $1
                            ELSE message_content || E'\n\n📝 Annotation: ' || $1
                        END
                        WHERE id = $2
                    `, [messageContent, recentMediaCheck.rows[0].id]);
                    console.log(`📝 Annotation added to media message for ${senderName}`);
                }
            }
            
            let embedDescription = messageContent || '_(No text content)_';
            let embedColor = 0x25D366;
            
            // Add annotation indicator to embed if this is an annotation
            if (isAnnotation) {
                embedDescription = `📝 **Media Annotation**\n\n${embedDescription}`;
                embedColor = 0x5865F2; // Discord blue for annotations
            }
            
            const embed = {
                title: `📱 WhatsApp Message from ${senderName}`,
                description: embedDescription,
                color: embedColor,
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
                    text: 'WhatsApp Bridge'
                }
            };

            const discordPayload = {
                username: 'WhatsApp Bridge',
                avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg',
                embeds: [embed]
            };

            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    if (media && media.mimetype.startsWith('image/')) {
                        const mediaData = `data:${media.mimetype};base64,${media.data}`;
                        
                        const buffer = Buffer.from(media.data, 'base64');
                        const filename = `whatsapp_image_${Date.now()}.${media.mimetype.split('/')[1]}`;
                        
                        const FormData = require('form-data');
                        const form = new FormData();
                        
                        form.append('file', buffer, {
                            filename: filename,
                            contentType: media.mimetype
                        });
                        
                        embed.fields.push({
                            name: '📎 Attachment',
                            value: `Image (${media.mimetype})`,
                            inline: false
                        });
                        
                        form.append('payload_json', JSON.stringify(discordPayload));
                        
                        await axios.post(DISCORD_WEBHOOK_URL, form, {
                            headers: form.getHeaders()
                        });
                        
                        if (messageDbId) {
                            await updateMessageStatus(messageDbId, 'success', null, mediaData);
                        }
                        console.log(`✅ Forwarded message with image from ${senderName} (${chatName}) to Discord`);
                        
                        // Prompt for annotation if media was sent without text
                        if (!messageContent || messageContent.trim().length < 3) {
                            const annotationPrompt = `📝 Media received! To help with organization and future searching, please reply with:\n\n• Hashtags (e.g., #meeting #sales)\n• Brief description\n• Any relevant notes\n\nThis will help index this media for easy discovery later in Discord.`;
                            await message.reply(annotationPrompt);
                            console.log(`📝 Prompted ${senderName} for media annotation`);
                        }
                        
                        return;
                    }
                } catch (mediaError) {
                    console.error('Error downloading media:', mediaError.message);
                    if (messageDbId) {
                        await updateMessageStatus(messageDbId, 'failed', mediaError.message);
                    }
                    return;
                }
            }

            await axios.post(DISCORD_WEBHOOK_URL, discordPayload);
            if (messageDbId) {
                await updateMessageStatus(messageDbId, 'success');
            }
            console.log(`✅ Forwarded message from ${senderName} (${chatName}) to Discord`);
            
        } catch (error) {
            console.error('❌ Error forwarding message to Discord:', error.message);
            if (messageDbId) {
                await updateMessageStatus(messageDbId, 'failed', error.message);
            }
        }
    });

    console.log('🚀 Starting WhatsApp to Discord Bridge...');
    console.log('📡 Discord webhook configured');
    console.log('⏳ Initializing WhatsApp client...\n');

    client.initialize().catch(err => {
        console.error('Failed to initialize WhatsApp client:', err);
    });
}

// ============ AUTHENTICATION MIDDLEWARE ============

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
}

// Middleware to check roles
function requireRole(...allowedRoles) {
    return async (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const userRole = result.rows[0].role;
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.userRole = userRole;
        next();
    };
}

// ============ AUTHENTICATION ROUTES ============

// Check if user is logged in
app.get('/api/auth/status', async (req, res) => {
    if (req.session && req.session.userId) {
        const result = await pool.query('SELECT id, email, phone, role FROM users WHERE id = $1', [req.session.userId]);
        if (result.rows.length > 0) {
            return res.json({ authenticated: true, user: result.rows[0] });
        }
    }
    res.json({ authenticated: false });
});

// Email/Password Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
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
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                email: user.email, 
                role: user.role 
            } 
        });
    } catch (error) {
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
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                phone: user.phone, 
                role: user.role 
            } 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Register new user (admin only)
app.post('/api/auth/register', requireRole('admin'), async (req, res) => {
    const { email, phone, password, role } = req.body;
    
    try {
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        
        const result = await pool.query(`
            INSERT INTO users (email, phone, password_hash, role)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, phone, role
        `, [email || null, phone || null, passwordHash, role || 'read-only']);
        
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ error: 'Email or phone already exists' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true });
    });
});

// Get all users (admin only)
app.get('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, phone, role, created_at FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user role (admin only)
app.put('/api/users/:id/role', requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    
    try {
        const result = await pool.query(`
            UPDATE users 
            SET role = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, phone, role
        `, [role, id]);
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PROTECTED API ROUTES ============
// All routes below require authentication, with role-based access where specified

app.get('/api/status', requireAuth, async (req, res) => {
    const stats = await getMessageStats();
    res.json({
        whatsappReady,
        botNumber: botNumber ? `+${botNumber}` : null,
        hasQR: currentQR !== null,
        messagesCount: stats.total
    });
});

app.get('/api/qr', requireAuth, (req, res) => {
    if (currentQR) {
        res.json({ qr: currentQR });
    } else if (whatsappReady) {
        res.json({ message: 'WhatsApp is already connected', connected: true });
    } else {
        res.json({ message: 'QR code not available yet', connected: false });
    }
});

app.post('/api/relink', requireRole('admin', 'write-only'), async (req, res) => {
    try {
        whatsappReady = false;
        currentQR = null;
        
        if (client) {
            await client.destroy();
        }
        
        if (fs.existsSync('.wwebjs_auth')) {
            fs.rmSync('.wwebjs_auth', { recursive: true, force: true });
        }
        
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 1000);
        
        res.json({ success: true, message: 'Relinking WhatsApp... QR code will be available shortly.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/messages', requireAuth, async (req, res) => {
    const { search, status } = req.query;
    const filtered = await getMessages(search, status);
    res.json(filtered);
});

app.get('/api/stats', requireAuth, async (req, res) => {
    const stats = await getMessageStats();
    res.json(stats);
});

// Bot management endpoints
// OPTIMIZED: Get all bots with stats in ONE query (eliminates N+1 problem)
app.get('/api/bots', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                b.*,
                COUNT(m.id) as total_messages,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as success_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count
            FROM bots b
            LEFT JOIN messages m ON b.id = m.bot_id
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bots', requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags } = req.body;
        const result = await pool.query(
            `INSERT INTO bots (name, input_platform, output_platform, input_credentials, output_credentials, contact_info, tags, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [name, inputPlatform, outputPlatform, inputCredentials || {}, outputCredentials || {}, contactInfo || null, tags || [], 'inactive']
        );
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/bots/:id', requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags, status } = req.body;
        const result = await pool.query(
            `UPDATE bots 
             SET name = $1, input_platform = $2, output_platform = $3, 
                 input_credentials = $4, output_credentials = $5, contact_info = $6, tags = $7, status = $8, updated_at = NOW()
             WHERE id = $9 RETURNING *`,
            [name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo || null, tags || [], status, id]
        );
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/bots/:id', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Prevent deleting the default active bot
        if (parseInt(id) === 1) {
            return res.status(400).json({ 
                error: 'Cannot delete the default bot (currently active). Create and activate a new bot first.' 
            });
        }
        
        await pool.query('DELETE FROM bots WHERE id = $1', [id]);
        res.json({ success: true });
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

// OPTIMIZED: Added pagination to prevent loading 1000 messages at once
app.get('/api/bots/:id/messages', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { search, status, page = 1, limit = 50 } = req.query;
        
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = 'SELECT * FROM messages WHERE bot_id = $1';
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
        
        // Get total count for pagination
        let countQuery = 'SELECT COUNT(*) FROM messages WHERE bot_id = $1';
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

app.listen(5000, '0.0.0.0', async () => {
    console.log('🌐 Dashboard available at http://localhost:5000');
    await initializeDatabase();
});

initializeWhatsAppClient();

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
