# PITA 🎀 — Payload ID-Tag Anchor
## Runbook: Append-Only Protocol + Cross-Book Trace Surface

---

## 1. Acronym

**PITA — Payload ID-Tag Anchor**

Each word names a level in the hierarchy:

| Level | Word | Meaning |
|---|---|---|
| 1 | **Payload** | The content unit. The thing that exists — bytes, text, an attachment. Substrate-agnostic. |
| 2 | **ID (π)** | The payload's stable, substrate-agnostic identity. Derived from `source_id` via SHA-256. Not a display alias — the referential handle for the first-class object across nodes. |
| 3 | **Tag** | A metadata attribute on the payload. The anchor string stored in `extracted_tags`. What is *said* about the payload. |
| 4 | **Anchor** | The role a tag plays when it links payloads across nodes. Pure relation — a tag that appears in two drops creates an implicit edge. |

Hierarchy: **content → identity → attribute → relation**.

---

## 2. The One Rule (PITA-AOP)

**When a payload passes through your node:**

1. Read the existing PITAs on the carrier.
2. Deduplicate against your own PITA list (case-insensitive comparison, original casing preserved — first-seen wins).
3. Append your own PITAs.
4. Write it back.

**Never remove. Never reorder.**

This is the Append-Only Protocol (AOP). It is a social and technical contract between cooperating nodes. NyanBook enforces deduplication; it does not police the order or content of claims.

---

## 3. NyanBook Search Notation

In the NyanBook UI, the `#` prefix triggers tag search:

```
#CORN-NE-2024-LOT007
```

This is the natural single-book PITA lookup. PITAs are stored *without* the `#` character; `#` is the search-prefix convention only. The mesh endpoint (`GET /api/mesh/tag/:tagValue`) is the cross-book version of the same primitive — supply the tag without `#`.

---

## 4. Integrity Boundary

PITA-AOP records **claims of custody**, not **proof of custody**.

PITAs are caller-minted strings. The protocol prevents *accidental* linkage between honest nodes through its dedup rule; it does not prevent malicious fabrication. Any node can append any string.

**NyanBook is protocol-agnostic storage.** It stores and retrieves tag arrays faithfully. It does not validate custody claims, verify chain integrity, or attest to origin.

Tamper-evidence (detecting removal or reordering) requires the ZK layer — a future extension.

---

## 5. Properties

| Property | Today | Requires ZK / hash-chain layer |
|---|---|---|
| Cooperative append-only | Honest nodes accumulate truthfully | Tamper-evidence (removal / reorder detectable) |
| Federation without coordination | No node needs to know the others | Cross-tenant cryptographic attestation |
| Self-describing carrier | Carrier holds full history at any point | Verifiable receipt proof |
| Forkable | Fork inherits parent PITA list, appends independently | — |
| Mergeable | Merge node appends union of both lists (deduped) | — |
| Queryable | Any PITA is a valid mesh lookup key | — |

---

## 6. Fat-Tag Design Choice

NyanBook uses **fat-tag** (not thin-link):

- The **full ancestor PITA list is carried forward** on every drop — not just immediate parents.
- Trade-off: O(1) mesh queryability (any PITA → instant hit) at the cost of storage growth proportional to chain depth.
- Deduplication is enforced by `lib/drop-writer.js`: case-insensitive comparison, original casing of first occurrence preserved.

The alternative (thin-link) stores only parent references and requires graph traversal to reconstruct the chain. Deferred.

---

## 7. π — Payload Identity Derivation

```
π = "pi_" + SHA-256(source_id).hex[:32]
```

- 128-bit payload address space — identity-grade, collision-safe at human scale.
- `source_id` is the *internal* per-book unique identifier (see §10 for channel prefixes).
- `π` (`payload_id`) is the *external* stable handle — safe to share across nodes without leaking internal routing keys.
- `source_id` is never surfaced in API responses.

---

## 8. Worked Illustration — Corn from Field to Shelf

A single lot of corn travels through four independent NyanBook nodes. Each node appends its own PITA. No node coordinates with any other.

```
Node A — Farm (harvest)
  Ingest:  "Harvested Lot 007, field NE-2024"
  Appends: ["CORN-NE-2024-LOT007"]
  Carrier: ["CORN-NE-2024-LOT007"]

Node B — Silo (storage)
  Receives carrier with ["CORN-NE-2024-LOT007"]
  Appends: ["SILO-TX-2024-BIN3"]
  Dedup:   CORN-NE-2024-LOT007 already present → no duplicate
  Carrier: ["CORN-NE-2024-LOT007", "SILO-TX-2024-BIN3"]

Node C — Mill (processing)
  Receives carrier with ["CORN-NE-2024-LOT007", "SILO-TX-2024-BIN3"]
  Appends: ["BATCH-MILL-2024-042"]
  Carrier: ["CORN-NE-2024-LOT007", "SILO-TX-2024-BIN3", "BATCH-MILL-2024-042"]

Node D — Retailer (shelf)
  Receives carrier with all three PITAs
  Appends: ["SKU-STORE-A-CORN-FLOUR"]
  Carrier: ["CORN-NE-2024-LOT007", "SILO-TX-2024-BIN3",
            "BATCH-MILL-2024-042", "SKU-STORE-A-CORN-FLOUR"]
```

**Mesh query at any node:** `GET /api/mesh/tag/CORN-NE-2024-LOT007` returns every drop carrying that PITA — the entire chain is reconstructable without a central registry.

---

## 9. Diamond-Merge Deduplication

When a payload is routed through two paths that converge:

```
         ┌── Node B (SILO-TX) ──┐
Node A ──┤                      ├── Node D (merge)
         └── Node C (MILL-042) ─┘
```

Node D receives two carriers, both bearing `CORN-NE-2024-LOT007`. Merge appends the union:

```
["CORN-NE-2024-LOT007",   ← deduplicated (appeared in both)
 "SILO-TX-2024-BIN3",
 "BATCH-MILL-2024-042",
 "MERGE-NODE-D-2024"]
```

Dedup rule: case-insensitive exact match; first-seen casing is preserved.

---

## 10. Unchained Honest Nodes

Two nodes that independently mint the same PITA string create an **implicit edge**, not a false chain.

Example: Node A (farm) and Node X (a different farm) both use `CORN-NE-2024` as a general harvest tag. A mesh query for `CORN-NE-2024` returns both — which is correct. No false ancestry is implied unless a node deliberately copies a lineage-specific PITA.

The protocol prevents *accidental* false linkage by making PITAs as specific as needed. It does not prevent deliberate fabrication.

---

## 11. Fork and Merge Patterns

**Fork:** A payload is duplicated at a node. Both copies inherit the full PITA list. Each fork appends independently. Forks are identified by diverging PITAs after the fork point.

**Merge:** A node receives two carriers. It appends the case-insensitive union of both PITA lists, deduplicated. The merged carrier continues as a single drop.

Both patterns are handled by the dedup rule in `lib/drop-writer.js` — no special merge logic required.

---

## 12. source_id Prefixes per Channel

| Channel | Prefix | Raw ID |
|---|---|---|
| Discord bot | *(none — bare snowflake)* | Discord message snowflake |
| WhatsApp / Twilio | `wa:` | Twilio MessageSid |
| LINE OA | `line:` | LINE platform message ID |
| Telegram | `tg:` | Telegram message ID |
| Email | `email:` | Email message ID |
| Generic HTTP | `gen:` | SHA-256(fractalId:timestamp:text)[:24] |
| Webhook / agent-pipe | `wh:` | SHA-256(fractalId:body)[:24] |

`source_id` values are book-scoped (unique index on `(book_id, source_id)`). They are never surfaced in API responses — only `payload_id` (π) is returned to callers.

---

## 13. Current Write Surface

All ingest paths converge on `lib/drop-writer.js` (shipped in Task #243):

| Entry point | Path |
|---|---|
| Discord bot annotation | `POST /api/drops` |
| WhatsApp / LINE / Telegram / Email | `lib/packet-queue.js → handleActiveBookAsync` |
| Webhook / agent-pipe | `lib/packet-queue.js → processWebhookMessage` |
| Generic HTTP ingest | `POST /api/inpipe/generic` |

`writeDrop({ pool, tenantSchema, bookInternalId, sourceId, metadataText, tags, sentAt, phiStamp })` is the single canonical write. It deduplicates tags, runs MetadataExtractor, and upserts on `(book_id, source_id)`.

---

## 14. Mesh Read Surface

`GET /api/mesh/tag/:tagValue` (shipped in Task #242):

- Auth: session-only (`requireAuth` + `setTenantContext`).
- Scope: all books in the authenticated tenant.
- Pagination: composite keyset cursor on `(COALESCE(sent_at, created_at) DESC, source_id DESC)`.
- Cursor: opaque `base64url`-encoded JSON `{ ts, id }` — internal only.
- Default limit: 50. Max: 200. Query param: `?limit=N`.
- Next page: `?before_cursor=<next_cursor value>`.

---

## 15. GIN Index on `extracted_tags` — Shipped

Exact-match tag queries now use a GIN index instead of a sequential scan.

### Approach: normalize at write time

Tags are stored **lowercase** in `extracted_tags` at write time (`lib/drop-writer.js`). The `dedupTags` function always stores the lowercase form of each tag — mixed-case input is silently normalized; no data is lost.

### Migration (`migrations/tenant/012_gin_extracted_tags.sql`)

Two steps, both idempotent:

1. **Backfill** — `UPDATE drops SET extracted_tags = ARRAY(SELECT lower(t) FROM unnest(extracted_tags) t)` for all existing rows. Lowering already-lowercase values is a no-op, so re-running is safe. A `WHERE` guard skips rows that are already clean.
2. **Index** — `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drops_extracted_tags_gin ON drops USING GIN (extracted_tags)` — no table lock during build.

The migration file is marked `-- @nontransactional` (line 1), which activates two-mode execution in the migration runner:

- **Boot-time (existing tenants):** each statement runs individually on the pool outside any implicit transaction, so `CREATE INDEX CONCURRENTLY` executes without holding a table lock. Reads and writes continue uninterrupted during the index build.
- **New-tenant creation (inside `createTenant` transaction):** the schema is not committed yet, so a different pool connection cannot see it. The runner uses the transaction client instead and strips `CONCURRENTLY` (which cannot run inside a transaction). For a brand-new tenant the `drops` table is empty, so the lock duration is zero regardless.

### Query split: exact vs. prefix

| Path | Query | Why |
|---|---|---|
| Mesh tag lookup (`routes/books/mesh.js`) | `extracted_tags @> ARRAY[lower($1)]` | Exact match — GIN index applies |
| Single-book tag search, `#tag` prefix (`routes/books/drops.js`) | `extracted_tags @> ARRAY[$2]` | Exact match — GIN index applies |
| FTS fallback tag OR (`routes/books/drops.js`) | `EXISTS (unnest … LIKE $4)` | Prefix/substring — containment can't do prefix; sequential scan is acceptable because this path is rare and short-circuited by the FTS clause |

### Next step if prefix GIN is ever needed

Add a `pg_trgm` GIN index (`CREATE INDEX … USING GIN (extracted_tags gin_trgm_ops)`). Requires the `pg_trgm` extension — separate decision, out of scope here.

---

## 16. Forward: ZK Cross-Node Federation

The current system is single-tenant: the mesh query is scoped to the authenticated user's books. Cross-tenant federation (a payload traced across organisations) requires:

1. A **verifiable receipt** — cryptographic proof that a node appended a specific PITA to a specific payload at a specific time.
2. A **ZK attestation layer** — nodes prove custody claims without revealing private data.
3. A **user-level bearer token** — cross-book M2M access without a session cookie (deferred; see API guide for the interim workaround).

These are explicitly out of scope for the current implementation.
