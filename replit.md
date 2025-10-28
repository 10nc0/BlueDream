# Nyan Bridge 🌈

## Overview
Nyan Bridge is a professional, multi-platform messaging bridge designed to connect WhatsApp to platforms like Discord and Telegram. It features robust authentication, permanent message retention (write-only), and a PostgreSQL database for storage. The project is deployed as a **SaaS application** where all users access the same instance via a public URL. Its core capabilities include multi-user authentication, 1-to-many output forwarding, media support, and comprehensive audit logging, ensuring messages and bot activities are permanently recorded and accessible.

## 🌐 Deployment Model: SaaS Application

**This is a deployed web app, NOT a template for forking.**

### How It Works
- **One Deployment**: Single instance hosted on Replit Autoscale
- **One Database**: All users share the same PostgreSQL database
- **Public URL**: Users visit your deployed site (e.g., `nyan-bridge.replit.app`)
- **Multi-User**: Users sign up and create accounts on YOUR instance
- **Genesis Admin**: First user to sign up becomes admin (you)

### User Flow
1. **You (Developer)**: Deploy the app → Become Genesis admin
2. **End Users**: Visit your URL → Sign up → Use the bridge
3. **You (Admin)**: Manage users, assign roles, monitor activity

### No Forking Required
Users do NOT fork the code. They simply:
- Visit your deployed website
- Create an account (email or Google OAuth)
- Start using the messaging bridge

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO bot only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user auth with audit logging
- **Compatibility**: Safari/iPad support critical
- **UX**: Auto-expanding single bots, responsive sidebar collapse

## System Architecture
### UI/UX Decisions
The dashboard is a Single Page Application (SPA) featuring an Apple glassmorphism design. It adopts a Discord-style two-pane layout with a left sidebar for bot management and a right pane for message feeds. The UI includes real-time updates, circular avatars, status badges, and responsive design for mobile compatibility. Accessibility is enhanced with custom tooltips that dynamically adjust positioning to prevent viewport cropping.

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: SPA with client-side authentication handling.
- **Authentication**: Dual-authentication system using JWT tokens stored in `localStorage` (for Safari/iPad compatibility) and session cookies. It supports multi-user authentication with role-based access control (admin, read-only, write-only) and includes an in-progress Google OAuth integration.
- **Database**: PostgreSQL (Neon-backed Replit database) for permanent retention of all data, including messages, users, sessions, bots, and audit logs.
- **WhatsApp Integration**: Utilizes `whatsapp-web.js` to interact with the WhatsApp Web protocol.
- **Discord Integration**: Uses Discord webhooks for forwarding messages.
- **Session Management**: `express-session` with a PostgreSQL store.
- **Media Handling**: Supports forwarding of images, videos, and documents. Media is lazy-loaded with an `IntersectionObserver` and cached using a triple-layer system (memory, IndexedDB, server API).
- **Search**: Features natural language date parsing (e.g., "today", "last week", "October 2025") and intelligent regex detection for advanced queries.
- **Data Retention**: Messages are write-only; no DELETE operations are permitted except for bot deletion, which cascades to associated messages.

### Feature Specifications
- **Multi-Platform Bridge**: WhatsApp to Discord, extensible to Telegram.
- **1-to-Many Output**: A single bot can forward messages to multiple destinations.
- **Web Dashboard**: Professional UI with real-time updates and Discord-style message feed.
- **Audit Logging**: Comprehensive tracking of session activities, authentication events, and CRUD operations.
- **Admin Panel**: An admin-only interface for monitoring users, sessions, and audit logs.
- **Quick-Start Wizard**: Guides first-time users through the initial setup process.

### System Design Choices
- **Safari/iPad Compatibility**: Achieved by relying on JWT in `localStorage` for primary authentication, addressing ITP cookie blocking.
- **Permanent Data Retention**: Ensures no message data is ever lost by disallowing deletion (except for bot cascade).
- **Scalability**: Designed for potential Autoscale deployment on Replit, with health checks and dynamic port configuration.

## External Dependencies
- **Database**: PostgreSQL (specifically Neon-backed Replit database)
- **WhatsApp**: `whatsapp-web.js` library
- **Discord**: Discord webhooks
- **Authentication (In Progress)**: Google OAuth via `passport` and `passport-google-oauth20`
- **AI (Dismissed)**: OpenAI (gpt-5-mini) for AI-powered search was removed for cost optimization.