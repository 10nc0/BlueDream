# Nyan Bridge 🌈

## Project Overview

A professional multi-platform messaging bridge (WhatsApp to Discord/Telegram) with authentication, PostgreSQL storage, Apple glassmorphism design, and 1-to-many output capability. Messages and bots are permanently retained (write-only, no deletion).

## Architecture

- **Backend**: Node.js + Express
- **Authentication**: JWT tokens (localStorage) + session cookies (dual-auth)
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: whatsapp-web.js (uses WhatsApp Web protocol)
- **Discord**: Discord webhooks for message forwarding
- **Dashboard**: SPA with Apple glassmorphism design + Discord-style two-pane layout
- **Session Management**: express-session with PostgreSQL store

## Key Features

1. **Multi-User Authentication**: JWT + session-based auth with role-based access control
2. **Safari/iPad Compatible**: JWT localStorage auth (fixes ITP cookie blocking)
3. **PostgreSQL Storage**: Permanent retention of messages, users, sessions, audit logs
4. **Multi-Platform Bridge**: WhatsApp → Discord (extensible to Telegram)
5. **1-to-Many Output**: Single bot can forward to multiple destinations
6. **Web Dashboard**: Professional UI with real-time updates and Discord-style message feed
7. **Audit Logging**: Complete session and authentication tracking
8. **Media Support**: Images, videos, documents forwarded with messages
9. **Discord-Style UI**: Two-pane layout with bot sidebar + message feed

## Authentication Architecture (Safari/iPad Fix)

### Login Flow
1. User submits credentials → `/api/auth/login`
2. Server validates and returns JWT access + refresh tokens
3. Tokens stored in `localStorage` (survives Safari ITP)
4. User redirected to dashboard at `/`

### Dashboard Loading
1. Browser requests `/` (HTML) - **no server-side auth required**
2. Server returns static HTML (HTTP 200)
3. Client-side JavaScript runs `checkAuth()`:
   - Reads JWT from `localStorage`
   - Calls `/api/auth/status` with `Authorization: Bearer <token>` header
   - If valid: loads dashboard data
   - If invalid: redirects to `/login.html`

### API Requests
- All API calls use `authFetch()` wrapper
- **CRITICAL**: Includes `credentials: 'include'` to send session cookies
- Automatically adds `Authorization: Bearer <token>` header
- Handles 401 errors with automatic token refresh
- Falls back to login on refresh failure

### Why This Works on Safari/iPad
- **Problem**: Safari's ITP blocks cookies in embedded contexts
- **Solution**: Dashboard HTML loads without cookies, all auth via JWT in localStorage
- **Fallback**: Session cookies still sent via `credentials: 'include'` for dual-auth
- **Security**: API routes protected with `requireAuth` middleware (supports both JWT and cookies)

## Discord-Style UI Layout

### Two-Pane Architecture
**Left Pane** (Bridge Sidebar):
- Bot cards grouped by input platform (WhatsApp, etc.)
- Channel-style items with message count badges
- Auto-selection of first bot
- Responsive: collapses on mobile (<768px)

**Right Pane** (Message Feed):
- Discord-style message cards with avatars
- Shows: timestamp, sender name, phone, message content, attachments
- Status badges: ✓ Success, ✗ Failed, ⏳ Pending
- Search and filtering (by text and status)
- Real-time updates every 10 seconds

### Message Display Format
```
[Avatar] Giovanni Wilson     Today at 3:45 PM  ✓
         +628116360610
         234,6 cm BST NO. 2
         [📎 Attachment: image/jpeg]
```

## File Structure

```
├── index.js              # Main server (Express routes, WhatsApp client)
├── auth-service.js       # JWT signing/verification utilities
├── public/
│   ├── index.html        # Dashboard (SPA with Discord-style UI)
│   ├── login.html        # Login page
│   └── css/
│       └── dashboard.css # Discord-style glassmorphism CSS
├── tests/
│   └── ui-audit/         # Playwright UI tests
│       ├── audit.spec.js # Test suite (7 states)
│       ├── states.js     # State definitions
│       └── playwright.config.js
├── package.json          # Dependencies
└── replit.md            # This file
```

## Database Schema

### Tables
- **users**: Email/phone, password hash, role (admin/read-only/write-only)
- **sessions**: Express sessions with PostgreSQL store
- **active_sessions**: Session metadata (device, browser, IP, location)
- **refresh_tokens**: JWT refresh tokens (revokable)
- **bots**: Input/output platforms, credentials, contact info, tags
- **messages**: Sender, content, media, forwarding status, bot_id
- **audit_logs**: Session creation, authentication events, CRUD operations

### Default Users
- **admin@bridge.local** / admin123 (admin role)
- **replit@test.local** (read-only role - for testing/screenshots)

### Key Constraints
- Write-only: No DELETE operations except bot deletion (permanent retention of messages)
- Foreign keys: messages.bot_id → bots.id (CASCADE on bot deletion)
- Unique constraints: users.email, users.phone

## API Endpoints

### Authentication
- `POST /api/auth/login` - Email/password login (returns JWT)
- `POST /api/auth/otp/request` - Request phone OTP
- `POST /api/auth/otp/verify` - Verify OTP (returns JWT)
- `POST /api/auth/register` - Admin-only user creation
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Revoke refresh token
- `GET /api/auth/status` - Check authentication (supports JWT + cookies)

### Dashboard
- `GET /` - Dashboard HTML (client-side auth guard)
- `GET /index.html` - Dashboard HTML (client-side auth guard)
- `GET /login.html` - Login page (no auth required)

### Bots
- `GET /api/bots` - List all bots with message counts
- `POST /api/bots` - Create new bot (admin only)
- `PUT /api/bots/:id` - Update bot configuration
- `DELETE /api/bots/:id` - Delete bot (admin only, cascades to messages)
- `GET /api/bots/:id/qr` - Get WhatsApp QR code
- `GET /api/bots/:id/messages` - Get paginated messages for bot

### Messages
- `GET /api/messages` - Get messages (filtered by bot, search, status)
- `GET /api/messages/:id/media` - Get media attachment (base64)

### Users & Sessions
- `GET /api/users` - List all users (admin only)
- `POST /api/users` - Create user (admin only)
- `PUT /api/users/:id/role` - Change user role (admin only)
- `DELETE /api/users/:id` - Delete user (admin only)
- `GET /api/sessions` - List active sessions (admin only)
- `DELETE /api/sessions/:id` - Revoke session (admin only)

### Stats
- `GET /api/stats` - Global statistics
- `GET /api/stats/bots/:id` - Bot-specific statistics

## Technical Details

- **Port**: 5000 (Replit webview)
- **Chromium**: Auto-detected NixOS Chromium for WhatsApp Web
- **JWT**: HS256 signing, 15min access token, 7day refresh token
- **Session**: 7-day cookie, httpOnly, secure, sameSite=none, partitioned (CHIPS)
- **Media**: Base64 encoded, stored in PostgreSQL (media_data column)
- **Timezone**: America/Los_Angeles (PDT/PST)
- **Auto-refresh**: Bot message counts update every 10 seconds

## User Preferences

- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bot only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bots, responsive sidebar collapse

## Recent Changes

### 2025-10-28: Discord-Style UI + Delete Bot + Bug Fixes ✅
- **Added Discord-style two-pane layout**: Left sidebar (bot channels) + right detail panel (messages)
- **Implemented delete bot functionality**: Red delete button with confirmation modal and cascade deletion
- **Fixed message display**: Updated `loadBotMessages()` to use `renderDiscordMessages()` and correct container ID
- **Fixed empty Users/Sessions pages**: Added `credentials: 'include'` to `authFetch()` to send session cookies
- **Added auto-refresh**: Bot message counts update every 10 seconds
- **Improved error handling**: Better empty states and error messages for Users, Sessions, Messages
- **Added XSS protection**: HTML escaping for all user-generated content in Discord messages
- **Updated message format**: "Today at 3:45 PM" timestamps, circular avatars, status badges

### 2025-10-27: Safari/iPad Login Loop Fix ✅
- **Problem**: After login, Safari blocked session cookies due to ITP, causing infinite redirect loop
- **Solution**: Removed `requireAuth` middleware from `/` and `/index.html` routes
- **Implementation**: Dashboard HTML loads without server-side auth, client-side `checkAuth()` handles access control
- **Result**: Login flow works on Safari/iPad using JWT localStorage authentication
- **Security**: All API routes still protected, no regressions
- **Test**: End-to-end flow verified (login → dashboard load → auth check → API access)

### 2025-10-26: JWT Authentication Implementation
- Added JWT token system with access/refresh tokens
- Created `auth-service.js` for token signing/verification
- Added `refresh_tokens` table to database
- Implemented dual-auth middleware (supports both JWT and cookies)
- Fixed token revocation bug (added `requireAuth` to logout endpoint)
- Updated frontend to use `authFetch()` wrapper with automatic token refresh

### 2025-10-25: Media Preview Fix
- Changed media preview endpoint from regular `fetch()` to `authFetch()`
- Fixed attachment display for JWT authentication

## Testing

### UI Audit Suite
- **Command**: `npm run audit-ui`
- **Framework**: Playwright with auth injection
- **Coverage**: 7 states (no bots, 1 bot, QR login, message view, filters, bot creation, logout)
- **Auth**: Test accounts injected via localStorage (bypasses login for speed)

### Manual Testing
1. Login at `/login.html` with admin@bridge.local / admin123
2. Verify dashboard loads without redirect loop
3. Check Discord-style message feed displays correctly with 3 messages
4. Test search/filtering in message feed
5. Test delete bot button (confirmation modal + cascade deletion)
6. Verify Users page shows admin@bridge.local and replit@test.local
7. Verify Sessions page shows current active session
8. **IMPORTANT**: Do hard refresh (Cmd+Shift+R / Ctrl+Shift+R) after code changes to clear JavaScript cache

## Known Issues

- WhatsApp client occasionally fails to initialize due to Chromium profile lock (restart workflow)
- UI audit tests may timeout (not critical, manual testing works)
- **Screenshot tool cannot authenticate** (JWT in localStorage not accessible to headless browser)
- **Browser caching**: After code changes, users must hard refresh (Cmd+Shift+R / Ctrl+Shift+R) to see updates

## Critical Bug Fixes Applied

### `authFetch()` Credentials Fix
**Line 302 in public/index.html:**
```javascript
options.credentials = 'include';  // CRITICAL: Sends session cookies with all requests
```
This ensures session cookies are sent alongside JWT tokens, enabling dual-auth fallback.

### Message Container Fix
**Line 1121-1123 in public/index.html:**
```javascript
const container = document.getElementById(`discord-messages-${botId}`);  // Correct container
container.innerHTML = renderDiscordMessages(data.messages, botId);  // Discord-style render
```
Changed from old `messages-${botId}` container to new Discord-style `discord-messages-${botId}`.

## Deployment

- **Status**: Ready for Replit deployment
- **Environment**: PostgreSQL database required (automatically configured in Replit)
- **Secrets**: SESSION_SECRET, DISCORD_WEBHOOK_URL, DATABASE_URL (auto-provided)

## Next Steps (Recommended by Architect)

1. Add automated regression test for unauthenticated redirect
2. Monitor logs for unexpected anonymous dashboard hits
3. Document JWT-only dashboard flow for future maintainers
4. Consider adding Telegram output platform
5. Implement bot status monitoring and auto-restart
6. Add pagination for Discord-style message feed
7. Implement real-time message updates via WebSockets
