const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

if (!DISCORD_WEBHOOK_URL) {
    console.error('❌ ERROR: DISCORD_WEBHOOK_URL environment variable is required!');
    console.error('Please set your Discord webhook URL in the Secrets tab.');
    process.exit(1);
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

const client = new Client({
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

let botNumber = null;

client.on('qr', (qr) => {
    console.log('QR Code received! Scan this with WhatsApp:');
    qrcode.generate(qr, { small: true });
    console.log('\nOr scan the QR code above with your WhatsApp mobile app.');
});

client.on('ready', async () => {
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
    console.error('❌ Authentication failed:', msg);
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
        const timestamp = new Date(message.timestamp * 1000).toLocaleString();
        
        let embedDescription = message.body || '_(No text content)_';
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
                    value: timestamp,
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
                if (media) {
                    if (media.mimetype.startsWith('image/')) {
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
                        
                        console.log(`✅ Forwarded message with image from ${senderName} (${chatName}) to Discord`);
                        return;
                    } else {
                        embed.fields.push({
                            name: '📎 Attachment',
                            value: `Media type: ${media.mimetype} (not displayed)`,
                            inline: false
                        });
                    }
                }
            } catch (mediaError) {
                console.error('Error downloading media:', mediaError.message);
                embed.fields.push({
                    name: '⚠️ Media',
                    value: 'Media download failed',
                    inline: false
                });
            }
        }

        await axios.post(DISCORD_WEBHOOK_URL, discordPayload);
        
        console.log(`✅ Forwarded message from ${senderName} (${chatName}) to Discord`);
        
    } catch (error) {
        console.error('❌ Error forwarding message to Discord:', error.message);
        
        try {
            await axios.post(DISCORD_WEBHOOK_URL, {
                content: `⚠️ Error processing WhatsApp message: ${error.message}`
            });
        } catch (webhookError) {
            console.error('Failed to send error notification to Discord:', webhookError.message);
        }
    }
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp client disconnected:', reason);
    console.log('Attempting to reconnect...');
});

console.log('🚀 Starting WhatsApp to Discord Bridge...');
console.log('📡 Discord webhook configured');
console.log('⏳ Initializing WhatsApp client...\n');

client.initialize().catch(err => {
    console.error('Failed to initialize WhatsApp client:', err);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});
