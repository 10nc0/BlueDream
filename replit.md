# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord. Its primary purpose is to provide permanent message retention via Discord threads and isolated data storage for each user. The project aims for zero-friction onboarding, a highly customizable interface, and offers a secure and efficient way for users to archive WhatsApp conversations, targeting individuals and small businesses needing reliable message retention and easy access. The project also features an AI Playground for multimodal interaction and an AI Audit System for message verification.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout, with real-time updates and responsiveness.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop has resizable sidebar/header; mobile has automatic layout, harmonized header, and floating action zone.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom, swipe navigation, auto-hide elements, 48px touch targets, and momentum scrolling.
- **Visual Elements**: Cat animation in header, blinking date/time, Discord-style message layout.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL with multi-tenant architecture, using isolated schemas per user and a centralized book registry (`core.book_registry`).
- **WhatsApp Integration**: Twilio-based messaging using WhatsApp Business API with a join-code-first routing architecture.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord as native attachments.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}`, auto-scroll, "New messages" banner, and jump-to-message functionality.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, providing general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior. Audit results are logged via the Prometheus Trinity Discord bots.
- **AI Playground**: A sovereign, public AI playground at `/AI` without authentication, offering multimodal support (Text, Photo, Audio, Documents), multi-file upload, dynamic capacity sharing, and abuse prevention. It features query classification, a factual cache, smart retry mechanisms, document parsing, and a search cascade for real-time knowledge. **Closed-loop document analysis** skips web search entirely for financial documents (user's own data needs no external verification).
- **Nyan Protocol (Permanent Seed Context)**: A specific protocol for historical comparison and socio-economic analysis, including a "Price/Income ratio" metric.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL stores all book state for recovery.
- **Security**: Strict webhook validation, JWT security, robust audit logging, Sybil attack prevention, and CSP compliance.
- **Discord Bot Trinity Architecture**:
    - **Human Trinity (WhatsApp → Discord forwarding):** Hermes (write-only for threads/messages), Thoth (read-only for message history).
    - **Prometheus Trinity (AI Audit Logging):** Idris (write-only for AI log threads/audit results), Horus (read-only for AI audit history).
- **Financial Physics System**: A 4-tier architecture (`utils/financial-physics.js`) for financial cognition, including document type detection, nature classification, semantic enrichment, and validation, with a specialized `FINANCIAL_PHYSICS_SEED` for AI context.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **AI (Production)**: Groq API
- **AI (Playground)**: Groq API (text + vision via dedicated tokens)
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`