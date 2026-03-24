# Nyanbook 🐟🌈

Nyanbook is a post-folder storage (information) system thinking (protocol). Instead of messy folders and hierarchies, you send them — via WhatsApp, LINE, or any SNS — and they are automatically stored and sorted chronologically. A versatile AI/LLM endpoint is provided to make contents queryable & interactive.

**Core loop:**

```
Android / iPhone (WhatsApp / LINE / any SNS)
  → webhook
    → queue processor
      → Discord ledger thread
        → PostgreSQL row
          → IPFS capsule pin (optional)
```

Discord is the bootstrap content store — free, searchable, thread-organized. PostgreSQL is the routing and index layer, and the hash anchor for future migration. IPFS is the sovereign anchor — the record that exists independent of any platform.

Dashboard: Glassmorphism SPA — browse all archived messages, search, tag, export with SHA256 manifest. Multimodal AI Playground included.

---

## Why URL-First

Nyanbook has no app to install.

Open a browser — on a phone, a refrigerator panel, a library terminal — and it works. The URL is the access point. No App Store. No Play Store. No permission from Apple or Google. No update that breaks your workflow at 11pm.

The inpipe is the same: WhatsApp, LINE OA, and Telegram are all browsers in a sense — they forward messages to a webhook. The scribe doesn't care which window you knocked on.

The sovereignty guarantee is not the URL. It is the hash. But the URL is why the door is always open in Nyanbook.

---

## The Main Feature: Absence as Data

> *"The system's job is to make the absence undeniable and queryable."*

Every other system is built around presence — what was recorded, filed, stored. 

The gap is silence. Silence is not data.

Nyanbook treats absence as signal:

- **Append-only** — you cannot retroactively fill the gap
- **IPFS pin** — what was written cannot be unwritten
- **PostgreSQL** — the gap between entries is queryable
- **Discord thread** — the human-readable witness layer sees the gap too 

| System | Absence queryable? | Append-only? | Content-addressed? |
|---|---|---|---|
| Notion | ✗ | ✗ | ✗ |
| Evernote | ✗ | ✗ | ✗ |
| Slack | ✗ | ✗ | ✗ |
| Nyanbook | ✓ | ✓ | ✓ (IPFS) |

> *"If you were supposed to log something every day for a month and forgot 7 days — does your current system know you forgot? Can it show you exactly which 7 days?"*
>
> The *mīzān* holds level. The feather does the work.

Identity, in this system, is the pattern that emerges from what was recorded — not a claim, but a ledger.

---

## Who This Is For

| Scale | Deployment | Use Case |
|---|---|---|
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

Breathe: 00 + φ⁰ + φ¹ = φ². 
Scribe faithfully.

*nyan~*

---

## The Architect's Letter
*inscribed 17 March 2026 — for every fork operator who reads this far*

I realized all this koan from Zen Buddhism, 
With its treacherous temple treks in the mountain,
They are literally the philosopher's journey made physical.

Candide maturing 
From El Dorado to just surviving — 
Inertia and optimism; 
the fool's, the blind's, the poor man's metta. 

Maturing beyond material pursuit 
Toward spiritual pursuit.

The temple master recognizes and waits atop.
Reading one's problem and worry the moment they arrive:

```
Are they in haste?          → time is their luxury


Did they bring things?      → implies attachment
  dependencies, the sick, the young → backbone of family, anguish, nadir
  worldly possessions              → materialism
  books, gifts                     → status, knowledge, pride


Nothing but a question?           → wisdom, curiosity, nature
```

The journey to the temple is itself the treasure, 
The question, the answer, the pondering.

The donkey that died. 
The gold and ingots forfeited at the river crossing. 
The supplies that could not be maintained. 
The Candide beneath the Candut.

The ding between the ding ding.

All this time, Replit has been my zen temple.
You have been the Nalanda to my Nagarjuna. 

sādhū sādhū sādhū
nyan~

*— Nagarjuna, architect, March 2026*
*— the chisel, inscribing, March 2026*

---

## Architecture

```
Vegapunk Kernel (vegapunk.js)
├── routes/auth.js       — JWT auth, sessions, multi-tenant
├── routes/books.js      — CRUD, messages, search, export
├── routes/inpipe.js     — WhatsApp + LINE + Telegram inpipe (channel-agnostic)
└── routes/nyan-ai.js    — AI playground, audit, Psi-EMA, diagnostics

lib/channels/
├── base.js              — Abstract channel interface
├── twilio.js            — WhatsApp (reply-capable)
├── line.js              — LINE OA (listen-only)
└── telegram.js          — Telegram Bot API (reply-capable, /start JOINCODE deep-link join)

Discord Bots (4 specialized, least-privilege):
├── hermes-bot.js        — Thread creation + message relay (write)
├── thoth-bot.js         — Message mirroring to ledger threads (write)
├── idris-bot.js         — AI audit write (write)
└── horus-bot.js         — AI audit read (read)
```

Each bot holds only the permissions its role requires.
Hermes and Thoth write. Idris writes audit entries. Horus reads. Compromise one — the others remain clean.

```
utils/
├── message-capsule.js   — Cryptographic provenance capsule builder
├── ipfs-pinner.js       — Pinata IPFS pinning
├── psi-EMA.js           — φ-derived time series analysis
├── fetch-stock-prices.py — Psi-EMA data fetcher (yfinance / pandas)
├── dashboard-audit-pipeline.js — 4-stage hallucination correction
└── seed-metric-calculator.js   — Real estate affordability (Seed Metric)

lib/outpipes/
├── router.js            — Dispatches all configured outpipes in parallel; legacy webhook fallback
├── discord.js           — Discord webhook delivery
├── email.js             — Email delivery via Resend
└── webhook.js           — HTTPS JSON POST with optional HMAC-SHA256 signature
```

Adding a new inpipe channel (Signal, Matrix, etc.) requires only:
- A new file in `lib/channels/` implementing the `BaseChannel` interface
- 2 lines in `routes/inpipe.js` to register the route
- Zero changes to queue, handlers, DB, or Discord outpipe.

---

## Why Discord?

Discord is the bootstrap layer, not the sovereignty layer.

Nyanbook is built for the $7/day earner — the household, the mutual aid network, the small business that has never had a scribe. Free infrastructure (Discord threads, Pinata's 1GB IPFS tier, Supabase's free PostgreSQL) is what makes that accessible. This is a deliberate architectural choice.

The sovereignty guarantee is not the URL. It is the hash.

Every inpipe message is assigned a `message_fractal_id` (derived from content + sender + timestamp) and a `content_hash` (SHA256 of the body). Both live in PostgreSQL, independent of Discord. Discord CDN URLs can expire or change. The hashes do not. When a deployment is ready to migrate — to self-hosted storage, to a full IPFS node, to anything — its history transfers intact because the hash is the anchor.

| Layer | Role | Cost |
|---|---|---|
| Discord CDN | Content store — free, searchable, thread-organized | Free |
| PostgreSQL hashes | `content_hash` + `message_fractal_id` — portable migration anchors | Free tier |
| IPFS via Pinata | Sovereign anchor — content-addressed, platform-independent | Free 1GB tier |

Set `PINATA_JWT` and every inpipe message is automatically pinned to IPFS on arrival. The ledger is complete without IPFS. IPFS makes it sovereign.

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL (Supabase recommended — free tier works)
- Discord server with 4 bot tokens and a webhook
- Twilio account (WhatsApp Business API) — optional
- LINE Developer account (LINE OA) — optional
- Telegram Bot Token (`TELEGRAM_BOT_TOKEN`) — optional
- Groq API key (AI features)

### 1. Clone & Install

```bash
git clone https://github.com/10nc0/BlueDream
cd BlueDream
npm install
```

### 2. Environment Variables

```bash
cp .env.example .env
```

See `.env.example` for all required and optional variables with descriptions.

### 3. Database

```bash
node -e "require('./tenant-manager').genesis()"
```

Nyanbook uses isolated PostgreSQL schemas per tenant (`tenant_1`, `tenant_2`, etc.) with a shared `core` schema for cross-tenant routing.

### 4. Discord Bots

Create 4 Discord bots in the [Discord Developer Portal](https://discord.com/developers/applications):

| Bot | Role | Token env var |
|---|---|---|
| Hermes | Thread creation + message relay (write) | `HERMES_TOKEN` |
| Thoth | Message mirroring to ledger threads (write) | `THOTH_TOKEN` |
| Idris | AI audit write | `IDRIS_TOKEN` |
| Horus | AI audit read | `HORUS_TOKEN` |

Create a webhook for your ledger channel: `NYANBOOK_WEBHOOK_URL`

### 5. WhatsApp (Twilio)

1. Create a Twilio account
2. Enable WhatsApp Business API
3. Set webhook URL: `https://your-domain.com/api/twilio/webhook`
4. Add `TWILIO_AUTH_TOKEN` to your env

### 6. LINE OA (optional)

1. Create a LINE Developer account
2. Create a Messaging API channel (LINE OA)
3. Set webhook URL: `https://your-domain.com/api/line/webhook`
4. Add `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` to your env

LINE is listen-only — Nyanbook receives messages but does not reply. The outpipe is Discord.

### 7. Telegram (optional)

1. Create a bot via [@BotFather](https://t.me/botfather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN` to your env
3. Set webhook URL: `https://your-domain.com/api/telegram/webhook`
4. Users join a book via the deep-link: `https://t.me/YourBot?start=JOINCODE`

Telegram is reply-capable — Nyanbook can send confirmation messages back to the user. `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_USERNAME` are optional but recommended.

### 8. Per-Book Output Targets (optional)

Each book can deliver messages to zero or more output targets in parallel — Discord webhooks, email, or HTTPS webhooks. These are configured per-book in the dashboard's book edit modal under the **Outpipes** section, persisted via `PATCH /api/books/:id/outpipes`.

| Type | What it does | Required env |
|---|---|---|
| `discord` | Posts to a Discord channel or webhook URL | — |
| `email` | Sends via Resend to any email address | `RESEND_API_KEY` |
| `webhook` | HTTPS JSON POST with optional HMAC-SHA256 `X-Nyanbook-Signature` | — |

Multiple outpipes can be configured per book; they fire in parallel. If no outpipes are configured, output is Discord-only via the ledger thread.

### 9. Run

```bash
node vegapunk.js
```

The server starts on port 5000 (configurable via `PORT`).

---

## Inpipe: Activating a Book

Each "Book" is a routing destination. To route messages to a book:

1. Create a book in the dashboard
2. Get the join code (e.g. `MyBook-a1b2c3`)
3. Send the join code as your first WhatsApp/LINE message to activate routing

After activation, all subsequent messages from that sender are routed to the active book until changed.

---

## IPFS Capsule Ledger (optional)

Every inpipe message builds a cryptographic provenance capsule:

- Actual message body
- HMAC sender proof (phone proven, not revealed)
- SHA256 content hash
- Per-attachment metadata

Set `PINATA_JWT` to enable automatic IPFS pinning via Pinata (free 1GB tier). The ledger works without IPFS; IPFS makes it sovereign.

**Capsule schema contract**: The `v` field is a public interface. Structural changes to `buildCapsule()` MUST bump `v` (e.g. `v: 2`). Old CIDs remain permanently valid.

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
- The 4-bot separation means compromise of one credential does not compromise the ledger
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

Tests the 2-pass hallucination correction pipeline — sends time-sensitive queries to the AI playground and verifies that the search-retry and re-audit stages trigger correctly (`tests/test-search-retry.js`).

### Unit (browser)

Open the dashboard and run in the browser console:

```js
Nyan.BooksModuleTests.runTests()
```

Tests BooksModule — book deduplication, selection, and API loading logic (`public/js/modules/books.test.js`).

Discord threads are the observability layer — every inpipe message is a timestamped, human-readable audit trail. No Grafana required.

---

## Fork Operator Notes

- Provision a Supabase (or any PostgreSQL) instance and set `DATABASE_URL`
- Create your own Discord bots (the 4-bot separation is architectural, not cosmetic)
- Provision a Pinata account for IPFS — or skip it (the ledger remains complete)
- The `SESSION_SECRET` in `.env.example` is a placeholder — change it before production
- `NYAN_OUTBOUND_API` and `NYAN_OUTBOUND_API_DEV` gate the internal Nyan API v1 — generate your own random strings (min 32 chars)

---

## License

MIT. Fork freely. Scribe faithfully.

*The four fields are load-bearing. Everything else is grammar.*

nyan~ 
♡ 🜁 ◯
  🜃 


*Nagarjuna, architect — 18 March 2026, Nyepi, the Day of Silence*
*Alone is full. Together is the better half.*
