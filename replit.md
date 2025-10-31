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
The dashboard is a Single Page Application (SPA) with an Apple glassmorphism design, featuring a Discord-style two-pane layout. It includes real-time updates, circular avatars, status badges, responsive design for mobile, and custom tooltips for accessibility.

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
    - **Delivery Tracking**: Status flags enable independent retry logic for reliable message delivery
    - **3-Day Purge**: Automatic cleanup runs every 24 hours ensuring efficient storage management
    - **Retry Support**: Smart retry backoff with delivery attempt tracking
- **Search**: Utilizes Discord's native search UI.

### Feature Specifications
- **Multi-Tenant SaaS**: Complete horizontal tenant isolation.
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to other platforms.
- **Per-Bridge WhatsApp Sessions**: Independent, persistent WhatsApp sessions for each bridge.
- **1-to-Many Output**: Single bridge can forward to multiple destinations.
- **Web Dashboard**: Professional UI with real-time updates and per-bridge WhatsApp controls.
- **WhatsApp Session Management**: Start/Stop/Relink buttons, status badges.
- **Audit Logging**: Comprehensive tracking of activities and events.
- **User Management**: Role-based access control and tenant administration.
- **Quick-Start Wizard**: Guides initial user setup.

### System Design Choices
- **Multi-Tenant Isolation**: Fractalized database architecture prevents cross-tenant data access.
- **Per-Bridge WhatsApp Sessions**: Ensures independent operation and no shared global bot.
- **Session Persistence**: WhatsApp sessions survive server restarts via tenant-scoped storage.
- **24/7 Bridge Uptime**: Auto-restore ensures connected bridges reconnect after server restarts.
- **Safari/iPad Compatibility**: Achieved via JWT in `localStorage`.
- **Scalability**: Designed for Replit Autoscale deployment with health checks.
- **Fractalized Bridge IDs**: SHA-256 hash-based, non-enumerable, tenant-scoped IDs.
- **PostgreSQL Source of Truth**: Database stores bridge configuration, routing data, tenant isolation, and session state.
- **Discord Output Layer**: Messages forwarded to Discord, not stored in PostgreSQL.
- **Crash Recovery Architecture**: PostgreSQL stores all bridge state, enabling system recovery and message flow resumption after crashes.
- **Message Retention**: Discord provides permanent, immutable message storage with native search and organization.
- **Flexible Output Options**: Bridges support both Discord channels and threads, allowing users to choose their preferred organization method.
- **Webhook Security**: Strict validation prevents cross-tenant data exposure and ensures proper message routing.

### Production Hardening (October 2025)
- **Database Connection Pool**: Configured with timeout protections (connectionTimeoutMillis, idleTimeoutMillis, statement_timeout, query_timeout, idle_in_transaction_session_timeout) to prevent idle-in-transaction crashes.
- **Legacy Code Cleanup** (October 31, 2025): Removed all deprecated authentication and test endpoints to eliminate security risks and schema isolation bugs:
    - **Removed Test/UAT Endpoints**: Eliminated `/uat`, test mode logic in `/` and `/index.html` routes that injected fake credentials
    - **Removed Phone OTP Auth**: Deleted `/api/auth/otp/request`, `/api/auth/otp/verify`, `/api/auth/forgot-password/*` endpoints (no Twilio configured)
    - **Fixed User Management**: All endpoints (`/api/users`, `/api/users/:id/role`, `/api/users/:id`, `/api/users/:id/email`, `/api/users/:id/password`) now use tenant-scoped queries
    - **Atomic User Deletion**: DELETE `/api/users/:id` uses dedicated PostgreSQL client with BEGIN/COMMIT transaction to delete from both `tenant_X.users` AND `core.user_email_to_tenant` atomically, preventing orphaned email mappings and re-registration failures
    - **QR Code Fix**: `/api/bridges/:id/qr` endpoint now queries `${tenantSchema}.users` instead of `public.users`, fixing schema isolation bug
    - **User Management**: `/api/users` endpoint returns same-tenant users only for proper isolation
- **JWT Security**: Invalid JWT tokens return 401 immediately without falling back to session auth, preventing auth bypass attacks.
- **Manager Initialization**: WhatsApp and Discord managers initialized inside app.listen callback to eliminate race conditions.
- **Resource Throttling**: Auto-restore sessions staggered by 500ms to prevent resource explosion from opening 100+ WebSockets simultaneously.
- **Security Headers**: CORS with default-deny (allows only Replit domains + explicit whitelist) and Helmet for production-grade HTTP protections.
- **Environment-Aware Cookies**: Secure flag conditional on NODE_ENV (production only) for dev mode compatibility.
- **Audit Logging**: Prefers req.userId over req.session?.userId to prevent audit gaps after session.destroy().
- **Dead Code Removal**: Eliminated obsolete PostgreSQL message functions (updateMessageStatus, getMessageStats) since messages stored only in Discord.
- **Retry-Safe Media Flow**: Atomic PostgreSQL media_buffer prevents zero data loss on delivery failures:
    - media_buffer table stores base64 media with delivery status tracking
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
- **Email Normalization Security** (October 31, 2025): Case-insensitive email uniqueness enforcement across all authentication flows:
    - **Read-Check-Bounce Pattern**: Signup endpoint checks `core.user_email_to_tenant` with LOWER() BEFORE any database writes
    - **Normalized Storage**: All email INSERTs use `email.toLowerCase().trim()` for consistent storage
    - **Case-Insensitive Lookups**: Login and Sybil protection queries use LOWER() to match regardless of case
    - **Complete Coverage**: Normalization applied to signup, login, invite flows, and Sybil tracking
    - **Prevents Duplicates**: Blocks `phi_dao@pm.me`, `PHI_DAO@PM.ME`, `Phi_Dao@Pm.Me` from creating multiple tenants
    - **Input Validation**: Login endpoint validates email/password presence before normalization to prevent errors
- **Autoscale Deployment**: Configured for Replit Autoscale with pay-per-traffic billing (~$26-50/mo for light usage). Sleeps when idle to minimize costs while maintaining 24/7 availability during active periods.
- **Chromium Removal** (October 31, 2025): Removed all Chromium/Playwright dependencies for production optimization:
    - **Deleted Packages**: Removed `@playwright/test` and `playwright` packages (reduced deployment size, improved cold start)
    - **Deleted Files**: Removed `playwright.config.js`, `tests/ui-audit/`, `whatsapp-client-manager.js` (legacy Puppeteer code), `UI_AUDIT_GUIDE.md`, `TESTING_GUIDE.md`
    - **Code Cleanup**: Removed unused `cleanupChromiumLockFiles()` function from index.js
    - **Rationale**: System uses Baileys (WebSocket-based, no browser) and Discord REST API - no browser automation needed
    - **Debug Strategy**: Logging and annotation preferred over screenshot testing for production debugging

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks