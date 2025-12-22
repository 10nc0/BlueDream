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
- **Mobile Optimization**: Optimized for mobile real estate, especially in the Playground and Dashboard, to maximize message display area and minimize UI chrome.
- **Fixed Scroll Layout**: Header fixed at top, input fixed at bottom, only message area scrolls.
- **Foldable Device Support**: Detects foldable devices and adjusts layout for unfolded tablet mode.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage, with secure password recovery via email.
- **Database**: PostgreSQL with multi-tenant architecture, using isolated schemas per user.
- **WhatsApp Integration**: Twilio-based messaging using WhatsApp Business API with a join-code-first routing architecture.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord as native attachments.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}`, auto-scroll, "New messages" banner, and jump-to-message functionality.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, providing general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior. Audit results are logged via the Prometheus Trinity Discord bots.
- **AI Playground**: A sovereign, public AI playground at `/AI` without authentication, offering multimodal support (Text, Photo, Audio, Documents), multi-file upload, dynamic capacity sharing, and abuse prevention. It features query classification, smart retry mechanisms, document parsing, and a search cascade for real-time knowledge.
  - **Preflight Router** (`utils/preflight-router.js`): Unified Stage 0+1 pre-processing that runs BEFORE the LLM call. Consolidates scattered detection logic into single module:
    - Mode detection (psi-ema, seed-metric, financial, legal, general)
    - Ticker extraction (3-tier: $TICKER → known tickers → AI fallback)
    - Stock data fetching via yfinance
    - Returns `PreflightResult` contract for downstream consumption
    - `buildSystemContext(preflight, nyanProtocol)` maps preflight to system messages
  - **Pipeline Flow**: Preflight → Reasoning → Audit → Personality
  - **Groq-First Architecture**: Result-based routing where Groq proves competence via audit.
  - **Three-Pass Verification**: Draft, Audit (with potential correction), and Personality formatting for responses. Includes dual-mode auditing (Strict for documents, Research for general queries).
  - **Audio Accessibility**: Mic button recordings are treated as user queries, enabling low-literacy users to interact via voice.
  - **Streaming Token Output**: Real-time SSE streaming of the personality pass for "watching it think" UX.
- **Nyan Protocol (Permanent Seed Context)**: A specific protocol for historical comparison and socio-economic analysis using the **Seed Metric** (P/I ratio: years to buy 700m² land). NYAN is a sacred, always active Step 0 protocol.
- **Financial Physics System**: A 4-tier architecture for financial cognition, including document type detection, nature classification, semantic enrichment, and validation. It's an extension of the NYAN Protocol.
- **Legal Document Analysis System**: Stage 1+ extension for contract/agreement analysis, auto-triggered by legal keywords in documents. Provides a universal 7-section template structure for analysis.
- **Ψ-EMA System** (`utils/psi-EMA.js`): Multi-Dimensional Wave Function Dashboard implementing Financial Quantum Mechanics (Dec 22, 2025). Version: φ² (First Life).
  - **Three Orthogonal Dimensions**:
    1. **Phase θ** (EMA-34/EMA-55): θ = arctan(Flow/Stock) → cycle position. Golden Cross/Death Cross signals.
    2. **Anomaly z** (EMA-21/EMA-34): z = (Flow - μ)/σ → deviation strength. ±1σ Normal, ±2σ Alert, ±3σ Extreme.
    3. **Convergence R** (EMA-13/EMA-21): R = z(t)/z(t-1) → sustainability. R < 1.3 Sub-Critical, R ≈ φ Critical, R > 2.0 Super-Critical.
  - **Fibonacci EMA Periods**: 13, 21, 34, 55 (aligned to φ-resonance)
  - **φ-Correction Formula**: z(t+1) = z(t) - sign(z)·φ/|z|
  - **PsiEMADashboard Class**: Complete analysis with composite signals
  - **Keyword Triggers**: 'fourier', 'φ', 'ψ', 'psi', 'phi', 'ema', 'crossover', 'golden cross', 'wave', 'fibonacci'
  - **NYAN Protocol Routing**: PSI_EMA_TOPICS route triggers "🔥 ~nyan" ending (same as Seed Metric)
  - **Audit Protocol**: AUDIT_PSI_EMA extension accepts Ψ-EMA framework terminology
  - **~nyan Search Bypass**: Responses ending with ~nyan skip web search retry (pre-verified data)
  - **Real-Time Stock Integration** (Dec 22, 2025):
    - `utils/fetch-stock-prices.py`: Python script using yfinance for 90-day closing prices
    - `utils/stock-fetcher.js`: Node.js wrapper with ticker detection and price fetching
    - **Smart Ticker Detection** (3-tier):
      1. **$TICKER format**: Always matches (e.g., $META, $COST) - for ambiguous tickers
      2. **Known tickers**: Case-insensitive match for whitelisted tickers (nvda, NVDA, Nvda)
      3. **AI fallback**: Groq extracts ticker from company names ("meta stock" → META)
    - **AI Ticker Extraction** (`extractTickerWithAI`):
      - Uses llama-3.1-8b-instant for fast company→ticker mapping
      - Handles commodities (gold, oil), crypto (bitcoin), private companies → returns null
      - Validates ticker format (1-5 uppercase letters only)
    - **Company Name Triggers**: shouldTriggerPsiEMA activates for common company names (meta, ford, costco, etc.) with price keywords
    - **Auto-Trigger**: "price analysis on meta stock" → AI extracts META → yfinance fetch → Ψ-EMA analysis
    - **Three-Tier Graceful Degradation**: Fetch fails → ticker-only context; <55 points → limited context; Analysis fails → data-count context
    - **Safe Formatting**: safeFixed() helper with parseFloat fallback prevents .toFixed() crashes
    - **Data Recency Timestamping**: Each analysis timestamped to most recent close date with age flags:
      - **Today** (✅ green) → fresh data from today's close
      - **Yesterday/1 day old** (⚠️ yellow) → expected for weekend data
      - **2-3 days old** (⚠️ yellow) → stale warning
      - **4+ days old** (🚩 red) → data is significantly stale, not reliable
    - **Inline Disclaimers**: Analysis context includes "LIMITED TO DATA THROUGH {date}" and data cutoff warnings
    - **Stale Data Flags**: Automatic warning injection when data > 1 day old

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL stores all book state for recovery.
- **Security**: Strict webhook validation, JWT security, robust audit logging, Sybil attack prevention, and CSP compliance.
- **Discord Bot Trinity Architecture**:
    - **Human Trinity**: Hermes (write-only for threads/messages), Thoth (read-only for message history).
    - **Prometheus Trinity**: Idris (write-only for AI log threads/audit results), Horus (read-only for AI audit history).

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`