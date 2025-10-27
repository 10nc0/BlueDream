const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

if (!DISCORD_WEBHOOK_URL) {
    console.error('❌ ERROR: DISCORD_WEBHOOK_URL environment variable is required!');
    console.error('Please set your Discord webhook URL in the Secrets tab.');
    process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const messages = [];
const MAX_MESSAGES = 1000;
let currentQR = null;
let botNumber = null;
let whatsappReady = false;
let client = null;

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
            console.log(`📱 Bot WhatsApp Number: +${botNumber}`);
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
                mediaType: message.hasMedia ? 'image' : null,
                mediaData: null,
                timestamp: timestamp.toISOString(),
                discordStatus: 'pending'
            };
            
            messages.unshift(messageRecord);
            if (messages.length > MAX_MESSAGES) {
                messages.pop();
            }
            
            let embedDescription = messageContent || '_(No text content)_';
            let embedColor = 0x25D366;
            
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
                        messageRecord.mediaData = `data:${media.mimetype};base64,${media.data}`;
                        
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
                        
                        messageRecord.discordStatus = 'success';
                        console.log(`✅ Forwarded message with image from ${senderName} (${chatName}) to Discord`);
                        return;
                    }
                } catch (mediaError) {
                    console.error('Error downloading media:', mediaError.message);
                    messageRecord.discordStatus = 'failed';
                    messageRecord.errorMessage = mediaError.message;
                }
            }

            await axios.post(DISCORD_WEBHOOK_URL, discordPayload);
            messageRecord.discordStatus = 'success';
            console.log(`✅ Forwarded message from ${senderName} (${chatName}) to Discord`);
            
        } catch (error) {
            console.error('❌ Error forwarding message to Discord:', error.message);
            const idx = messages.findIndex(m => m.id === message.id._serialized);
            if (idx !== -1) {
                messages[idx].discordStatus = 'failed';
                messages[idx].errorMessage = error.message;
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

app.get('/api/status', (req, res) => {
    res.json({
        whatsappReady,
        botNumber: botNumber ? `+${botNumber}` : null,
        hasQR: currentQR !== null,
        messagesCount: messages.length
    });
});

app.get('/api/qr', (req, res) => {
    if (currentQR) {
        res.json({ qr: currentQR });
    } else if (whatsappReady) {
        res.json({ message: 'WhatsApp is already connected', connected: true });
    } else {
        res.json({ message: 'QR code not available yet', connected: false });
    }
});

app.post('/api/relink', async (req, res) => {
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

app.get('/api/messages', (req, res) => {
    const { search, status } = req.query;
    let filtered = [...messages];
    
    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(m => 
            m.senderName.toLowerCase().includes(searchLower) ||
            m.senderContact.includes(search) ||
            m.messageContent.toLowerCase().includes(searchLower)
        );
    }
    
    if (status && status !== 'all') {
        filtered = filtered.filter(m => m.discordStatus === status);
    }
    
    res.json(filtered);
});

app.get('/api/stats', (req, res) => {
    const stats = {
        total: messages.length,
        success: messages.filter(m => m.discordStatus === 'success').length,
        failed: messages.filter(m => m.discordStatus === 'failed').length,
        pending: messages.filter(m => m.discordStatus === 'pending').length
    };
    res.json(stats);
});

app.listen(5000, '0.0.0.0', () => {
    console.log('🌐 Dashboard available at http://localhost:5000');
});

initializeWhatsAppClient();

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
