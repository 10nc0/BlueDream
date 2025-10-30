# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-input messaging bridge designed to forward messages from any platform (WhatsApp, Telegram, Twitter/X, SMS, Email) to Discord. It features robust authentication, permanent message retention, and a PostgreSQL database. The project is deployed as a multi-tenant SaaS application where all users access the same instance via a public URL, with each user having an isolated PostgreSQL schema.

**Key Capabilities:**
- **Hybrid Input Model:** Supports WhatsApp (with QR login and session management) and Generic Webhooks for various platforms.
- **Unified Output:** All inputs forward to Discord webhooks (1-to-many support).
- **Multi-Tenant SaaS:** Single deployment with fractalized database architecture ensuring 100% tenant isolation.
- **Zero Cost for Webhooks:** Webhook inputs have no runtime overhead.

## Recent Updates (Oct 30, 2025)
- **QR-FIRST ARCHITECTURE COMPLETE**: Bypass library indexing for instant QR display
  - Bridge creation now opens popup window with instant QR code
  - Window auto-closes when WhatsApp connects successfully
  - No dependency on library indexing - QR = proof of life
  - POST /api/bridges/:id/start now returns QR code in response
  - Created `public/create-bridge.html` as standalone popup page
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