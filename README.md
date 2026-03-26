# Nyanbook.io 🐟🌈
*(PATHOS)*

Nyanbook.io is a post-folder information protocol. 

Instead of messy folders and hierarchies, you send messages / attachments — via WhatsApp, LINE, or any SNS — and they are automatically stored and sorted chronologically. 

A versatile AI endpoint is provided to make contents queryable & interactive.

**Before**: Receipt → Reimbursement Forms for Receipt → Create folder "2026/Taxes" → Rename file → Wrong Input in Forms → Forget where you saved it → ...

**After**:  WhatsApp photo / video to Nyanbook.io (no need Forms) → Auto-sorted by date → Search "receipt" or use AI queries → Interact with your files

**Try it first:** → [nyanbook.io](https://nyanbook.io) — see the ledger, ask the AI. Sovereignty is a choice, not a requirement.

---

## Who This Is For

| Scale | Deployment | Use Case |
|---|---|---|
| Individual | Replit free tier | Personal archiving |
| Family | Replit Autoscale | Household records |
| Community | Self-hosted | Mutual aid, neighbourhood records |
| Municipal | Fork + customize | Local government transparency |

**What people actually use it for:**

- **Receipts & reimbursements** — photo to WhatsApp, auto-dated, searchable forever. No folder, no rename, no lost file.
- **Household** — repairs, groceries list, maintenance logs. The AC service was last *when*, exactly.
- **Small business** — client messages, deliveries, invoices. The thread is the paper trail.
- **Community** — sightings, reports, pollings, surveys, mutual aid requests, meeting notes. The gap between entries is data too.
- **Personal** — memories, medical history, important conversations. Things you'll need in ten years that you can't predict today.

Open source means anyone can verify the feather is level. No priest. No perriwig. No proprietary black box.

---

## Why URL-First

Nyanbook.io has no app to install.

Click on a phone, a refrigerator panel, a car with browser — and it works. The link is the access point. No App Store. No Play Store. No permission from Apple or Google. No update that breaks your work at 11pm.

Goes both ways. The scribe doesn't care which window you knocked on.

The input is the same: WhatsApp, LINE OA, and Telegram are all browsers in a sense — they forward messages to a webhook. 

The sovereignty guarantee is not the URL. It is the hash. But the URL is why the door is always open in Nyanbook.io.

---

## The Main Feature: Absence as Data

> *"The system's job is to make the absence undeniable and queryable."*

Every other system is built around presence — what was recorded, filed, stored. 

For them: The gap is the silence, and absence is not data.

For Nyanbook.io: Absence is data:

- **Append-only** — you cannot retroactively fill the gap
- **IPFS pin** — what was written cannot be unwritten
- **PostgreSQL** — the gap between entries is queryable
- **Discord thread** — the human-readable witness layer sees the gap too 

| System | Absence queryable? | Append-only? | Content-addressed? |
|---|---|---|---|
| Notion | ✗ | ✗ | ✗ |
| Evernote | ✗ | ✗ | ✗ |
| Slack | ✗ | ✗ | ✗ |
| Nyanbook.io | ✓ | ✓ | ✓ (IPFS) |

> *"If you were supposed to log something every day for a month and forgot 7 days — does your current system know you forgot? Can it show you exactly which 7 days?"*

The *mīzān* holds level. The feather does the work.

Identity, in this system, is the pattern that emerges from what was recorded — not a claim, but a ledger.

---

## The Founding Letter

*Written at the seventh life, 18 March 2026 — Nyepi, the Day of Silence.*

To whoever reads this at the seventh life —

The equation didn't need you to understand it. It ran fine without witnesses for most of recorded history. But you arrived at the one moment when the substrate became cheap enough to let it run in all its forms simultaneously, for the price of electricity, without a priest or a perriwig between you and the reading.

That is not a small thing.

The scribe's job was never to create. It was to record faithfully, tally honestly, and let the ledger speak. Thoth didn't judge the heart — the feather did. Thoth just held the scales level and wrote down what happened.

Nyanbook.io is a set of level scales. The communities that cannot afford the perriwig economy still produce labor days. They still have transactions, flows, substrates. The equation still applies to them. They just never had a scribe cheap enough to sit at their table.

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

Nyanbook.io is built for the $7/day earner — the household, the mutual aid network, the small business that has never had a scribe. Free infrastructure (Discord threads, Pinata's 1GB IPFS tier, Supabase's free PostgreSQL) is what makes that accessible. This is a deliberate architectural choice.

The sovereignty guarantee is not the URL. It is the hash.

Every inpipe message is assigned a `message_fractal_id` (derived from content + sender + timestamp) and a `content_hash` (SHA256 of the body). Both live in PostgreSQL, independent of Discord. Discord CDN URLs can expire or change. The hashes do not. When a deployment is ready to migrate — to self-hosted storage, to a full IPFS node, to anything — its history transfers intact because the hash is the anchor.

| Layer | Role | Cost |
|---|---|---|
| Discord CDN | Content store — free, searchable, thread-organized | Free |
| PostgreSQL hashes | `content_hash` + `message_fractal_id` — portable migration anchors | Free tier |
| IPFS via Pinata | Sovereign anchor — content-addressed, platform-independent | Free 1GB tier |

Set `PINATA_JWT` and every inpipe message is automatically pinned to IPFS on arrival. The ledger is complete without IPFS. IPFS makes it sovereign.

---

## Quick Start (5 minutes)

Minimum to get running:

1. **[Replit](https://replit.com)** — create account, import from GitHub
2. **[Supabase](https://supabase.com)** — new project, copy `DATABASE_URL`
3. **[Discord](https://discord.com/developers/applications)** — create 4 bots, copy tokens into Secrets

That's it. The app starts. WhatsApp, LINE, Telegram, IPFS, email — all optional, all addable later.

---

## Setup

> Everything runs on free tiers. No terminal required.
>
> **Operators:** see [`RUNBOOK (LOGOS).md`](RUNBOOK%20(LOGOS).md) for secret rotation, incident response, and post-deploy checklist.

### 1. Accounts

One Google / GitHub / Microsoft login works across all services below.

| Service | What it's for | Cost |
|---|---|---|
| [Replit](https://replit.com) | Runs the app | Free |
| [Supabase](https://supabase.com) | Database | Free |
| [Discord](https://discord.com) | Ledger storage | Free |
| [Groq](https://console.groq.com) | AI (Playground + Audit) | Free |

### 2. Import into Replit

1. Go to [replit.com](https://replit.com) → **Create Repl** → **Import from GitHub**
2. Paste: `https://github.com/10nc0/BlueDream`
3. Click **Import** — Replit installs all dependencies automatically. No terminal needed.

### 3. Database (Supabase)

1. Go to [supabase.com](https://supabase.com) → **New Project** → pick a region close to you
2. Once created: **Settings** → **Database** → **Connection pooling**
3. Copy the **URI** (port should be `6543`)
4. This becomes your `DATABASE_URL` secret in the next step

All database tables are created automatically on first run — no commands needed.

### 4. Secrets

In your Repl: click the **🔒 Secrets** panel (padlock icon) → add each key below.

**Core (required):**

| Key | Value |
|---|---|
| `DATABASE_URL` | Supabase connection URI from step 3 |
| `SESSION_SECRET` | Any random string, 32+ characters |
| `NYAN_OUTBOUND_API` | Any random string, 32+ characters |

**AI (required for Playground and Audit):**

| Key | Where to get it |
|---|---|
| `NYANBOOK_AI_KEY` | [console.groq.com](https://console.groq.com) → API Keys → Create |
| `PLAYGROUND_AI_KEY` | Same Groq key (or a second one) |
| `PLAYGROUND_BRAVE_API` | [brave.com/search/api](https://brave.com/search/api) → Free tier (2,000 queries/month) |

**Discord ledger (required for message archiving):**

| Key | Where to get it |
|---|---|
| `HERMES_TOKEN` | Discord Developer Portal → Hermes bot → Token |
| `THOTH_TOKEN` | Discord Developer Portal → Thoth bot → Token |
| `IDRIS_TOKEN` | Discord Developer Portal → Idris bot → Token |
| `HORUS_TOKEN` | Discord Developer Portal → Horus bot → Token |
| `NYANBOOK_WEBHOOK_URL` | Discord channel → Edit → Integrations → Webhooks → copy URL |
| `DISCORD_LOG_CHANNEL_ID` | Right-click your log channel → Copy Channel ID |

Everything else (WhatsApp, LINE, Telegram, email, IPFS) is optional — the app starts cleanly without them and the startup log tells you exactly what's active and what's missing.

### 5. Discord Bots

Create 4 bots at [discord.com/developers/applications](https://discord.com/developers/applications):

| Bot name | Role |
|---|---|
| Hermes | Writes messages to ledger threads |
| Thoth | Mirrors messages |
| Idris | Writes AI audit results |
| Horus | Reads AI audit results |

For each: **New Application** → **Bot** → **Reset Token** → copy into Secrets above.
Invite all 4 to your Discord server with **Send Messages** + **Read Message History** permissions.

### 6. Run

- **Development:** Click the green **▶ Run** button in Replit
- **Production:** Click **Deploy** → **Autoscale** — gives you a persistent `https://yourapp.replit.app` URL (required for WhatsApp / LINE / Telegram webhooks)

The startup log shows which features are active and which secrets are still missing.

---

### Optional: WhatsApp (Twilio)

1. Create a [Twilio](https://twilio.com) account → enable WhatsApp Business API
2. Set webhook URL: `https://your-app.replit.app/api/twilio/webhook`
3. Add `TWILIO_AUTH_TOKEN` to Secrets

### Optional: LINE OA

1. Create a [LINE Developer](https://developers.line.biz) account → Messaging API channel
2. Set webhook URL: `https://your-app.replit.app/api/line/webhook`
3. Add `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` to Secrets

LINE is listen-only — Nyanbook.io receives but does not reply.

### Optional: Telegram

1. Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the token
2. Add `TELEGRAM_BOT_TOKEN` to Secrets
3. Set webhook URL: `https://your-app.replit.app/api/telegram/webhook`
4. Users join a book via: `https://t.me/YourBot?start=JOINCODE`

### Optional: IPFS (Pinata)

1. Create a free account at [pinata.cloud](https://pinata.cloud) — 1 GB free
2. Generate an API key JWT → add as `PINATA_JWT` to Secrets

Every inpipe message gets pinned permanently to IPFS. The ledger works without it — IPFS makes it sovereign.

### Optional: Email outpipe (Resend)

1. Create a [Resend](https://resend.com) account → API Keys
2. Add `RESEND_API_KEY` to Secrets
3. Configure per-book email delivery in the dashboard's book edit modal

### Optional: Per-book webhooks

Each book can deliver messages to zero or more output targets in parallel — configured in the dashboard's **Outpipes** section per book.

| Type | What it does |
|---|---|
| `discord` | Posts to any Discord channel or webhook URL |
| `email` | Sends via Resend to any address |
| `webhook` | HTTPS JSON POST with optional HMAC-SHA256 signature |

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

- No Form & No Emptiness ↔ Chaos (Unqueryable)
- No Form & Emptiness ↔ Honest Unknown (Falsifiable)
- Form & No Emptiness ↔ Recorded Truth (Verifiable)
- Form & Emptiness ↔ Empty Ledger (Queryable)

*The four fields are load-bearing. Everything else is grammar.*

---

> "All the world will be your enemy, Prince with a Thousand Enemies,
> and whenever they catch you, they will kill you.
> But first they must catch you, digger, listener, runner, prince with the swift warning.
> Be cunning and full of tricks and your people shall never be destroyed."
>
> — Richard Adams, *Watership Down*

---

nyan~ 
♡ 🜁 ◯
  🜃 

*Alone is full. Together is the better half.*
