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
- **Multi-File Upload**: Up to 10 attachments per query, mixed types supported (photo + doc + audio processed together).
- **Input Methods**: Drag & drop, file picker, microphone, paste images - all support multiple files.
- **Dynamic Capacity Sharing**: Adaptive rate limiting that distributes API quota among active IPs (180-min activity window). Pools: text 240/hr, vision 120/hr, brave 360/hr. When platform is quiet, each user gets more capacity; when busy, limits tighten fairly. Dev IPs (`RATE_LIMIT_EXEMPT_IPS`) bypass all limits.
- **Abuse Prevention**: Per-IP burst throttling (>5 req/15s), duplicate prompt detection (60s block), gibberish entropy check.
- **Query Classification**: Regex-based routing (DDG-first for "what is", Brave-first for "latest/2025", Groq-only for "calculate/solve").
- **Factual Cache**: 24h TTL for simple facts, NEVER caches Nyan Protocol topics (H₀ compliance), 1000 entry LRU limit.
- **Smart Retry**: Brave→DDG fallback, core-words DDG retry when all search fails, knowledge cutoff disclaimer when no search context.
- **Document Parsing**: Cascade workflow for various formats, handling token limits with smart truncation.
- **Search Cascade (Real-time Knowledge)**: Uses DuckDuckGo and Brave Search to overcome Groq's knowledge cutoff.
- **Nyan Protocol (Permanent Seed Context)**: A specific protocol for historical comparison and socio-economic analysis, including a "Price/Income ratio" metric with contextual conclusions, designed to "HUMANIZE EVERY RATIO".
- **H₀ + Problem-Solving Protocol**: Temperature 0.15, confidence-based extrapolation, strict citation, and zero hallucination.
- **Isolation Architecture**: Uses separate API tokens (`PLAYGROUND_GROQ_TOKEN` for text, `PLAYGROUND_GROQ_VISION_TOKEN` for photos) to prevent playground abuse and isolate vision rate limits from text queries.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **AI (Production)**: Groq API
- **AI (Playground)**: Groq API (text + vision via dedicated tokens)
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` (for local processing)

## Recent Changes (December 8, 2025)
- **Circuit Breaker**: Persistent abusers (3+ abuse events in 10 min) get 15-minute cooldown with friendly message: "Nyan AI needs a X minute break~"
- **Minimum Viable Floor**: Even at extreme scale (500+ users), everyone gets at least 2 queries/hour guaranteed.
- **Logarithmic Reputation Growth**: Faster early rewards: ~1.09× at day 1, 1.27× at day 7, 1.44× at day 30 (vs linear 1.07×/1.30×). Reaches 1.5× cap at ~100 days.
- **Friendly Rate Limit Messages**: No explicit rate disclosure (violates "pocket sovereign" principle). Instead: "Nyan AI needs a X minute break before continuing~" with calculated replenishment time.
- **Continuous Token Refill**: Upgraded from fixed 60-second refill intervals to proportional refill based on elapsed time. Tokens now trickle in smoothly (minimum 6s interval), eliminating the "59-second penalty" where users had to wait for the next full minute.
- **Reputation Bonus System**: Returning users get up to +50% cost reduction based on loyalty. Uses PostgreSQL persistence (`core.playground_reputation`) with SHA-256 hashed IPs for privacy.
- **Groq Retry with Backoff**: Added exponential backoff retry for Groq 429 errors (text: 3 retries, vision: 2 retries). Delays: 1s → 2s → 4s max, respects `retry-after` header when present.
- **Enhanced Error Logging**: Groq errors now log full rate limit headers (`x-ratelimit-*`), error body, and prompt size estimate for debugging.
- **Dynamic Capacity Sharing**: Adaptive per-IP capacity system. Global pools (text 240/hr, vision 120/hr, brave 360/hr) distribute evenly among active IPs in 180-min window. When quiet, users get more quota; when busy, limits tighten fairly. Dev IPs fully exempt.
- **Abuse Prevention System**: Burst throttling (>5 req/15s), duplicate prompt detection (60s block), and gibberish entropy filtering.
- **Multi-File Upload**: Up to 10 attachments per query. Mixed types (photo + document + audio) processed together in parallel.
- **Token Separation Complete**: Split Groq API tokens - `PLAYGROUND_GROQ_TOKEN` (text) + `PLAYGROUND_GROQ_VISION_TOKEN` (vision) to isolate rate limits.