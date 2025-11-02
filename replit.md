# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to forward messages from WhatsApp to Discord. It operates as a secure, multi-user application with robust authentication and permanent message retention via Discord threads. Each user has isolated data storage for privacy and security.

## Recent Changes
**November 2, 2025** - REAL-TIME UPDATES: Implemented smart polling and jump-to-message navigation for seamless message viewing:
- **Smart Polling Engine**: 5-second auto-refresh polls Discord for new messages using `?after={messageId}` parameter. Pauses when tab is hidden (Page Visibility API), only fetches messages newer than last seen. Green breath-glow animation highlights newly arrived messages.
- **Auto-Scroll Logic**: Messages auto-scroll to bottom only if user was already there. When user scrolls up, "New messages" banner appears (clickable to jump to bottom) instead of forced scrolling.
- **Jump-to-Message**: Shareable URLs with `#msg-{messageId}` hash allow direct navigation to specific messages. Backend `?around={messageId}&context={n}` parameter fetches target ± context window (max 25 messages). Yellow jump-pulse animation (2s) highlights target message with smooth scroll to center.
- **URL Hash Navigation**: Browser back/forward buttons work with message jumps. `initUrlHashSupport()` parses hash on page load and handles `popstate` events.
- **Duplicate Prevention**: `insertContextMessages()` uses `querySelector` guards to prevent duplicate message insertion. `insertAdjacentHTML` for efficient DOM updates without re-rendering.
- **Input Validation**: Backend validates `context >= 0 && <= 25`, rejects negative values and non-integers. `around` and `after` parameters validated with `isNaN()` checks.
- **Timeline Visibility**: Messages have `min-height: 48px` to ensure visibility when zoomed out. Bucket headers show message counts for timeline organization.
Backend API supports 3 fetch modes: normal pagination (`?before={id}`), polling (`?after={id}`), and jump-to-message (`?around={id}&context={n}`). All modes integrate with existing source parameter (user/ledger) for schema switcheroo.

**November 2, 2025** - CRITICAL FIX: Completed tenant schema initialization for infinite N+1 scalability. TenantManager now creates complete database schemas with all required columns for new tenants. Fixed schema mismatches across four tables:
- `refresh_tokens`: Added `token_hash` (not `token`), `device_info`, `ip_address`, `revoked_at`, `is_revoked` to match auth-service.js
- `audit_logs`: Renamed columns to match logAudit function (`actor_user_id`, `action_type`, `target_type`, `target_id`)
- `active_sessions`: Added `device_type`, `browser`, `os`, `location`, `login_time`, `is_active` for session tracking
- `media_buffer`: Fixed critical schema mismatch - added `filename`, `sender_name`, `delivered_to_ledger`, `delivered_to_user`, `delivery_attempts`, changed `media_data` from TEXT to BYTEA for binary storage

**MEDIA ATTACHMENT BUG FIX**: Removed `SET LOCAL search_path` from media INSERT transaction (line 846) that was causing multiple images to get duplicate IDs. Now using schema-qualified queries (`${tenantSchema}.media_buffer`) to ensure atomic uniqueness. This fixes the issue where only 1 of 3 images would appear as Discord attachments.

Migrated existing tenants (9, 10, 11, 12, 13) to match new schema. Removed legacy migration code from index.js that conflicted with TenantManager. Logout flow hardened with non-fatal error handling and correct cookie name (`book.sid`). Session destruction now guaranteed regardless of schema state. System ready for production N+1 tenant creation and reliable media forwarding.

**November 2, 2025** - Breakthrough UX improvement: Made personal webhooks (output_0n) completely optional to eliminate #1 onboarding friction. Users can now create books in 5 seconds (name → instant QR → scan → done) without knowing what a webhook is. Webhooks moved to Edit tab as optional power-user feature. Removed all "Discord" terminology from user-facing text, replaced with platform-agnostic "Webhook URL" that works with Discord, Slack, or any webhook service. Backend already supported optional output_0n perfectly; frontend updated to match with simplified Create modal and progressive disclosure in Edit modal.

**November 2, 2025** - Complete terminology refactor from "bridge" to "book" across the entire codebase to align with product branding and user mental model (messages are recorded in a notebook/book, not bridged). This includes database schema (`bridges` → `books` table), all backend functions, frontend UI, CSS classes, and user-facing text. Preserved existing fractal_ids (dev_bridge_t1_...) as immutable database data.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend. It features an Apple glassmorphism design with a Discord-style two-pane layout, real-time updates, and responsive design for desktop and mobile.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop mode offers a resizable sidebar and header with dynamic positioning. Mobile mode features automatic layout detection, harmonized header, and floating action zone for quick access.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom for media, swipe navigation, auto-hide elements on scroll, 48px touch targets, and momentum scrolling. Cat animation is non-interactive on authentication pages (login/signup/forgot-password) to avoid form field interference, with full wiggle interaction enabled on dashboard.
- **Responsive Components**: Self-contained UI components adapt behavior for mobile/desktop contexts.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL (Neon-backed) with multi-tenant architecture. Isolated schemas provide per-tenant separation for user data, book configuration, sessions, and audit logs.
- **WhatsApp Integration**: Multi-instance Baileys library for independent, persistent WhatsApp sessions.
- **QR Regeneration Flow**: Generate QR destroys and reinitializes WhatsApp session for fresh QR code. Warning modal shows ONLY when replacing active connection (connected books), clearly communicating temporary disconnection and message loss risk. New/inactive books skip warning and generate QR directly.
- **Message Loss Tradeoff**: QR regeneration causes brief (~30 second) downtime where messages sent to the book may be lost. This is a necessary tradeoff due to WhatsApp API limitations (error 515 prevents multiple simultaneous sessions with identical credentials). Discord threads/webhooks remain unchanged during reconnection.
- **Webhook Integration**: Messages always saved to output_01 Ledger (eternal, automatic). Personal webhooks (output_0n) are completely optional - users can add them later in Edit tab to mirror messages to their own channel. Works with any webhook service (Discord, Slack, etc.). Trinity security model with Hermes (φ) for thread creation (MANAGE_THREADS only) and Toth (0) for message reading (READ_MESSAGE_HISTORY only). Auto-healing system checks all books at startup and creates missing Discord threads automatically, with on-demand retry when users click "Generate QR".
- **Media Handling**: Atomic storage for base64-encoded media with delivery tracking and automatic cleanup.
- **Search**: Enhanced search functionality across messages and metadata tags.
- **Metadata System**: Universal tagging system supporting plain words, hashtags, captions, dates, and multilingual text (English, 日本語, 中文, العربية, etc.). Tags stored with full-text search indexing.
- **Unified Interface**: Centralized action registry maps all UI actions for both mobile and desktop, reducing code duplication.
- **Auto-Scaling Timeline**: Intelligent message organization using density-based algorithms to group messages into time buckets.
- **Export System**: Data portability with ZIP download containing messages and metadata.
- **Interactive UI**: Modern responsive interface with glassmorphism effects and smooth animations.

**System Design Choices:**
- **Multi-Tenant Isolation**: Database architecture ensures complete data separation between users.
- **Session Persistence**: WhatsApp sessions survive server restarts with auto-restore for 24/7 uptime.
- **Compatibility**: Cross-browser support including Safari/iPad via JWT in localStorage.
- **Scalability**: Designed for Replit Autoscale deployment.
- **Crash Recovery**: PostgreSQL stores all book state for automatic recovery.
- **Message Retention**: Discord provides permanent, immutable message storage.
- **Security**: Strict webhook validation, production hardening with database connection pool timeouts, JWT security, staggered resource initialization, security headers (CORS, Helmet), environment-aware cookies, and robust audit logging.
- **Optimized Deployment**: Lightweight architecture without heavy dependencies.
- **CSP Compliance**: Production-ready Content Security Policy with event delegation and self-hosted libraries.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks for message delivery
