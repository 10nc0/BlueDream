# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder and post-filing structure archiving architecture, currently supporting records via WhatsApp -> Twilio -> Local / Discord channel flows. It aims to provide a zero-friction, highly customizable, secure, and efficient way to archive documents, photos, and drive links for individuals, businesses, and public organizations, promoting data sovereignty. The project envisions a future with sovereign, secure, and efficient remote storage infrastructure and remote inference (AI as compression and acceleration).

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features

## System Architecture
The system utilizes a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. It treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**3-Layer Perception-Substrate-Cognition Model:**
- **L1: Perception**: File classification, extraction, and cache hydration.
- **L2: Substrate**: Immutable state containers, shared caches, and system constants.
- **L3: Cognition**: 7-stage state machine (S-1 to S6) for reasoning and auditing.

**7-Layer AI Processing Pipeline:**
- **Layer 7: AI Interface**
- **Layer 6: Orchestration** (7-stage state machine)
- **Layer 5: Verification** (two-pass LLM output validation)
- **Layer 4: Memory & Context**
- **Layer 3: Perception** (document parsing, financial physics)
- **Layer 2: Measurement** (3D financial analysis: θ, z, R)
- **Layer 1: Identity** (system prompts, routing)
- **Layer 0: Constants**

**UI/UX Decisions:**
- Adaptive & Responsive Design for various devices.
- Enhanced Touch Interactions for mobile.
- Visuals include a cat animation, blinking date/time, Discord-style message layout, and fixed scroll for messages.
- `LayoutController`: Unified state machine for UI modes, handling device detection, expansion states, animation timing, and auto-collapse timers.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access control, secure password recovery, isolated user data.
- **Database**: PostgreSQL with multi-tenant architecture using isolated schemas.
- **WhatsApp Integration**: Twilio-based messaging with WhatsApp Business API.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord.
- **Search**: Enhanced search across messages and metadata.
- **Real-time Updates**: Smart polling, auto-scroll.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, logging results via Discord bots. Features general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior.
- **AI Playground**: Public, unauthenticated multimodal AI playground with multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, and real-time knowledge search.
    - **AI Processing Pipeline**: A 7-stage state machine for context extraction, preflight, context building, reasoning, auditing, retrying, personality application, and output finalization.
    - **Sliding Window Memory**: 8-message context window with periodic summarization.
- **Nyan Protocol**: System prompt framework for historical comparison and socio-economic analysis, using a Seed Metric to prevent LLM hallucinations via mandatory source requirements.
- **Financial Physics System**: 4-tier architecture extending NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis.
- **Ψ-EMA System**: Fourier compass for time series analysis, providing coordinates (θ, z, R) relative to equilibrium for diagnostics.
- **Unified Personality Layer**: Enforces formatting via regex post-processing and includes Epistemic Transparency to distinguish verified facts from inferred conclusions.
- **Mode Registry**: Plug-and-play mode configuration for the 7-stage pipeline, including modes like `psi-ema`, `forex`, `seed-metric`, `legal`, `code-audit`, and `general`.
- **Code Audit Mode**: Professional security auditor for uploaded code files, detecting multiple programming languages.
- **Harmonized Document Processing**: Unified architecture between `attachment-cascade.js` and `data-package.js` using a shared tenant-scoped `DocumentExtractionCache`.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via PostgreSQL schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
- **Security (10/10 Hardened)**: Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, CSP compliance.
- **Discord Bot Trinity Architecture**: Hermes (write-only), Thoth (read-only), Idris (AI write-only), Horus (AI read-only).
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection, orchestrating 5 modular routes (auth, books, inpipe, prometheus, nyan-ai).
- **AI Architecture Split**: Nyan AI (public playground) and Prometheus AI (authenticated ledger auditor) for independent rate limiting and security.
- **Dual AI Engine Audit Panel**: Dashboard AI Audit modal supports engine selection with multi-book chip selector.
- **Phi Breathe Orchestrator**: Unified φ-rhythm background task scheduler for continuous logs, heartbeat checkpoints, memory cleanup, media purge, and dormancy contributor revocation.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface for extensibility.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`

## Coding Guidelines

### Supabase Multi-Tenant Schema Pattern
- Tenant > Book > Messages > Messages metadata + tag + attachment, etc.
- Each tenant gets an isolated PostgreSQL schema (not just row-level filtering)
- Schema naming: `tenant_{tenantId}` format
- All tenant-specific tables live within tenant schema
- Shared/system tables remain in `public` schema
- Always use schema-qualified queries: `SELECT * FROM tenant_abc.messages`
- Connection pooler: Use Supabase transaction pooler for connection efficiency

### innerHTML Security (XSS Prevention)
- **NEVER use `innerHTML` with user-generated or external content**
- **ALWAYS use safe alternatives:**
  - `element.textContent = userInput` for plain text
  - `element.appendChild(document.createElement(...))` for DOM construction
  - Template literals with explicit sanitization only for trusted HTML
- **If HTML rendering is unavoidable:**
  - Use DOMPurify or similar sanitization library
  - Validate against allowlist of safe tags/attributes
  - Never trust data from APIs, databases, or user input
- **CSP headers** are configured but innerHTML bypasses them — code must be safe at source

### Unified Authentication
- Single auth system for all users (no separate "admin" terminology)
- Role-based access control via `user.role` field (owner, contributor, viewer)
- JWT with 15-min access tokens + refresh token rotation
- See **Vegapunk Kernel Architecture** → routes/auth.js for implementation
- Never create parallel auth systems or "back-door" admin routes