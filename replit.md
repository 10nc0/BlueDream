# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is an archiving architecture for documents, photos, and drive links, emphasizing zero-friction, customizability, security, and efficiency. It supports record archiving via WhatsApp, Twilio, and Discord, promoting data sovereignty. The project aims to provide sovereign, secure, and efficient remote storage and AI-powered remote inference for individuals, businesses, and public organizations.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features
- **Mobile/Desktop parity**: Whenever making any UI size, spacing, or layout change, always check BOTH the desktop CSS rule AND the `@media (max-width: 480px)` mobile override — they are independent `!important` blocks and a fix to one silently leaves the other broken. Dashboard: `mobile-mode` / `desktop-mode` body classes are set by JS `LayoutController`. **Cat architecture (AUTHORITATIVE)**: `#catContainer` uses `position: relative; margin: 0 -22px` — unified approach identical to `playground.html`, no mobile/desktop split. It is a flex item inside the header flex row; `align-items: center` on the parent vertically centers the 100px canvas in the 60px header. `margin: 0 -22px` compensates the 32px blank canvas on each side of the cat face so the face aligns with the left edge. `LayoutController` does NOT resize the canvas. Canvas HTML attrs: `width="100" height="100"` (same as playground). Drawing scale = `(canvas.width / 125) × 2.8`. Cat face at canvas y≈28–72; blank canvas above y=28 hidden above viewport. z-index: 20. `pointer-events: none`. **Auth page cat (AUTHORITATIVE)**: 250px buffer canvas displayed at 200px CSS (desktop) / 240px (mobile). Buffer has ~55px transparent blank above cat ears and ~55px below feet. Fixed by `margin-top: -50px; margin-bottom: -50px` on `.character-canvas` and container height shrunk to 130px (desktop) / 150px (mobile). Do NOT revert to height: 200/240px without restoring the negative margins.

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
- **Message Capsule + IPFS Ledger**: Every inpipe message builds a cryptographic provenance capsule containing body text, HMAC sender proof, SHA256 content hash, and per-attachment metadata. Capsule is pinned to IPFS via Pinata. CID stored in `core.message_ledger` table. Supports full/partial/selective binary disclosure at message and attachment granularity.
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
- **Architectural Philosophy: Live API over Dogma**: Hardcoded lists are permitted ONLY for routing/classification decisions (e.g., `KNOWN_CITIES_REGEX` ~200 cities to detect geographic intent, ticker format patterns, forex pair regex). Once the entity type is determined, ALL data must come from live APIs — never from training knowledge or hardcoded values. Prices → Brave Search. Stock data → Yahoo Finance. Exchange rates → fawazahmed0. The city list answers "is this a city?" (routing); Brave answers "what does a flat cost there?" (data). Conflating the two layers is dogma. The canonical split: `routing guards = lean patterns`, `data = live API`.
- **Architectural Philosophy: The Totem (Triangulation-First)**: For the Seed Metric, price/sqm is derived by triangulation (total_price ÷ area_sqm) as the primary path — not a fallback. A direct $/sqm quote is the fallback. Triangulation (`resolvePrice()` → `triangulateFromTotalPrice()`) is the totem because real search results express prices as total transaction values + unit sizes, not as pre-computed $/sqm. The ×700 pilgrimage follows from the derived $/sqm. Parse log annotates `(triangulated)` to audit which path fired.
- **Architectural Philosophy: Walk the Dog (LLM Tool Calling)**: The Seed Metric uses Groq's function-calling API to let the LLM execute `brave_search` directly. The LLM decides what to search (city-aware, language-aware), reads raw Brave results, triangulates price/sqm from total+area mentions, and produces the canonical table — no hardcoded query templates, no regex parsers. Two Groq round-trips: Round 1 (tool_calls emission) + Round 2 (synthesis after results injected). Rate-limited to 400ms between Brave calls, max 8 searches per query. "Teaching the dog to read reminders" (stuffing parsing rules into the prompt) = dogma. "Walking the dog" (giving the LLM a search tool and letting it discover) = live epistemics. Implemented in `stepSeedMetricToolCall()` in `pipeline-orchestrator.js`.
- **Architectural Philosophy: Adam/Eve UI Hierarchy**: The message pane (Adam) is always the primary view — it carries live, updating content. The book list sidebar (Eve) is secondary — it is static navigation that spawns alongside Adam only when there is sufficient screen resolution. On mobile: only Adam is shown by default; Eve is hidden (LayoutController). On tablet/desktop: Eve spawns with a `eveSpawn` slide-in animation (translateX -18px → 0) after Adam is ready. Eve's width: 180px (tablet) / 200px (desktop), capped at 22-26% — Adam always dominates visually. The header (cat + title) is eternal — present at all resolutions, before and above both Adam and Eve.

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

## Code Conventions — Shared Resources (NEVER REPLICATE)
- **~nyan identity**: `prompts/nyan-protocol.js` exports `NYAN_PROTOCOL_SYSTEM_PROMPT` (full) and `NYAN_PROTOCOL_COMPRESSED` (ultra-terse seed). Every pipeline path that needs ~nyan's identity MUST import from here. Never write "You are ~nyan..." inline. Domain-specific instructions (search steps, table rules, coda directions) live alongside the injected compressed identity, NOT instead of it.
- **Forex detection**: `utils/forex-fetcher.js` → `detectForexPair()` / `isForexQuery()`. Currency alias matching uses word-boundary regex (`\bfranc\b`) — NOT `String.includes()`. Substring match causes false positives (e.g. "franc" in "Francisco" → CHF).
- **Seed Metric formula**: The formula, regimes, and 700sqm symbolism are canonical in `NYAN_PROTOCOL_COMPRESSED`. The tool-calling system prompt in `stepSeedMetricToolCall()` inherits from it — do not redeclare the formula separately.
- **Any string or constant used in >1 file**: extract to a shared module in `utils/` or `prompts/`. Code bloat = drift risk.