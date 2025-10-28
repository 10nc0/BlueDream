# Nyan Bridge 🌈

## Overview
Nyan Bridge is a professional, multi-platform messaging bridge designed to connect WhatsApp to platforms like Discord and Telegram. It features robust authentication, permanent message retention (write-only), and a PostgreSQL database for storage. The project aims to provide a reliable, secure, and user-friendly solution for forwarding messages with an Apple glassmorphism design and a Discord-style interface. Its core capabilities include multi-user authentication, 1-to-many output forwarding, media support, and comprehensive audit logging, ensuring messages and bot activities are permanently recorded and accessible.

## 🔒 Database Isolation & Ownership

**CRITICAL FOR FORKED REPLS:** Each forked Repl MUST create its own isolated PostgreSQL database!

### Why Database Isolation Matters
- **Privacy**: Without isolation, you'll see the developer's data and they'll see yours
- **Security**: Shared databases expose sensitive user information
- **Genesis User**: First user in YOUR database becomes admin (not developer's)
- **Data Integrity**: Your messages and users stay private

### Database Ownership Check
The app automatically checks database ownership on startup:
- ✅ Creates `db_metadata` table to track ownership
- ✅ Records Repl owner (`REPL_OWNER/REPL_SLUG`) on first run
- ✅ Warns if database owner doesn't match current Repl
- ✅ Provides clear instructions to fix the issue

### Setup Instructions for Forked Repls
1. **Fork the Repl** from the original
2. **Create Database**: Tools → PostgreSQL (wait 30 seconds)
3. **Verify**: Look for "✅ Database ownership verified" in console
4. **Sign Up**: Visit `/signup.html` - you'll be Genesis User (admin)

### Warning Signs You're Using Wrong Database
```
⚠️  WARNING: You may be using someone else's database!
⚠️  Database owner: original-dev/their-repl
⚠️  Current Repl:   your-username/your-repl
```

**Fix:** Create your own database (see setup instructions above)

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bot only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bots, responsive sidebar collapse

## System Architecture
### UI/UX Decisions
The dashboard is a Single Page Application (SPA) featuring an Apple glassmorphism design. It adopts a Discord-style two-pane layout with a left sidebar for bot management and a right pane for message feeds. The UI includes real-time updates, circular avatars, status badges, and responsive design for mobile compatibility. Accessibility is enhanced with custom tooltips that dynamically adjust positioning to prevent viewport cropping.

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication handling.
- **Authentication**: Dual-authentication system using JWT tokens stored in `localStorage` (for Safari/iPad compatibility) and session cookies. It supports multi-user authentication with role-based access control (admin, read-only, write-only) and includes an in-progress Google OAuth integration.
- **Database**: PostgreSQL (Neon-backed Replit database) for permanent retention of all data, including messages, users, sessions, bots, and audit logs.
- **WhatsApp Integration**: Utilizes `whatsapp-web.js` to interact with the WhatsApp Web protocol.
- **Discord Integration**: Uses Discord webhooks for forwarding messages.
- **Session Management**: `express-session` with a PostgreSQL store.
- **Media Handling**: Supports forwarding of images, videos, and documents. Media is lazy-loaded with an `IntersectionObserver` and cached using a triple-layer system (memory, IndexedDB, server API).
- **Search**: Features natural language date parsing (e.g., "today", "last week", "October 2025") and intelligent regex detection for advanced queries.
- **Data Retention**: Messages are write-only; no DELETE operations are permitted except for bot deletion, which cascades to associated messages.

### Feature Specifications
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to Telegram.
- **1-to-Many Output**: A single bot can forward messages to multiple destinations.
- **Web Dashboard**: Professional UI with real-time updates and Discord-style message feed.
- **Audit Logging**: Comprehensive tracking of session activities, authentication events, and CRUD operations.
- **Admin Panel**: An admin-only interface for monitoring users, sessions, and audit logs.
- **Quick-Start Wizard**: Guides first-time users through the initial setup process.

### System Design Choices
- **Safari/iPad Compatibility**: Achieved by relying on JWT in `localStorage` for primary authentication, addressing ITP cookie blocking.
- **Permanent Data Retention**: Ensures no message data is ever lost by disallowing deletion (except for bot cascade).
- **Scalability**: Designed for potential Autoscale deployment on Replit, with health checks and dynamic port configuration.

## External Dependencies
- **Database**: PostgreSQL (specifically Neon-backed Replit database)
- **WhatsApp**: `whatsapp-web.js` library
- **Discord**: Discord webhooks
- **Authentication (In Progress)**: Google OAuth via `passport` and `passport-google-oauth20`
- **AI (Dismissed)**: OpenAI (gpt-5-mini) for AI-powered search was removed for cost optimization.