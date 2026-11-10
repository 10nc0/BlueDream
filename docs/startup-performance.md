# Startup performance and safety

## Import deferral: controlled process-start comparison

Three sequential fresh Node processes per version on the same development host,
with real bot **module/SDK imports**, real read-only schema metadata queries,
and simulated Discord login (1.2s) and repair/DDL round trips. The schema fixture
models migration 014 as applied. No inference or production-counter writes.
These are shared-host/file-cache-warm process measurements, **not** container
cold starts; filesystem cache state was not reset or measured.

| Milestone | Before median | After median | Before observed worst | After observed worst |
|---|---:|---:|---:|---:|
| Handshake → listener (imports + app setup) | 0.713s | 0.252s | 0.784s | 0.318s |
| Process → first worker-published breath | 2.708s | 2.260s | 2.970s | 2.398s |
| API registration ready | 2.689s | 2.643s | 2.923s | 2.705s |
| Process → second breath log | 9.186s | 8.737s | 9.448s | 8.877s |
| Worker-published first → second spacing | 6.478s | 6.478s | 6.478s | 6.479s |

First breath is **448ms / 16.5% earlier** at the median. Logical queries remain
9 and real read-only queries remain 4 through the second breath. The cadence
target remains 6.472s for inhale → exhale, then 4s for exhale → inhale. This
comparison isolates process startup; it does not claim that the earlier
reported 5.35s cold import observation will always fall by this percentage.

An initial, uncontrolled-cache scouting process took 3.694s from handshake to
listener and reached the first breath log at 6.130s. Its inclusive import trace
attributed 1.202s to the AI routes (including 0.892s in shared search/pipeline
code), 0.692s to Twilio, and 0.593s to Express. Subsequent before runs with real
bot imports had 0.205–0.275s in Discord and 0.201–0.210s in AI routes. This
large between-run variance is why the scouting sample is not mixed into the
matched comparison. Parent and child timings overlap and must not be summed.

Changes:
- Keep authentication, schema verification, AI admission middleware, capacity
  state and usage state in the mandatory startup path.
- Start the existing isolated heartbeat publisher after schema and budget setup.
  Defer books/pipe/AI/account implementation imports and bot connections until
  after the worker's initial observation. API readiness still waits for all
  route registration and error handlers. No route is lazily registered on a
  live request, and packet consumption retains its original counter gate.
- Bot constructors no longer import Discord. SDK loading occurs only when a
  configured connection is initialized. Twilio loads at signature validation
  (after the missing-token/signature checks), and Exa loads only for a configured,
  non-cache-hit search. Missing optional configuration does not load those SDKs.
- Record mandatory and optional import phases separately. Startup summaries
  distinguish process-to-first-publication from worker-publication spacing;
  benchmark JSON also records log-delivery timing and the cache/network caveats.

The real-service development restart reached the first breath at **2.158s**,
API registration at **2.417s**, and the second breath at **8.637s** (6.479s
publication spacing). Mandatory imports took 192ms; deferred route imports took
246ms. All four bots and healing became ready. This is one same-host development
process restart with an already-current schema, not a cold-container or
production latency guarantee.

## Earlier heartbeat-isolation comparison

Five sequential starts per version, development mode, unchanged 4s / 6.472s
breath timing. Kernel imports and database metadata reads are real; Discord
login takes a fixed 1.2s and maintenance DDL/writes are simulated at measured
database round-trip latency. No paid inference, book scan, or production-counter
write. The after fixture models migration 014 as applied without changing live
tracking. Every direct benchmark-client write is rejected.

| Milestone | Before median | After median | Before observed worst | After observed worst |
|---|---:|---:|---:|---:|
| API ready | 4.753s | 2.469s | 12.843s | 5.506s |
| First breath | 5.596s | 2.456s | 13.732s | 5.487s |
| Second breath | 12.069s | 8.928s | 20.204s | 11.960s |
| Logical DB queries through second breath | 14 | 9 | 14 | 9 |
| Real read-only DB queries | 6 | 4 | 6 | 4 |
| Observed event-loop histogram maximum | 28ms | 474ms | 30ms | 3576ms |

First breath is 56.1% earlier at the median. Second breath improves 26.0%;
the intentional interval between emitted breaths has **not** been shortened.
Logical queries include simulated maintenance SQL, so they are not billed-query
or production transaction counts.

These are controlled **process starts**, not guaranteed container-cold production
latency. File-cache state, DNS/TLS, database latency and Discord vary. Import time
remains material on cold reads. The native event-loop histogram does not include
the original entrypoint's initial fully synchronous import/probe block; awaiting
the new handshake allows subsequent imports to appear in the histogram. Do not
claim that event-loop delay improved or compare that histogram as a whole-start
CPU measure. Listener/import phase timings include the elapsed import cost.

Raw benchmark JSON belongs in ignored `generated-artifacts/`, not Git.

### Actual development restart

The final real-service development restart was healthy: API **10.780s**, first
breath **10.769s**, second breath **17.242s**, all four bots ready. This start
applied migration 014 for the first time and spent **6.392s** between the verified
handshake and imports-ready. It is not equivalent to the warm-schema fixtures
above. Further reduction of that cold module-loading cost is the next major
optimization; do not present the controlled 8.928s median as a production or
real-service cold-start guarantee.

After the monthly-trigger regression fix, a second actual development restart
with migration 014 already applied reached API at **8.404s**, first breath at
**8.388s**, and second breath at **14.862s**. All bots and maintenance became
ready. Cold imports still accounted for **6.011s**, confirming the remaining
module-loading bottleneck rather than a wait for healing or Discord.

## Dependency order

1. Resolve configuration and authenticate/TLS-check the **actual runtime pool**;
   preserve DATABASE_URL → PG-variable fallback and discard failed candidates.
2. Construct lightweight bot objects while ordered schema checks/migrations run.
   The warm check verifies *all* expected migration filenames, not just the
   newest one. Normal migration DDL and recording share transaction locks.
   Missing catalogued schemas fail closed rather than silently rebuilding empty
   tenant data or trusting stale tracking after an incomplete restore.
3. Once schema and budget setup are safe, begin durable heartbeat election.
   After the initial worker observation, start optional bot connections and
   import/register all routes. API readiness does not depend on Discord logins,
   but still requires complete route registration.
4. Only features actually needing a missing bot return `503 warming_up` with
   `Retry-After: 5`. Login, core metadata and shared AI budget enforcement retain
   their normal guards. Incoming webhooks are acknowledged only after durable
   enqueue; workers wait for Hermes plus a fresh, nonzero published counter.
5. Healing waits for both schema and Hermes. Hydration/retired repairs/heal
   recovery share a one-job maintenance queue with four pool connections
   reserved for foreground requests. Catch-up cleanup starts after 15 seconds,
   not as five simultaneous scans. Global housekeeping requires the production
   lease owner; per-process memory/usage cleanup remains local.
6. Shutdown closes readiness, stops timers/workers, rejects future background
   work, drains accepted queue processing within the existing bounded grace,
   destroys clients and releases ownership. Late startup completions cannot
   restart the heartbeat or schedule new jobs.

Request-time expiry checks do not depend on cleanup timing: dormant/null
noncreator phone associations cannot route messages; registered creators remain
exempt. A share accepted by registration within its invitation window remains
valid; late registration cannot revive an expired invitation.

Monthly takeover captures the due month instead of reinterpreting it after a
delayed bot becomes ready. Closing and email are independent, bounded retry jobs
with the existing durable once-per-month claim guards.

## Heartbeat ownership and first rollout

Session advisory locks obtained using `pool.query` are not reliable ownership
through a transaction pooler. Each production tick now atomically acquires or
renews a database-time 30-second owner lease **and increments the existing global
counter** in one statement. A stale owner cannot increment after takeover.
Followers may use a recently observed published counter; they emit no fabricated
breath. Failed counter queries clear readiness. Development never advances the
production counter.

Migration 014 adds nullable counter metadata, also used by existing mesh
snapshots. The ordinary migration gate must complete before leadership starts.
No AI limit or feature-activation setting is reset.

**Do not do an uncontrolled mixed-version rolling first publish.** Drain/stop
the old heartbeat process before promoting this version: the old unfenced code
cannot participate in the new lease protocol reliably through transaction
pooling. The transaction advisory guard respects a genuine legacy session
owner, but cannot retroactively fence unsafe old pooled-query ownership.
Check the new readiness endpoint, monotonic counter and exactly one publisher
during the controlled handover. No production deployment was performed here.

Rollback: stop the new publisher first, then use a pre-change checkpoint and
restart one old instance. Keep the additive metadata column and existing
monotonic counter; never reset counters, monetary usage or durable queues.

## Verification and reproduction

- `npm run test:startup`: dependency gates, bounded/deduplicated maintenance,
  foreground reservation, shutdown races, exact cadence, follower behavior,
  counter failure, migration gaps/restored-schema fail-closed checks and async
  resolver TLS/fallback/disposal tests. No external services.
- `npm run test:startup:kernel`: real kernel with read-only DB fixtures; 15s
  bots and separately 10s heal queries cannot delay the second breath; login/core
  access remains independent and authorization still applies.
- `npm run test:heartbeat:db`: isolated temporary schema only; simultaneous
  election, follower reads, release/expiry takeover, old-owner fencing, legacy
  transaction-lock guard, counter-write rollback and request-time expiry SQL.
  Drops only its own fixture schema. Requires development DB access.
- `node tests/test-clean-bootstrap.js`: isolated local PostgreSQL from an empty
  database, core/tenant migrations and existing onboarding/audit smoke checks.
- Existing `npm run test:unit` suite also passes.

Benchmark example (development DB metadata only):

```sh
NODE_ENV=development REPLIT_DEPLOYMENT=0 PORT=5501 \
STARTUP_BENCH_PROFILE=1 STARTUP_BENCH_REAL_BOT_IMPORTS=1 \
STARTUP_BENCH_ASSERT_DEFERRED=1 \
STARTUP_BENCH_OUTPUT="$PWD/generated-artifacts/startup-sample.json" \
node -r ./tests/helpers/startup-preload.js vegapunk.js
```

Use `mkdir -p generated-artifacts` first. `STARTUP_BENCH_REAL_BOT_IMPORTS=1`
uses actual bot classes and imports Discord at simulated connection time without
logging in. The default historical fixture replaces whole bot modules and is
not suitable for measuring their import cost. `STARTUP_BENCH_PROFILE=1` records
slow inclusive imports with their parent and start time, plus route/SDK imports
regardless of duration. `STARTUP_BENCH_ASSERT_DEFERRED=1` fails if optional
routes/SDKs load before the first published breath.

`node tests/test-startup-imports.js` checks unconfigured bot/Exa SDK avoidance,
configured bot failure behavior, and valid/unsigned/tampered Twilio signatures.
`node tests/test-startup-http.js` additionally checks schema/budget failure,
mandatory-before-optional ordering, authenticated route guards, and cadence
under slow bots, healing and a blocked application thread. Its exit grace lets
HTTP assertions finish after the delayed heartbeat log arrives.

`/health` remains liveness. `/health/ready` reports actual schema/core readiness,
per-service states, phase times, query count and counter/leadership freshness.
Startup timing logs contain metrics in the message itself because this project's
custom logger stream does not preserve structured log fields.
