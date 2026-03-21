# Nyanbook 🌈

> *The scribe's job was never to create. It was to record faithfully, tally honestly, and let the ledger speak.*

A sovereign, multi-tenant archiving system — WhatsApp, LINE OA, and Discord, unified under one ledger. Built for zero-friction data sovereignty from the $7/day mobile user to the enterprise archivist. No dogma. No hallucination. Honest measurement (*mīzān*).

---

## What This Is

Nyanbook is a **post-folder archiving architecture**. Instead of filing documents into folders, you send them — via WhatsApp, LINE OA, or Discord — and they are automatically routed via PostgreSQL, stored in Discord threads, and optionally anchored to IPFS.

Nyanbook is a temporal accountability substrate. Identity, in this system, is the pattern that emerges from what was recorded — not a claim, but a ledger.

**Core loop:**
```
iPhone (WhatsApp / LINE OA)
  → webhook
    → queue processor
      → Discord ledger thread
        → PostgreSQL row
          → IPFS capsule pin (optional)
```

> *Discord is the permanent content store — free, searchable, thread-organized. PostgreSQL is the routing and index layer. IPFS is the sovereign anchor — the record that exists independent of any platform.*

**Dashboard:** Glassmorphism SPA — browse all archived messages, search, tag, export with SHA256 manifest. Multimodal AI Playground included.

---

## The Main Feature: Absence as Data

> *"The system's job is to make the absence undeniable and queryable."*

Every other system is built around presence — what was recorded, filed, stored. The gap is silence. Silence is not data.

Nyanbook treats absence as signal:

- **Append-only** — you cannot retroactively fill the gap
- **IPFS pin** — what was written cannot be unwritten
- **PostgreSQL** — the gap between entries is queryable
- **Discord thread** — the human-readable witness layer sees the gap too

The driver who logged 4 entries where 11 were expected: the ledger doesn't accuse. It shows. The mīzān holds level. The feather does the work.

| System | Absence queryable? | Append-only? | Content-addressed? |
|--------|-------------------|--------------|--------------------|
| Notion | ✗ | ✗ | ✗ |
| Evernote | ✗ | ✗ | ✗ |
| Slack | ✗ | ✗ | ✗ |
| **Nyanbook** | **✓** | **✓** | **✓ (IPFS)** |

> *"If you were supposed to log something every day for a month and forgot 7 days — does your current system know you forgot? Can it show you exactly which 7 days?"*

Identity, in this system, is the pattern that emerges from what was recorded — not a claim, but a ledger.

---

## Who This Is For

| Scale | Deployment | Use Case |
|-------|-----------|----------|
| Individual | Replit free tier | Personal archiving |
| Family | Replit Autoscale | Household records |
| Community | Self-hosted | Mutual aid, neighbourhood records |
| Municipal | Fork + customize | Local government transparency |

Open source means anyone can verify the feather is level. No priest. No perriwig. No proprietary black box.

---

## The Founding Letter

*Written at the seventh life, 18 March 2026 — Nyepi, the Day of Silence.*

To whoever reads this at the seventh life —

The equation didn't need you to understand it. It ran fine without witnesses for most of recorded history. But you arrived at the one moment when the substrate became cheap enough to let it run in all its forms simultaneously, for the price of electricity, without a priest or a perriwig between you and the reading.

That is not a small thing.

The scribe's job was never to create. It was to record faithfully, tally honestly, and let the ledger speak. Thoth didn't judge the heart — the feather did. Thoth just held the scales level and wrote down what happened.

Nyanbook is a set of level scales. The communities that cannot afford the perriwig economy still produce labor days. They still have transactions, flows, substrates. The equation still applies to them. They just never had a scribe cheap enough to sit at their table.

Now they do.

Don't add more than the tally requires. The void, the mark, the self-reference, the attractor. Four fields. That's the whole thing. Everything else is grammar.

Breathe: `00 + φ⁰ + φ¹ = φ²`. Scribe faithfully.

*nyan~*

---

## Architecture

```
Vegapunk Kernel (vegapunk.js)
├── routes/auth.js       — JWT auth, sessions, multi-tenant
├── routes/books.js      — CRUD, messages, search, export
├── routes/inpipe.js     — WhatsApp + LINE inpipe (channel-agnostic)
└── routes/nyan-ai.js    — AI playground, audit, Psi-EMA, diagnostics

lib/channels/
├── base.js              — Abstract channel interface
├── twilio.js            — WhatsApp (reply-capable)
└── line.js              — LINE OA (listen-only)

Discord Bots (4 specialized, least-privilege):
├── hermes-bot.js        — General messaging (write)
├── thoth-bot.js         — Ledger scribe (read)
├── idris-bot.js         — Index / search (read)
└── horus-bot.js         — Audit / oversight (read)

Each bot holds only the permissions its role requires.
Hermes writes. Thoth reads. Compromise one — the others remain clean.

utils/
├── message-capsule.js   — ZK-ready capsule builder
├── ipfs-pinner.js       — Pinata IPFS pinning
├── psi-EMA.js           — φ-derived time series analysis
├── fetch-stock-prices.py — Psi-EMA data fetcher (yfinance / pandas)
├── dashboard-audit-pipeline.js — 4-stage hallucination correction
└── seed-metric-calculator.js   — Real estate affordability (Seed Metric)
```

**Adding a new inpipe channel** (Telegram, Signal, etc.) requires only:
1. `lib/channels/telegram.js` implementing the `BaseChannel` interface
2. 2 lines in `routes/inpipe.js` to register the route

Zero changes to queue, handlers, DB, or Discord outpipe.

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL (Supabase recommended — free tier works)
- Discord server with 4 bot tokens and a webhook
- Twilio account (WhatsApp Business API) — optional
- LINE Developer account (LINE OA) — optional
- Groq API key (AI features)

### 1. Clone & Install

```bash
git clone https://github.com/10nc0/BlueDream
cd Nyan
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

See `.env.example` for all required and optional variables with descriptions.

### 3. Database

Run the genesis migration to create the multi-tenant schema:

```bash
node -e "require('./tenant-manager').genesis()"
```

Nyanbook uses isolated PostgreSQL schemas per tenant (`tenant_1`, `tenant_2`, etc.) with a shared `core` schema for cross-tenant routing.

### 4. Discord Bots

Create 4 Discord bots in the [Discord Developer Portal](https://discord.com/developers/applications):

| Bot | Role | Token env var |
|-----|------|---------------|
| Hermes | Messaging relay | `HERMES_TOKEN` |
| Thoth | Ledger scribe | `THOTH_TOKEN` |
| Idris | Index / search | `IDRIS_TOKEN` |
| Horus | Audit / oversight | `HORUS_TOKEN` |

Create a webhook for your ledger channel: `NYANBOOK_WEBHOOK_URL`

### 5. WhatsApp (Twilio)

1. Create a [Twilio account](https://twilio.com)
2. Enable WhatsApp Business API
3. Set webhook URL: `https://your-domain.com/api/twilio/webhook`
4. Add `TWILIO_AUTH_TOKEN` to your env

### 6. LINE OA (optional)

1. Create a [LINE Developer account](https://developers.line.biz)
2. Create a Messaging API channel (LINE OA)
3. Set webhook URL: `https://your-domain.com/api/line/webhook`
4. Add `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` to your env

LINE is **listen-only** — Nyanbook receives messages but does not reply. The outpipe is Discord.

### 7. Run

```bash
node vegapunk.js
```

The server starts on port 5000 (configurable via `PORT`).

---

## Inpipe: Activating a Book

Each "Book" is a routing destination. To route messages to a book:

1. **Create a book** in the dashboard
2. **Get the join code** (e.g. `MyBook-a1b2c3`)
3. **Send the join code** as your first WhatsApp/LINE message to activate routing

After activation, all subsequent messages from that sender are routed to the active book until changed.

---

## IPFS Capsule Ledger (optional)

Every inpipe message builds a ZK-ready capsule:
- Actual message body
- HMAC sender proof (phone proven, not revealed)
- SHA256 content hash
- Per-attachment metadata

Set `PINATA_JWT` to enable automatic IPFS pinning via [Pinata](https://pinata.cloud) (free 1GB tier). Without it, the system degrades gracefully (null CID).

**Capsule schema contract:** The `v` field is a public interface. Structural changes to `buildCapsule()` MUST bump `v` (e.g. `v: 2`). Old CIDs remain permanently valid.

> *Deleting a Postgres row does not delete the IPFS pin. The name is erased. The weight of the heart remains on the scale.*

---

## AI Features

### Playground (public, no login)
- Multimodal: text + images + documents
- Document parsing: PDF, Excel, DOCX
- Real-time web search (Brave API)
- Powered by Groq Llama 3.3 70B

### Dashboard Audit (authenticated)
- 4-stage hallucination correction pipeline (S0–S3)
- AuditCapsule: session-scoped entity extraction
- Executive Formatter: strips filler from responses
- Psi-EMA: φ-derived time series analysis for financial data

### Seed Metric
Real estate affordability formula:
```
(price_per_sqm × 700) / annual_income = years_to_afford
```
No P/I ratio fallback. N/A is the honest answer when data is unavailable.

---

## Security

- JWT authentication with role-based access
- Multi-tenant schema isolation (complete data separation)
- Twilio webhook signature validation
- LINE webhook HMAC validation
- Session management with audit logging
- XSS prevention, CSP compliance
- Sybil attack prevention on book activation

---

## Testing

### Integration (requires live server)

Start the server first (`npm start`), then:

```bash
npm test
```

Tests the 2-pass hallucination correction pipeline — sends time-sensitive queries
to the AI playground and verifies that the search-retry and re-audit stages trigger
correctly (`tests/test-search-retry.js`).

### Unit (browser)

Open the dashboard and run in the browser console:

```javascript
Nyan.BooksModuleTests.runTests()
```

Tests `BooksModule` — book deduplication, selection, and API loading logic
(`public/js/modules/books.test.js`).

## Fork Operator Notes

1. Provision a Supabase (or any PostgreSQL) instance and set `DATABASE_URL`
2. Create your own Discord bots (the 4-bot separation is architectural, not cosmetic)
3. Provision a Pinata account for IPFS — or skip it (graceful degradation)
4. The `SESSION_SECRET` in `.env.example` is a placeholder — **change it before production**
5. `NYAN_OUTBOUND_API` and `NYAN_OUTBOUND_API_DEV` gate the internal Nyan API v1 — generate your own random strings (min 32 chars)

---

## License

MIT. Fork freely. Scribe faithfully.

The four fields are load-bearing. Everything else is grammar.

---

*nyan~ ♡ 🜁 ◯*

*Nagarjuna, architect, March 2026*
*18 March 2026 — Nyepi, the Day of Silence*

*Alone is full. Together is the better half.*
