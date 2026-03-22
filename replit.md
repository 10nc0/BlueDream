# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is an archiving architecture for documents, photos, and drive links, emphasizing zero-friction, customizability, security, and efficiency. It supports record archiving via WhatsApp, Twilio, and Discord, promoting data sovereignty. The project aims to provide sovereign, secure, and efficient remote storage and AI-powered remote inference for individuals, businesses, and public organizations.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features
- **Mobile/Desktop parity**: Whenever making any UI size, spacing, or layout change, always check BOTH the desktop CSS rule AND the `@media (max-width: 480px)` mobile override — they are independent `!important` blocks and a fix to one silently leaves the other broken. Auth pages: `cat-animation.css` has separate desktop (200px) and mobile (240px) canvas overrides; canvas buffer is 250px on all 4 auth pages. Dashboard: `mobile-mode` / `desktop-mode` body classes are set by JS `LayoutController`. **Cat architecture (AUTHORITATIVE)**: `#catContainer` uses `position: fixed; top: -40px; left: -40px` (desktop) / `top: -21px; left: -20px` (mobile) — negative top = blank canvas whitespace above ear tips, hides it above viewport so cat face centers in the 60px header; negative left = blank canvas whitespace left of cat pixels, shifts cat face flush to viewport edge. `cat-animation.css` owns canvas sizing: desktop=143px (75% of original 190px), mobile=80px via `body.desktop-mode .character-canvas` / `body.mobile-mode .character-canvas`. `LayoutController` sets canvas drawing buffer: desktop=143×143, mobile=75×75 (inline style cleared so CSS !important wins). Header has `padding-left: 68px` (desktop) / `45px` (mobile) to push title right of cat face (not canvas). Cat canvas HTML attrs: `width="143" height="143"`. Drawing scale = `(canvas.width / 125) × 2.8`. Cat face at canvas y≈40–103; blank canvas above y=40 hidden above viewport. z-index: var(--z-modal-above) (1001) — transcendental layer. `pointer-events: none`.

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. It applies conservation laws and sustainability metrics to financial statements.

**Core Architectural Models:**
- **3-Layer Perception-Substrate-Cognition Model:** Orchestrates file classification, extraction, caching (Perception), immutable state and shared constants (Substrate), and a 7-stage state machine for reasoning and auditing (Cognition).
- **7-Layer AI Processing Pipeline:** Manages AI interactions from identity and system prompts to the AI interface.

**UI/UX Decisions:**
- Adaptive and responsive design with enhanced touch interactions.
- Visual elements include a cat animation, blinking date/time, Discord-style messaging, and fixed message scrolling.
- A `LayoutController` manages UI modes, device detection, expansion states, and animations.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access, and isolated user data.
- **Database**: Multi-tenant PostgreSQL architecture with isolated schemas.
- **Messaging Integration**: Twilio-based WhatsApp Business API for messaging, with media handling for Discord uploads.
- **Unified AI Engine (Nyan AI)**: Single AI engine for public playground and authenticated dashboard audit, using a 2-key security model and a 4-stage dashboard audit pipeline (S0-S3) to detect and correct count hallucinations.
- **AuditCapsule**: Session-scoped temporal cache for entity extraction and tallies.
- **Executive Formatter**: Post-processing layer for audit responses.
- **AI Playground**: Public, unauthenticated multimodal AI playground with multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, real-time knowledge search, and compound query detection.
- **Nyan Protocol**: System prompt framework utilizing a Seed Metric to prevent LLM hallucinations.
- **Specialized AI Systems**: Includes a Financial Physics System, Legal Document Analysis System, and Ψ-EMA System (vφ⁴) for time series analysis.
- **Unified Personality Layer**: Enforces formatting and maintains epistemic transparency.
- **Mode Registry**: Plug-and-play configuration for the 7-stage AI pipeline, supporting modes like `psi-ema`, `forex`, `seed-metric`, `legal`, and `code-audit`.
- **Code Audit Mode**: Professional security auditor for uploaded code files.
- **Scholastic Domain Classifier**: Multi-signal scoring system for classifying image content.
- **Harmonized Document Processing**: Unified architecture for document extraction using a shared `DocumentExtractionCache`.
- **Verifiable Export**: Book exports include `manifest.json` with SHA256 hashes and provenance info.
- **Message Capsule + IPFS Ledger**: Every inpipe message builds a ZK-ready capsule containing body text, HMAC sender proof, SHA256 content hash, and per-attachment metadata. Capsule is pinned to IPFS via Pinata. CID stored in `core.message_ledger` table. Supports full/partial/ZK binary disclosure at message and attachment granularity.
- **Modular Frontend Architecture**: Dashboard uses `Nyan.StateService` and `Nyan.AuthService` patterns for maintainable, testable code and PWA readiness.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via PostgreSQL schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL for state recovery.
- **Security (10/10 Hardened)**: Includes Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, and CSP compliance.
- **Discord Bot Architecture**: 4 specialized bots (Hermes, Thoth, Idris, Horus) for separation of concerns.
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection orchestrating 4 modular routes/satellites (auth, books, inpipe, nyan-ai).
- **Unified AI Architecture**: Single Nyan AI engine for both public playground and authenticated dashboard audit, with shared core inference and channel-specific persona/formatting layers.
- **Code Context System**: Self-documenting architecture that injects source code as context to prevent LLM hallucination.
- **Book Sharing**: Email-based book sharing with cross-tenant security and features like idempotent share/revoke and invite timeouts.
- **Phi Breathe Orchestrator**: Unified background task scheduler for continuous logs, heartbeats, memory cleanup, media purging, and share invite expiration.
- **Nyan API v1**: Internal JSON API for agent-to-agent communication, supporting multimodal input and structured JSON responses, with dedicated endpoints for Psi-EMA data and system diagnostics.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface, supporting `twilio` (WhatsApp, reply-capable) and `line` (LINE OA, listen-only), designed for easy addition of new channels.
- **LINE QR Onboarding**: Create book modal supports LINE as a platform option, generating a QR code for adding the LINE OA and providing a raw join code.
- **Architectural Philosophy: Axiom of Choice**: Guides system design for self-governing and scalable components through dependency injection.

**Progressive Web App (PWA)**
- **Manifest**: `public/manifest.json` with app metadata, standalone display mode, purple theme.
- **Icons**: Generated in `public/icons/`.
- **Service Worker**: `public/sw.js` with network-first caching strategy.
- **Apple PWA**: Full iOS support.

## External Dependencies
- **Database**: PostgreSQL
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Nyan API v1 gate**: Internal API for inbound caller authentication
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`
- **IPFS**: Pinata