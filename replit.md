# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord. Its primary purpose is to provide permanent message retention via Discord threads and isolated data storage for each user. The project aims for zero-friction onboarding, a highly customizable interface, and offers a secure and efficient way for users to archive WhatsApp conversations, targeting individuals and small businesses needing reliable message retention and easy access.

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
- **Responsive Components**: UI components adapt for mobile/desktop.
- **Visual Elements**: Cat animation in header, blinking date/time, Discord-style message layout.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL with multi-tenant architecture, using isolated schemas per user.
- **Book Registry**: Centralized global registry (`core.book_registry`) for O(1) join code lookups, storing book metadata.
- **WhatsApp Integration**: Twilio-based messaging integration using WhatsApp Business API with a join-code-first routing architecture.
- **Webhook Integration**: Messages are permanently saved to a Ledger with multi-webhook capability.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord as native attachments.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}`, auto-scroll, "New messages" banner, and jump-to-message functionality.
- **Terminology Refactor**: "Bridge" terminology replaced with "book".

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL stores all book state for recovery.
- **Security**: Strict webhook validation, JWT security, robust audit logging, Sybil attack prevention, and CSP compliance. Password recovery has been removed.

**Discord Bot Trinity Architecture:**
- **Human Trinity (WhatsApp → Discord forwarding):**
    - **Hermes (φ)**: Write-only bot for creating threads and posting messages.
    - **Thoth (0)**: Read-only bot for fetching message history.
- **Prometheus Trinity (AI Audit Logging):**
    - **Idris (ι)**: Write-only bot for creating AI log threads and posting audit results.
    - **Horus (Ω)**: Read-only bot for fetching AI audit history.

**AI Audit System (Prometheus):**
- Provides AI-powered message verification using Groq API (llama-3.3-70b-versatile).
- Features: General Intelligence, H(0) Guard Rails (zero-hallucination), Bilingual Support, Prompt-Directed behavior.
- UI Integration: AI Audit button and History button in the dashboard.
- Discord Logging: All AI audit results logged via Prometheus Trinity.

**AI Playground (Public):**
- Sovereign, public AI playground at `/AI` without authentication.
- **Multimodal Support**: Text (Groq Llama 3.3 70B), Photo (Groq Llama 4 Scout Vision), Audio (Groq Whisper), Documents (PDF, Excel, Word).
- **Input Methods**: Drag & drop, file picker, microphone, paste images.
- **Rate Limiting**: Per-IP 50 requests/hour; HuggingFace Vision 40 photos/day.
- **Document Parsing**: Cascade workflow for various formats, handling token limits with smart truncation.
- **Search Cascade (Real-time Knowledge)**: Uses DuckDuckGo and Brave Search to overcome Groq's knowledge cutoff.
- **Nyan Protocol (Permanent Seed Context)**: A specific protocol for historical comparison and socio-economic analysis, including a "Price/Income ratio" metric with contextual conclusions, designed to "HUMANIZE EVERY RATIO".
- **H₀ + Problem-Solving Protocol**: Temperature 0.15, confidence-based extrapolation, strict citation, and zero hallucination.
- **Isolation Architecture**: Uses separate API tokens to prevent playground abuse from impacting the core app.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **AI (Production)**: Groq API
- **AI (Playground)**: Groq API, HuggingFace Vision API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` (for local processing)