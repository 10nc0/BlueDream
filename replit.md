# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-input messaging bridge designed to forward messages from any platform (WhatsApp, Telegram, Twitter/X, SMS, Email) to Discord. It features robust authentication, permanent message retention, and a PostgreSQL database. The project is deployed as a multi-tenant SaaS application where all users access the same instance via a public URL, with each user having an isolated PostgreSQL schema.

**Key Capabilities:**
- **Hybrid Input Model:** Supports WhatsApp (with QR login and session management) and Generic Webhooks for various platforms.
- **Unified Output:** All inputs forward to Discord webhooks (1-to-many support).
- **Multi-Tenant SaaS:** Single deployment with fractalized database architecture ensuring 100% tenant isolation.
- **Zero Cost for Webhooks:** Webhook inputs have no runtime overhead.

## Recent Updates (Oct 30, 2025)
- **PRODUCTION-GRADE HARDENING COMPLETE**: Four critical fixes for 24/7 reliability and security
  1. **Database Transaction Timeout Fix**: Message handler now commits immediately after saveMessage(), preventing idle-in-transaction crashes. Media downloads and webhook sends happen outside transaction scope (no more 25P03 crashes).
  2. **Webhook Security (NYAN TRUTH)**: Bridge deletion now deletes Discord webhooks to prevent ghost messages. ONE BRIDGE = ONE WEBHOOK URL. On destroy: WhatsApp client + Discord webhook both deleted (output_0n_url only, preserving eternal output_01_url).
  3. **Portable Storage Path**: Replaced hardcoded paths with WWEBJS_DATA_PATH environment variable for Docker/Render/Fly.io compatibility. Fixed critical regression where destroyClient() targeted old path (breaking relink flow).
  4. **Health Monitoring**: Enhanced /health endpoint shows WhatsApp client status breakdown (connected, qr_ready, etc.) and storage path for operational visibility.
- **PERSISTENT STORAGE FIX - THE REAL ISSUE**: Fixed ephemeral filesystem killing 24/7 operation
  - ROOT CAUSE: WhatsApp sessions saved to `.wwebjs_auth/` which Replit wipes on restart
  - SOLUTION: Migrated all sessions to `/home/runner/workspace/.wwebjs_auth_persistent` (survives restarts)
  - IMPACT: Sessions now persist → Scan QR once → Works 24/7 → Messages forward reliably
  - All session paths updated: WhatsAppClientManager, auto-restore, lock file cleanup, destroyClient
  - **The code was always GENESIS - it was infrastructure, not over-engineering**
- **CREATE BRIDGE CRASH FIX**: Fixed critical crash when creating new bridges
  - Root cause: `showQRAndWaitForConnection()` tried to access wrong modal elements (qrModal vs bridge-qr-section)
  - Create bridge form now uses its own dedicated modal with inline QR display and status polling
  - Relink flow continues using unified `showQRAndWaitForConnection()` function for "Generate QR" button
  - Both flows properly poll `/api/bridges/:id/qr` for status and auto-close on connection
- **QR FLOW IMPROVEMENTS**: Enhanced QR display reliability and logging
  - Enhanced QR endpoint with comprehensive logging: tracks status, hasQR, tenant:bridge indexing
  - Fixed logging inconsistencies: all endpoints now use "bridges" terminology (not legacy "bots")
  - QR endpoint properly returns status field in all code paths (verified with detailed logging)
  - Create bridge and relink flows both support auto-close on successful WhatsApp connection
- **ANTI-SPAM KICK DETECTION**: Critical session age tracking fix for WhatsApp auto-reconnect
  - Session creation time now captured at 'ready' event (not disconnect) for accurate age calculation
  - LOGOUT on new sessions (<5 mins) = anti-spam kick → auto-reconnect preserved
  - LOGOUT on established sessions (>5 mins) = real user logout → permanent destroy
  - QR modal auto-close now detects 'ready' OR 'connected' status (WhatsApp progression: qr_ready → authenticated → ready → connected)
  - Modal close delay reduced to 1.5s for faster UX
  - UI text updated: "dedicated Discord thread" → "your Discord webhook" for clarity
- **AUTO-RECONNECT MECHANISM COMPLETE**: WhatsApp sessions now self-heal without user intervention
  - Intelligent disconnect detection: only permanently destroys on LOGOUT/NAVIGATION
  - Auto-reconnect with exponential backoff (10s → 20s → 40s → 60s max)
  - Preserves session credentials (no re-QR needed after network issues)
  - Reconnect counter resets on successful connection
  - Message handlers preserved across reconnection cycles
  - **24/7 Operation**: Bridges stay connected through server restarts, network issues, WhatsApp server hiccups
  - **Zero User Intervention**: No need to login to Nyanbook dashboard to restore connections
- **QR-FIRST ARCHITECTURE COMPLETE**: Bypass library indexing for instant QR display
  - Bridge creation now opens in-page modal (no popup window friction!)
  - Modal auto-closes when WhatsApp connects successfully (1.5s delay)
  - No dependency on library indexing - QR = proof of life
  - POST /api/bridges/:id/start now returns QR code in response
  - Users stay hypnotized by cat animation 🐱 while creating bridges
  - **Recovery**: Fractal IDs cached in localStorage (last 10 bridges) for disaster recovery
  - **Dev Visibility**: Fractal ID displayed in modal with one-click copy button
  - **UX Polish**: Copy button shows "✓ Copied!" feedback with color change
  - **Zero Friction**: All in same page context - no localStorage token passing needed
- **WEBHOOK-CENTRIC ARCHITECTURE COMPLETE**: Migrated from bridge-centric to webhook-centric model
  - Database: Added `output_01_url` and `output_0n_url` columns to all `tenant_*.bridges` tables
  - Code: Renamed `sendToNyanbook()` → `sendToLedger()`, `sendToUserWebhook()` → `sendToUserOutput()`
  - Each "bridge" = dual-output pair: Output #01 (Ledger) + Output #0n (User Discord)
  - Output #01 automatically set to NYANBOOK_WEBHOOK_URL (eternal, masked from Admin #0n)
  - Output #0n user-configurable via `userOutputUrl` in create form (mutable, visible)
  - Bridge creation fixed: `archived=false` explicitly set (was NULL, causing invisibility bug)
  - **UI Masking**: "webhook" → "bridge" in all user-facing text (except create form keeps "Webhook Outputs" for clarity)
  - **Frontend Rendering Bug Fixed**: Line 912 changed from `bridges.map()` to `bots.map()` - was breaking platform grouping
  - **UI Enhancement**: Sidebar now shows bridge names (e.g., "Bridge #99") instead of generic "whatsapp → discord"
  - **CRITICAL DEV USER FIX**: tenant-middleware.js now sets `search_path` for dev users (was missing, causing INSERT to fail silently)
- **Genesis Admin Fixed**: First user EVER = Dev #01 (role='dev', god view to dbA), all subsequent users = Admin #0n (role='admin', isolated tenant with own dbB)
- **Dev Panel UI**: `/dev` endpoint now mirrors bridges tab with dbA/notdbA view switch
- **Fractalized Multi-Tenant**: No invites needed - each signup creates isolated tenant (Admin #02, #03, etc.)

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bridge only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bridges, responsive sidebar collapse

## System Architecture
### UI/UX Decisions
The dashboard is a Single Page Application (SPA) with an Apple glassmorphism design, featuring a Discord-style two-pane layout. It includes real-time updates, circular avatars, status badges, responsive design for mobile, and custom tooltips for accessibility. A Dev Panel provides system-wide bridge visibility for Admin #01, showing tenant and bridge statistics while maintaining strict isolation for regular users.

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication.
- **Authentication**: Email/password authentication using JWT tokens in `localStorage`. Multi-user authentication with role-based access control (admin, read-only, write-only).
- **Database**: PostgreSQL (Neon-backed) with fractalized multi-tenancy:
    - **Global Schema**: `public` for core authentication (`users`, `sessions`, `audit_logs`).
    - **Tenant Schemas**: Isolated `tenant_X` for per-tenant data (`bridges` only - messages stored in Discord).
    - **Horizontal Isolation**: Dedicated database clients and `SET LOCAL search_path` for complete data separation.
    - **Zero Storage Cost**: PostgreSQL only stores bridge metadata; Discord threads handle all message storage at $0 cost.
- **WhatsApp Integration**: Multi-instance `whatsapp-web.js` with `WhatsAppClientManager` to manage independent, tenant-scoped sessions. Sessions are persistent across restarts.
- **Discord Integration (SOLE STORAGE SOLUTION)**: 
    - **Global Webhook**: Admin-configurable webhook via `/dev` panel (file-based, Replit-proof persistence).
    - **Per-Bridge Threads**: Each bridge auto-generates unique `thread_name` (e.g., `nyanbook-t7-1761839223643`).
    - **Smart Thread Reuse**: First message creates Discord thread and captures `thread_id`, subsequent messages reuse it.
    - **Discord as Database**: All messages stored exclusively in Discord - no PostgreSQL message storage.
    - **Native UI**: Dashboard shows Discord thread info with "Open Discord" button for full native experience.
    - **Zero Cost**: Discord provides UI, search, attachments, and permanent storage at $0 - scales to 1000+ users for free.
- **Media Handling**: Forwards images, videos, and documents directly to Discord threads.
- **Search**: Discord's native search (full-text, date filters, attachments, etc.) - no custom implementation needed.
- **Data Retention**: Permanent storage in Discord threads - deletion only via bridge removal.

### Feature Specifications
- **Multi-Tenant SaaS**: Complete horizontal tenant isolation.
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to other platforms.
- **Per-Bridge WhatsApp Sessions**: Independent, persistent WhatsApp sessions for each bridge.
- **1-to-Many Output**: Single bridge can forward to multiple destinations.
- **Web Dashboard**: Professional UI with real-time updates and per-bridge WhatsApp controls.
- **WhatsApp Session Management**: Start/Stop/Relink buttons, status badges.
- **Audit Logging**: Comprehensive tracking of activities and events.
- **Admin Panel**: Per-tenant monitoring for admins.
- **Quick-Start Wizard**: Guides initial user setup.

### System Design Choices
- **Multi-Tenant Isolation**: Fractalized database architecture prevents cross-tenant data access.
- **Per-Bridge WhatsApp Sessions**: Ensures independent operation and no shared global bot.
- **Session Persistence**: WhatsApp sessions survive server restarts via tenant-scoped `LocalAuth` storage.
- **Composite Tracking**: `tenantSchema:bridgeId` keys prevent cross-tenant collisions.
- **24/7 Bridge Uptime**: Auto-restore ensures connected bridges reconnect after server restarts.
- **Automatic Lock File Cleanup**: Prevents launch failures.
- **Safari/iPad Compatibility**: Achieved via JWT in `localStorage` to avoid ITP cookie blocking.
- **Permanent Data Retention**: Disallows message deletion (except via bridge cascade).
- **Scalability**: Designed for Replit Autoscale deployment with health checks.
- **Fractalized Bridge IDs**: SHA-256 hash-based, non-enumerable, tenant-scoped IDs to prevent enumeration attacks.
- **Discord-First Architecture**: Uses Discord threads as the complete UI/storage solution, eliminating custom message UI and PostgreSQL storage costs. Each bridge gets a persistent Discord thread where all messages are sent, with Discord handling UI, search, and attachments at zero cost.
- **Admin Dev Panel**: `/dev` endpoint for admins to configure global Discord webhook via file-based storage (Replit-proof persistence).

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: `whatsapp-web.js` library
- **Discord**: Discord webhooks