# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-input messaging bridge designed to forward messages from any platform (WhatsApp, Telegram, Twitter/X, SMS, Email) to Discord. It features robust authentication, permanent message retention via Discord threads, and a PostgreSQL database for bridge configuration and routing. The project is deployed as a multi-tenant SaaS application where all users access the same instance via a public URL, with each user having an isolated PostgreSQL schema.

**Key Capabilities:**
- **Hybrid Input Model:** Supports WhatsApp (with QR login and session management) and Generic Webhooks.
- **Unified Output:** All inputs forward to Discord webhooks (1-to-many support).
- **Multi-Tenant SaaS:** Single deployment with fractalized database architecture ensuring 100% tenant isolation.
- **Zero Cost for Webhooks:** Webhook inputs have no runtime overhead.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bridge only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bridges, responsive sidebar collapse, user-customizable layout dimensions

## System Architecture
### Global Constants (Isolated UI Islands)
The system uses two immutable global constants: `NYANBOOK_LEDGER_WEBHOOK_URL` (Dev-only Discord webhook) and `CAT_CONFIG` (Pixel cat animation settings).

### UI/UX Decisions
The dashboard is a Single Page Application (SPA) with an Apple glassmorphism design, featuring a Discord-style two-pane layout. It includes real-time updates, circular avatars, status badges, responsive design for mobile, and custom tooltips. The design prioritizes message content visibility, with **user-adjustable layout dimensions via draggable resizers**:
- **Sidebar Width Resizer**: Vertical rainbow gradient bar (180px-400px range) allows users to customize sidebar/message panel ratio, with preference saved to localStorage
- **Header Height Resizer**: Horizontal rainbow gradient bar (40px-120px range) gives users control over header vertical space, with preference saved to localStorage
- **Outside-In Layout Architecture**: Viewport → header → container → children all use `height: 100%` cascading, ensuring edge-to-edge fill across all devices without hardcoded calculations
- **Reduced Default Widths**: Sidebar defaults to 240px (Mac) and 220px (iPad) for maximum message space allocation
- **CSP-Compliant**: Both resizers use event delegation on document, no inline handlers

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication.
- **Authentication**: Email/password authentication using JWT tokens in `localStorage` with role-based access control. User data is strictly isolated within `tenant_X.users` tables; no global user table exists. Email-to-tenant routing is managed via a `core.user_email_to_tenant` mapping table.
- **Database (Source of Truth)**: PostgreSQL (Neon-backed) with pure fractalized multi-tenancy.
  - `core` schema: Tenant registry, email routing, invites, security tables.
  - `tenant_X` schemas: Per-tenant isolation for `users`, `bridges`, `active_sessions`, `audit_logs`, `refresh_tokens`, `media_buffer`.
  - `public` schema: Only `sessions` table for express-session global store.
- **WhatsApp Integration**: Multi-instance `Baileys` with `BaileysClientManager` for independent, tenant-scoped persistent sessions.
- **Discord Integration**: Messages are sent to two outputs: `output_01` (Ledger thread for dev oversight and message viewing) and `output_0n` (webhook-only for user's server). All message fetching occurs from `output_01`.
- **Media Handling**: Retry-safe atomic storage via `media_buffer` in PostgreSQL for base64-encoded media using `BYTEA` type, with delivery tracking, smart retry backoff, and automatic 3-day purge.
- **Search**: Utilizes Discord's native search UI.
- **Metadata System (Drops)**: A "Drops System" allows users to add freeform metadata (text, tags, dates) to messages. This metadata is extracted using regex (zero-cost, no AI) and stored in a `drops` table within each `tenant_X` schema, indexed with `TSVECTOR` for instant full-text search. This transforms Your Nyanbook into a Personal Cloud OS.

### Feature Specifications
- **Multi-Tenant SaaS**: Complete horizontal tenant isolation.
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to other platforms.
- **Per-Bridge WhatsApp Sessions**: Independent, persistent WhatsApp sessions.
- **1-to-Many Output**: Single bridge can forward to multiple destinations.
- **Web Dashboard**: Professional UI with real-time updates and per-bridge WhatsApp controls.
- **WhatsApp Session Management**: Start/Stop/Relink buttons, status badges.
- **Audit Logging**: Comprehensive tracking of activities and events.
- **User Management**: Role-based access control and tenant administration.
- **Quick-Start Wizard**: Guides initial user setup.

### System Design Choices
- **Multi-Tenant Isolation**: Pure fractalized database architecture prevents cross-tenant data access.
- **Session Persistence**: WhatsApp sessions survive server restarts.
- **24/7 Bridge Uptime**: Auto-restore ensures connected bridges reconnect.
- **Safari/iPad Compatibility**: Achieved via JWT in `localStorage`.
- **Scalability**: Designed for Replit Autoscale deployment.
- **Fractalized Bridge IDs**: SHA-256 hash-based, non-enumerable, tenant-scoped IDs.
- **Crash Recovery Architecture**: PostgreSQL stores all bridge state.
- **Message Retention**: Discord provides permanent, immutable message storage.
- **Flexible Output Options**: Bridges support both Discord channels and threads.
- **Webhook Security**: Strict validation prevents cross-tenant data exposure.
- **Production Hardening**: Includes database connection pool timeouts, strict JWT security, staggered resource initialization, security headers (CORS, Helmet), environment-aware cookies, and robust audit logging.
- **Chromium Removal**: Eliminated Playwright/Chromium dependencies for optimized production deployment.
- **Secret Management**: Relies on Replit Secrets.
- **CSP Compliance**: Production-ready Content Security Policy with inline handler elimination via event delegation, self-hosted external libraries, and strict directives.

### Personal Cloud OS - Advanced Features (Nov 1, 2025)
**AUTO-SCALING TIMELINE & EXPORT SYSTEM**: Complete implementation of advanced Personal Cloud OS features for intelligent organization and data portability:
- **Time Bucket System**: Auto-scaling timeline grouping with density-based algorithm:
  - Analyzes message density (messages/day) to determine optimal bucket size
  - 24h buckets for low density (<10 msgs/day)
  - 8h buckets for medium density (10-30 msgs/day): Night/Morning/Evening
  - 6h buckets for high density (>30 msgs/day): Late Night/Morning/Afternoon/Evening
  - Frontend implementation with `analyzeMessageDensity`, `groupMessagesByTimeBuckets`
  - Sticky bucket headers with glassmorphism design, message counts, and purple gradient
  - Verified working via browser console: "📊 Timeline: 2 buckets (8h intervals, 16 msgs over 1 days)"
- **Universal Search**: Enhanced search across messages AND drops metadata:
  - Single search bar queries both message content and drops full-text search
  - Messages matching via metadata get purple left border indicator
  - Async search via `/api/drops/search/:bridge_id` with `to_tsquery` PostgreSQL
  - Zero performance impact (search runs in parallel)
- **Export System**: Complete data portability with ZIP download:
  - Backend endpoint at `/api/bridges/:bridge_id/export` using `archiver` library
  - ZIP contains: `messages.json` (all messages with merged drops metadata), `README.txt` (statistics and notes)
  - Frontend: Export button (📦 green icon) in bridge controls
  - Download via blob creation with toast notifications ("📦 Preparing export...", "✅ Export downloaded!")
  - Includes Discord CDN URLs for media (media not duplicated in ZIP, accessible via URLs)
- **Production Quality**: CSP-compliant event delegation, tenant isolation enforced, error handling with user-friendly toasts, tested end-to-end

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks