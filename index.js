const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1432251247611875339/0bygzUiOuhKnnMX93SRza8DrGavtyWHe2mswJXYIgdxj85BEUeDZCJABNAwK6X8yYLlU';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        headless: true
    }
});

client.on('qr', (qr) => {
    console.log('QR Code received! Scan this with WhatsApp:');
    qrcode.generate(qr, { small: true });
    console.log('\nOr scan the QR code above with your WhatsApp mobile app.');
});

client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    console.log('🔗 Connected to Discord webhook');
    console.log('📱 Listening for WhatsApp messages...\n');
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

client.on('message', async (message) => {
    try {
        const chat = await message.getChat();
        const contact = await message.getContact();
        
        const chatName = chat.name || contact.pushname || contact.number;
        const senderName = contact.pushname || contact.number;
        const timestamp = new Date(message.timestamp * 1000).toLocaleString();
        
        let embedDescription = message.body;
        let embedColor = 0x25D366;
        
        const embed = {
            title: `📱 WhatsApp Message from ${senderName}`,
            description: embedDescription || '_(No text content)_',
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
                text: `WhatsApp Bridge • ID: ${message.id._serialized}`
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
                    embed.fields.push({
                        name: '📎 Attachment',
                        value: `Type: ${media.mimetype}`,
                        inline: false
                    });
                    
                    if (media.mimetype.startsWith('image/')) {
                        const base64Data = media.data;
                        const imageUrl = `data:${media.mimetype};base64,${base64Data}`;
                        embed.image = { url: imageUrl };
                    }
                }
            } catch (mediaError) {
                console.error('Error downloading media:', mediaError);
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
