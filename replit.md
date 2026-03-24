# replit.md — Internal LLM Memory
> Replit-internal only. Never pushed. Not a public document.
> For the public-facing readme → see README.md (tracked in git; pushes to `bluedream` automatically). Full git procedure → `.local/GIT_INSTRUCTIONS.md`.

---

## What this is
NyanBook~ — multi-tenant archiving notebook. Users send messages (WhatsApp / LINE / Telegram) to a personal "book". Backend: Node.js + Express. Frontend: vanilla JS SPA. DB: PostgreSQL (multi-tenant schemas). AI: Groq Llama 3.3 70B. Discord: 4 bots (Hermes/Thoth/Idris/Horus).

---

## UI Implementation Rules — AUTHORITATIVE (do not guess, do not revert)

### Mobile/Desktop parity
Every UI size/spacing/layout change: check BOTH the base CSS rule AND the `@media (max-width: 599px)` override — they are independent `!important` blocks. A fix to one silently leaves the other broken. Body classes `mobile-mode` / `desktop-mode` are set by JS `LayoutController`.
- **Mobile threshold**: `viewport width < 600px` — pure width, no aspect-ratio check. `detectDevice()` in `layout-controller.js` is a single line.
- **CSS breakpoints**: `@media (max-width: 599px)` = mobile; `@media (min-width: 600px)` = desktop row layout.

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
- Eve width: `width: var(--sidebar-width)` in base `.book-sidebar` rule. Default in `:root` = `clamp(160px, 22vw, 240px)` (responsive on first load). JS drag overrides `--sidebar-width` with a fixed px value; constraints: CSS `min-width: 160px`, `max-width: 400px`; JS `MIN_WIDTH=180`, `MAX_WIDTH=400`. `localStorage` key `nyanbook_sidebar_width` persists across sessions. No per-breakpoint width overrides.
- Header (cat + title) is eternal — present at all resolutions, above Adam and Eve.

---

## Architecture

### Backend — Vegapunk Kernel
Factory pattern with dependency injection. 4 modular satellites:
- `auth` — JWT, email/password, role-based access, audit trail, password reset
- `books` — CRUD, messages, search, tags, export (verifiable SHA256 manifest)
- `inpipe` — abstract channel interface; `twilio` (WhatsApp, reply-capable) + `line` (LINE OA, listen-only) + `telegram` (Bot API, reply-capable, deep-link join)
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
- **Telegram**: Bot API inpipe → book archival. `/start JOINCODE` deep-link activation. Reply-capable. `phone_number = null` (non-phone channel, same as LINE — password reset disabled). `book_engaged_phones` stores Telegram userId as routing key.
- **Discord bots**: Hermes (thread creation), Thoth (message mirroring), Idris (AI audit write), Horus (AI audit read).

### Fractal Outpipe (`lib/outpipes/`)
Two invariant output layers per message:
- **Output #01 (Ledger)**: always Discord-only — bot append-only nature IS the immutability guarantee. Never fractal.
- **Output #0n (User)**: fractal — per-book JSONB array `books.outpipes_user` configures 0-N parallel delivery targets.
  - `discord` type: posts to a user-specified Discord channel/webhook
  - `email` type: sends via Resend (`RESEND_API_KEY` env var; `RESEND_FROM_EMAIL` optional)
  - `webhook` type: HTTPS JSON POST with optional HMAC-SHA256 `X-Nyan-Signature` header
  - Router (`lib/outpipes/router.js`) dispatches all configured outpipes in parallel; falls back to legacy `output_credentials.webhooks` if `outpipes_user` is empty (backward-compatible migration).
  - API: `PATCH /api/books/:id/outpipes` — typed upsert with password guard for URL-based types.
  - UI: Outpipes section appears in edit-book modal only; hidden on create.

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
| Telegram Bot API | Telegram inpipe (`TELEGRAM_BOT_TOKEN` required; `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` optional) |
| Resend | Transactional email |
| Pinata | IPFS pinning for message capsule ledger |
| Discord | Bot message threading + AI audit logging |
| `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` | Document parsing |

---

## Code Conventions — Shared Resources (NEVER REPLICATE)

**~nyan identity** → `prompts/nyan-protocol.js` exports `NYAN_PROTOCOL_SYSTEM_PROMPT` (full) and `NYAN_PROTOCOL_COMPRESSED` (ultra-terse seed). Every pipeline path that needs ~nyan's identity MUST import from here. Never write `"You are ~nyan..."` inline. Domain-specific instructions (search steps, table rules, coda directions) go alongside the injected compressed identity, not instead of it.

**Forex detection** → `utils/forex-fetcher.js` → `detectForexPair()` / `isForexQuery()`. Currency alias matching uses word-boundary regex (`\bfranc\b`) — NOT `String.includes()`. Substring match causes false positives ("franc" in "Francisco" → CHF false-positive for USD/CHF).

**Seed Metric detection** → `prompts/seed-metric.js` → `detectSeedMetricIntent()`. `SEED_METRIC_TOPIC_KEYWORDS` uses word-boundary regex (`\bland\b`) — NOT `String.includes()`. Same substring class as forex: "landscape" → "land" false-positive. Keyword regexes are pre-compiled in `SEED_METRIC_KEYWORD_REGEXES` at module load.

**Seed Metric formula** → canonical in `NYAN_PROTOCOL_COMPRESSED`. `stepSeedMetricToolCall()` in `pipeline-orchestrator.js` inherits from it — do not redeclare the formula separately.

**Schema validation** → `lib/validators.js` exports `assertValidSchemaName(schema)` (throws) and `VALID_SCHEMA_PATTERN` (regex predicate). Every file that validates a tenant schema name MUST import from here — never inline `/^[a-z_][a-z0-9_]*$/i`.

**AI API keys** → `config/index.js` centralizes all env var lookups:
- `config.ai.dashboardAiKey` = `NYANBOOK_AI_KEY || GROQ_API_KEY` (book audit / dashboard)
- `config.ai.groqToken` = `PLAYGROUND_AI_KEY || PLAYGROUND_GROQ_TOKEN` (playground)
- `config.ai.groqVisionToken` = vision model key
- Never write `process.env.NYANBOOK_AI_KEY || process.env.GROQ_API_KEY` inline — use `config.ai.dashboardAiKey`.

**Logging** → `lib/logger.js` (pino, msg-only stream). All server files MUST use `logger.info/warn/error/debug`. `console.*` is permitted ONLY in pre-logger startup paths (guarded by `// NOTE: intentional`) or standalone test harnesses (`require.main === module`). `utils/` is excluded from migration (401 calls, user decision).

**Any string or constant used in >1 file** → extract to a shared module in `utils/` or `prompts/`. Code bloat = drift risk.

**Git remotes** — two separate push targets with different content rules:
- `origin` → `10nc3/Nyan` (private, PAT=`GITHUB_PAT_10NC3`) — ALL code + `replit.md` (force-add: `git add -f replit.md`). Push here first.
- `bluedream` → `10nc0/BlueDream` (public) — ALL code + `README.md`. NEVER include: `replit.md`, `notebook.md`, `.env`, secrets. These are already gitignored.
- `gitsafe-backup` → Replit internal git — push all code (same as origin minus replit.md).
- Always use PAT-embedded remote URL: `git remote set-url origin "https://${GITHUB_PAT_10NC3}@github.com/10nc3/Nyan.git"`. Redact in logs: `sed 's/https:\/\/[^@]*@/https:\/\/[REDACTED]@/g'`
- `replit.md` push sequence: `git add -f replit.md && git commit -m "..." && git push origin main` — then do NOT push that commit to bluedream (push bluedream from the preceding commit hash or just skip replit.md commits to bluedream).

**Git commit discipline** — one logical change = one commit, pushed once.
- Before the first push: check the task's "Done looks like" against the diff. Catch all gaps locally.
- Do NOT push then fix then push again — squashing after a public push requires force-push on all remotes.
- Multiple fix commits on a single task = avijja. Review first, push once.
