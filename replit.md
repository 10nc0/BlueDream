# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging bridge designed to forward messages from WhatsApp to Discord. It operates as a secure, multi-user application with robust authentication and permanent message retention via Discord threads. Each user has isolated data storage for privacy and security.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bridge only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend. It features an Apple glassmorphism design with a Discord-style two-pane layout, real-time updates, and responsive design for desktop and mobile.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop mode offers a resizable sidebar and header with dynamic positioning. Mobile mode features automatic layout detection, harmonized header, and floating action zone for quick access.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom for media, swipe navigation, auto-hide elements on scroll, 48px touch targets, and momentum scrolling. Cat animation is non-interactive on authentication pages (login/signup/forgot-password) to avoid form field interference, with full wiggle interaction enabled on dashboard.
- **Responsive Components**: Self-contained UI components adapt behavior for mobile/desktop contexts.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL (Neon-backed) with multi-tenant architecture. Isolated schemas provide per-tenant separation for user data, bridge configuration, sessions, and audit logs.
- **WhatsApp Integration**: Multi-instance Baileys library for independent, persistent WhatsApp sessions.
- **QR Regeneration Flow**: Generate QR destroys and reinitializes WhatsApp session for fresh QR code. Warning modal shows ONLY when replacing active connection (connected bridges), clearly communicating temporary disconnection and message loss risk. New/inactive bridges skip warning and generate QR directly.
- **Message Loss Tradeoff**: QR regeneration causes brief (~30 second) downtime where messages sent to the bridge may be lost. This is a necessary tradeoff due to WhatsApp API limitations (error 515 prevents multiple simultaneous sessions with identical credentials). Discord threads/webhooks remain unchanged during reconnection.
- **Discord Integration**: Messages forwarded to user-configured Discord webhooks for permanent storage. Trinity security model with Hermes (φ) for thread creation (MANAGE_THREADS only) and Toth (0) for message reading (READ_MESSAGE_HISTORY only). Auto-healing system checks all bridges at startup and creates missing Discord threads automatically, with on-demand retry when users click "Generate QR".
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
- **Crash Recovery**: PostgreSQL stores all bridge state for automatic recovery.
- **Message Retention**: Discord provides permanent, immutable message storage.
- **Security**: Strict webhook validation, production hardening with database connection pool timeouts, JWT security, staggered resource initialization, security headers (CORS, Helmet), environment-aware cookies, and robust audit logging.
- **Optimized Deployment**: Lightweight architecture without heavy dependencies.
- **CSP Compliance**: Production-ready Content Security Policy with event delegation and self-hosted libraries.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks for message delivery
