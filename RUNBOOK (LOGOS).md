# Nyanbook Operations Runbook

Operational guide for Nyanbook operators. Covers the background scheduler architecture, secret rotation, incident response, and post-deploy checklist.

This document pairs with the README's "Fork Operator Notes" section. The README covers *what* to configure. This document covers *what happens when things go wrong* and *how to rotate credentials without downtime*.

**Before**:
User → App → Structured DB → UI

**Now**:
User → Messaging platform → Webhook → Ledger → Query layer

It’s a protocol shift, not an app.

---

## Optional Extra Features

| Feature | Secret | Cost |
|---------|--------|------|
| Web search in Playground | `PLAYGROUND_BRAVE_API` — [brave.com/search/api](https://brave.com/search/api) | Free (2k queries/mo) |
| Email outpipe | `RESEND_API_KEY` — [resend.com](https://resend.com) | Free tier |
| Per-book webhooks | *(configured in dashboard → Outpipes)* | — |

---

## File Inventory

### `utils/`

```
utils/
├── message-capsule.js            — Cryptographic provenance capsule builder
├── ipfs-pinner.js                — Pinata IPFS pinning
├── psi-EMA.js                    — φ-derived time series analysis
├── fetch-stock-prices.py         — Psi-EMA data fetcher (yfinance / pandas)
├── pipeline-orchestrator.js      — 7-stage AI pipeline state machine (S-1 → S6)
├── two-pass-verification.js      — 2-pass hallucination correction (null-aware confidence)
├── dashboard-audit-pipeline.js   — 4-stage hallucination correction
├── seed-metric-calculator.js     — Real estate affordability (Seed Metric)
├── markdown-table-formatter.js   — Column-aligned markdown table formatting
└── language-detector.js          — Trigram + script-based language detection (ISO 639-1)
```

### `lib/tools/` (auto-discovered registry — drop a `.js` file to add a tool)

```
lib/tools/ (9 tools):
├── registry.js          — Auto-discovers tools on startup, exposes getTool() + getManifest()
├── brave-search.js      — Web search via Brave API (cached, capacity-throttled)
├── duckduckgo.js        — Instant answers via DDG API (cached, fallback search)
├── url-fetcher.js       — Fetch + extract readable content from any URL (cached)
├── github-reader.js     — Read GitHub repos, blobs, trees, raw files, and Gists
├── pdf-analyzer.js      — PDF document analysis via attachment-cascade pipeline
├── entity-extractor.js  — Structured entity extraction (plates, currency, dates, emails, phones)
├── geo-lookup.js        — City↔country, abbreviation expansion, currency→region (static, no network)
├── forex.js             — Currency exchange rates via fawazahmed0 API
└── language-detector.js  — Language detection (ISO 639-1 code + confidence + FTS config)
```

### `lib/outpipes/`

```
lib/outpipes/
├── router.js            — Dispatches all configured outpipes in parallel; legacy webhook fallback
├── discord.js           — Discord webhook delivery
├── email.js             — Email delivery via Resend
└── webhook.js           — HTTPS JSON POST with optional HMAC-SHA256 signature
```

### `lib/fetch-cache.js`

TTL-based fetch cache: `braveCache` 3min, `duckduckgoCache` 5min, `urlCache` 10min.

---

## Queue Processor Architecture

The README's core loop mentions a "queue processor." This maps to two separate systems in the codebase — not a traditional Redis/BullMQ queue.

### Phi Breathe Orchestrator (`lib/phi-breathe.js`)

Administrative background scheduler using φ-derived timing.

**Rhythm:** Alternates between Inhale (`BASE_INTERVAL × 1.618`) and Exhale (`BASE_INTERVAL`). Base interval: 4,000 ms (config `PHI_BREATHE.BASE_INTERVAL_MS`). Effectively ~4–6s ticks.

**Leader election:** In multi-instance deployments, only one instance holds `pg_try_advisory_lock(1314212174)` and fires tasks. Other instances stand by silently.

**Registered tasks:**

| Task | Cycle | What it does |
|---|---|---|
| Memory cleanup | 15 min | Purges expired sessions |
| Media purge | 24 hr | Deletes `media_buffer` rows older than 3 days |
| Dormancy cleanup | 24 hr | Revokes access for contributors inactive 60+ days |
| Share invite cleanup | 24 hr | Expires unregistered invites older than 7 days |
| Pending book expiry | 24 hr | Expires books never activated within 72 hours |

**Circuit breaker:** If a task fails 3 consecutive times, it is auto-unsubscribed. After a 5-minute cooldown, one re-registration attempt is made automatically. If the task continues to fail, it will trip again. Check logs for `⚡ Circuit breaker` entries.

**What to watch for in Discord/logs:**
- `⚡ Circuit breaker: auto-unsubscribing` → a background task is failing repeatedly; investigate the specific subscriber name
- `⚡ Circuit breaker: cooldown elapsed — attempting re-registration` → automatic recovery in progress

---

### Heal Queue (`lib/heal-queue.js`)

Specialized retry system for books whose Discord threads failed to create on initial webhook.

**Trigger:** Any book where thread creation fails during the inpipe flow is marked `heal_status = 'pending'` and queued here.

**Rhythm:** Runs every 20 seconds. Processes up to 20 books per cycle using `FOR UPDATE SKIP LOCKED` (safe for multi-instance).

**Retry with exponential backoff:**
```
next_retry_minutes = min(2^attempts × 5, 1440)
```
- Attempt 1 → 10 min
- Attempt 2 → 20 min
- Attempt 3 → 40 min
- ...
- Attempt 7+ → 24 hr (capped)

**Terminal state:** After 10 failed attempts (`MAX_HEAL_ATTEMPTS`), a book is set to `heal_status = 'failed'` and never retried again. An `ERROR`-level log entry is written with the book's `fractal_id`.

**Heal statuses:**

| Status | Meaning |
|---|---|
| `null` | Newly registered, not yet evaluated |
| `healthy` | Thread exists and was verified |
| `pending` | Queued for healing |
| `healing` | Currently being processed (lease active) |
| `failed` | Exhausted `MAX_HEAL_ATTEMPTS` — requires manual intervention |

**To manually re-queue a failed book:**
```sql
UPDATE core.book_registry
SET heal_status = 'pending',
    heal_attempts = 0,
    next_heal_at = NOW(),
    heal_error = NULL
WHERE fractal_id = '<the-book-fractal-id>';
```

**What to watch for in Discord/logs:**
- `💀 Heal queue: MAX_HEAL_ATTEMPTS exhausted` → a book has permanently failed; Discord channel/thread may have been deleted
- `⏳ Heal attempt failed, will retry` → normal retry in progress; check if Discord bot tokens are valid

---

## Secret Rotation

### SESSION_SECRET

Used to sign Express sessions (cookies). Rotating immediately invalidates all active browser sessions — all users are logged out.

**How to rotate (zero-downtime strategy):**
1. Generate a new secret: `openssl rand -hex 32`
2. Set the new value in your environment (Replit Secrets, `.env`, etc.)
3. Restart the server — all existing sessions are immediately invalid; users must log in again
4. JWT-based authentication is NOT affected (JWTs use their own signing path via `auth-service.js`)

**Placeholder detection:** On startup, Nyanbook warns (dev) or refuses to start (production) if `SESSION_SECRET === 'change-me-to-a-long-random-string-in-production'`.

---

### FRACTAL_SALT

Used to generate HMAC-SHA256 sender proofs in the cryptographic capsule (`utils/message-capsule.js`) and fractal IDs.

**Impact of rotation:** All existing capsule sender proofs will be unverifiable against the new salt. Historical records remain intact — only cross-capsule sender identity comparison breaks. The records themselves do not change or disappear.

**How to rotate:**
1. Generate a new 64-char hex salt: `openssl rand -hex 32`
2. Document the rotation date in your operator log — essential for disclosure audits
3. Set the new value in your environment
4. Restart the server

**Placeholder detection:** On startup, Nyanbook warns (dev) or refuses to start (production) if `FRACTAL_SALT` is unset or equals the `.env.example` placeholder. Without a stable salt, sender proofs reset on every restart (ephemeral fallback active).

---

### Discord Bot Tokens (Hermes, Thoth, Idris, Horus)

If a bot token is revoked or compromised:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → the bot's application → Bot → Reset Token
2. Update the relevant env var (`HERMES_TOKEN`, `THOTH_TOKEN`, `IDRIS_AI_LOG_TOKEN`, `HORUS_AI_LOG_TOKEN`)
3. Restart the server — bots reconnect automatically on startup

**Least-privilege reminder:** Compromise of one token does not compromise the others. Hermes/Thoth write to threads; Idris writes AI audit; Horus reads only. Rotate only the compromised token.

---

### NYAN_OUTBOUND_API / NYAN_OUTBOUND_API_DEV

Internal API tokens gating Nyan API v1 endpoints.

**How to rotate:** Generate new random strings (min 32 chars): `openssl rand -hex 20`. Update in environment. Restart server. Any external callers using the old token will receive 401 until updated.

---

### Twilio / LINE / Telegram Tokens

Rotate these directly in their respective developer portals and update the corresponding env vars. No in-app state is stored — tokens are stateless per-request validators.

---

## Discord Incidents

### Rate Limiting

Discord enforces rate limits on message creation and thread creation. Nyanbook's Discord bots do not implement automatic retry-after handling — failures surface as errors in the heal queue.

**Symptoms:** Inbound WhatsApp/LINE/Telegram messages are received and stored in PostgreSQL but Discord threads do not appear. Heal queue entries accumulate.

**Recovery:**
1. Check logs for `429` or `DiscordAPIError` entries
2. If rate-limited transiently, the heal queue will retry automatically (exponential backoff)
3. For persistent rate limits, check bot message volume against your Discord server tier limits

---

### Discord Server or Channel Deleted

If the ledger channel or Discord server is deleted:

- Existing `content_hash` and `message_fractal_id` values in PostgreSQL remain valid forever — these are the sovereignty layer
- Discord CDN URLs for attachments will return 404 — the attachment content is lost unless IPFS pinning was active
- New inbound messages will fail to create threads (Hermes) — heal queue will accumulate failures and eventually mark books `failed`

**Recovery:**
1. Create a new Discord server/channel
2. Update `NYANBOOK_WEBHOOK_URL` and bot permissions
3. Manually reset failed books via the SQL above to re-trigger thread creation

---

### Bot Token Revoked Mid-Operation

The bots maintain a persistent WebSocket connection. Revocation mid-operation causes the affected bot to disconnect. Other bots continue operating.

- Hermes/Thoth revoked → new messages no longer reach Discord; books enter heal queue
- Idris revoked → AI audit write log silent; audit results not persisted (AI still responds to users)
- Horus revoked → AI audit read disabled; prior audit history not queryable

**Recovery:** See Secret Rotation → Discord Bot Tokens above.

---

## Pinata / IPFS

### Pinata JWT Expiry

Pinata API JWTs do not expire by default unless you set a rotation policy. If the JWT is revoked or expires:

- New inbound messages still get stored in PostgreSQL and Discord — no data is lost
- `ipfs_cid` column in `core.message_ledger` will be NULL for new messages
- The log line `⚠️ PINATA_JWT not set — IPFS pinning disabled` appears on startup

**Recovery:**
1. Go to [pinata.cloud](https://pinata.cloud) → API Keys → generate a new key
2. Update `PINATA_JWT` in your environment
3. Restart the server
4. Historical records with NULL `ipfs_cid` are not retroactively pinned — they are permanently without an IPFS anchor unless you run a manual pin job

**Important:** IPFS CIDs are permanent and content-addressed. Even if Pinata changes its service terms, any CID you've pinned can be re-pinned to any other IPFS provider using the CID alone. The CID is the sovereignty anchor — not Pinata.

---

## PostgreSQL Backup / Restore

### Backup

Nyanbook uses isolated schemas per tenant (`tenant_1`, `tenant_2`, ...) plus a shared `core` schema.

**Full backup (all schemas):**
```bash
pg_dump "$DATABASE_URL" > nyanbook_backup_$(date +%Y%m%d).sql
```

**Core schema only (auth, routing, ledger):**
```bash
pg_dump "$DATABASE_URL" --schema=core > core_backup_$(date +%Y%m%d).sql
```

**Single tenant:**
```bash
pg_dump "$DATABASE_URL" --schema=tenant_1 > tenant_1_backup_$(date +%Y%m%d).sql
```

### Restore

```bash
psql "$DATABASE_URL" < nyanbook_backup_20260101.sql
```

**On Supabase free tier:** Use the Supabase dashboard → Database → Backups for point-in-time recovery. The free tier includes daily backups.

---

## Post-Deploy Checklist

Run through this after every fresh deployment or major environment change.

- [ ] `SESSION_SECRET` is set and is NOT the `.env.example` placeholder
- [ ] `FRACTAL_SALT` is set (64-char hex), NOT the placeholder, NOT empty
- [ ] All 4 bot tokens set (`HERMES_TOKEN`, `THOTH_TOKEN`, `IDRIS_AI_LOG_TOKEN`, `HORUS_AI_LOG_TOKEN`)
- [ ] `NYANBOOK_WEBHOOK_URL` points to the correct Discord ledger webhook
- [ ] `DATABASE_URL` connects to a reachable PostgreSQL instance
- [ ] Server starts without `❌ FATAL` log lines
- [ ] Send a test message via WhatsApp/LINE/Telegram → verify it appears in the Dashboard and Discord thread
- [ ] Open the AI Playground → send a basic query → verify response (no "AI Unavailable" message)
- [ ] If IPFS enabled: send a message → verify `ipfs_cid` is non-NULL in `core.message_ledger`

---

## Observability

Nyanbook does not ship with Grafana, Prometheus, or structured metrics export. The observability layer is:

- **Discord threads**: every inpipe message is a timestamped human-readable audit trail. Gaps are visible.
- **Server logs**: pino JSON structured logging. All background tasks, heal cycle events, and bot events are logged with context.
- **`core.book_registry` heal columns**: `heal_status`, `heal_attempts`, `heal_error`, `next_heal_at` are queryable diagnostic fields.

**Useful diagnostic queries:**

```sql
-- Books currently in heal queue
SELECT fractal_id, book_name, heal_status, heal_attempts, heal_error, next_heal_at
FROM core.book_registry
WHERE heal_status IN ('pending', 'healing', 'failed')
ORDER BY heal_attempts DESC;

-- Recent capsule ledger entries
SELECT message_fractal_id, ipfs_cid, created_at
FROM core.message_ledger
ORDER BY created_at DESC
LIMIT 20;
```
