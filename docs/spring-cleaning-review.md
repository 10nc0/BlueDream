# Spring cleaning: September–November 2026

## Inventory and scope

Reviewed the available Git history from September 12 through November 12:
43 commits, 146 changed files, 10,649 additions and 2,076 removals.
Tests account for 3,871 added lines, library code 2,012, utilities 1,572,
documentation 535 and scripts 471. These are change counts, not a claim that
every added line is unnecessary.

Before cleanup the ingestion module was 1,216 lines and the pipeline orchestrator
3,288 lines. Both predate this window; their full size is not recent growth.
The high-risk boundaries are delivery receipts, shared worker ownership, media
transport and AI accounting—not the number of helper files.

## Decisions and caller inventory

- Keep the ordered queue as the only publication coordinator for ingestion.
  Subscriber sends must not escape into the independently scheduled outbox.
- Reuse environment authority across ingestion startup, cleanup and outbox
  startup/ticks/direct job methods. Development routing cannot schedule the
  non-ordered outbox fast path.
- Hoist missing-book/snapshot/media preparation rules, rather than creating a
  universal publisher. Discord receipts and generic HTTP acknowledgements have
  different semantics.
- Share Discord 429 delay parsing; retain the Bot-specific archived-thread
  recovery and per-chunk webhook receipts. Never retry network uncertainty.
- Extract pure Seed Metric output handling into a focused utility. Keep thin
  orchestrator methods so existing stage callers remain compatible.
- Retain provider compatibility adapters: the shared AI constructor still passes
  individual search providers, smoke scripts also reference them, and the
  `kimiFirst` alias has a test consumer. They are not proven unused. No model,
  preflight routing, shared admission policy or audit pass was removed.
- Remove the ingestion module's unused branding import, duplicate attachment
  retry loop, obsolete text-only fallback and receive-only reply attempts.

## Before / after evidence

| Work | Before | After |
|---|---|---|
| Discord-only subscriber media preparation | One CDN download and re-upload per subscriber | Zero subscriber GETs; explicit attachment links |
| Two Discord subscribers (including webhook-typed Discord) | Up to three fetches due to type-based eager fetching plus per-subscriber resolution | Fixture verifies two publications and zero GETs |
| Generic/email media | Shared fetch plus possible per-destination fallback after failure | One required bounded fetch per routing attempt; failure stops instead of falling back silently |
| Book lookup on receipt/archive retry | Mutable SELECT before consulting snapshot | Snapshot first; fixture verifies one lookup across two attempts |
| Attachment failure attempts | Channel retry × extra handler retry × queue retry | Channel retry × queue retry; no extra handler loop |
| Development outbox | Background worker could read shared jobs | Start, tick, delivery, prune and router fast path denied |
| Ledger chunk recovery | Outer stage could accept a swallowed failure/null | Each Discord chunk requires a receipt; accepted chunks survive retry |
| Media fetch safety | Unbounded Axios fetch with automatic redirects | 25 MiB, 10-second total signal, five redirects, vetted/pinned DNS, no proxy or credentials, HTML rejection |

Signed CDN query strings remain supported. Public-reader *route* restrictions
are not appropriate for attachments; the shared public IP classifier is reused,
but media URLs have their own validation policy. Channel-authenticated provider
downloads remain separate from untrusted subscriber media retrieval.

No production latency benchmark was performed. A real development playground
request intended to check empty-input validation unexpectedly ran the full
pipeline and returned SSE audit/done events after 22.9 seconds, instead of
rejecting the empty prompt. This is a separate input-validation defect, not
proof of correct answer quality or a latency improvement. No further inference
was run. Queue claim/lease SQL and AI reservation round trips were not changed.
The benefit established here is removal of redundant network operations, not
a claimed number of seconds saved. Live rendering of the attachment link must
be confirmed during the separately approved live burst.

## Verification

The targeted offline pass covers 19 ordered-delivery/cleanup tests, 133 Seed
Metric cases, preflight routing, provider handling, playground progress,
attachment handling and startup ownership/cadence. The isolated PostgreSQL
test exercises actual claim SQL and the active handler with fake Discord/media;
it is not a live WhatsApp test. Logs for this run are temporary evidence, not
production telemetry.

Important cases: slow video cannot be overtaken by the next hashtag; independent
senders progress; unknown sends hold; 429 retries respect delay; partial chunks
do not repost; missing media/books stop; invalid schema holds; snapshots survive
mutable lookup changes; development workers do not query storage; private DNS,
unsafe redirects, HTML and oversized responses are rejected.

## Rollout and limitations

No deployment or live message send is authorized by these checks. Stop/drain
old ingestion workers and drain/reconcile legacy outbox jobs for affected
destinations before enabling the new processor. Do not mix unfenced old workers
with the ordered path.

Ordering means durable accepted ingress order, not reconstruction of late
Twilio webhooks. Pending-book media is explicitly held until operator disposition:
it is never silently consumed as an activation-only message. Activation side
effects with uncertain outcomes are also held, not blindly recreated.

The non-ingestion legacy outbox still needs independent cross-instance claiming
and ambiguous-outcome handling. It is not used by ordered ingestion. Administrator
hold recovery and the approved live WhatsApp burst are already separate drafts.

The workflow restart reached API readiness at 7.2 seconds with both development
delivery workers disabled; this is one warm-workspace observation, not a cold
container benchmark. Separately supplied production logs showed a Thoth ready
callback accessing a null client and process exit, plus later database startup
failures. Those logs are not evidence against the development restart, and this
cleanup did not modify or publish the production bot code.
