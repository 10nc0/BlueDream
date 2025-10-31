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
- **Authentication**: Email/password authentication using JWT tokens in `localStorage` with role-based access control. Multi-tenant user architecture with isolated `tenant_X.users` and `core.user_email_to_tenant` for email-to-tenant mapping.
- **Database (Source of Truth)**: PostgreSQL (Neon-backed) with fractalized multi-tenancy. Uses a `public` schema for core authentication and isolated `tenant_X` schemas for per-tenant bridge metadata. PostgreSQL stores bridge configuration, routing data, and tenant isolation, but NOT message content.
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
- **Multi-Tenant Isolation**: Fractalized database architecture prevents cross-tenant data access.
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

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks