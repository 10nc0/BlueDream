# WhatsApp to Discord Bridge

## Project Overview

A Node.js application that bridges WhatsApp messages to Discord webhooks with a professional web dashboard for monitoring and management.

## Architecture

- **Backend**: Node.js + Express
- **WhatsApp Integration**: whatsapp-web.js (uses WhatsApp Web protocol)
- **Discord Integration**: Discord webhooks for message forwarding
- **Dashboard**: Static HTML/CSS/JS served by Express
- **Storage**: In-memory (no database required)

## File Structure

```
├── index.js              # Main application file (WhatsApp client + Express server)
├── public/
│   └── index.html        # Web dashboard
├── package.json          # Node.js dependencies
├── .env.example          # Environment variable template
├── .gitignore            # Git ignore rules
└── README.md             # User documentation
```

## Key Features

1. **WhatsApp Connection**: Uses whatsapp-web.js to connect to WhatsApp Web
2. **Message Forwarding**: Forwards messages to Discord via webhook
3. **Privacy-Focused**: Only forwards messages sent TO the bot by default
4. **Web Dashboard**: Professional UI for monitoring messages and stats
5. **QR Relinking**: Easy way to disconnect and reconnect with new numbers
6. **Message Filtering**: Search and filter messages by sender, content, or status

## Configuration

### Required Environment Variables
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for message forwarding

### Optional Environment Variables
- `ALLOWED_GROUPS`: Comma-separated list of WhatsApp group names to monitor
- `ALLOWED_NUMBERS`: Comma-separated list of phone numbers to monitor
- `PUPPETEER_EXECUTABLE_PATH`: Custom path to Chromium (auto-detected on NixOS)

## API Endpoints

- `GET /api/status` - WhatsApp connection status and bot number
- `GET /api/qr` - Current QR code (base64 data URL)
- `POST /api/relink` - Disconnect and relink WhatsApp
- `GET /api/messages` - Get messages with optional search and status filters
- `GET /api/stats` - Message statistics (total, success, failed, pending)

## Technical Details

- **Port**: 5000 (configured for Replit webview)
- **Chromium**: Uses system Chromium for WhatsApp Web (auto-detected)
- **Message Storage**: In-memory array, max 1000 messages
- **Auto-refresh**: Dashboard polls API every 5 seconds
- **Image Support**: Images are uploaded to Discord as attachments via multipart form data

## User Preferences

- Keep implementation simple and functional (no overengineering)
- Use temporary phone numbers for testing
- Easy QR relinking for switching numbers
- Privacy-focused (only forward messages sent TO the bot)

## Recent Changes

- Added Express web server with dashboard
- Implemented message filtering and search
- Added QR relink functionality
- Improved error handling and status indicators
- Enhanced message preview with real-time updates
