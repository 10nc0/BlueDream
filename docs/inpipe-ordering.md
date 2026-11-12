# Ingestion ordering and recovery

## Ordering contract

WhatsApp and LINE remain receive-only. HTTP webhook acknowledgments are not
messaging replies. Development does not claim, recover or clean shared packets
or legacy outbox jobs. There is no outbox fast-path sender.

## One delivery coordinator

### Burst intake and provider retries

Acceptance uses bounded, per-pool microbatches (up to 128 packets). Replicas
still share the short database admission gate: it assigns committed ingress
order, enforces the exact 10,000-packet pending/processing cap and atomically
records provider identities. It no longer holds that gate for a separate series
of database roundtrips for every photo. Indexes cover modern and legacy
idempotency lookups and active backlog counts.

The temporary admission buffer is bounded to 2,048 waiting packets per pool,
with a five-second waiting deadline. It is NOT durable acceptance: a 200 response
is sent only after the batch transaction commits. Full or unavailable admission
returns 503 and Retry-After; known duplicate retries still succeed at capacity.
The disk-backed backlog holds media references, not downloaded media buffers.
Delivery concurrency and Discord rate-limit delays remain bounded separately;
acceptance throughput is not a promise of immediate Discord delivery.

**Twilio does not retry HTTP 5xx by default.** Its documented default retry policy
is `ct` (connection failures), not `5xx` or read timeout. For loss recovery during
overload/outages, configure the inbound WhatsApp webhook with the fragment
`#rc=5&rp=ct,rt,5xx` in Twilio, retaining the existing HTTPS path. This fragment
is provider configuration, is not sent to the server, and must not be included
in the server's signature-validation URL. Check any existing URL fragments
before combining settings. Retry-After alone is not proof that Twilio retries.
Retries are bounded by Twilio's total-time policy; prolonged outages or sustained
capacity exhaustion still need provider failure monitoring and reconciliation.

Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides

Run `npm run test:inpipe:bursts` for signed HTTP requests against isolated
PostgreSQL tables: 14 messages, then 20 concurrent senders with 30 messages each
across two independent admission instances. It reports acceptance latency and
SQL roundtrips and verifies duplicates, exact cross-instance capacity, legacy
identities and retryable failures. These tests do not send live provider media.

`DeliveryCoordinator` in `lib/ordered-inpipe.js` is the shared implementation;
`OrderedInpipe` is only a compatibility export of that same class.

Publishing caller graph:

```text
WA / LINE / existing channel routes ── accepted message_queue packet ─┐
agent/message + webhook/:book ─────── accepted message_queue packet ──┤
non-queued routeUserOutput caller ─── accepted outbox-kind packet ────┤
                                                                    ▼
                        shared atomic claim → routing/placeholder → media
                          → ledger receipt → subscriber chunk receipts
                          → archive → fenced completion / retry / hold

generic storage-only ingress ───────── writeDrop (unchanged; no publication)
legacy outbox worker ───────────────── quarantine only (no publication)
```

Before, three competing execution paths could publish: ingestion, immediate
outbox send, and legacy outbox polling. Now there is **one claim implementation,
one lease table, one fencing implementation, and one receipt/retry/hold state
machine**. Provider adapters only format and transport payloads. No new queue
table, dependency or publishing endpoint was added.

Every new accepted event has an immutable acceptance ID/time inside its existing
queue payload. Repeated provider IDs deduplicate before admission; distinct events
with identical text remain distinct. New message references include the accepted
event as a derivation input without changing their format, sender/content hashes,
proof version, or any stored historical reference. Legacy rows keep their original
derivation. Message/breath anchors, proof capsules and destination plans are
checkpointed; retrying does not rebind them to a new timestamp or configuration.

Webhook/agent ordering is scoped to the authenticated tenant/book (claimed sender
fields cannot create a separate order lane). Outbox admissions are scoped by
tenant/book/sender; their deduplication identity also includes tenant/book.
WA/LINE retain conservative per-channel sender ordering across book switches.

Queue IDs define **durable accepted ingress order**, assigned in an atomic
acceptance transaction. Media priority and timestamps do not determine delivery.
Provider identity deduplication commits with acceptance, so a failed/full enqueue
does not consume the provider ID. Completed queue records cover provider retry
windows, including Twilio's.

A conversation is conservatively a channel plus sender identity, spanning that
sender's books. A book switch therefore finishes before the next attachment.
Different senders are independent, with two workers per process and no more than
four active queue leases across app instances.

Hashtags are ordinary message text in this bridge, not a mutable “current group”
variable. A burst such as `#A, A1, A2, video A, #B, B1` stays in that order.
No delayed attachment inherits tags or routing from whichever hashtag is current
when its download finishes. Routing and destination snapshots are persisted
before expensive processing and reused on retries.

An old provider timestamp arriving in a **later webhook** remains later in ingress
order. Neither Twilio's MessageSid nor DateCreated is a reliable contiguous
conversation sequence. We cannot reconstruct a missing or reordered upstream
webhook from a timestamp alone. Archive `sent_at` retains the provider time;
`recorded_at` records ordered archival commit time.

## Publication and failure policy

Every claim has an expiring fencing token. Renewals run while work is active;
publication checkpoints and completion require the same unexpired token.
Preparing an attachment does not release the sender's head-of-line position.
Remote attachment downloads have a 25 MiB maximum and bounded network retries;
Discord uploads are bounded too. Buffers are not serialized into the queue.

Before each external publication, the row records `started`. On success it
stores a minimal receipt. A restart after receipt persistence reuses the receipt,
stable archive ID and routing snapshot; archive retries do not repost.
Discord Bot sends also carry an enforced nonce, but the nonce's short dedupe
window is **not** relied upon for long-term exactly-once delivery.

An expired preparation lease can be reclaimed. An expired `started` send,
ambiguous network/5xx result, or successful send whose receipt could not be
persisted is held as `failed`. It is **not** blindly retried. Explicit rejections
of a single Discord message can retry. Discord subscriber chunks have individual
receipts: a 429 honors `retry_after` and retries only the rejected chunk, not
earlier accepted chunks. Long rate-limit delays use a durable retry deadline and
release the active lease. Unknown outcomes for any chunk still hold the sender.

Preparation failures retry at most three times with backoff. Exhaustion retains
the row and holds subsequent messages from that sender. No failed media is
silently replaced with a text-only success. Other senders continue.
The worker logs `Inpipe HOLD queue=...` when it holds a conversation. Operators
can inspect `status`, `last_error`, `lease_until`, `delivery_state`, and the
same-sender successors in `core.message_queue`. Failed records are not
automatically deleted, and manually resolved records retain their error trail.

### Operator disposition

1. Inspect the held queue ID and persisted Ref/receipts. Stop that sender's old
   worker before handling an uncertain send; do not reset all processing rows.
2. If the message exists on Discord, reconcile the corresponding stage with its
   actual receipt, retaining its Ref and attachments; then allow archive-only
   retry. Do not resend it to “see whether it works.”
3. If non-delivery is established, clear only the uncompleted stage, record the
   evidence/reason, and explicitly requeue that item. Preserve routing and Ref.
4. For terminal media failure, repair the source and explicitly retry, or record
   an operator-approved skip with a reason. Never quietly delete the row.
   A skip closes that queue item and releases its successor; it does not fabricate
   an archive/media delivery or rewrite posted Discord/ledger history.

Held items intentionally require intervention rather than indefinite automatic
retries. An administrator recovery UI is a separate follow-up.

Pending-book media is held rather than consumed as an activation-only message.
Uncertain activation side effects also require reconciliation. Retries consult
persisted book snapshots before mutable lookups. Missing media, missing books,
missing destinations and missing Discord receipts do not count as delivery.

Discord subscribers receive explicit attachment links instead of downloading
and uploading the ledger CDN video again. Destinations that need bytes share
one bounded fetch per attempt; a failed fetch does not become text-only success.

## Rollout and verification

The additive migration adds queue metadata/indexes; it does not rewrite messages
or ledger history. **Drain/stop every legacy ingestion worker before enabling the
new processor.** A rolling mix with old, unfenced media-first workers cannot
provide the new ordering guarantee. Drain or explicitly reconcile existing
legacy outbox jobs for the same Discord destinations too; late legacy jobs must
not interleave with newly ordered sends. Existing legacy `processing` rows have unknown
publication outcomes and are held for review, not automatically replayed.

The compatibility outbox worker no longer executes jobs, falls back to direct
sends, or prunes delivery evidence. It marks pending legacy rows as failed with
an explicit `HELD` reason, in batches of 50. Even zero-attempt rows may already
have been sent by the removed immediate path. Preserve those records and reconcile
them before admitting replacements to the shared queue. This is not proof that an
old send failed. Successful and previously failed history is not rewritten.

Do not enable the development processor to test this change. Run
`npm run test:inpipe:db` for isolated PostgreSQL schemas with fake Discord/media.
It verifies real claim SQL and active-book handlers, slow video, competing workers,
archive order, duplicate acceptance, rate limits, receipt recovery, ambiguous
sends, terminal failures, fencing and the shared concurrency cap. No paid
Twilio/Discord live messaging test has been performed. Shared-delivery tests also
exercise LINE preparation, agent/webhook delivery, outbox admission versus
competing claims, slow-video fan-out, same-text distinct events and legacy holds.
