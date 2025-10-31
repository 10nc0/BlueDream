# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-input messaging bridge designed to forward messages from any platform (WhatsApp, Telegram, Twitter/X, SMS, Email) to Discord. It features robust authentication, permanent message retention via Discord threads, and a PostgreSQL database for bridge configuration and routing. The project is deployed as a multi-tenant SaaS application where all users access the same instance via a public URL, with each user having an isolated PostgreSQL schema.

**Key Capabilities:**
- **Hybrid Input Model:** Supports WhatsApp (with QR login and session management) and Generic Webhooks for various platforms.
- **Unified Output:** All inputs forward to Discord webhooks (1-to-many support).
- **Multi-Tenant SaaS:** Single deployment with fractalized database architecture ensuring 100% tenant isolation.
- **Zero Cost for Webhooks:** Webhook inputs have no runtime overhead.

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
- **Authentication**: Email/password authentication using JWT tokens in `localStorage`. Multi-user authentication with role-based access control.
- **Database (Source of Truth)**: PostgreSQL (Neon-backed) with fractalized multi-tenancy:
    - **Global Schema**: `public` for core authentication.
    - **Tenant Schemas**: Isolated `tenant_X` for per-tenant bridge metadata.
    - **Horizontal Isolation**: Dedicated database clients and `SET LOCAL search_path` for complete data separation.
    - **Bridge Metadata Only**: PostgreSQL stores bridge configuration, routing data (thread_id, webhook_url), and tenant isolation - NOT messages.
- **WhatsApp Integration**: Multi-instance `Baileys` with `BaileysClientManager` to manage independent, tenant-scoped sessions. Sessions are persistent across restarts using JSON auth files.
- **Discord Integration (Output Layer + UI)**: 
    - **Bot-Managed Threads**: Discord bot client creates dedicated thread for each bridge on creation.
    - **Smart Thread Reuse**: Thread ID stored in PostgreSQL, enabling message routing and crash recovery.
    - **Fire-and-Forget Messages**: Messages forwarded directly to Discord threads - NOT stored in PostgreSQL.
    - **Discord = Output + UI**: Provides a human interface with real-time updates, search, and attachments.
- **Media Handling**: Retry-safe atomic storage architecture ensures zero media loss:
    - **Critical Path**: WhatsApp → downloadMedia() → PostgreSQL media_buffer → Discord webhooks
    - **Atomic Storage**: Media base64-encoded and committed to media_buffer BEFORE webhook delivery
    - **Schema-Qualified Queries**: All media_buffer queries use `${tenantSchema}.media_buffer` syntax to prevent transaction scope issues
    - **Dual Delivery Tracking**: delivered_to_ledger and delivered_to_user flags enable independent retry logic
    - **3-Day Purge**: Automatic cleanup runs every 24 hours (safe because Nyanbook Ledger has permanent copy)
    - **Retry Support**: delivery_attempts counter and last_delivery_attempt timestamp enable smart retry backoff
- **Search**: Utilizes Discord's native search UI.

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
- **Session Persistence**: WhatsApp sessions survive server restarts via tenant-scoped storage.
- **24/7 Bridge Uptime**: Auto-restore ensures connected bridges reconnect after server restarts.
- **Safari/iPad Compatibility**: Achieved via JWT in `localStorage`.
- **Scalability**: Designed for Replit Autoscale deployment with health checks.
- **Fractalized Bridge IDs**: SHA-256 hash-based, non-enumerable, tenant-scoped IDs.
- **PostgreSQL Source of Truth**: Database stores bridge configuration, thread_id, webhook_url, tenant isolation, and session state.
- **Discord Output Layer**: Messages forwarded to Discord threads, not stored in PostgreSQL.
- **Crash Recovery Architecture**: PostgreSQL stores all bridge state, enabling system recovery and message flow resumption after crashes.
- **Scribe of Scribe Principle**: Discord threads are PERMANENT and IMMUTABLE - never deleted even when bridges are archived.
- **Webhook Security**: User output webhooks (output_0n_url) CANNOT equal the Nyanbook Ledger webhook (output_01_url) to prevent cross-tenant data exposure.
- **Duplicate Webhooks Allowed**: Multiple bridges can share the same input platform or output_0n_url webhook, but output_0n_url ≠ output_01_url always.

### Production Hardening (October 2025)
- **Database Connection Pool**: Configured with timeout protections (connectionTimeoutMillis, idleTimeoutMillis, statement_timeout, query_timeout, idle_in_transaction_session_timeout) to prevent idle-in-transaction crashes.
- **JWT Security**: Invalid JWT tokens return 401 immediately without falling back to session auth, preventing auth bypass attacks.
- **Manager Initialization**: WhatsApp and Discord managers initialized inside app.listen callback to eliminate race conditions.
- **Resource Throttling**: Auto-restore sessions staggered by 500ms to prevent resource explosion from opening 100+ WebSockets simultaneously.
- **Security Headers**: CORS with default-deny (allows only Replit domains + explicit whitelist) and Helmet for production-grade HTTP protections.
- **Environment-Aware Cookies**: Secure flag conditional on NODE_ENV (production only) for dev mode compatibility.
- **Audit Logging**: Prefers req.userId over req.session?.userId to prevent audit gaps after session.destroy().
- **Dead Code Removal**: Eliminated obsolete PostgreSQL message functions (updateMessageStatus, getMessageStats) since messages stored only in Discord.
- **Retry-Safe Media Flow**: Atomic PostgreSQL media_buffer prevents zero data loss on delivery failures:
    - media_buffer table stores base64 media with delivery status flags (delivered_to_ledger, delivered_to_user)
    - Schema-qualified queries (`${tenantSchema}.media_buffer`) prevent "relation does not exist" errors
    - 3-day purge job runs daily to prevent bloat while ensuring retry window
    - Migration automatically adds media_buffer to existing tenant schemas on startup
- **Binary-Safe Media Storage**: media_buffer.media_data column uses BYTEA type (not TEXT) to handle Excel, ZIP, PDFs, and all binary files containing null bytes. Automatic migration converts existing TEXT columns to BYTEA on startup.
- **FRACTAL_SALT Security Enforcement**: Server refuses to start without FRACTAL_SALT environment variable configured, ensuring secure bridge ID generation. Provides clear setup instructions and pre-generated salt value on startup.
- **Multi-Tenant User Architecture** (October 2025): Complete tenant-scoped authentication refactor for true horizontal isolation:
    - **User Storage**: Users stored in `tenant_X.users` (NOT `public.users`) ensuring zero cross-tenant data exposure
    - **Email → Tenant Mapping**: `core.user_email_to_tenant` lookup table enables fast login queries without schema enumeration
    - **Tenant-Scoped Refresh Tokens**: `tenant_X.refresh_tokens` tables with schema-qualified auth-service queries
    - **Middleware Isolation**: `requireAuth` and `setTenantContext` query tenant-specific tables via email mapping
    - **JWT Tenant Context**: All tokens include tenantId, adminId, and isGenesisAdmin for complete context propagation
    - **Auth Flow**: Register → creates tenant schema + user + mapping → Login → queries mapping → tenant_X.users → JWT with tenant context
    - **Session Management**: Both JWT and cookie-based sessions maintain tenant context across all endpoints
    - **Production Tested**: Complete flow validated (register → login → auth status → refresh → logout) with architect approval
- **Autoscale Deployment**: Configured for Replit Autoscale with pay-per-traffic billing (~$26-50/mo for light usage). Sleeps when idle to minimize costs while maintaining 24/7 availability during active periods.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks