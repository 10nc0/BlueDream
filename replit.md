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
- **Media Handling**: Forwards images, videos, and documents directly to Discord threads.
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

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks