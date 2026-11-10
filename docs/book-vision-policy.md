# Book-image audit and shared AI admission

## Current rollout

The checkbox is OFF on each new audit. The backend defaults an omitted
`includeImages` to false and rejects other types. This audit's OFF choice does
not stop independent ingestion that was already extracting images.

Vision is **disabled until explicitly configured**. Ordinary chat and text
audits keep their current models. A disabled, incompatible, unreadable or
over-budget image audit never silently becomes a successful image check.

Copy `config/ai-budget.example.json` to `config/ai-budget.json` and set centrally
approved daily UTC token and USD limits, not new per-application allowances.
The example deliberately contains no invented spend ceilings. This is
non-secret operator policy; keys continue to come from workspace Secrets.
Global and tenant USD/token limits, approved model pricing, contract approval,
and approval to process private evidence with the existing OpenRouter connection
are required before `bookVision.enabled=true`. Roll back vision by setting it
false; no ledger records need to be changed.

All installations sharing a budget must use the **same database**, tables,
policy and server-verified principal mapping. A hostname or Origin header does
not extend a quota to other deployments. A separate app must adopt this module
and authenticate its callers; never trust a browser-provided principal.

## Baseline and reservations

The authoritative baseline remains config/constants: 240 text, 120 vision,
360 search per hour, vision weight 3, 180-minute active-user fairness,
duplicate and burst protection, logarithmic reputation up to 1.5, and
30-minute abuse cooldown. HTTP limits remain cheap ingress protection.
The former playground facade now uses database admission; admin/dev/loopback
do not bypass shared limits.

`utils/ai-capacity` installs application-wide request context and provider
transport admission. Its inventory covers:
- playground normal/SSE routes and their model/check/retry calls;
- authenticated dashboard audits, source-check and corrective calls;
- authenticated AI API and operator-funded Watchtower checking;
- Groq audio/vision and ingestion model calls;
- direct two-pass/audit calls, OpenRouter and DeepSeek fallbacks;
- Brave and TinyFish search. Existing public-reader work must adopt this same
  ledger rather than adding a second spend allowance.

Registered AI API labels are server-verified application principals where no
owning user is available. Authenticated users are keyed by tenant and user ID;
anonymous requests use a hashed server-derived IP. Background jobs share a
bounded system principal. BYOK inference does not spend operator token/USD
allowances, but its operator-funded checking/search does. Transport adapters
must be extended before introducing a new provider/SDK.

Atomic PostgreSQL transactions/advisory locks protect shared buckets, scope
spend and leases. The database is mandatory: paid work fails closed on missing
or unreachable shared state. A small global model concurrency cap and global
audit-preparation cap bound work; there is no queue. Every actual paid
attempt/retry reserves again. Daily scope reservations are global, tenant,
principal and configured provider. Fair-share floors/reputation affect only
relative admission, never hard spend limits.

Before an enabled image audit fetches or renders bytes it reserves a 24,000
token envelope priced at the approved model's worst input/output rate.
Its calls allocate inside that envelope, not against a second quota. Actual
reported tokens/cost settle reservations; unknown usage retains conservative
charges. A network timeout retains its per-call concurrency lease for 120
seconds and estimated spend instead of granting an immediate refund. Unused
audit envelope space is released; uncertain attempted calls remain charged.
Per-audit limits: 24,000 input+output tokens, 4,000 output tokens,
three paid calls total, three images/pages, and a 60-second deadline.

Add each operator-funded model to `models`, using current provider upper-bound
`inputUsdPerMillion`, `outputUsdPerMillion` and, for vision, `imageTokens`.
When USD ceilings are configured, unpriced providers/models fail closed.
Search services can have `services.brave.usdPerCall` (a worst-case upper bound
across configured Brave/TinyFish routes). Do not substitute zero for unknown
prices. A confirmed zero-priced service can explicitly use zero.

## Evidence/security boundary

Only server-authorized tenant book records and attachments are candidates.
Cross-tenant IDs, schemas, cached responses and citation requests are rechecked.
Attachment-only database records are included without requiring OCR/FTS matches.
Date/sender metadata filters apply; absent captions cannot exclude images based
on action words. Discovery is bounded and capped selection is disclosed.

The initial controlled download locations are Discord CDN attachments.
Unsupported gateways/CIDs are reported unavailable, never fetched from an
arbitrary client/model URL. CDN URLs are refreshed from the authorized Discord
message where that source identity is available. DNS addresses are checked and
the connection pins the chosen address. Redirects are not followed. No
credentials/cookies are forwarded. Download cap: 10 MiB/source, 20 MiB total;
encoded vision payload cap: 8 MiB. Rendering occurs in terminated, time-bounded
workers; PNG/JPEG/WebP dimensions are checked before decoding, PDF pages/images
are capped, and only three pages can be rendered. Images use at most a 1200px
long edge; unclear/downscaled fields require human review.

Models see inline original pixels and stable source IDs, never signed source
URLs. Both draft and independent checking invocations get the selected originals.
Associated text is explicitly untrusted and checker prompts ask about OCR
disagreements. Findings are schema/source validated. Missing/malformed findings,
disagreements and partial evidence cannot produce a visual pass. Deterministic
text checks run before visual adjudication so cannot erase it. Both invocations
currently use the same model: their errors can correlate; this is not document
authenticity certification.

Responses contain source references, page identity, hashes, provenance, coverage,
model and structured field findings. New history embeds contain bounded mode/
coverage/model metadata; old entries remain unchanged and are shown as not
image-checked. No raw pixels or signed URLs are put in audit history/webhook
payloads. The short-lived, tenant/user-keyed response cache retains only the
normal answer/metadata. Citation links require authentication and serve private
normalized images with no-store and sandbox headers.

Operator-only `/api/nyan-ai/ai-budget` reports aggregate calls, estimated/charged
tokens/USD, reported-usage counts, audit/image counts and configured limits.
`unpricedCalls` identifies legacy throughput-only calls before central pricing
is configured; their missing price is not a claim that the provider was free.
No document contents, credentials or private media links are telemetry.

## Model gate and evaluation

The adapter currently targets **OpenRouter `openai/gpt-4.1-mini`** as an
evaluation candidate, not a measured superiority claim. It accepts inline
`image_url` data and JSON-schema checking. Provider routing denies data collection,
requires ZDR and disallows fallback; unsupported contracts fail explicitly.
At a 1200px long-edge maximum, the documented 32px patch × 1.62 formula fits
within the conservative **2490 image-token allowance per repeated image**.
The public catalogue check on 2026-10-23 confirmed image/text/file inputs,
text output, `response_format`/structured outputs and listed $0.40/M input,
$1.60/M output for this candidate. These are catalogue prices, not measured
audit costs or a pinned-provider upper bound. Prices must be checked against
the selected route before approval.

Official reference sources:
- https://openrouter.ai/docs/llms.txt (current image-input/routing documentation index)
- https://developers.openai.com/api/docs/guides/images-vision
- https://openrouter.ai/api/v1/models (current image/text capabilities and pricing)

Deterministic fixture checks validate separate original-bearing calls, wrong
OCR disagreement, valid/invalid evidence references, partial/unavailable
coverage and cost failure behavior. They do **not** establish real model
accuracy. A live synthetic/redacted evaluation still needs the operator's
budget and data-handling approval. Record: correct field accuracy, deliberate
OCR-error detection, false approval/review rate, schema validity, latency,
actual usage/cost and unavailable-provider behavior against the current
text-only baseline. Do not enable `contractApproved` on mocked results alone,
do not benchmark real tenant documents, and do not replace the chat model.

Initial verification used synthetic fixtures; their receipts and amounts are
fabricated. The browser pass reached login only, so authenticated modal behavior
is not claimed as browser-verified. The user subsequently authorized a scoped
live-book test through valid bearer authentication. That text-only audit
succeeded with `sourceLimit=1`, zero inspected images, limited discovery and
human-review status. An image-enabled request correctly returned the disabled
configuration gate. No source-ledger records were changed or bulk media scanned.

With explicit one-test approval capped at $0.05, an isolated live validation
then inspected **one** original image selected from three recent message
references. Draft and separate source-check calls both received the pixels;
the checker returned one valid, source-linked `supported` finding. Reported
usage was 3,359 tokens and $0.0016508. Coverage remained partial and the outcome
required human review. Normal HTTP image auditing stayed disabled throughout.
This is a live contract/integration check, not a population accuracy benchmark
or a recommendation to enable private image audits for all users.

The single-image operator script uses an in-process, explicitly approved policy
and a request-level monetary ceiling, with shared database reservations and a
provider `max_price` bound. It never writes the general feature configuration,
logs source contents, or scans more than three recent source-message references.
