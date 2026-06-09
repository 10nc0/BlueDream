---
name: Mesh cursor sealing
description: How GET /api/mesh/tag pagination cursors are sealed and why source_id must not appear in them
---

## Rule
Mesh cursors are AES-256-GCM sealed JSON `{ ts, id: drops.id }`.
- Key: `SHA-256("cursor-seal:" + SESSION_SECRET)` — derived at module init in `routes/books/mesh.js`
- Tiebreaker: `drops.id` (SERIAL PRIMARY KEY) — globally unique within a tenant, safe to seal inside the cursor
- `source_id` must never appear in the cursor (π privacy guarantee)

**Why:** base64url is encoding, not encryption. The old cursor stored raw source_id (Discord snowflake) in plain JSON — any caller could run `atob()` and read it. AES-GCM makes the cursor opaque AND non-forgeable.

**How to apply:** Any future pagination on drops that needs a keyset tiebreaker should use `d.id` (integer) wrapped in `sealCursor`/`unsealCursor` from mesh.js, not source_id. Old plain-base64url cursors are rejected at unseal (AES-GCM auth tag mismatch).
