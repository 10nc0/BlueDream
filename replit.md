# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder and post-filing structure archiving architecture that aims to provide a zero-friction, highly customizable, secure, and efficient way to archive documents, photos, and drive links. It supports record archiving via WhatsApp, Twilio, and Discord channel flows, promoting data sovereignty. The project envisions a future with sovereign, secure, and efficient remote storage infrastructure and remote inference (AI as compression and acceleration) for individuals, businesses, and public organizations.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features

## System Architecture
The system utilizes a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. It treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**Core Architectural Models:**
- **3-Layer Perception-Substrate-Cognition Model:** Orchestrates file classification, extraction, caching (Perception), immutable state and shared constants (Substrate), and a 7-stage state machine for reasoning and auditing (Cognition).
- **7-Layer AI Processing Pipeline:** Manages AI interactions from identity and system prompts (Layer 1) to AI interface (Layer 7), including perception, measurement, memory, verification, and orchestration.

**UI/UX Decisions:**
- Adaptive and responsive design with enhanced touch interactions.
- Visual elements include a cat animation, blinking date/time, Discord-style messaging, and fixed message scrolling.
- A `LayoutController` acts as a unified state machine for managing UI modes, device detection, expansion states, and animations.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access, and isolated user data. Auth module (`public/js/modules/auth.js`) provides `window.authFetch` with automatic token refresh.
- **Database**: Multi-tenant PostgreSQL architecture with isolated schemas.
- **Messaging Integration**: Twilio-based WhatsApp Business API for messaging, with media handling for Discord uploads.
- **Search**: Enhanced search across messages and metadata.
- **Real-time Updates**: Smart polling and auto-scroll.
- **Unified AI Engine (Nyan AI)**: Single AI engine for both public playground and authenticated dashboard audit. Uses 2-key security model: `PLAYGROUND_GROQ_TOKEN` for public access, `GROQ_API_KEY` for authenticated dashboard users. Features a 4-stage dashboard audit pipeline (S0-S3) to detect and correct count hallucinations.
- **AuditCapsule**: Session-scoped temporal cache (`utils/audit-capsule.js`) that captures entity extraction and tallies, shares pre-computed counts between pipeline stages, and burns after delivery. Integrated with `buildAuditContext` which now returns `entityAggregates` alongside `recentMessages`.
- **Executive Formatter**: Post-processing layer (`utils/executive-formatter.js`) that strips conversational filler from audit responses for executive-style brevity. Supports bilingual ID/EN patterns for apologies, pleasantries, and self-references while preserving data integrity.
- **AI Playground**: Public, unauthenticated multimodal AI playground featuring multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, and real-time knowledge search. It uses a 7-stage state machine for AI processing and a sliding window memory.
- **Nyan Protocol**: A system prompt framework utilizing a Seed Metric for historical comparison and socio-economic analysis to prevent LLM hallucinations.
- **Specialized AI Systems**: Includes a Financial Physics System, Legal Document Analysis System, and Ψ-EMA System (vφ⁴) for time series analysis. Ψ-EMA uses pure phase + z-score framework (no arbitrary composite weighting) for falsifiable signal detection.
- **Unified Personality Layer**: Enforces formatting and maintains epistemic transparency.
- **Mode Registry**: Plug-and-play configuration for the 7-stage pipeline, supporting modes like `psi-ema`, `forex`, `seed-metric`, `legal`, and `code-audit`.
- **Code Audit Mode**: Professional security auditor for uploaded code files across multiple languages.
- **Harmonized Document Processing**: Unified architecture for document extraction using a shared tenant-scoped `DocumentExtractionCache`.
- **Verifiable Export**: Book exports include `manifest.json` with SHA256 hashes for all files, export timestamp, provenance info (source, book ID, book name), and statistics. Users can verify integrity using `sha256sum` or similar tools.
- **Modular Frontend Architecture**: Dashboard uses `Nyan.StateService` and `Nyan.AuthService` patterns (`public/js/modules/`) for gradual migration toward maintainable, testable code. AuthService provides `window.authFetch` for authenticated requests with automatic token refresh. StateService manages 17 state slices (books, filteredBooks, editingBookId, selectedBookId, expandedBots, messageCache, allMessages, currentUser, bookSearchContext, botTags, botWebhooks, users, sessions, selectedMessages, messagePageState, scrollListenerAttached, lensFilterState) with getter/setter pattern - all dashboard.js mutations now flow through setters that sync local variables with centralized state for PWA readiness. Phase 2 modularization complete: DataSync module (fetch wrapper for PWA bridge), BooksModule (CRUD, sharing, WhatsApp operations), and MessagesModule (fetch messages, context, media) extracted - dashboard.js reduced from 9118 to 8975 lines (143 lines saved, pattern established for future extraction).

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via PostgreSQL schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL for state recovery.
- **Security (10/10 Hardened)**: Includes Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, and CSP compliance.
- **Discord Bot Architecture**: 4 specialized bots for separation of concerns:
  - **Hermes (φ)** - Thread creator (MANAGE_THREADS only)
  - **Thoth (0)** - Message reader (READ_MESSAGE_HISTORY only)
  - **Idris (ι)** - Nyan AI audit scribe (write-only, posts via webhook)
  - **Horus (Ω)** - Nyan AI audit watcher (read-only, fetches audit logs)
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection orchestrating 4 modular routes/satellites (auth, books, inpipe, nyan-ai).
- **Unified AI Architecture**: Single Nyan AI engine handles both public playground and authenticated dashboard audit with 2-key security isolation (`PLAYGROUND_GROQ_TOKEN` for public, `GROQ_API_KEY` for dashboard). Core inference is shared; persona/formatting layers are channel-specific:
  - **Playground** → Uses `PipelineOrchestrator` with S5 personality layer (`fastStreamPersonality`, `applyPersonalityFormat`) for casual, conversational tone
  - **Dashboard Audit** → Uses `prompts/executive-audit.js` + `utils/executive-formatter.js` for direct, executive-style responses
- **Book Sharing**: Email-based book sharing with cross-tenant security. Owners can invite viewers via email, with Resend email notifications. Features include: idempotent share/revoke, 7-day invite timeout for unregistered users (auto-cleaned via phi breathe), and LOWER() normalized email matching. Shared books appear view-only (no edit/delete buttons) for invitees.
- **Phi Breathe Orchestrator**: Unified background task scheduler for continuous logs, heartbeats, memory cleanup, media purging, and share invite expiration.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface for extensibility.
- **Architectural Philosophy: Axiom of Choice**: This philosophy guides the system's design, asserting the existence of ideal configurations for infinite components, making the system self-governing and scalable through dependency injection, even without explicit construction of every case.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`