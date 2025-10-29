# Nyan Bridge 🌈

## Overview
Nyan Bridge is a professional, multi-platform messaging bridge designed to connect WhatsApp to platforms like Discord and Telegram. It features robust authentication, permanent message retention (write-only), and a PostgreSQL database for storage. The project is deployed as a **SaaS application** where all users access the same instance via a public URL. Its core capabilities include multi-user authentication, 1-to-many output forwarding, media support, and comprehensive audit logging, ensuring messages and bridge activities are permanently recorded and accessible.

## 🌐 Deployment Model: Multi-Tenant SaaS Application

**This is a deployed web app with fractalized database architecture, NOT a template for forking.**

### How It Works
- **One Deployment**: Single instance hosted on Replit Autoscale
- **Fractalized Database**: Each user signup creates an **isolated PostgreSQL schema** (tenant_1, tenant_2, etc.)
- **Public URL**: Users visit your deployed site (e.g., `nyan-bridge.replit.app`)
- **100% Tenant Isolation**: Each Genesis admin has their own isolated database schema with dedicated DB clients
- **Genesis Admin Per Tenant**: Each signup creates a new tenant where that user becomes the Genesis admin

### Database Architecture (Fractalized Multi-Tenancy)
- **Global Schema (`public`)**: Core authentication tables (`users`, `sessions`, `audit_logs`)
- **Tenant Schemas (`tenant_X`)**: Isolated per-tenant tables (`bridges`, `messages`, `users`)
- **Complete Isolation**: Tenants CANNOT see each other's data - enforced by transaction-scoped `SET LOCAL search_path`
- **Dedicated DB Clients**: Each tenant has its own database client pool for true horizontal isolation

### User Flow
1. **New User Signs Up** → System creates isolated `tenant_X` schema → User becomes Genesis admin of their tenant
2. **Genesis Admin** → Creates bridges, starts WhatsApp sessions, manages their tenant → **Starts with 0 bridges**
3. **Additional Users** → Genesis admin can invite users to their tenant with role-based permissions (admin, read-only, write-only)

### No Forking Required
Users do NOT fork the code. They simply:
- Visit your deployed website
- Create an account (email or Google OAuth)
- Become Genesis admin of their own **isolated tenant**
- Create and manage their own bridges independently

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bridge only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bridges, responsive sidebar collapse

## System Architecture
### UI/UX Decisions
The dashboard is a Single Page Application (SPA) featuring an Apple glassmorphism design. It adopts a Discord-style two-pane layout with a left sidebar for bridge management and a right pane for message feeds. The UI includes real-time updates, circular avatars, status badges, and responsive design for mobile compatibility. Accessibility is enhanced with custom tooltips that dynamically adjust positioning to prevent viewport cropping.

**Dev Panel (Admin #01 Only):**
- System-wide bridge visibility across all tenants
- Horizontal tenant cards showing Admin #01 (Dev - gold badge) and Admin #02+ (Genesis Admins - blue badges)
- Bridge statistics per tenant: message count, success/failure rates
- Complete isolation: regular users see only their tenant's bridges

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication handling.
- **Authentication**: Dual-authentication system using JWT tokens stored in `localStorage` (for Safari/iPad compatibility) and session cookies. It supports multi-user authentication with role-based access control (admin, read-only, write-only) and includes an in-progress Google OAuth integration.
- **Database**: PostgreSQL (Neon-backed Replit database) with **fractalized multi-tenancy**:
  - **Global Schema**: `public` schema contains `users`, `sessions`, `audit_logs`
  - **Tenant Schemas**: Each user signup creates isolated `tenant_X` schema with `bridges`, `messages`, `users`
  - **Horizontal Isolation**: Dedicated database clients per tenant with transaction-scoped `SET LOCAL search_path`
  - **Dev Access**: Special dev user (`phi_dao@pm.me`) has global cross-tenant access for debugging
- **WhatsApp Integration**: Multi-instance architecture using `whatsapp-web.js`:
  - **WhatsAppClientManager**: Manages multiple independent WhatsApp sessions using composite `tenantSchema:bridgeId` keys
  - **Tenant-Scoped Sessions**: Each bridge has its own session stored in `.wwebjs_auth/session-{tenantSchema}_bridge_{bridgeId}/`
  - **Cross-Tenant Isolation**: Composite keys and tenant-scoped paths prevent bridge ID collisions between tenants
  - **Session Persistence**: Sessions survive server restarts with automatic restoration (no QR re-scan needed)
  - **Legacy Migration**: Auto-migrates pre-fractalization sessions to tenant-scoped paths on first startup
  - **Tenant-Aware Routing**: Messages automatically route to correct tenant schema based on bridge ownership
  - **Bridge-Level API**: Start, stop, relink WhatsApp sessions independently per bot
- **Discord Integration**: Uses Discord webhooks for forwarding messages.
- **Session Management**: `express-session` with a PostgreSQL store.
- **Media Handling**: Supports forwarding of images, videos, and documents. Media is lazy-loaded with an `IntersectionObserver` and cached using a triple-layer system (memory, IndexedDB, server API).
- **Search**: Features natural language date parsing (e.g., "today", "last week", "October 2025") and intelligent regex detection for advanced queries.
- **Data Retention**: Messages are write-only; no DELETE operations are permitted except for bridge deletion, which cascades to associated messages.

### Feature Specifications
- **Multi-Tenant SaaS**: Complete horizontal tenant isolation with fractalized database architecture
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to Telegram
- **Per-Bridge WhatsApp Sessions**: Each bridge has independent WhatsApp session with persistent credentials
- **1-to-Many Output**: A single bridge can forward messages to multiple destinations
- **Web Dashboard**: Professional UI with real-time updates, Discord-style message feed, and per-bridge WhatsApp controls
- **WhatsApp Session Management**: Start/Stop/Relink buttons, status badges (Connected, Scan QR, Inactive, etc.)
- **Audit Logging**: Comprehensive tracking of session activities, authentication events, and CRUD operations
- **Admin Panel**: An admin-only interface for monitoring users, sessions, and audit logs (per-tenant)
- **Quick-Start Wizard**: Guides first-time users through the initial setup process

### System Design Choices
- **Multi-Tenant Isolation**: Fractalized database architecture ensures Genesis admins cannot see other tenants' data
- **Per-Bridge WhatsApp Sessions**: Each bridge creates its own WhatsApp session (no shared global bot)
- **Session Persistence**: WhatsApp sessions survive server restarts via tenant-scoped LocalAuth storage in `.wwebjs_auth/session-{tenantSchema}_bridge_{bridgeId}/`
- **Composite Tracking**: All WhatsApp clients tracked with `tenantSchema:bridgeId` keys (e.g., `tenant_6:7`) preventing cross-tenant collisions
- **24/7 Bridge Uptime**: Auto-restore on startup ensures all connected bridges reconnect automatically after server restarts
- **Automatic Lock File Cleanup**: Cleans stale Chromium lock files (SingletonLock, SingletonSocket, SingletonCookie) before bridge initialization to prevent launch failures on restart
- **All Admins Start with 0 Bots**: No pre-created bridges - each admin creates their own from scratch
- **Safari/iPad Compatibility**: Achieved by relying on JWT in `localStorage` for primary authentication, addressing ITP cookie blocking
- **Permanent Data Retention**: Ensures no message data is ever lost by disallowing deletion (except for bridge cascade)
- **Scalability**: Designed for potential Autoscale deployment on Replit, with health checks and dynamic port configuration

### Key Files
- **`whatsapp-client-manager.js`**: Multi-instance WhatsApp client manager (one per bridge)
- **`tenant-middleware.js`**: Tenant context middleware for request isolation
- **`tenant-manager.js`**: Database client pool manager with per-tenant isolation
- **`index.js`**: Main Express server with bridge-level WhatsApp API endpoints
- **`public/index.html`**: SPA dashboard with per-bridge WhatsApp controls (Start, Stop, Relink, QR)

## External Dependencies
- **Database**: PostgreSQL (specifically Neon-backed Replit database)
- **WhatsApp**: `whatsapp-web.js` library
- **Discord**: Discord webhooks
- **Authentication (In Progress)**: Google OAuth via `passport` and `passport-google-oauth20`
- **AI (Dismissed)**: OpenAI (gpt-5-mini) for AI-powered search was removed for cost optimization.