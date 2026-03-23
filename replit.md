# replit.md — Internal LLM Memory
> Replit-internal only. Never pushed. Not a public document.
> For the public-facing readme → see README.md (push to `bluedream` remote only via `git add -f README.md`).

---

## What this is
NyanBook~ — multi-tenant archiving notebook. Users send messages (WhatsApp / LINE) to a personal "book". Backend: Node.js + Express. Frontend: vanilla JS SPA. DB: PostgreSQL (multi-tenant schemas). AI: Groq Llama 3.3 70B. Discord: 4 bots (Hermes/Thoth/Idris/Horus).

---

## UI Implementation Rules — AUTHORITATIVE (do not guess, do not revert)

### Mobile/Desktop parity
Every UI size/spacing/layout change: check BOTH the base CSS rule AND the `@media (max-width: 480px)` override — they are independent `!important` blocks. A fix to one silently leaves the other broken. Body classes `mobile-mode` / `desktop-mode` are set by JS `LayoutController`.

### Dashboard cat (#catContainer)
- `position: relative; margin: 0 -22px` — unified, identical to `playground.html`. No mobile/desktop split.
- Flex item inside header flex row; `align-items: center` on parent vertically centers the 100px canvas in the 60px header.
- `margin: 0 -22px` compensates the 32px blank canvas on each side of the cat face so face aligns left edge.
- `LayoutController` does NOT resize the canvas.
- Canvas HTML attrs: `width="100" height="100"`. Drawing scale = `(canvas.width / 125) × 2.8`.
- Cat face at canvas y≈28–72. Blank canvas above y=28 is hidden above viewport. z-index: 20. `pointer-events: none`.

### Auth page cat (.character-canvas)
- 250px buffer canvas displayed at 200px CSS (desktop) / 240px (mobile).
- ~55px transparent blank above cat ears and ~55px below feet.
- Fixed via `margin-top: -50px; margin-bottom: -50px` on `.character-canvas`.
- Container height: 130px (desktop) / 150px (mobile).
- Do NOT revert to height: 200/240px without restoring the negative margins.

### Adam/Eve UI hierarchy
- **Adam** (message pane) = primary, always spawns first, dominates visually at all breakpoints.
- **Eve** (book sidebar) = secondary, static navigation. Mobile: hidden by default. Tablet/desktop: spawns via `eveSpawn` slide-in (translateX -18px → 0) after Adam is ready.
- Eve width: 180px (tablet) / 200px (desktop). Base CSS: `flex-grow: 0; min-width: 160px; max-width: 300px` — Eve can never blow past 300px.
- Header (cat + title) is eternal — present at all resolutions, above Adam and Eve.

---

## Architecture

### Backend — Vegapunk Kernel
Factory pattern with dependency injection. 4 modular satellites:
- `auth` — JWT, email/password, role-based access, audit trail, password reset
- `books` — CRUD, messages, search, tags, export (verifiable SHA256 manifest)
- `inpipe` — abstract channel interface; `twilio` (WhatsApp, reply-capable) + `line` (LINE OA, listen-only)
- `nyan-ai` — playground, vision, audit, book history, psi-ema, diagnostics

Phi Breathe Orchestrator: background scheduler (memory cleanup, media purge, share expiry, pending book expiry).

### Database
PostgreSQL multi-tenant: each user gets an isolated schema. `core` schema for shared tables (auth, ledger, shares).

### Frontend
Vanilla JS SPA. `Nyan.StateService` + `Nyan.AuthService` patterns. `LayoutController` manages device detection, UI mode switching, animations. PWA: `public/manifest.json` + `public/sw.js` (network-first cache). Safari/iPad compatible (JWT in localStorage).

### AI Pipeline — 7-stage state machine (S-1 → S6)
Single Nyan AI engine shared by public playground and authenticated dashboard audit.
- **Preflight router** classifies query → mode: `forex` / `seed-metric` / `psi-ema` / `legal` / `code-audit` / default
- **Mode registry** plug-and-play config per mode
- **AuditCapsule** session-scoped entity extraction + tally cache
- **Executive Formatter** post-processing for audit responses
- **Nyan Protocol** (`prompts/nyan-protocol.js`) — identity + epistemic rules, canonical for all paths
- **Walk-the-Dog** seed metric path: Groq tool-calling API, LLM drives Brave searches (Round 1 = tool_calls, Round 2 = synthesis)

### Messaging
- **WhatsApp**: Twilio Business API inpipe → book archival. Media uploads to Discord.
- **LINE**: LINE OA listen-only channel. QR onboarding in create-book modal.
- **Discord bots**: Hermes (thread creation), Thoth (message mirroring), Idris (AI audit write), Horus (AI audit read).

### Security
Sybil prevention, JWT hardening, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, CSP (`script-src: 'self'` — all external scripts must be vendored to `/public/vendor/`).

### Message Capsule + IPFS Ledger
Every inpipe message → cryptographic provenance capsule (body text, HMAC sender proof, SHA256 content hash, per-attachment metadata). Capsule pinned to IPFS via Pinata. CID stored in `core.message_ledger`. Supports full/partial/selective binary disclosure.

---

## Architectural Philosophies

**Axiom of Choice** — self-governing, scalable components via dependency injection.

**Live API over Dogma** — hardcoded lists permitted ONLY for routing/classification (e.g. `KNOWN_CITIES_REGEX` ~200 cities, ticker patterns, forex regex). Once entity type is known, ALL data comes from live APIs. Prices → Brave Search. Stocks → Yahoo Finance. FX rates → fawazahmed0. Conflating routing guards with data = dogma.

**The Totem (Triangulation-First)** — Seed Metric $/sqm is derived by triangulation (total_price ÷ area_sqm) as the primary path, not a fallback. Real search results express total prices + unit sizes, not pre-computed $/sqm. Parse log annotates `(triangulated)` to audit which path fired.

**Walk the Dog (LLM Tool Calling)** — Seed Metric uses Groq function-calling. LLM decides what to search (city-aware, language-aware), reads raw Brave JSON results `[{title, url, description, age}]`, triangulates $/sqm, produces table + coda. `tool_choice: 'required'` forces searches — prevents training-data dogma. 2 round-trips: Round 1 (tool_calls) + Round 2 (synthesis). Rate-limit: 1100ms between Brave calls, max 8 searches, 1500ms retry on 429.

**Adam/Eve UI Hierarchy** — see UI Implementation Rules above.

---

## External Dependencies

| Service | Purpose |
|---|---|
| PostgreSQL | Multi-tenant database |
| Twilio | WhatsApp Business API |
| Groq | LLM inference (Llama 3.3 70B) |
| Brave Search | Live web search for seed metric + general search |
| DuckDuckGo | Instant answer API |
| fawazahmed0 | Currency exchange rates |
| Resend | Transactional email |
| Pinata | IPFS pinning for message capsule ledger |
| Discord | Bot message threading + AI audit logging |
| `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` | Document parsing |

---

## Code Conventions — Shared Resources (NEVER REPLICATE)

**~nyan identity** → `prompts/nyan-protocol.js` exports `NYAN_PROTOCOL_SYSTEM_PROMPT` (full) and `NYAN_PROTOCOL_COMPRESSED` (ultra-terse seed). Every pipeline path that needs ~nyan's identity MUST import from here. Never write `"You are ~nyan..."` inline. Domain-specific instructions (search steps, table rules, coda directions) go alongside the injected compressed identity, not instead of it.

**Forex detection** → `utils/forex-fetcher.js` → `detectForexPair()` / `isForexQuery()`. Currency alias matching uses word-boundary regex (`\bfranc\b`) — NOT `String.includes()`. Substring match causes false positives ("franc" in "Francisco" → CHF false-positive for USD/CHF).

**Seed Metric formula** → canonical in `NYAN_PROTOCOL_COMPRESSED`. `stepSeedMetricToolCall()` in `pipeline-orchestrator.js` inherits from it — do not redeclare the formula separately.

**Any string or constant used in >1 file** → extract to a shared module in `utils/` or `prompts/`. Code bloat = drift risk.

**Git remotes**
- `origin` → `10nc3/Nyan` (private, PAT=`GITHUB_PAT_10NC3`) — push all code changes here
- `bluedream` → `10nc0/BlueDream` (public) — push all code changes + `git add -f README.md` for public readme
- `gitsafe-backup` → Replit internal git
- Strip PAT from git URLs immediately after push (use `sed` substitution in logs)
