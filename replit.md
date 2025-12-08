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
- **DDG Chemistry Enrichment Layer (H₀ Verified)**: For ALL chemistry/chemical structure queries, mandatory DDG knowledge enrichment BEFORE final Groq response:
  - **enrichChemistryContext()**: Runs 2 parallel DDG queries for every detected chemical structure:
    - Query 1: Molecular formula search (e.g., "C21H30O2 compound molecule chemical")
    - Query 2: Structure-based search (e.g., "benzene pyran cyclohexene compound molecule")
  - **DDG Context Injection**: External knowledge from DDG added to extraction output before final Groq prompt
  - **Groq deliberates with grounded knowledge**: Cannot hallucinate when DDG provides contradicting facts
  - **Canonical Formula Extraction**: DDG results mined for correct formula, overriding Vision counting errors
  - **Both PDF and Word/PPT**: Same enrichment pipeline applied to all document types
- **Compound Identification Cascade**: 5-stage cascade with matchType tracking:
  - `ddg-verified`: DDG enrichment found compound (highest reliability)
  - `groq-known`: Groq Vision identified + DDG fallback
  - `exact`, `verified-ddg`, `structure-based`, `fuzzy`: Progressive fallback stages
- **Word/PPT Vision Prompt Update**: Now matches PDF Vision - asks for "Molecular Formula:" and "Known as:" fields
- **Unified Chemistry Pipeline**: Topic-based `processChemistryContent()` function handles ALL chemistry enrichment regardless of document format (PDF, DOCX, PPTX). Single source of truth eliminates code duplication and ensures consistent behavior.
- **Smart Compound Name Expansion**: DDG Query 3 now expands abbreviations to full chemical names (THC → tetrahydrocannabinol) for better DDG Instant Answer results.
- **Multi-Strategy Compound Extraction**: 3 extraction strategies for compound names: (1) "Known as:" regex, (2) 30+ common compound patterns, (3) "similar to X" pattern matching.
- **Request ID Middleware**: Every HTTP request gets a unique UUID logged at request middleware level. All console logs automatically prefixed with `[request-id]` for easy tracing and debugging. X-Request-ID header returned in responses.
- **Externalized System Prompts**: NYAN Protocol (1000+ lines) moved from hardcoded inline string to `prompts/nyan-protocol.js`. Cleaner code, easier iteration on prompt tuning, maintains full functionality.
- **Centralized Constants**: Created `config/constants.js` with all magic numbers grouped by category: TIMEOUTS, CAPACITY, CACHE, SESSION, DISCORD, AI_MODELS, GROQ_RETRY, REPUTATION, FILE_UPLOAD, MISC. Single source of truth for tuning database timeouts, rate limits, cache settings, etc.
- **Webhook DRY Refactor**: Extracted duplicate media handling logic from `sendToLedger` and `sendToUserOutput` into unified `postPayloadToWebhook` helper. Handles direct buffers, DB media fetches, and text payloads. Eliminates 100+ lines of duplication, single source of truth for webhook POST operations.
- **PDF Visual Analysis**: Added `renderPDFPagesToImages()` using pdfjs-dist + canvas to render PDF pages. Routes through Groq Llama 4 Scout Vision for chart, chemical structure, and diagram analysis. Max 5 pages guardrail. Content auto-classified into chemical/chart/diagram/general categories.
- **Groq Retry Logic**: `groqWithRetry()` helper with exponential backoff (1s→2s→4s→8s cap) for 429/5xx errors. Wired into `analyzePageWithGroqVision()` for resilient Vision API calls.
- **Extraction Caching**: SHA-256 content hash caching in `executeExtractionCascade()` with 24h TTL and 1000-entry LRU limit. Cache HIT logs and `fromCache` flag in results. 100% savings on duplicate PDF uploads.
- **HF Vision Purge**: Removed dead HuggingFace Vision code from pdf-handler.js and attachment-cascade.js. Unified on Groq Vision for all image/PDF visual analysis. Image pipeline now uses same cost-optimized Groq Vision as PDF pages.
- **Dead Code Cleanup**: Removed orphaned `extractPDF()` from document-parser.js, removed unused `EXPENSIVE_API` cost tier from attachment-cascade.js.
- **Auth Middleware Optimization**: Removed duplicate tenant lookup in `requireRole` - now trusts `req.tenantSchema` already set by `requireAuth`. Saves 1 DB query per role-checked request.
- **Cache Headers DRY**: Extracted `noCacheHeaders(res)` helper to replace 4× repeated Cache-Control/Pragma/Expires header sets across auth endpoints.
- **Request ID Fix**: Replaced buggy global `console.log` patching with `AsyncLocalStorage`. Previous implementation caused double/triple request IDs when concurrent requests arrived. Now uses `requestContext.run()` for proper request-scoped context. Added `rlog()`/`rerror()` helpers for request-aware logging.
- **Universal Document Visual Analysis**: Extended visual analysis beyond PDFs to Word and PowerPoint files:
  - **Word (DOCX)**: `extractWordImages()` uses mammoth to extract embedded images, then sends to Groq Vision for chemical structure/chart/diagram identification.
  - **PowerPoint (PPTX)**: `convertDocumentToImages()` extracts media from ppt/media folder via JSZip, sends to Groq Vision.
  - **Pipeline Enhancement**: Cascade now passes `extractedImages` between steps via `cascadeOptions`, enabling mammoth-images → groq-doc-vision flow.
  - **libuuid Fix**: Installed system dependency to fix PDF page rendering with pdfjs-dist + canvas.
- **Lease-Based Auto-Heal System**: Replaced O(n²) linear scan with O(log n) priority queue:
  - **Schema**: Added heal_status, next_heal_at, heal_attempts, heal_lease_until, last_healed_at to core.book_registry.
  - **Worker**: 20-second cycle, batch=20, 60-second lease with SELECT FOR UPDATE SKIP LOCKED for concurrent safety.
  - **Exponential Backoff**: Failed heals retry with 2^attempts × 5min (capped at 24h).
  - **Stale Lease Recovery**: On startup, expired leases are released back to 'pending' queue.
  - **Event-Driven**: `queueBookForHealing()` triggers immediate heal on webhook failure.
  - **Partial Index Fix**: Replaced NOW() in partial index predicate (PostgreSQL IMMUTABLE requirement) with status-based indexing.

**Previous improvements (still active):**
- **Circuit Breaker**: Persistent abusers (5 events in 1 hour) get 30-minute cooldown. Progressive warnings at 3/5 and 4/5.
- **Logarithmic Reputation Growth**: Reaching 1.5× cost reduction cap at ~100 days.
- **Friendly Rate Limit Messages**: Cat-themed wellness prompts instead of harsh rejections.
- **Continuous Token Refill**: Smooth proportional refill (minimum 6s intervals).
- **Dynamic Capacity Sharing**: Adaptive per-IP quotas among active users.
- **Abuse Prevention**: Burst throttling, duplicate detection, entropy filtering.
- **Internal Usage Scribe**: `/api/playground/usage` tracks daily Groq token consumption with PostgreSQL persistence.