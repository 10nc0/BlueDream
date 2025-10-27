# WhatsApp to Discord Bridge

A bridge that automatically forwards WhatsApp messages to a Discord channel using webhooks. By default, it only forwards messages sent **to** the bot, not all messages from your account.

## Features

- 📊 **Professional Web Dashboard** - Monitor messages, stats, and manage connections
- ✅ Real-time message forwarding from WhatsApp to Discord
- 🔒 **Privacy-focused**: Only forwards messages sent TO the bot by default
- 🔍 **Message filtering and search** - Search by sender or content
- 🔄 **Easy QR relinking** - Button to connect a new WhatsApp number
- 🎯 Optional filtering by specific groups or phone numbers
- 📱 Displays sender name, chat name, and timestamp
- 🖼️ Supports image attachments (uploaded to Discord)
- 🎨 Beautiful Discord embeds with WhatsApp branding
- 🔐 Secure authentication using WhatsApp Web
- 🛡️ Secure secret management via environment variables

## How It Works

### Default Behavior (Most Private)
By default, the bridge **only forwards messages sent TO the bot's WhatsApp number**. This means:
- ✅ Someone sends a message to your bot → Forwarded to Discord
- ❌ You send a message to someone → NOT forwarded
- ❌ Messages in your other chats → NOT forwarded
- ❌ Group messages (unless configured) → NOT forwarded

### Optional Filtering
You can optionally configure the bridge to monitor:
- Specific WhatsApp groups by name
- Messages from specific phone numbers

## Setup Instructions

### 1. Configure Discord Webhook

1. Go to your Discord server settings
2. Navigate to Integrations → Webhooks
3. Click "New Webhook" or "Copy Webhook URL" for an existing one
4. Copy the webhook URL

### 2. Set Required Environment Variables

In the Replit Secrets tab, add:

**Required:**
- **Key**: `DISCORD_WEBHOOK_URL`
- **Value**: Your Discord webhook URL (e.g., `https://discord.com/api/webhooks/...`)

### 3. (Optional) Configure Filtering

To monitor specific groups or numbers, add these secrets:

**Optional - Monitor Specific Groups:**
- **Key**: `ALLOWED_GROUPS`
- **Value**: Comma-separated group names (e.g., `Family Group,Work Team`)

**Optional - Monitor Specific Numbers:**
- **Key**: `ALLOWED_NUMBERS`
- **Value**: Comma-separated phone numbers without + or spaces (e.g., `1234567890,9876543210`)

**Note:** If you don't set these, only messages sent TO your bot will be forwarded (recommended for privacy).

### 4. Run the Bridge

1. Click the "Run" button to start the bridge
2. The web dashboard will open automatically
3. Click the **"Relink WhatsApp"** button to see the QR code
4. Open WhatsApp on your phone
5. Go to Settings → Linked Devices → Link a Device
6. Scan the QR code from the dashboard modal
7. Once connected, the dashboard will show your bot's WhatsApp number
8. Share this number with people who should contact the bot!

## Web Dashboard

The bridge includes a professional web dashboard accessible at the webview when you run the app.

### Dashboard Features

- **Real-time Stats**: View total, successful, failed, and pending messages
- **Message Preview**: See all forwarded messages with timestamps and sender info
- **Search & Filter**: 
  - Search by sender name, contact, or message content
  - Filter by status (All, Success, Failed, Pending)
- **Connection Status**: Live indicator showing WhatsApp connection status and bot number
- **QR Code Management**: 
  - Click "Relink WhatsApp" to view current QR code
  - Generate new QR code to connect a different number
  - Useful for switching from temporary to permanent numbers
- **Auto-refresh**: Dashboard updates every 5 seconds automatically

### Using the Dashboard

1. **Monitor Messages**: See all forwarded messages in real-time
2. **Search**: Type in the search box to find specific messages
3. **Filter**: Use the status dropdown to show only successful, failed, or pending messages
4. **Relink**: Click "Relink WhatsApp" button to disconnect and connect a new number
5. **Stats**: View summary statistics at the top of the dashboard

## Usage

### As a Bot (Default)
1. Share your bot's WhatsApp number with others
2. When someone sends a message to that number, it appears in Discord
3. Your personal messages remain private

### Monitor Specific Groups
1. Set `ALLOWED_GROUPS=My Group Name` in Secrets
2. Messages in groups matching that name will be forwarded
3. Supports partial, case-insensitive matching

### Monitor Specific Numbers
1. Set `ALLOWED_NUMBERS=1234567890` in Secrets
2. Messages from that number will be forwarded

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
| `DISCORD_WEBHOOK_URL` | **Yes** | Your Discord webhook URL |
| `ALLOWED_GROUPS` | No | Comma-separated group names to monitor |
| `ALLOWED_NUMBERS` | No | Comma-separated phone numbers to monitor |
| `PUPPETEER_EXECUTABLE_PATH` | No | Path to Chromium (auto-detected) |

## Examples

### Example 1: Bot Only (Default - Most Private)
```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```
Result: Only messages sent TO your bot are forwarded.

### Example 2: Monitor Specific Groups
```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALLOWED_GROUPS=Support Team,Customer Inquiries
```
Result: Messages from groups with "Support Team" or "Customer Inquiries" in the name.

### Example 3: Monitor Specific Numbers
```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALLOWED_NUMBERS=1234567890,9876543210
```
Result: Messages from those specific phone numbers.

### Example 4: Combine Filters
```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALLOWED_GROUPS=VIP Customers
ALLOWED_NUMBERS=1234567890
```
Result: Messages from VIP Customers group OR from that specific number.

## Technical Details

- Built with Node.js
- Uses `whatsapp-web.js` for WhatsApp connectivity
- Uses Discord webhooks for message delivery
- Runs headless Chromium for WhatsApp Web session
- Automatically detects Chromium on NixOS systems
- Privacy-focused filtering by default

## Troubleshooting

**QR Code not appearing?**
- Check the console logs for errors
- Ensure Chromium is installed

**Messages not forwarding to Discord?**
- Verify your Discord webhook URL is correctly set in Secrets
- Check the console - it will show which messages are being forwarded
- Make sure people are sending messages TO the bot number (shown in console)

**Want to monitor all messages?**
- This is not recommended for privacy reasons
- The bridge is designed to act as a bot that receives messages

**Authentication failed?**
- Try clearing the `.wwebjs_auth` folder and scan the QR code again
