# NyanBook~

## Overview
NyanBook~ is a multi-tenant archiving notebook application designed to help users archive messages from various communication platforms (WhatsApp, LINE, Telegram) into personal "books." The project aims to provide a robust, scalable, and AI-powered solution for personal data management and analysis, with a focus on privacy and verifiable data integrity.

**Business Vision:** To become the leading personal archiving solution, empowering users with control over their digital communication history and leveraging AI for insightful analysis without compromising privacy.
**Market Potential:** Individuals and professionals seeking to consolidate and analyze their digital conversations from disparate messaging apps.
**Project Ambitions:** To offer a seamless, secure, and intelligent archiving experience, evolving into a comprehensive personal knowledge management system.

## User Preferences
- **Communication Style:** I prefer simple language and direct explanations.
- **Workflow:** I want iterative development with clear communication at each step.
- **Interaction:** Please ask for confirmation before making any major architectural changes or significant code refactors.
- **Codebase Changes:** Do not make changes to files in the `.local/` folder, including `GIT_INSTRUCTIONS.md`. Do not modify `replit.md` or `notebook.md`.
- **No Code Bloat:** Before creating any new lookup table, map, constant, or shared resource, check if one already exists in the codebase. Reuse and extend existing resources — never duplicate. If a resource is used by multiple modules, hoist it to a shared location (e.g., a utils module or the module that owns the data). When adding fallback/retry logic, check if the same data source is already queried elsewhere and unify.

## System Architecture

### Backend — Vegapunk Kernel
The backend is built with Node.js and Express, utilizing a factory pattern with dependency injection for modularity. It comprises four main satellites:
- `auth`: Handles JWT, email/password authentication, role-based access, and audit trails.
- `books`: Manages CRUD operations for books, messages, search, tags, and verifiable SHA256 manifest exports.
- `inpipe`: Provides an abstract interface for integrating various messaging channels like Twilio (WhatsApp), LINE, and Telegram.
- `nyan-ai`: Offers AI functionalities including a playground, vision capabilities, audit features, book history analysis, and diagnostics.
A Phi Breathe Orchestrator handles background tasks such as memory cleanup and media purging.

### Database
PostgreSQL is used as the primary database, employing a multi-tenant architecture where each user has an isolated schema. A `core` schema stores shared tables like authentication, ledger, and shares.

### Frontend
The frontend is a vanilla JavaScript Single Page Application (SPA). It uses `Nyan.StateService` and `Nyan.AuthService` for state and authentication management. `LayoutController` manages UI responsiveness, device detection, and animations. The application is a Progressive Web App (PWA) with a network-first cache strategy and is compatible with Safari/iPad, storing JWT in localStorage.

#### Dashboard Detail Shell (Level 0 Architecture)
The book detail panel uses a permanent shell pattern — structural UI elements (header bar, action buttons, toolbar, search/filter row, messages container) are built once at init via `_buildDetailShell()` and never destroyed. Data binding updates only the dynamic content:
- `_bindShellToBook(fractalId, name)` — re-targets all dataset attributes and element IDs to the current book. Tracks `_boundBookId` for clean re-binding on book switch.
- `_updateShellVisibility(book)` — toggles platform-specific (WhatsApp) and permission-gated (edit/delete) buttons.
- `_fetchWhatsAppStatus(book)` — async status badge update.
- `renderBookDetail()` is now a thin wrapper (~8 lines) that calls shell functions.

#### Priority Loading (Gaming Logic)
Init sequence after auth: `_buildDetailShell()` → `_initPriorityLoad()` ∥ `_initBackgroundBooks()`.
- `_initPriorityLoad()` hits `GET /api/books/top` (single-row LIMIT 1, ~100ms) with optional `?fid=` for cached book. Binds shell + loads messages (~2s). Sets `_priorityBookLoaded` flag.
- `_initBackgroundBooks()` hits `GET /api/books` (full list, slow). Fills sidebar only, calls `_updateShellVisibility` — never destroys messages.
- Race protection: `_backgroundBooksDone` flag prevents priority path from overwriting if background finishes first (warm cache scenario).
- localStorage keys: `nyan_lastBook` (fractalId), `nyan_lastBookName` (display name). Persisted on every `selectBook()`.
- First visit (no cache): `/api/books/top` returns first book by sort_order. Subsequent visits: uses cached fractal_id.

### AI Pipeline
A 7-stage state machine (S-1 → S6) orchestrates AI operations, used by both the public playground and authenticated audit features. Key components include:
- **Preflight Router:** Classifies queries into specific modes (e.g., `forex`, `seed-metric`, `psi-ema`, `legal`, `code-audit`).
- **Mode Registry:** Provides plug-and-play configuration for each AI mode.
- **AuditCapsule:** Extracts and tallies session-scoped entities.
- **Executive Formatter:** Post-processes audit responses.
- **Nyan Protocol:** Defines the AI's identity and epistemic rules, canonical for all paths.
- **Seed Metric (Agent Swarm Architecture):** A 3-stage pipeline replaces the old bulk regex/LLM extraction:
    1. **Round 1 (SEARCH):** LLM drives Brave tool_calls to pick search queries (unchanged).
    2. **Per-search EXTRACT:** Each Brave result gets its own micro-LLM call (~50 token system prompt, no Nyan Protocol) returning `{"value": <number>, "type": "pricePerSqm"|"income", "currency": "XXX"}` or `{"value": null}`. Fires async during Brave rate-limit wait for net-zero added latency. Zero cross-city contamination by design — one result, one city.
    3. **Server MATH:** Collects extractions → `buildSeedMetricTable` (deterministic). `parseSeedMetricData` retained as emergency fallback but not called in main flow.
    4. **CODA:** LLM writes narrative (unchanged).
  **City matching:** Word-boundary regex (not substring `includes`) prevents false positives (e.g., `la` matching `salary`). 2-char abbreviations only match via expanded form (la→los angeles, ny→new york, etc.). **Historical detection:** Parses year tokens numerically; primary check `[histDecadeNum, histDecadeNum+15]` range, fallback `hasAnyOldYear` (< currentYear-5) catches LLM queries targeting decades outside the default range. Default historical period is `currentYear - 25` (2000s), user can override with explicit year. **TFR capsule:** Orchestrator runs dedicated Brave searches per city for both current and historical TFR, stores in `tfrCapsule`, merges into `parsedData.cities[city].*.tfr` after parsing — avoids regex cross-city contamination. **Country-level fallback:** When city-level TFR or income searches return null, the system falls back to country-level queries using a `_CITY_TO_COUNTRY` map (e.g., Berlin→Germany, Tokyo→Japan). TFR fallback fires immediately after a city-level miss; income fallback fires after all primary extractions complete, only for slots that remain null.

### Messaging Integrations
- **WhatsApp:** Integrated via Twilio Business API for message archiving, with media uploaded to Discord.
- **LINE:** A listen-only channel for LINE Official Accounts, with QR onboarding.
- **Telegram:** Uses the Bot API for message archiving, supporting reply capabilities and deep-link activation.

### Fractal Outpipe
A flexible output system (`lib/outpipes/`) allows for invariant output layers:
- **Output #01 (Ledger):** Always Discord-only, ensuring immutability.
- **Output #0n (User):** Configurable per-book JSONB array (`books.outpipes_user`) for parallel delivery to multiple targets:
    - `discord`: Posts to user-specified Discord channels/webhooks.
    - `email`: Sends transactional emails via Resend.
    - `webhook`: Sends HTTPS JSON POST requests with optional HMAC-SHA256 signatures.

### Security
Comprehensive security measures include Sybil prevention, JWT hardening, robust session management, tenant key hashing, prevention of command injection and XSS, LLM prompt sanitization, and a strict Content Security Policy (`script-src: 'self'`).

### Tool Registry (`lib/tools/`)
A portable, auto-discovered tool registry following the outpipe factory pattern. Each tool in `lib/tools/` exports `{ name, description, parameters, execute }`. The central `registry.js` auto-discovers all tool modules on startup and exposes them via `getTool(name)` and `getManifest()`. Current tools (9):
- **brave-search:** Web search via Brave API (text or JSON format, capacity-throttled, cached 3min)
- **duckduckgo:** Instant answers via DDG API (fallback search, cached 5min). Also exports `ddgRawQuery()` for structured access (used by attachment-cascade chemistry enrichment)
- **url-fetcher:** Fetch and extract readable content from any web URL (cached 10min)
- **github-reader:** Read GitHub repos, blobs, trees, raw files, and Gists
- **pdf-analyzer:** PDF document analysis via attachment-cascade pipeline
- **entity-extractor:** Structured entity extraction (license plates, currency amounts, dates, emails, phone numbers, URLs) — stateless, read-only
- **geo-lookup:** Geographic metadata lookup — city→country, country→cities, city abbreviation expansion, currency→region mapping. Pure static data, no network calls
- **forex:** Currency exchange rates via fawazahmed0 API
- **language-detector:** Language detection wrapping `utils/language-detector.js` — returns ISO 639-1 code + confidence + FTS config
Fork operators can add a tool by dropping a `.js` file in `lib/tools/` with the standard shape — zero other file changes needed. Remove a tool by deleting its file.

### URL Fetcher + GitHub Reader (implementation: `lib/url-fetcher.js`)
The system automatically injects web content into `extractedContent` when URLs are present in messages. It supports various URL types, including GitHub repositories, blobs, trees, raw files, Gists, and general web pages. The tool registry wraps these as `url-fetcher` and `github-reader` tools.

### Language Detection (`utils/language-detector.js`)
Lightweight, pure-JS language detection using script analysis (CJK, Hangul, Cyrillic, Arabic, Devanagari, Thai) and Latin-script trigram frequency matching. Returns ISO 639-1 codes with confidence scores. Integrated into:
- **Inpipe:** Every incoming message is tagged with `detected_lang` in `core.message_ledger` (confidence threshold ≥ 0.3).
- **Drops search:** FTS config is dynamically selected based on query language (e.g., `german` for German queries, `simple` for CJK).
- **Message search:** Unicode NFKC normalization and CJK full-width→half-width conversion applied to search terms and content.

### Message Capsule + IPFS Ledger
Every incoming message is converted into a cryptographic provenance capsule containing body text, sender proof, content hash, and attachment metadata. This capsule is pinned to IPFS via Pinata, with the CID stored in `core.message_ledger` for verifiable disclosure.

## Testing

### Test Commands
- `npm run test:unit` — Preflight router + capsule integrity (standalone, no DB)
- `npm run test:core` — Core flow integration tests against live PostgreSQL (50 tests covering auth/JWT, books CRUD, tenant isolation, capsule/inpipe, validators, book registry/ledger). Creates ephemeral test schemas and tears them down.
- `npm run test:smoke` — HTTP endpoint smoke tests (requires running server)

### Test Architecture
- `tests/test-core.js` — Integration tests that create isolated `test_<timestamp>_a` / `test_<timestamp>_b` schemas, provision users/tenants, exercise the full auth-service, books CRUD, multi-tenant isolation boundaries, capsule v2 building, Twilio normalization, message queue ordering/retry, idempotency guards, validators, book registry, and message ledger uniqueness. Self-contained teardown on exit.
- `tests/test-capsule.js` — Pure crypto tests for `buildCapsule()` (SHA256, HMAC, attachment hashing).
- `tests/test-preflight-router.js` — AI preflight routing logic (geo-veto, forex, seed-metric detection).
- `tests/smoke.js` — HTTP-level health and auth-gate checks.

## External Dependencies

- **PostgreSQL:** Primary multi-tenant database.
- **Twilio:** Used for WhatsApp Business API integration.
- **Groq:** Provides LLM inference (Llama 3.3 70B) as a fallback.
- **DeepSeek API:** Primary LLM inference (DeepSeek R1).
- **Brave Search:** For live web search, particularly for seed metric calculations and general queries.
- **DuckDuckGo:** Used for Instant Answer API.
- **fawazahmed0:** Provides currency exchange rates.
- **Telegram Bot API:** For Telegram messaging integration.
- **Resend:** For sending transactional emails.
- **Pinata:** For IPFS pinning of message capsules.
- **Discord:** Used for bot message threading and AI audit logging.
- **`pdf-parse`, `tabula-js`, `exceljs`, `mammoth`:** Libraries for document parsing.