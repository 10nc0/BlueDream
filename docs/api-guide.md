# NyanBook~ API Guide — v1

**Machine-readable discovery:** `GET /api/v1/nyan/guide` — returns this spec as JSON. Read that endpoint first; it is always current.

**Stability contract:** v1 fields are additive-only. No field will be removed or renamed without a new version path (`/api/v2/...`). New optional fields may appear in responses at any time.

**Changelog:**
| Version | Date | Notes |
|---|---|---|
| 1 | 2026-06-09 | Initial stable declaration. All `/api/*` routes declared v1. Guide endpoint added. |

---

## Authentication

| Type | How | Used by |
|---|---|---|
| **Agent bearer token** | `Authorization: Bearer <token>` | Per-book write/read (`/api/agent/*`). Token is the sole routing key — no book ID in URL. |
| **User bearer token** | `Authorization: Bearer <token>` | Cross-book read access within your own tenant. GET-only. Works on `/api/mesh/*` and all other `requireAuth` GET routes. Generate via `POST /api/me/token` (requires password). |
| **Session (cookie)** | Browser JWT cookie | Fallback for browser-based flows. Not suitable for automation. |

---

## Agent Pipe Endpoints

### POST /api/agent/message — Write a message

Ingest a message into the book bound to the bearer token.

**Auth:** Bearer

**Request body** (all fields optional except at least one content field):

| Field | Type | Description |
|---|---|---|
| `text` | string ≤10 000 | Message body |
| `username` | string ≤100 | Sender display name. Default: `"External"` |
| `avatar_url` | string URL \| null | Sender avatar |
| `media_url` | string URL \| null | Remote media attachment |
| `media_type` | string \| null | MIME type, e.g. `"image/jpeg"` |
| `phone` | string E.164 \| null | e.g. `"+15551234567"` |
| `email` | string \| null | Sender email |
| `photos` | array \| null | Inline images — `[{name?, data: base64}]` max 5 |
| `documents` | array \| null | Inline docs — `[{name, data: base64, type?}]` max 5 |

**Response:**
```json
{ "success": true, "message": "Message accepted", "book_id": "bk_..." }
```

**Errors:**

| Status | Cause |
|---|---|
| `400` | Invalid payload (details array included) |
| `401` | Missing or invalid bearer token |
| `503` | Server queue full — retry with backoff |

---

### GET /api/agent/messages — Read messages (token-only)

Read messages from the book bound to the bearer token. Results are newest-first.

**Auth:** Bearer

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer 1–100 | `50` | Messages per page |
| `after` | ISO 8601 timestamp | — | Return messages **newer than** this timestamp |
| `before` | ISO 8601 timestamp | — | Return messages **older than** this timestamp |

`after` and `before` are mutually exclusive.

**Response:**
```json
{
  "book": "My Book Name",
  "book_id": "bk_...",
  "_meta": { "source": "postgresql", "media_note": "..." },
  "messages": [
    {
      "id": 1234,
      "message_fractal_id": "mf_...",
      "sender": "Alice",
      "text": "Hello world",
      "timestamp": "2024-11-01T08:00:00.000Z",
      "has_media": false,
      "media_ipfs_cid": null,
      "media_ipfs_gateway_url": null,
      "media_url": null
    }
  ],
  "total": 1,
  "hasMore": false,
  "cursor": { "newest": "2024-11-01T08:00:00.000Z", "oldest": "2024-11-01T08:00:00.000Z" }
}
```

**Pagination:** Pass `before=<cursor.oldest>` to fetch the next (older) page. Stop when `hasMore` is `false`.

**Errors:**

| Status | Cause |
|---|---|
| `400` | Invalid cursor format or conflicting after+before |
| `401` | Missing or invalid bearer token |
| `404` | Book not found |

---

### GET /api/webhook/:fractalId/messages — Read messages (legacy)

Identical response to `GET /api/agent/messages`. The bearer token **must** be scoped to the `fractalId` in the URL. Prefer the token-only path above for new integrations.

---

### POST /api/agent/bootstrap — Multi-book cold-start

Load a structured memory snapshot for up to 20 books in a single round-trip. Designed for agents managing multiple books that need to re-hydrate context after a cold start.

**Auth:** None (tokens are supplied in the request body per book)

**Rate limit:** 20 requests/min per IP

**Request body:**
```json
{
  "books": [
    { "token": "<bearer_token>", "limit": 50 },
    { "token": "<another_token>" }
  ]
}
```

`limit` per book is optional (default 50, max 100). Max 20 books per call.

**Response:**
```json
{
  "bootstrap_at": "2024-11-01T08:00:00.000Z",
  "total_books": 2,
  "books": [
    {
      "book_id": "bk_...",
      "book_name": "Farm Ledger A",
      "status": "ok",
      "messages": [...],
      "tags": ["corn-ne-2024-lot007"],
      "stats": { "total_messages": 412, "last_activity": "..." }
    },
    {
      "token_hint": "abc...xyz",
      "error": "Invalid agent token"
    }
  ]
}
```

Invalid tokens produce an error slot without failing the entire request.

**Errors:**

| Status | Cause |
|---|---|
| `400` | Missing or malformed `books` array |
| `429` | Rate limit exceeded |

---

## Tag Mesh / PITA 🎀 Query

### GET /api/mesh/tag/:tagValue

Query all drops across **all books in the tenant** carrying a specific tag. This is the cross-book read surface of PITA-AOP (Payload ID-Tag Anchor, Append-Only Protocol).

**Auth:** Session **or user bearer token**. Agent tokens are per-book and cannot cross books. Use a user bearer token for automation (see Auth section above).

**URL parameter:** `tagValue` — case-insensitive exact match. Do not include `#` prefix. Max 500 chars.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer 1–200 | `50` | Results per page |
| `before_cursor` | string | — | Opaque cursor from `next_cursor` of a previous response |

**Response:**
```json
{
  "results": [
    {
      "payload_id": "pi_a3f1c8d2e7b94f1a2c3d4e5f6a7b8c9d",
      "book_fractal_id": "bk_7f3a1b2c4d5e6f7a",
      "book_name": "Farm Ledger A",
      "sent_at": "2024-11-01T08:00:00.000Z",
      "metadata_text": "Harvest complete. Lot 007.",
      "extracted_tags": ["corn-ne-2024-lot007", "silo-tx-2024-bin3"]
    }
  ],
  "next_cursor": null
}
```

`next_cursor` is `null` when there are no more pages.

**Errors:**

| Status | Cause |
|---|---|
| `400` | Empty tag, tag too long, or invalid cursor |
| `401` | No valid session |

---

## Reference

### Payload ID (π)

`payload_id` values follow the pattern `pi_<32 hex chars>`:

```
pi_ + SHA-256(internal_source_id).hexdigest[:32]
```

Stable across renames and migrations. Safe to share across nodes. The underlying `source_id` is internal and never exposed.

### Read cursors

Agent-pipe cursors (`after` / `before`) are plain ISO 8601 timestamps — construct them directly.

Mesh cursors (`before_cursor`) are opaque `base64url`-encoded strings — treat as a black box, never construct manually.

### Media

`media_ipfs_cid` is verifiable against `content_hash` in `core.message_ledger`. `media_ipfs_gateway_url` is a convenience URL (`https://gateway.pinata.cloud/ipfs/<cid>`). `media_url` is a Discord CDN URL and may expire.

See `runbook/payload-id-tag-anchor.md` for the full PITA-AOP protocol spec.
