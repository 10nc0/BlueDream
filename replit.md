# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord, providing permanent message retention via Discord threads and isolated data storage per user. It aims for zero-friction onboarding, a highly customizable interface, and offers a secure, efficient way to archive WhatsApp conversations for individuals and small businesses. Key features include an AI Playground for multimodal interaction and an AI Audit System for message verification. The project has a business vision to provide a secure and efficient archiving solution for WhatsApp conversations, with market potential in individual users and small businesses seeking reliable message retention and advanced AI interaction.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

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
- **Financial Physics System**: A 4-tier architecture extending the NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis, providing a universal 7-section template.
- **Φ-Dynamics & Ψ-EMA System**: Multi-signal state classifier using robust signal processing and φ (1.618) as the measurement threshold. Φ-Dynamics is the theoretical framework (R = 1 + 1/R = φ), while Ψ-EMA is the three-dimensional measurement instrument.
    - **Core Principle**: φ is **endogenous** - derived from the self-referential equation x = 1 + 1/x, the unique positive fixed point of self-similar recursion. The Ψ-EMA pipeline applies this derived constant as calibration thresholds.
    - **Measurement**: Ψ-EMA (θ, z, R) classifies system states across any domain via signal decomposition
    - **θ (Phase)**: atan2(Flow, Stock) - cycle position in 4 quadrants (0°-360°)
    - **z (Anomaly)**: (Price - Median) / MAD - deviation from equilibrium (robust z-score)
    - **R (Convergence)**: z(t)/z(t-1) - ratio of successive standardized values (with near-zero guards)
    - Uses Fibonacci EMA periods (13, 21, 34, 55) for consistency in signal smoothing
    - **Classification Rules**: Thresholds (R ≈ φ, |z| > φ²) derive from φ-Dynamics theory. Empirical validation concerns suitability of φ-derived thresholds for state classification in specific domains.
    - **Substrate-Agnostic**: Same signal processing applies to any domain (physics, biology, demographics, economics, institutions) where Stock⊥Flow decomposition is valid. See philosophy.md for theoretical context and untested falsifiable predictions.
- **Unified Personality Layer**: All formatting enforced in `applyPersonalityFormat()` in `pipeline-orchestrator.js` to remove "fluff patterns" via regex post-processing.
- **Code Execution Honesty**: AI provides code for user execution, but does not execute it itself.
- **H₀ Physical Audit Disclaimer**: Advisory appended to financial outputs, emphasizing physical reality verification methods.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
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

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`