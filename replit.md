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
### Global Constants (Isolated UI Islands)
The system uses two immutable global constants protected from dynamic UI changes:
1. **NYANBOOK_LEDGER_WEBHOOK_URL**: Dev-only Discord webhook for ledger oversight
2. **CAT_CONFIG**: Pixel cat animation settings

### UI/UX Decisions
The dashboard is a Single Page Application (SPA) with an Apple glassmorphism design, featuring a Discord-style two-pane layout. It includes real-time updates, circular avatars, status badges, responsive design for mobile, and custom tooltips for accessibility.

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication.
- **Authentication**: Email/password authentication using JWT tokens in `localStorage` with role-based access control. **Pure tenant_X architecture**: Users stored ONLY in `tenant_X.users` (no global user table). Email-to-tenant routing via `core.user_email_to_tenant` mapping table. First signup becomes Genesis Admin (dev role, tenant_1, god view).
- **Database (Source of Truth)**: PostgreSQL (Neon-backed) with **pure fractalized multi-tenancy**. Database schema architecture:
  - `core` schema: Tenant registry (`tenant_catalog`), email routing (`user_email_to_tenant`), invites, security tables (sybil protection, rate limits)
  - `tenant_X` schemas: Per-tenant isolation with `users`, `bridges`, `active_sessions`, `audit_logs`, `refresh_tokens`, `media_buffer`
  - `public` schema: Only `sessions` table for express-session global store
  - **CRITICAL**: NO `public.users` table - all user data lives exclusively in `tenant_X.users` (first principles: single source of truth)
- **WhatsApp Integration**: Multi-instance `Baileys` with `BaileysClientManager` for independent, tenant-scoped persistent sessions.
- **Discord Integration (Dual Output + Unified Fetch)**: Messages are sent to both a dev oversight webhook (Ledger) and the user's webhook. A Discord bot creates dedicated threads for each bridge on the Ledger webhook. The UI fetches messages from the Ledger thread for both display and development, offering a transparent user experience without requiring bot invites to user channels.
- **Media Handling**: Retry-safe atomic storage via `media_buffer` in PostgreSQL for base64-encoded media, ensuring zero media loss. Includes delivery tracking, smart retry backoff, and automatic 3-day purge. `BYTEA` type is used for binary-safe storage.
- **Search**: Utilizes Discord's native search UI.

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
- **Multi-Tenant Isolation**: Pure fractalized database architecture prevents cross-tenant data access. Each tenant has complete schema isolation with their own `users`, `bridges`, `sessions`, and `audit_logs` tables. Zero data leakage between tenants.
- **Session Persistence**: WhatsApp sessions survive server restarts.
- **24/7 Bridge Uptime**: Auto-restore ensures connected bridges reconnect.
- **Safari/iPad Compatibility**: Achieved via JWT in `localStorage`.
- **Scalability**: Designed for Replit Autoscale deployment.
- **Fractalized Bridge IDs**: SHA-256 hash-based, non-enumerable, tenant-scoped IDs.
- **Crash Recovery Architecture**: PostgreSQL stores all bridge state, enabling system recovery.
- **Message Retention**: Discord provides permanent, immutable message storage with native search and organization.
- **Flexible Output Options**: Bridges support both Discord channels and threads.
- **Webhook Security**: Strict validation prevents cross-tenant data exposure.
- **Production Hardening**: Includes database connection pool timeouts, strict JWT security, staggered resource initialization, security headers (CORS, Helmet), environment-aware cookies, and robust audit logging.
- **Chromium Removal**: Eliminated Playwright/Chromium dependencies for optimized production deployment, reducing size and improving cold start times.
- **Secret Management**: Relies on Replit Secrets for secure environment variable management; admin panel secret updates were removed to prevent misleading UX.

## Recent Architecture Changes (Oct 31, 2025)
### Pure Tenant_X Migration + Genesis Admin Hardening
Completed full migration to pure tenant_X architecture with NO global `public.users` table:
- **Before**: Dual storage with `public.users` + `tenant_X.users` (data inconsistency risk)
- **After**: Single source of truth - users stored ONLY in `tenant_X.users`
- **Signup Flow**: Creates user in `tenant_X.users` → maps email in `core.user_email_to_tenant`
- **Login Flow**: Queries `core.user_email_to_tenant` → retrieves user from `tenant_X.users`
- **Genesis Admin**: First tenant signup gets `role='dev'`, `is_genesis_admin=true`, `tenant_1`
- **Database Cleanup**: Dropped `public.users`, `public.active_sessions`, `public.audit_logs` tables
- **InitializeDatabase Fix**: Removed public schema table creation (except `sessions`)
- **Architect Verified**: Post-restart confirmation that tables stay in tenant schemas only

### Genesis Admin System Hardening (Oct 31, 2025)
Fixed critical bugs preventing genesis admin achievement:
- **Sybil Protection Bypass**: Genesis admin now skips ALL rate limits and sybil checks (first principles: genesis should never be blocked)
- **Ghost Tenant Fix**: Auto-restore now queries `core.tenant_catalog` instead of `information_schema` (prevents errors from orphaned schemas)
- **UI Detection**: Dashboard now properly detects `isGenesisAdmin` flag and displays 🌟 badge + Dev Panel access
- **CORS Whitelist**: Added `.replit.app` domain support for published site
- **Cache-Busting**: Added `Cache-Control: no-store, no-cache, must-revalidate, private` + `Pragma: no-cache` + `Expires: 0` headers to ALL auth endpoints (`/api/auth/check-genesis`, `/api/auth/status`, `/api/auth/login`, `/api/auth/register/public`) to prevent browser/CDN caching of authentication state

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks