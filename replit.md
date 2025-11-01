# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-input messaging bridge designed to forward messages from various platforms (e.g., WhatsApp, Telegram, Twitter/X, SMS, Email) to Discord. It operates as a multi-tenant SaaS application, providing robust authentication, permanent message retention via Discord threads, and a PostgreSQL database for configuration and routing. Each user has an isolated PostgreSQL schema, ensuring data separation. Key capabilities include a hybrid input model (WhatsApp, Generic Webhooks), unified output to Discord webhooks, and a multi-tenant SaaS architecture with fractalized database isolation. The project aims to provide a zero-cost solution for webhook inputs.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bridge only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding single bridges, responsive sidebar collapse, user-customizable layout dimensions
- **Mobile**: Cat animation properly positioned above date/time on login page (100×100px with 2rem spacing)

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend. It features an Apple glassmorphism design with a Discord-style two-pane layout, real-time updates, and responsive design for desktop and mobile.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop mode offers a resizable sidebar and header, with dynamic date/time positioning. Mobile mode features automatic layout detection, a harmonized header, and a "Floating Thumbs Zone" for quick actions.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom for media, swipe navigation, auto-hide elements on scroll, 48px touch targets, and momentum scrolling.
- **Transcendental Cat Component**: A self-contained, independent cat animation component (`public/js/ui/cat-animation.js`, `public/components/cat-animation.html`, `public/css/components/cat-animation.css`) exists across all pages, adapting behavior for mobile/desktop.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and user data isolated within tenant-specific PostgreSQL tables.
- **Database**: PostgreSQL (Neon-backed) with pure fractalized multi-tenancy. A `core` schema manages tenant registry, while `tenant_X` schemas provide per-tenant isolation for user data, bridges, sessions, audit logs, and media buffers.
- **WhatsApp Integration**: Multi-instance Baileys for independent, tenant-scoped persistent sessions.
- **Discord Integration**: Messages are sent to both a Ledger thread for development oversight and user-defined webhooks.
- **Media Handling**: Retry-safe atomic storage for base64-encoded media in PostgreSQL with delivery tracking and automatic purging.
- **Search**: Leverages Discord's native search UI and an enhanced Universal Search across messages and metadata ("Drops").
- **Metadata System (Drops)**: Allows users to add freeform metadata (text, tags, dates) to messages, stored in the `drops` table within each `tenant_X` schema, indexed with `TSVECTOR` for full-text search. **Data hierarchy**: `tags ← message ← bridge ← tenant`, with GIN indexes on `extracted_tags[]` (1D arrays only), `discord_message_id`, and `bridge_id` for efficient querying. Tags are extracted via zero-cost regex (`MetadataExtractor`) and displayed as interactive bubbles with × delete buttons in the Discord embed UI. **Critical fix (Nov 2025)**: PostgreSQL arrays require `::text[]` type casting when inserting/updating from JavaScript arrays to ensure proper storage.
- **Unified Action Registry**: A central `ACTION_REGISTRY` object maps all UI actions for both mobile and desktop, reducing code duplication and simplifying event handling.
- **Auto-Scaling Timeline & Export System**: Implemented for intelligent message organization and data portability. The timeline uses a density-based algorithm to group messages into 24h, 8h, or 6h buckets. The export system allows users to download a ZIP file containing messages and merged drops metadata.

**System Design Choices:**
- **Multi-Tenant Isolation**: Pure fractalized database architecture.
- **Session Persistence & Uptime**: WhatsApp sessions survive server restarts, and auto-restore ensures connected bridges reconnect for 24/7 uptime.
- **Compatibility**: Safari/iPad compatibility achieved via JWT in `localStorage`.
- **Scalability**: Designed for Replit Autoscale deployment.
- **Crash Recovery**: PostgreSQL stores all bridge state.
- **Message Retention**: Discord provides permanent, immutable message storage.
- **Security**: Strict webhook validation, production hardening with database connection pool timeouts, strict JWT security, staggered resource initialization, security headers (CORS, Helmet), environment-aware cookies, and robust audit logging.
- **Optimized Deployment**: Eliminated Playwright/Chromium dependencies.
- **CSP Compliance**: Production-ready Content Security Policy with event delegation and self-hosted libraries.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks