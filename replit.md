# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder & post-filing structure archiving architecture. Currently support records via Whatsapp -> Twilio -> Local / your Discord channel flows with future integrations planned. Dump your documents, photos, or even drive links; send another message #audit #2025 -> search back with discord & jump to context window. Use "AI button" to activate Prometheus bot to speak to your data (currently supports text based queries only; multimedia supports is still sandboxing in nyanbook.io/AI playground ONLY.) Zero-friction onboarding, a highly customizable interface, and offers a secure, efficient way to archive (local filing with remote access; void nyanbook) for anyone from individuals; small businesses; corporate teams; public bureaucracies; etc. Anti-Zuckeberg architecture of data sovereignty vs data commercialization. 

## AI Playground (playground.html) + AI audit within Nyanbook (dashboard.html)
AI Playground for multimodal interaction and NYAN AI. The project has a vision to provide a sovereign secure and efficient archiving solution. Liberalizing; not only democratizing remote storage infrastructure and remote inference (AI as compression and acceleration) as minimum viable ontology (cognition) to survival (offspring genesis)

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features

## System Architecture
The system employs a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. The core paradigm treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**7-Layer Stack:**
- **Layer 7: AI Interface** (playground.js - user interaction)
- **Layer 6: Orchestration** (pipeline-orchestrator - 7-stage state machine)
- **Layer 5: Verification** (two-pass-verification - LLM output validation)
- **Layer 4: Memory & Context** (data-package + context-extractor - session state)
- **Layer 3: Perception** (attachment-cascade + financial-physics - document parsing)
- **Layer 2: Measurement** (psi-EMA - 3D financial analysis: θ, z, R)
- **Layer 1: Identity** (nyan-protocol - system prompts + routing)
- **Layer 0: Constants** (φ=1.618 thresholds, conservation laws)

**UI/UX Decisions:**
- **Adaptive & Responsive Design**: Resizable elements for desktop, mobile-optimized layouts, and foldable devices.
- **Touch Interactions**: Enhanced for mobile with tap-to-zoom, swipe navigation, auto-hide elements, and momentum scrolling.
- **Visuals**: Cat animation, blinking date/time, Discord-style message layout, and a fixed scroll layout for messages.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, secure password recovery, and isolated user data.
- **Database**: PostgreSQL with multi-tenant architecture using isolated schemas per user.
- **WhatsApp Integration**: Twilio-based messaging with WhatsApp Business API and a join-code-first routing.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord.
- **Search**: Enhanced search across messages and metadata, including multilingual and full-text indexing.
- **Real-time Updates**: Smart polling, auto-scroll, and "New messages" banner.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, logging results via Prometheus Trinity Discord bots. Includes general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior.
- **AI Playground**: A public, unauthenticated multimodal AI playground at `/AI` with features like multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, and real-time knowledge search.
    - **AI Processing Pipeline (7-Stage State Machine)**:
        - S-1: Context Extraction (φ-8 message window, entity extraction)
        - S0: Preflight (mode detection, routing, external data fetch)
        - S1: Context Build (inject system prompts based on mode)
        - S2: Reasoning (LLM call, O(tokens), ~1500 tokens)
        - S3: Audit (LLM call, O(tokens), ~800 tokens)
        - S4: Retry (search augmentation if audit rejected)
        - S5: Personality (regex cleanup, O(n) string ops, NOT an LLM call)
        - S6: Output (finalize DataPackage, store in φ-8 window)
        - **Complexity**: Best case 2 LLM calls (Reasoning + Audit), worst case 4 (with retry + re-audit). Personality is regex-based `applyPersonalityFormat()` + chunked SSE streaming via `fastStreamPersonality()`.
    - **Sliding Window Memory**: 8-message context window with periodic summarization (5-sentence summaries every 2nd query).
    - **DataPackage Flow**: Each message carries a JSON container through the pipeline. Storage: IP → 8-message window → per-message package. Immutable after finalization; personality layer cleans formatting but preserves data integrity.
    - **In-Memory Store**: Session context stored in RAM for speed. Discord provides permanent retention. Server restart clears context (acceptable for conversational AI).
- **Nyan Protocol**: System prompt framework for historical comparison and socio-economic analysis. Uses Seed Metric (Price/Income ratio) as falsifiable threshold. Prevents LLM hallucinations via mandatory source requirements.
    - **Seed Metric Conditional Injection**: The Seed Metric proxy cascade (700sqm conversion rules, income proxy cascade, P/I ratio methodology) is conditionally loaded only when Seed Metric topics are detected via `routingFlags.isSeedMetric`. Saves ~300 tokens on non-Seed queries. Module: `prompts/seed-metric.js`.
- **Financial Physics System**: A 4-tier architecture extending the NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis, providing a universal 7-section template.
- **Φ-Dynamics & Ψ-EMA System**: Multi-signal time series oscillator using robust signal processing and φ (1.618) as the measurement threshold. Φ-Dynamics is the theoretical framework (R = 1 + 1/R = φ), while Ψ-EMA is the three-dimensional measurement instrument.
    - **Glossary & Framing**: Ψ-EMA is a **general-purpose time series oscillator**, not stock-market-specific. Examples herein use capital markets due to data accessibility, but identical mathematics apply to climate (temperature dynamics), sports (win-rate momentum), demographics (population flows), and any system with stock/flow decomposition.
    - **Philosophical Foundation**: See `philosophy.md` for the complete theoretical grounding: the **Time Series Fidelity Law** (0 + φ⁰ + φ¹ = φ²), its manifestation across all domains, the Möbius closure, and Buddhist Dependent Origination correspondence.
    - **Core Principle**: φ is **endogenous** - derived from the self-referential equation x = 1 + 1/x, the unique positive fixed point of self-similar recursion. The Ψ-EMA pipeline applies this derived constant as calibration thresholds.
    - **Measurement**: Ψ-EMA (θ, z, R) classifies system states across any domain via signal decomposition
    - **θ (Phase)**: atan2(Flow, Stock) - cycle position in 4 quadrants (0°-360°). Measures phase relationship between stock and flow components.
    - **z (Anomaly)**: (Value - Median) / MAD - deviation from equilibrium (robust z-score). Detects when signal deviates beyond φ² threshold.
    - **R (Convergence)**: z(t)/z(t-1) - ratio of successive standardized values (with near-zero guards). Classifies amplitude growth/decay/stability.
    - Uses Fibonacci EMA periods (13, 21, 34, 55) for consistency in signal smoothing across all domains
    - **Classification Rules**: Thresholds (R ≈ φ, |z| > φ²) derive from φ-Dynamics theory. Empirical validation concerns suitability of φ-derived thresholds for state classification in specific domains.
    - **Substrate-Agnostic**: Same signal processing applies to any domain (physics, biology, demographics, economics, climate, sports, institutions) where Stock⊥Flow decomposition is valid. See philosophy.md for theoretical context and untested falsifiable predictions.
- **Unified Personality Layer**: All formatting enforced in `applyPersonalityFormat()` in `pipeline-orchestrator.js` to remove "fluff patterns" via regex post-processing.
- **Code Execution Honesty**: AI provides code for user execution, but does not execute it itself.
- **H₀ Physical Audit Disclaimer**: Advisory appended to financial outputs, emphasizing physical reality verification methods.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
- **Push Guard vs Pull Action Pattern** (O(1) Security Strategy):
    - **Push Guard**: O(1) validation before expensive work (signature verification, routing flags, secret checks)
    - **Pull Action**: On-demand work triggered only after guard passes (data fetching, LLM calls, parsing)
    - Examples: Twilio signature verification → pull message routing; Routing flags set → conditionally pull context injection
    - Strategy: Fail-closed startup checks for critical secrets; O(1) guards at all ingress points; conditional context injection based on routing flags
- **Security (10/10 Hardened)**:
    - **Sybil Attack Prevention**: Dual-layer rate limiting (in-memory fast-check + database persistence). Limits: 3/hour per IP, 5/day per IP, 10/day per domain. Disposable email domains blocked.
    - **JWT Security**: Issuer/audience validation, HS256 only, 15min access tokens, 7-day refresh tokens.
    - **Session Management**: SHA256 hashed session IDs, 1-hour TTL with 5-minute auto-cleanup.
    - **Tenant Key Hashing**: IP+UserAgent hashed with SHA256 (no raw PII stored).
    - **Command Injection Prevention**: Strict ticker sanitization (A-Z0-9 only, 1-10 chars, must start with letter) before subprocess spawn.
    - **LLM Prompt Sanitization**: 50KB limit, control character removal before Groq API calls.
    - **XSS Prevention**: DOMPurify with strict allowed tags/attributes for all markdown rendering.
    - **CSP Compliance**: Strict Content Security Policy headers.
- **Discord Bot Trinity Architecture**: Hermes (write-only), Thoth (read-only), Idris (AI write-only for logs/audits), Horus (AI read-only for audit history).

## Route Modularization (Dec 2024)
**Pattern**: Factory pattern with dependency injection. Each route file exports `registerXRoutes(app, deps)`.

**Files**:
- `lib/deps.js` - Dependency injection container with pool, bots, middleware, helpers, constants
- `lib/logger.js` - Pino structured logging
- `routes/auth-admin.js` (1278 lines) - Auth routes (login, signup, password reset, refresh, logout, invites) + Admin routes (sessions, users, audit-logs)
- `routes/books.js` (270 lines) - Core CRUD (get books, archive/unarchive, stats)
- `routes/inpipe.js` (406 lines) - Multi-channel input with abstract channel interface

**Inpipe Architecture** (Multi-In Pattern):
- `lib/channels/base.js` - Abstract channel interface (validateSignature, parsePayload, normalizeMessage, sendReply)
- `lib/channels/twilio.js` - Twilio WhatsApp implementation (first channel)
- Future channels: telegram.js, twitter.js (same interface)
- Flow: Channel → normalize() → routeMessage() → Discord out

**Wiring Order** (in index.js):
1. Initialize pool, bots, middleware
2. Call `deps.initialize()` with all dependencies
3. `registerAuthAdminRoutes(app, deps)` → returns `{requireAuth, requireRole}`
4. `deps.setMiddleware(requireAuth, requireRole)`
5. `registerBooksRoutes(app, deps)`
6. `registerInpipeRoutes(app, deps)`

**Remaining in index.js**: AI streaming routes, sendToLedger integration

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`