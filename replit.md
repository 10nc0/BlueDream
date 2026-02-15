# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder and post-filing structure archiving architecture designed for zero-friction, highly customizable, secure, and efficient archiving of documents, photos, and drive links. It supports record archiving via WhatsApp, Twilio, and Discord channel flows, promoting data sovereignty. The project envisions a future with sovereign, secure, and efficient remote storage infrastructure and remote inference (AI as compression and acceleration) for individuals, businesses, and public organizations.

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
- **7-Layer AI Processing Pipeline:** Manages AI interactions from identity and system prompts (Layer 1) to AI interface (Layer 7).

**UI/UX Decisions:**
- Adaptive and responsive design with enhanced touch interactions.
- Visual elements include a cat animation, blinking date/time, Discord-style messaging, and fixed message scrolling.
- A `LayoutController` acts as a unified state machine for managing UI modes, device detection, expansion states, and animations.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access, and isolated user data.
- **Database**: Multi-tenant PostgreSQL architecture with isolated schemas.
- **Messaging Integration**: Twilio-based WhatsApp Business API for messaging, with media handling for Discord uploads.
- **Unified AI Engine (Nyan AI)**: Single AI engine for both public playground and authenticated dashboard audit. Uses a 2-key security model and a 4-stage dashboard audit pipeline (S0-S3) to detect and correct count hallucinations.
- **AuditCapsule**: Session-scoped temporal cache for entity extraction and tallies.
- **Executive Formatter**: Post-processing layer that strips conversational filler from audit responses.
- **AI Playground**: Public, unauthenticated multimodal AI playground with multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, real-time knowledge search, and compound query detection.
- **Nyan Protocol**: System prompt framework utilizing a Seed Metric to prevent LLM hallucinations.
- **Specialized AI Systems**: Includes a Financial Physics System, Legal Document Analysis System, and Ψ-EMA System (vφ⁴) for time series analysis using φ-derived thresholds.
- **Unified Personality Layer**: Enforces formatting and maintains epistemic transparency.
- **Mode Registry**: Plug-and-play configuration for the 7-stage AI pipeline, supporting modes like `psi-ema`, `forex`, `seed-metric`, `legal`, and `code-audit`.
- **Code Audit Mode**: Professional security auditor for uploaded code files.
- **Scholastic Domain Classifier**: Multi-signal scoring system for classifying image content.
- **Harmonized Document Processing**: Unified architecture for document extraction using a shared `DocumentExtractionCache`.
- **Verifiable Export**: Book exports include `manifest.json` with SHA256 hashes and provenance info.
- **Modular Frontend Architecture**: Dashboard uses `Nyan.StateService` and `Nyan.AuthService` patterns for maintainable, testable code and PWA readiness.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via PostgreSQL schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL for state recovery.
- **Security (10/10 Hardened)**: Includes Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, and CSP compliance.
- **Discord Bot Architecture**: 4 specialized bots (Hermes, Thoth, Idris, Horus) for separation of concerns.
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection orchestrating 4 modular routes/satellites (auth, books, inpipe, nyan-ai).
- **Unified AI Architecture**: Single Nyan AI engine for both public playground and authenticated dashboard audit, with shared core inference and channel-specific persona/formatting layers.
- **Code Context System**: Self-documenting architecture that injects source code as context to prevent LLM hallucination when users ask about internal design.
- **Book Sharing**: Email-based book sharing with cross-tenant security and features like idempotent share/revoke and invite timeouts.
- **Phi Breathe Orchestrator**: Unified background task scheduler for continuous logs, heartbeats, memory cleanup, media purging, and share invite expiration.
- **Nyan API v1**: Internal JSON API for agent-to-agent communication, supporting multimodal input and structured JSON responses. Includes dedicated endpoints for Psi-EMA data and system diagnostics.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface.
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
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`