# WhatsApp to Discord Bridge

A bridge that automatically forwards WhatsApp messages to a Discord channel using webhooks.

## Features

- ✅ Real-time message forwarding from WhatsApp to Discord
- 📱 Displays sender name, chat name, and timestamp
- 🖼️ Supports image attachments
- 🎨 Beautiful Discord embeds with WhatsApp branding
- 🔐 Secure authentication using WhatsApp Web

## Setup

1. The bridge uses `whatsapp-web.js` which connects to WhatsApp Web
2. On first run, scan the QR code with your WhatsApp mobile app
3. Messages will automatically forward to your Discord webhook

## How to Use

1. Click the "Run" button to start the bridge
2. A QR code will appear in the console
3. Open WhatsApp on your phone
4. Go to Settings > Linked Devices > Link a Device
5. Scan the QR code displayed in the console
6. Once connected, all incoming WhatsApp messages will be forwarded to Discord!

## Configuration

The Discord webhook URL is configured in the code. You can also set it via environment variable:

```
DISCORD_WEBHOOK_URL=your_webhook_url_here
```

## Message Format

Messages are sent to Discord with:
- Sender name
- Chat name (individual or group)
- Message timestamp
- Message content
- Image attachments (when available)

## Technical Details

- Built with Node.js
- Uses `whatsapp-web.js` for WhatsApp connectivity
- Uses Discord webhooks for message delivery
- Runs headless Chromium for WhatsApp Web session
