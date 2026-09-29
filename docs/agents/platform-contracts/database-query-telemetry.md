# The BST-403 privacy boundary and its bounded buffers — evidence

Supports `docs/agents/platform-contracts.md` § "IN-MEMORY DATABASE QUERY TELEMETRY".
Read before adding a producer, a feature area, or a retained field to the query-telemetry collector. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
`packages/db/src/database-query-telemetry.ts` is the privacy boundary for
BST-403. Producers must choose one fixed feature area (`file-tree`,
`live-query`, `queue-stats`, or `token-estimation`) at the typed call site. Do
not infer feature ownership from SQL text or labels. The collector keeps an
independent rolling one-minute buffer of at most 512 duration samples **per
feature** plus a separate bounded arrival-count bucket stream. Query count and
rate therefore remain independent of the duration-sample cap; sample count
remains the number of retained percentile inputs. The collector exposes counts,
failures, p50/p95/max duration, live subscription/update frequency, token-cache
hit rate, and an explicit retained-sample overflow count to System Diagnostics.
Query arrivals, failures, and token lookup/hit totals each use exact bounded
rolling buckets rather than being reconstructed from the capped percentile
samples. Overflow buckets use the evicted sample's occurrence time and therefore
expire with the evicted sample.
Counts use a boundary-inclusive bucket interval and can therefore retain up to
one coarse bucket of events older than the strict duration-sample cutoff. A
nonzero count with zero retained percentile inputs at that boundary is expected.
The card renders every per-feature count, failure, p50/p95/max, and overflow
dimension plus the raw live-update count, so warning attribution is visible;
the one-minute count and its derived per-minute rate are deliberately not shown
together as duplicate values.
External-store notifications are coalesced to one-second updates; while a
subscriber is active, reads return the published snapshot identity until the
coalesced notification publishes a replacement. Producers do not sort or
rebuild snapshots on every query. A monotonic Performance clock owns sample and
count-bucket retention; the wall clock is used only for the externally reported
`snapshotAt`. The per-feature cap therefore evicts the oldest duration sample
directly, while query arrivals and overflow events are bucketed at their
occurrence time. Module
construction is clock-free; the first collection or external-store read
validates the monotonic clock and fails loudly if it is unavailable.

The collector is memory-only and deliberately process-local. It retains no SQL,
parameters, rows, paths, filenames, queue names, or content, and requires no
factory-reset wiring. Runtime records accept only the declared feature,
duration, failure, lookup, and hit fields; unknown keys and malformed values
throw before a sample is retained, and caller fields are captured exactly once
before validation and retention. Query duration and retention both use the
monotonic performance clock. File-record counts and selected-file token SUMs
are measured alongside the other production reads; SUM samples contribute
duration and failure data with zero lookup and hit counts. Live-query histogram
samples represent start and refresh query executions on both renderer and
Electron paths; subscription lifecycle, update delivery, and teardown are
tracked separately. A direct unsubscribe stops delivery to the unsubscribed
listener before its async teardown settles, so the scheduler releases its one
supported locally counted listener exactly once on the first teardown attempt.
The scheduled wrapper owns this terminal state itself — it admits exactly one
listener and rejects subscribe/refresh once released — rather than inheriting it
from the raw PGlite handle: as of PGlite 0.5.5 (BST-1283) a raw handle stays live
after one of several listeners unsubscribes, where it previously terminalized for
all of them. Nothing here subscribes twice to one handle, so that upstream change
is inert. Repeated unsubscribe is idempotent, while subscribe and refresh reject
on the released scheduled handle; callers must create a fresh live-query handle.
Folder-wide token-cache preloads record duration/failure with zero lookup and hit
counts.
Concurrent Electron teardown callers share one remote stop attempt;
a rejected stop remains retryable while renderer-local listener and counter
ownership release exactly once. Production wrappers log telemetry failures,
including an unavailable timing clock, at error level while preserving and always
executing the database operation's original success or rejection. Each producer
latches an unavailable clock and logs it once rather than emitting an error for
every subsequent operation. The collector also suppresses repeated timer callbacks
after its retention clock fails; retained metrics become zero, clock-independent
live-subscription ownership continues to update, and an explicit
imperative `snapshot()` read still throws the latched error. External-store reads
instead return one stable snapshot marked `failed` with the precise reason, so a
React diagnostics surface can render the failure without crashing. The clock-free
package regression imports the public database package entrypoint. There is
deliberately no public reset: clearing the singleton could invalidate
live-subscription ownership held by active proxies. Paired coverage
lives in
`packages/db/__tests__/database-query-telemetry.test.ts`,
`database-work-scheduler.test.ts`,
`database-work-scheduler-live-handle.integration.test.ts`,
`use-live-query.test.tsx`, the token-cache and
Drizzle token/file repository tests, and
`packages/app-shell/src/__tests__/system-diagnostics-panel.test.tsx`.

The background token indexer has a separate renderer-local telemetry stream in
`packages/token-cache/src/telemetry.ts`. System Diagnostics subscribes only
while the panel is mounted: `useIndexerTelemetry` creates the subscribing
aggregator inside its effect, and every effect instance disposes that aggregator.
Do not move subscription creation into render or a memo initializer; StrictMode
and abandoned concurrent renders can otherwise retain a raw-event listener after
the panel closes. The panel shows rolling one-minute aggregate latency, cache-hit
rate, throughput, token count, error count, and explicit retained event count.
Expected binary-file exclusions remain terminal file outcomes but never emit an
`indexing_error` event or contribute to that error count.
Cache-hit-only windows render a neutral latency glyph because they contain events
but no timed indexing work; `No samples` remains the whole-window state. The view
receives a deliberately projected aggregate object: raw
events contain composite keys, folder ids, paths, and error messages and must
never cross into the diagnostics card. Token-cache database duration and lookup
hit rate remain owned by the `token-estimation` feature above. The old
selection-change-to-estimate metric is no longer a meaningful asynchronous seam:
selected-token summaries read the already-built in-memory map synchronously, so
do not add a timer or debounce around that read solely for diagnostics.
