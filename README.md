# WhatsApp to Discord Bridge

A bridge that automatically forwards WhatsApp messages to a Discord channel using webhooks.

## Features

- ✅ Real-time message forwarding from WhatsApp to Discord
- 📱 Displays sender name, chat name, and timestamp
- 🖼️ Supports image attachments (uploaded to Discord)
- 🎨 Beautiful Discord embeds with WhatsApp branding
- 🔐 Secure authentication using WhatsApp Web
- 🛡️ Secure secret management via environment variables

## Setup Instructions

### 1. Configure Discord Webhook

1. Go to your Discord server settings
2. Navigate to Integrations → Webhooks
3. Click "New Webhook" or "Copy Webhook URL" for an existing one
4. Copy the webhook URL

### 2. Set Environment Variables

In the Replit Secrets tab, add:

- **Key**: `DISCORD_WEBHOOK_URL`
- **Value**: Your Discord webhook URL (e.g., `https://discord.com/api/webhooks/...`)

### 3. Run the Bridge

1. Click the "Run" button to start the bridge
2. A QR code will appear in the console
3. Open WhatsApp on your phone
4. Go to Settings → Linked Devices → Link a Device
5. Scan the QR code displayed in the console
6. Once connected, all incoming WhatsApp messages will be forwarded to Discord!

## How It Works

When you receive a WhatsApp message:
1. The bridge captures the message details
2. Formats it as a Discord embed with sender info, chat name, and timestamp
3. If the message contains an image, it uploads it to Discord
4. Sends the formatted message to your Discord channel via webhook

## Message Format

Messages appear in Discord with:
- Sender name in the title
- Message content in the description
- Chat name (individual or group)
- Timestamp of when the message was received
- Image attachments (when available)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Yes | Your Discord webhook URL |
| `PUPPETEER_EXECUTABLE_PATH` | No | Path to Chromium (auto-detected on NixOS) |

## Technical Details

- Built with Node.js
- Uses `whatsapp-web.js` for WhatsApp connectivity
- Uses Discord webhooks for message delivery
- Runs headless Chromium for WhatsApp Web session
- Automatically detects Chromium on NixOS systems

## Troubleshooting

**QR Code not appearing?**
- Check the console logs for errors
- Ensure Chromium is installed

**Messages not forwarding to Discord?**
- Verify your Discord webhook URL is correctly set in Secrets
- Check the console for error messages

**Authentication failed?**
- Try clearing the `.wwebjs_auth` folder and scan the QR code again
