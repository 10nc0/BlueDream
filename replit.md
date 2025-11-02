# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord. It provides robust authentication, permanent message retention via Discord threads, and isolated data storage for each user. The project aims to offer a zero-friction onboarding experience and a highly customizable, responsive interface for managing personal message archives.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout. It supports real-time updates and is responsive across devices.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop offers a resizable sidebar and header; mobile features automatic layout, harmonized header, and a floating action zone.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom, swipe navigation, auto-hide elements on scroll, 48px touch targets, and momentum scrolling. Cat animation is interactive on dashboard but non-interactive on auth pages.
- **Responsive Components**: UI components adapt for mobile/desktop contexts.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL with multi-tenant architecture, ensuring data separation per user via isolated schemas.
- **WhatsApp Integration**: Multi-instance Baileys library for independent, persistent WhatsApp sessions. QR regeneration reinitializes sessions with clear warnings about potential message loss during reconnection. Group message forwarding is an optional, per-book configuration.
- **Webhook Integration**: Messages are permanently saved to an internal Ledger. Optional personal webhooks (Discord, Slack, etc.) can mirror messages, with an improved UX that makes webhooks optional for initial book creation.
- **Media Handling**: Atomic storage for base64-encoded media, with delivery tracking and automatic cleanup. Fixed critical bugs preventing media delivery and ensuring unique media IDs.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}` fetches new messages, pausing when the tab is hidden. Auto-scrolls only if the user is at the bottom, otherwise shows a "New messages" banner. Jump-to-message functionality with `#msg-{messageId}` allows direct navigation to specific messages.
- **Terminology Refactor**: All internal and external "bridge" terminology has been replaced with "book" for consistent branding and user understanding.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation between users via database schemas.
- **Session Persistence**: WhatsApp sessions survive server restarts with auto-restore.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL storing all book state for automatic recovery.
- **Security**: Strict webhook validation, production hardening with JWT security, staggered resource initialization, security headers, and robust audit logging.
- **CSP Compliance**: Production-ready Content Security Policy with event delegation and self-hosted libraries.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed Replit database)
- **WhatsApp**: Baileys library
- **Discord**: Discord webhooks for message delivery