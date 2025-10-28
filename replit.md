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
│   ├── css/
│   │   ├── dashboard.css           # Discord-style glassmorphism CSS
│   │   └── components/
│   │       ├── tooltips.css        # Tooltip system styles
│   │       ├── analytics.css       # Analytics dashboard styles
│   │       ├── enhancements.css    # Global UX enhancements
│   │       └── media-modal.css     # Media viewer modal styles
│   └── js/ui/
│       ├── tooltips.js             # Tooltip glossary system
│       ├── onboarding.js           # Onboarding hints
│       ├── analytics.js            # Analytics charts
│       ├── search.js               # Advanced search
│       └── media-loader.js         # Media lazy loading + caching
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
- **phi_dao@pm.me** / admin123 (genesis admin - full system access)
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

### 2025-10-28: Header UI Polish + Consistency ✅
- **Font Consistency**: All header text now uses consistent 0.875rem font size (except main "🌈Nyan Bridge" title)
  - Status indicators: 0.6875rem → 0.875rem
  - Tagline: 0.75rem → 0.875rem
  - Clock: 0.75rem → 0.875rem
- **User Email Fix**: Added max-width (250px) and text-overflow ellipsis to prevent email overflow
  - Now properly readable and scales with Logout button
  - "phi_dao@pm.me (dev)" displays correctly
- **Enlarged Cat**: Increased animated character size from 125px → 200px
  - Canvas size: 125x125 → 200x200
  - Responsive clamp: 120-200px (was 75-125px)
  - Significantly more visible and prominent in header
- **Animated Time Color**: Time alternates between black (#1a1a1a) and white (#ffffff) synced with cat jump animation
  - Creates dynamic visual rhythm in header
  
### 2025-10-28: Smart Tooltip Boundary Detection ✅
- **Problem**: Tooltips were being cropped by viewport edges (especially on badge hover in header)
- **Solution**: Intelligent viewport boundary detection
  - **Dynamic Measurement**: Calculates actual tooltip dimensions before positioning
  - **Horizontal Clamping**: Ensures tooltip never overflows left/right viewport edges (10px padding)
  - **Vertical Clamping**: Ensures tooltip never overflows top/bottom viewport edges (10px padding)
  - **Auto-Adjustment**: Automatically shifts tooltip to stay fully visible while maintaining proximity to target element
  - **No Transform Conflicts**: Removed transform-based centering in favor of direct pixel positioning
- **Result**: Tooltips now always appear fully visible regardless of target element position

### 2025-10-28: Custom Tooltip System + Header Cleanup ✅
- **Problem**: Tooltips were cropped by table edges using native browser title attribute
- **Solution**: Custom tooltip system with intelligent positioning
  - **Fixed Positioning**: Uses `position: fixed` with z-index 10000 to appear above all containers
  - **Smart Placement**: Automatically positions above or below element based on available viewport space
  - **Glassmorphism**: Dark themed with backdrop blur matching design system
  - **Arrow Indicators**: Visual arrows point to the target element
  - **Smooth Animations**: Fade-in transitions for polished UX
- **Header Simplification**: Reduced status indicators from 4 to 2 (System: Healthy + Bridges count)

### 2025-10-28: Natural Language Search + Auto-Search ✅
- **Removed**: Search/Regex toggle button (saves UI space, auto-detects regex patterns)
- **Natural Language Date Parsing**: Supports intuitive queries like:
  - "today", "yesterday" - searches messages from that day
  - "this week", "last week" - searches current/previous week
  - "this month", "last month" - searches current/previous month
  - "last 7 days", "last 30 days" - searches rolling time windows
- **Auto-Search**: Debounced search (300ms delay) triggers automatically as you type
- **Visual Feedback**: Blue badge shows active search context (e.g., "📅 yesterday")
- **Intelligent Regex Detection**: Auto-enables regex mode when pattern starts with "/" or contains special chars
- **UX**: No manual buttons to click - just type and search happens automatically

### 2025-10-28: Universal Search System + UI Polish ✅
- **Problem**: Search implementations were "forked" (different code for bridge search, Discord message search, table search) - regex toggle didn't work consistently
- **Solution**: Created unified `window.searchState` parent repository
  - **Single Source of Truth**: `searchState.regexMode` controls all search boxes
  - **Universal Algorithm**: `searchState.performSearch(query, text, caseSensitive)` used everywhere
  - **Safe Regex**: Try/catch wrapper falls back to literal search on invalid patterns
  - **Consistent Behavior**: Bridge library, Discord messages, and table view all use same logic
- **UI Improvements**:
  - Fixed button text: "Search" (default) / "Regex" (when active) instead of ".* Regex"
  - Blue highlighting when regex mode is active
  - All search boxes respect the same regex toggle state
- **Technical**: Consolidated 3 separate search implementations into 1 reusable function

### 2025-10-28: Enhanced Search + Quick-Start Wizard ✅
- **Problem**: Search was too vague ("Search bridges by name, platform..."), newbies confused by +Create Bridge button
- **Search Improvements**:
  - **Advanced Filters**: Date range pickers (from/to), message type filter (text/image/video/audio/document)
  - **Regex Mode**: Toggle for power users with pattern matching (e.g., `Giovanni.*today`)
  - **Better Placeholder**: "Search bridges, messages, senders..." (more specific)
  - **Visual Feedback**: Blue highlighting when regex mode is active
- **Quick-Start Wizard**:
  - **Auto-shows**: For first-time users or when no bridges exist
  - **3-Step Guide**: ⏱️ Takes 2 minutes
    1. 📱 Scan QR Code with WhatsApp (Linked Devices)
    2. 🔗 Add Discord Webhook URL (Server Settings → Integrations)
    3. ✅ Done - Test by sending a message
  - **Skip Option**: "Skip (I know what to do)" for experienced users
  - **Setup Banner**: Green banner appears in form with step reminders
  - **localStorage Memory**: Won't show wizard again after skipping
- **Result**: Reduces friction for newbies, power users get regex search

### 2025-10-28: Admin Panel ✅
- **Feature**: Admin-only tab for monitoring users, sessions, and audit logs
- **Access**: Only visible to genesis admin (phi_dao@pm.me)
- **Design**: White tab header to distinguish from regular tabs
- **Sections**:
  - **Registered Users**: View all users with roles and IDs
  - **Active Sessions**: Monitor current sessions with location, device, browser info
  - **Audit Logs**: Track all system activities (login, logout, user management, bot operations)
  - **Filtering**: Filter audit logs by activity type (auth, session, user, bot)
- **Layout**: Responsive grid with scrollable sections
- **Security**: Enforced access control - only admin@bridge.local can see this tab

### 2025-10-28: Media Lazy Loading + Caching System ✅
- **Problem**: Media showed "Loading media..." placeholders but never loaded actual images/videos
- **Root Cause**: `media-loader.js` loaded in `<head>` before `authFetch()` was defined in `<body>`
- **Solution**: Moved script loading to correct order (after authFetch definition)
- **Features Added**:
  - **IntersectionObserver** lazy loading (loads media only when visible in viewport)
  - **Triple-layer caching**: Memory cache → IndexedDB (90-min TTL) → Server API
  - **Media modal**: Click to expand images in full-screen viewer
  - **Automatic re-initialization**: After message rendering and search results
  - **Comprehensive error logging**: Detailed diagnostics for debugging
- **Performance**: Media persists across scrolling and tab switches without re-downloading
- **Testing**: Login at `/login.html` (admin@bridge.local/admin123), expand bot, verify images load and cache

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
1. Login at `/login.html` with phi_dao@pm.me / admin123
2. Verify dashboard loads without redirect loop
3. **Check Admin Panel tab**: Should see white "🛡️ Admin Panel" tab (only visible to genesis admin phi_dao@pm.me)
4. **Test Admin Panel**: Click tab to see registered users, active sessions, and audit logs
5. **Filter audit logs**: Use dropdown to filter by activity type (auth, session, user, bot)
6. Check Discord-style message feed displays correctly with 3 messages
7. Test search/filtering in message feed
8. Test delete bot button (confirmation modal + cascade deletion)
9. **Test media loading**: Expand bot with images, verify they load and cache
10. **IMPORTANT**: Do hard refresh (Cmd+Shift+R / Ctrl+Shift+R) after code changes to clear JavaScript cache

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
