# Nyanbook Operations Runbook

Pairs with the README (pathos — *what to configure*) and LINEAGE (ethos — *why it exists*). This document is logos: *how it works, and what to do when it doesn't*.

**Before**: User → App → Structured DB → UI

**Now**: User → Messaging platform → Webhook → Ledger → Query layer

It's a protocol shift, not an app.

---

## Post-Deploy Checklist

Run after every fresh deployment or major environment change.

- [ ] `SESSION_SECRET` set, NOT the `.env.example` placeholder
- [ ] `FRACTAL_SALT` set (64-char hex), NOT placeholder, NOT empty
- [ ] All 4 bot tokens set (`HERMES_TOKEN`, `THOTH_TOKEN`, `IDRIS_AI_LOG_TOKEN`, `HORUS_AI_LOG_TOKEN`)
- [ ] `NYANBOOK_WEBHOOK_URL` → correct Discord ledger webhook
- [ ] `DATABASE_URL` → reachable PostgreSQL instance
- [ ] Server starts without `❌ FATAL` log lines
- [ ] Send a test message (WhatsApp/LINE/Telegram) → appears in Dashboard + Discord thread
- [ ] AI Playground → basic query → no "AI Unavailable" error
- [ ] If IPFS enabled: verify `ipfs_cid` is non-NULL in `core.message_ledger`

---

## Optional Features

| Feature | Secret / Config | Cost |
|---------|----------------|------|
| Web search in Playground | `PLAYGROUND_BRAVE_API` — [brave.com/search/api](https://brave.com/search/api) | Free (2k queries/mo) |
| Email outpipe | `RESEND_API_KEY` — [resend.com](https://resend.com) | Free tier |
| IPFS pinning | `PINATA_JWT` — [pinata.cloud](https://pinata.cloud) | Free tier |
| Semantic search (cascade tier 3) | `EXA_API_KEY` — [exa.ai](https://exa.ai) | Free (1k/mo) |
| Firecrawl source enrichment | `FIRECRAWL_API_KEY` — [firecrawl.dev](https://firecrawl.dev) | Free (500/mo) |
| LLM failover (Groq → OpenRouter) | `OPENROUTER_API_KEY` — [openrouter.ai](https://openrouter.ai) | Free account |
| Per-book webhooks | Dashboard → Edit Book → Outpipes | — |
| HTTP Token | Dashboard → Edit Book → HTTP Token | — |

**When infrastructure approaches a paid tier, fork rather than upgrade.**

A Nyanbook node is stateless by design — the durable record lives in IPFS and Discord, not the database. When Supabase storage approaches its free limit (~500K messages), the lowest-cost path is:

1. Fork a new BlueDream instance (new Replit, fresh Supabase free DB)
2. Keep the old node running at minimal cost (Autoscale scales to zero when idle)
3. Update DNS / webhook URLs to point to the new node
4. Reference the old node's URL in the new node's config as a peer archive

The old node becomes a read-only archive. Provenance is unbroken — IPFS CIDs and Discord threads are permanent and independent of any node lifecycle. The only continuity gap is cross-boundary AI audit queries, which would need to query both nodes separately. That is an acceptable trade-off given the cost savings (per month subscription paid for just storage).

_The fractal self-references. The ledger outlives the node._

### HTTP Token — Anatta Node Mesh

Lets external agents, peer nodes, or any HTTP client read a single book's messages via bearer token. Auth is **per-tenant per-book** — a token for Book A cannot read Book B, even within the same tenant.

Read source is **PostgreSQL** (`anatta_messages` table, tenant schema). No Discord bot required for reads.

**Setup:** Dashboard → Edit Book → HTTP Token → Generate Token. Copy immediately; only the SHA-256 hash is stored.

**Endpoint:**

```
GET /api/webhook/:fractalId/messages
Authorization: Bearer <agent_token>
```

| Param | Type | Description |
|-------|------|-------------|
| `after` | ISO 8601 | Cursor — messages recorded after this timestamp |
| `before` | ISO 8601 | Cursor — messages recorded before this timestamp (mutually exclusive with `after`) |
| `limit` | int | 1–100 (default 50) |

Discord snowflake cursors (17–20 digit integers) return 400 with a migration message.

**Response shape:**

```json
{
  "book": "book-name",
  "_meta": {
    "source": "postgresql",
    "media_note": "media_ipfs_cid is verifiable against content_hash in core.message_ledger. media_ipfs_gateway_url is a convenience URL for direct access. media_url is a Discord CDN URL and may expire."
  },
  "messages": [
    {
      "id": 1,
      "message_fractal_id": "msg_...",
      "sender": "phone-or-name",
      "text": "...",
      "timestamp": "2026-01-01T00:00:00.000Z",
      "has_media": false,
      "media_ipfs_cid": "Qm...",
      "media_ipfs_gateway_url": "https://gateway.pinata.cloud/ipfs/Qm...",
      "media_url": "https://cdn.discordapp.com/..."
    }
  ],
  "total": 1,
  "hasMore": false,
  "cursor": { "newest": "2026-01-01T00:00:00.000Z", "oldest": "2026-01-01T00:00:00.000Z" }
}
```

**Trust levels:** `media_ipfs_cid` is sovereign — verify against `content_hash` in `core.message_ledger`. `media_url` is ephemeral — Discord CDN, may expire. `media_ipfs_gateway_url` is a convenience link, trust level follows `media_ipfs_cid`.

Rate limit: 60 req/min per IP.

**Token lifecycle:**

| Action | Method | Route |
|--------|--------|-------|
| Check | GET | `/api/books/:fractalId/agent-token` |
| Generate / rotate | POST | `/api/books/:fractalId/agent-token` |
| Revoke | DELETE | `/api/books/:fractalId/agent-token` |

> Route paths retain `/agent-token` for backward compatibility with existing integrations.

Rotate replaces the hash in-place — old token dies instantly. Revoke sets hash to NULL; read endpoint returns 403 until a new token is generated. Token: 32 random bytes (base64url), UNIQUE index per tenant schema, timing-safe comparison.

---

## Secret Rotation

All secrets follow the same pattern: generate → set in environment → restart. Specifics below.

### SESSION_SECRET

Signs Express session cookies. Rotation invalidates all browser sessions (users must re-login). JWT auth is unaffected.

```bash
openssl rand -hex 32
```

Startup refuses to start (production) or warns (dev) if set to the `.env.example` placeholder.

### FRACTAL_SALT

Generates HMAC-SHA256 sender proofs in capsules and fractal IDs. Rotation breaks cross-capsule sender identity comparison — historical records stay intact, but you can't prove "same sender" across the salt boundary. Document the rotation date for disclosure audits.

```bash
openssl rand -hex 32
```

Same placeholder detection as `SESSION_SECRET`.

### Discord Bot Tokens

[Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token → update env var → restart.

Tokens are isolated per bot. Compromise of one doesn't affect the others:

| Bot | Env Var | Impact if revoked |
|-----|---------|-------------------|
| Hermes | `HERMES_TOKEN` | New threads stop; books enter heal queue |
| Thoth | `THOTH_TOKEN` | Message mirroring stops |
| Idris | `IDRIS_AI_LOG_TOKEN` | AI audit writes go silent (AI still works) |
| Horus | `HORUS_AI_LOG_TOKEN` | Audit read/history disabled |

### NYAN_OUTBOUND_API / NYAN_OUTBOUND_API_DEV

Internal API tokens for Nyan API v1. Generate: `openssl rand -hex 20`. External callers get 401 until updated.

### Twilio / LINE / Telegram

Rotate in their respective developer portals and update env vars. Stateless per-request validators — no in-app state.

---

## Background Systems

The README mentions a "queue processor." It maps to three separate systems — not a traditional job queue.

### Phi Breathe (`lib/phi-breathe.js`)

Background scheduler with φ-derived timing. Alternates Inhale (base × 1.618) and Exhale (base) cycles at ~4–6s ticks.

**Leader election:** `pg_try_advisory_lock(1314212174)` — only one instance fires tasks in multi-instance setups.

| Task | Cycle | Purpose |
|------|-------|---------|
| Memory cleanup | 15 min | Purge expired sessions |
| Media purge | 24 hr | Delete `media_buffer` rows older than 3 days |
| Dormancy cleanup | 24 hr | Revoke inactive contributors (60+ days) |
| Share invite cleanup | 24 hr | Expire unregistered invites (7+ days) |
| Pending book expiry | 24 hr | Expire books never activated within 72 hours |

**Circuit breaker:** 3 consecutive failures → auto-unsubscribe → 5-min cooldown → one re-registration attempt. Watch for `⚡ Circuit breaker` in logs.

### Heal Queue (`lib/heal-queue.js`)

Retries books whose Discord thread creation failed. Runs every 20s, processes up to 20 books per cycle (`FOR UPDATE SKIP LOCKED`).

**Backoff:** `min(2^attempts × 5, 1440)` minutes. Caps at 24hr after attempt 7. Terminal after 10 attempts → `heal_status = 'failed'`.

| Status | Meaning |
|--------|---------|
| `null` | New, not evaluated |
| `healthy` | Thread verified |
| `pending` | Queued for retry |
| `healing` | Lease active |
| `failed` | Exhausted retries — manual intervention needed |

**Re-queue a failed book:**
```sql
UPDATE core.book_registry
SET heal_status = 'pending', heal_attempts = 0,
    next_heal_at = NOW(), heal_error = NULL
WHERE fractal_id = '<fractal-id>';
```

**Log signals:**
- `💀 Heal queue: MAX_HEAL_ATTEMPTS exhausted` → permanent failure; check if Discord channel still exists
- `⏳ Heal attempt failed, will retry` → normal; verify bot tokens if persistent

### Message Queue (`lib/packet-queue.js` → `core.message_queue`)

Durable inbound message queue. Every inbound message (WhatsApp, LINE, Telegram, email, agent write) is atomically enqueued before the webhook ACKs. A single continuous async loop dequeues and dispatches — no polling interval.

| Property | Value |
|---|---|
| Table | `core.message_queue` |
| Priority | `media` before `text` per `ORDER BY priority, created_at` |
| Dequeue | `FOR UPDATE SKIP LOCKED` — crash-safe, no duplicate processing |
| Retry | Up to 3 attempts; `last_error` stored on row at failure |
| Gap | 500ms normal / 200ms burst (queue depth > 5) |
| Consumers | `routes/pipe.js` only — agent write path included |

**Re-queue failed messages:**
```sql
UPDATE core.message_queue SET status = 'pending', retry_count = 0, last_error = NULL
WHERE status = 'failed';
```

**Reliability properties:**
- Graceful shutdown: three checkpoints (pre-dequeue, post-dequeue, post-process) drain the loop cleanly on SIGTERM — no mid-flight message loss.
- TOCTOU guard: dequeue uses `FOR UPDATE SKIP LOCKED` so concurrent restarts cannot claim the same row.
- Dead-letter: after 3 failed attempts the row is set to `status = 'failed'` with `last_error` stored. Row survives for 24 h then purged. Re-queue with the SQL above.

**Log signals:**
- `⚙️ Queue processor started` → normal startup
- `📥 Recovered N in-flight messages back to pending` → crash recovery on boot
- `Queued message permanently failed (max retries)` → check `last_error` column; re-queue or drop

---

## Incident Response

### Discord Rate Limiting

**Symptom:** Messages stored in PostgreSQL but no Discord threads appear. Heal queue entries accumulate.

**Recovery:** Check logs for `429` / `DiscordAPIError`. Transient limits resolve via heal queue backoff. Persistent limits → check message volume against server tier.

### Discord Server or Channel Deleted

- Capsule hashes and fractal IDs in PostgreSQL remain valid forever (sovereignty layer)
- Discord CDN attachment URLs return 404 — content lost unless IPFS was active
- New messages fail → heal queue accumulates → books eventually marked `failed`

**Recovery:** Create new Discord server/channel → update `NYANBOOK_WEBHOOK_URL` + bot permissions → re-queue failed books (SQL above).

### Bot Token Revoked Mid-Operation

Bots maintain persistent WebSocket connections. Revocation mid-operation disconnects only the affected bot; others keep running.

- Hermes/Thoth revoked → messages stop reaching Discord; books enter heal queue
- Idris revoked → AI audit writes go silent (AI still responds to users)
- Horus revoked → audit read/history disabled

**Recovery:** Rotate the token (see Secret Rotation → Discord Bot Tokens).

### Pinata JWT Expiry

No data loss — messages still go to PostgreSQL + Discord. New `ipfs_cid` values will be NULL. Startup log shows `⚠️ PINATA_JWT not set`.

**Recovery:** [pinata.cloud](https://pinata.cloud) → API Keys → new key → update `PINATA_JWT` → restart. Historical NULL CIDs are not retroactively pinned.

CIDs are content-addressed and provider-agnostic. Any CID pinned via Pinata can be re-pinned elsewhere using just the CID. The CID is the sovereignty anchor — not Pinata.

---

## Observability

No Grafana/Prometheus. The observability stack:

- **Discord threads** — every inbound message is a timestamped audit trail. Gaps are visible.
- **Server logs** — pino JSON. Background tasks, heal events, bot lifecycle all logged with context.
- **`core.book_registry`** — `heal_status`, `heal_attempts`, `heal_error`, `next_heal_at` are queryable.

**Diagnostic queries:**
```sql
SELECT fractal_id, book_name, heal_status, heal_attempts, heal_error, next_heal_at
FROM core.book_registry
WHERE heal_status IN ('pending', 'healing', 'failed')
ORDER BY heal_attempts DESC;

SELECT message_fractal_id, ipfs_cid, created_at
FROM core.message_ledger
ORDER BY created_at DESC LIMIT 20;
```

---

## Backup / Restore

Isolated schemas per tenant (`tenant_1`, `tenant_2`, ...) + shared `core` schema.

```bash
# Full
pg_dump "$DATABASE_URL" > nyanbook_backup_$(date +%Y%m%d).sql

# Core only
pg_dump "$DATABASE_URL" --schema=core > core_backup_$(date +%Y%m%d).sql

# Single tenant
pg_dump "$DATABASE_URL" --schema=tenant_1 > tenant_1_backup_$(date +%Y%m%d).sql

# Restore
psql "$DATABASE_URL" < nyanbook_backup_20260101.sql
```

On Supabase free tier: Dashboard → Database → Backups for point-in-time recovery (daily backups included).

---

## Appendix: Search Architecture

The AI pipeline uses a three-layer search cascade via `lib/tools/search-cascade.js`, followed by optional Firecrawl enrichment:

| Layer | Role | Cost |
|-------|------|------|
| **DDG enrichment** | Grounds general queries against live web before LLM reasoning. Free, no key, ~200ms. | $0 |
| **Brave fallback** | Cascades to Brave if DDG returns nothing. Requires `PLAYGROUND_BRAVE_API`. | Free tier |
| **Exa semantic fallback** | Cascades to Exa if DDG + Brave both return nothing. Requires `EXA_API_KEY`. Neural search. | Free (1k/mo) |
| **Firecrawl enrichment** | After cascade: replaces raw HTML snippets with clean Firecrawl markdown in-place. Requires `FIRECRAWL_API_KEY`. | Free (500/mo) |
| **Temporal volatility** | Classifies freshness: HIGH (prices, scores), MEDIUM (politics), LOW (philosophy, history). | $0 |
| **Two-pass audit** | LLM self-checks its answer (S2→S3). Confidence scoring catches hallucination. | In LLM calls |

**For forkers:** DDG is auto-plugged — web-grounded answers out of the box. Brave, Exa, and Firecrawl are optional (each key is independent; missing ones degrade gracefully). New providers plug into the cascade with zero orchestrator changes.

### Internals

- `cascade({ query, strategy, clientIp })` → `{ result, provider }`. Strategies: `ddg-first` or `brave-first`.
- `cascadeMulti()` — batch queries with rate limiting.
- Exa fires only when DDG + Brave both return null; lazy-required so startup has no overhead when `EXA_API_KEY` is absent.
- Firecrawl enrichment runs post-cascade in `pipeline-orchestrator.js` (S0 + S4 retry). `enrichUrls()` fetches cited URLs in parallel with per-URL timeout; `substituteEnrichedSnippets()` replaces descriptions in-place. `state.searchSourceUrls` is never modified — source-ascriber uses it for the `📚 Sources` footer.
- `classifyTemporalVolatility()` in `utils/preflight-router.js` — injected at `stepContextBuild` when search context exists.
- `utils/source-ascriber.js` — canonical `📚 Sources` attribution. Priority: `nyan-identity` → `psiEmaDirectOutput` → `seedMetricDirectOutput` → `forex` → search URLs → training data.
- DDG gating: default-on for `general` mode. Opted out: math exercises, creative writing, code debugging, greetings, single-word queries. Philosophy gets enrichment.

---

## Appendix: File Inventory

### `utils/`

```
utils/
├── message-capsule.js            — Cryptographic capsule builder
├── ipfs-pinner.js                — Pinata IPFS pinning
├── psi-EMA.js                    — φ-derived time series analysis
├── fetch-stock-prices.py         — Psi-EMA data fetcher (yfinance/pandas)
├── pipeline-orchestrator.js      — 7-stage AI pipeline (S-1 → S6)
├── two-pass-verification.js      — 2-pass hallucination correction
├── dashboard-audit-pipeline.js   — 4-stage hallucination correction
├── seed-metric-calculator.js     — Real estate affordability (Seed Metric)
├── markdown-table-formatter.js   — Column-aligned markdown tables
└── language-detector.js          — Trigram + script language detection (ISO 639-1)
```

### `lib/tools/` (auto-discovered — drop a `.js` file to add a tool)

```
lib/tools/ (9 tools):
├── registry.js          — Auto-discovers on startup, getTool() + getManifest()
├── brave-search.js      — Brave API (cached, throttled)
├── duckduckgo.js        — DDG instant answers (cached, fallback)
├── url-fetcher.js       — Fetch + extract readable content from URLs (cached)
├── github-reader.js     — GitHub repos, blobs, trees, raw files, Gists
├── pdf-analyzer.js      — PDF analysis via attachment cascade
├── entity-extractor.js  — Structured extraction (plates, currency, dates, emails, phones)
├── geo-lookup.js        — City↔country, abbreviations, currency→region (static)
├── forex.js             — Exchange rates via fawazahmed0 API
└── language-detector.js — Language detection (ISO 639-1 + confidence + FTS config)
```

### `lib/outpipes/`

```
lib/outpipes/
├── router.js   — Dispatches all outpipes in parallel; legacy webhook fallback
├── discord.js  — Discord webhook delivery
├── email.js    — Email via Resend
└── webhook.js  — HTTPS JSON POST with optional HMAC-SHA256 signature
```

### `lib/fetch-cache.js`

TTL cache: `braveCache` 3min, `duckduckgoCache` 5min, `urlCache` 10min.

---

## Dependency Security

### Pinning Policy

All `package.json` dependencies use **upper-bound semver ranges** (`>=current <next-major`) instead of bare `^` caret ranges. This allows patch and minor updates within the current major while blocking unexpected major-version jumps that could introduce breaking changes or unaudited code.

Example: `"axios": ">=1.14.0 <2.0.0"` — accepts any 1.x patch, blocks 2.x.

### Running the Security Check

```bash
npm run security
```

This runs `npm audit --audit-level=high` and exits non-zero if any high or critical CVEs are found. Run this after every `npm install` or dependency change. The underlying script is `scripts/security-check.sh`.

### Accepted / Mitigated CVEs

As of 2026-04-02, `npm audit` returns **0 vulnerabilities**. The following CVEs were resolved during the initial hardening pass:

| Package | CVE | Resolution |
|---------|-----|------------|
| `axios <=1.13.4` | GHSA-43fc-jf86-j433 (DoS via `__proto__` in mergeConfig) | Upgraded to `>=1.14.0` |
| `@xmldom/xmldom <0.8.12` | GHSA-wh4c-j3r5-mjhp (XML injection via CDATA) | Resolved via `discord.js` transitive update |
| `undici` (transitive via `@discordjs/rest`) | Moderate | Resolved via `discord.js >=14.26.0` |
| `express-rate-limit <8.3.0` | High | Upgraded to `>=8.3.2` |
| `path-to-regexp`, `minimatch`, `lodash`, `underscore` | Various | Resolved via transitive dependency upgrades |

If a new CVE appears, triage it here and either upgrade the pinned lower-bound or document the accepted risk with justification.

### When a New CVE Is Discovered

1. Run `npm audit` to identify the affected package and version range.
2. Bump the lower bound in `package.json` to the patched version (e.g. `>=1.14.0` → `>=1.15.0`).
3. Run `npm install` to update `package-lock.json`.
4. Run `npm run security` to confirm zero findings.
5. Document the CVE in the table above.
6. Commit both `package.json` and `package-lock.json`.
