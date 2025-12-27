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

**7-Layer AI Processing Pipeline:**
- **Layer 7: AI Interface** (user interaction)
- **Layer 6: Orchestration** (7-stage state machine)
- **Layer 5: Verification** (two-pass LLM output validation)
- **Layer 4: Memory & Context** (session state management)
- **Layer 3: Perception** (document parsing, financial physics)
- **Layer 2: Measurement** (3D financial analysis: θ, z, R)
- **Layer 1: Identity** (system prompts, routing)
- **Layer 0: Constants** (φ=1.618 thresholds, conservation laws)

**UI/UX Decisions:**
- Adaptive & Responsive Design for various devices.
- Enhanced Touch Interactions for mobile.
- Visuals include a cat animation, blinking date/time, Discord-style message layout, and fixed scroll for messages.
- **LayoutController (public/js/layout-controller.js)**: Unified state machine for UI modes:
  - Device detection (mobile/desktop with foldable device support)
  - Expansion states (collapsed, expanding, expanded, collapsing)
  - Animation timing and locking (eliminates race conditions)
  - Auto-collapse timers for mobile thumbs zone
  - Replaces scattered layout state variables (77 references consolidated)

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
    - **DataPackage Flow**: JSON container per message, immutable after finalization.
- **Nyan Protocol**: System prompt framework for historical comparison and socio-economic analysis, using a Seed Metric to prevent LLM hallucinations via mandatory source requirements.
- **Financial Physics System**: 4-tier architecture extending NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis.
- **Ψ-EMA System**: Fourier compass for time series — calibrates position (θ, z, R) relative to equilibrium (θ=0°), like Google Maps for Hilbert space instead of geospace.
  - **ehi passiko**: "Come and see" — users upload CSV/SQL/TXT time series, apply the compass, diagnose anomalies themselves. No predictions, no mysticism, just coordinates.
  - **Coordinate System**: θ (phase angle 0°-360°), z (deviation from median via MAD), R (convergence ratio). φ-derived thresholds provide consistent measurement scale.
  - **Tool-First Design**: Framework measures where you ARE on the wave, not where you're going. Users navigate; the compass just shows true north (equilibrium).
- **Unified Personality Layer**: Enforces formatting via regex post-processing.
- **Mode Registry (lib/mode-registry.js)**: Plug-and-play mode configuration for the 7-stage pipeline:
  - Each mode declares: detection heuristics, personality formatting rules (skipIntroOutro, preserveVerdicts)
  - Modes: `psi-ema`, `psi-ema-identity`, `forex`, `seed-metric`, `legal`, `code-audit`, `general`
  - Code detection uses soft consensus (2+ pattern matches) to avoid Excel/data false positives
  - Personality layer reads from registry instead of hardcoded if-else chains
- **Code Audit Mode**: Professional security auditor for uploaded code files:
  - Detects .js/.ts/.py/.go/.java/.cpp/etc. via extension + content patterns (console.log, const, require, async/await)
  - Preserves technical verdicts (🟢/🟡/🔴) through S5 personality layer
  - Prompt: getCodeReviewPrompt() in prompts/code-analysis.js
- **Code Execution Honesty**: AI provides code for user execution but does not execute it itself.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
- **Push Guard vs Pull Action Pattern**: O(1) validation before expensive work.
- **Security (10/10 Hardened)**: Sybil attack prevention, JWT security (15-min access token + refresh token revocation), session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, CSP compliance, dev-role bypass blocked in production.
- **Discord Bot Trinity Architecture**: Hermes (write-only), Thoth (read-only), Idris (AI write-only), Horus (AI read-only).
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection. Named after Dr. Vegapunk (One Piece) - the genius who splits consciousness into satellite bodies while maintaining a pure core. vegapunk.js orchestrates 5 modular routes (satellites) via DI.
  - **Kernel (vegapunk.js)**: 1299 lines (85% reduction from 8500-line monolith)
  - **Routes (satellites)**: auth.js (1335), books.js (1381: CRUD + drops + messages + search + export), inpipe.js (405), prometheus.js (505), nyan-ai.js (769)
  - **Shared libs**: deps.js (85), phi-breathe.js (280: unified background task orchestrator), discord-webhooks.js (232), heal-queue.js (266), logger.js (26), validators.js (137: Zod schemas), error-handler.js (108: global Express error middleware)
  - **Total endpoints**: 62 (health/pages: 11, auth: 19, books: 22 [includes export], inpipe: 1, prometheus: 4, nyan-ai: 5)
  - **Code stats**: Kernel ~1330 + Routes 4395 + Libs 829 = ~6554 total lines (route-registry inlined into kernel)
  - Unified auth removes separate admin terminology (no admin/back-door impression)
  - **Export consolidation**: Moved 2 export endpoints into books satellite for tighter cohesion
- **AI Architecture Split**: Nyan AI (public playground) and Prometheus AI (authenticated ledger auditor) for independent rate limiting and security.
- **Dual AI Engine Audit Panel**: Dashboard AI Audit modal supports engine selection (Local Prometheus vs Cloud Nyan AI) with multi-book chip selector. Nyan AI accesses book substrate via authenticated /api/nyan-ai/audit endpoint, loading user-selected book context from Discord threads.
- **Phi Breathe Orchestrator**: Unified φ-rhythm background task scheduler (lib/phi-breathe.js) with:
  - Continuous breathing logs (every inhale #1, #2, #3... exhale cycle)
  - Heartbeat checkpoint every 86 breaths (~15min) for system status PULSE
  - Memory cleanup (15min cycle, 1h max age)
  - 3-day media purge (immediate + 24h cycle)
  - 60-day dormancy contributor revocation (immediate + 24h cycle)
  - Usage tracking via heartbeat subscription pattern. One φ-rhythm, multiple bells.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface for extensibility.

## Security Configuration
- **Database SSL**: Supabase handles SSL/TLS automatically. Connection is always encrypted.
- **Production Hardening** (via Supabase Dashboard):
  1. Enable **Row Level Security (RLS)** on all tables (Authentication → Policies)
  2. Enable **Attack Protection** with CAPTCHA for sign-up/sign-in (Authentication → Attack Protection)
  3. Use **database functions and policies** to restrict direct table access
  4. Store credentials in **environment variables** (never hardcode)
- **Optional verify-full mode**: Set `DATABASE_CA_CERT` env var with Supabase CA (download from Dashboard → Settings → Database → SSL) for strict certificate verification
- **Webhook Validation**: All external webhooks validated with Zod schemas + regex patterns
- **Secrets Compartmentalization**: Route satellites receive only required dependencies via DI

## External Dependencies
- **Database**: PostgreSQL (Supabase) with transaction pooler
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`