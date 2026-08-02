# Diagnostics Privacy Contract

Brainstrike diagnostics must preserve the product's local-first trust boundary.
Performance telemetry exists to help find slow paths and regressions; it is not a
channel for collecting user content, local workspace identity, or provider
credentials.

This contract applies to background telemetry, diagnostics panels, performance
budgets, regression suites, and future diagnostic exports unless a narrower
feature-specific contract is documented.

## Default Background Telemetry

Background telemetry may collect operational measurements that are useful without
identifying a user's local files, prompts, or content. Acceptable default fields
are:

- durations
- counts
- byte sizes
- process labels
- feature names
- coarse route or surface
  identifiers
- queue depths, retry counts, and bounded error categories
- cache entry counts, eviction reasons, and residency durations

Telemetry names should describe product surfaces or subsystems, not user data.
For example, `file-explorer.expand.duration_ms` is acceptable; a metric keyed by
a specific local path is not.

BST-403's database-query telemetry applies that boundary at the producer. It
retains a bounded rolling minute of duration, failure, lookup, and hit counts
under four fixed feature identifiers: `file-tree`, `live-query`, `queue-stats`,
and `token-estimation`. It never retains SQL, parameters, query results, queue
names, file paths, filenames, or content. The collector is process-local and
memory-only; it is not written to the diagnostic event store or exported. Each
feature has an independent bounded duration-sample buffer and a separate bounded
arrival-count bucket stream. Query count and rate report bounded-bucket rolling
executions above the sample cap; top-level sample count remains the number of
retained percentile inputs. Failure and token lookup/hit totals use exact bounded
rolling buckets rather than capped duration samples. Retention overflow is
reported only as a numeric dropped-sample count and is timestamped at the evicted
sample's occurrence so it expires with that sample. Counts are reported over a
boundary-inclusive bucket interval, which can retain up to one
coarse bucket of events older than the strict duration-sample cutoff; a nonzero
count with zero retained percentile inputs at that boundary is expected. Runtime
records are fail-closed: unsupported keys or malformed values throw before
retention, and the collector captures each caller field once and
copies only explicit allowlisted fields into each sample. Selected-file aggregate token queries
record duration and failure only, with zero lookup and hit counts; live-query
histograms count start and refresh query executions rather than teardown.
Folder-wide token-cache preloads also report zero lookup and hit counts. Direct
PGlite wrappers support exactly one listener, release that ownership exactly once,
and make repeated unsubscribe idempotent even when cleanup rejects. Subscribe and
refresh become terminal when teardown starts, so the handle must be recreated;
concurrent Electron callers share a retryable remote-stop attempt without
reacquiring local ownership. A missing telemetry clock is logged visibly once per
producer, timer callbacks stop attempting telemetry publication, and explicit
imperative snapshot reads continue to fail loudly. External-store reads expose a
stable failed snapshot with the precise reason so diagnostics can render the
failure without crashing, while the wrapped database or token-cache operation
always runs. Measurement-clock failure remains latched for the failed clock
identity; token-cache timing failure remains latched for that store.

## Prohibited By Default

Background telemetry must not collect these values by default:

- raw file paths
- filenames
- prompts
- file content
- embeddings
- provider keys
- raw local database rows
- source snippets, chunks, or generated answers
- stable hashes of user content, filenames, prompts, or file paths

Redaction after collection is not enough for these fields. The default path must
avoid collecting them at the source.

## User-Initiated Diagnostic Export

A user-initiated diagnostic export is different from background telemetry.
Exports may include richer local state only when the user explicitly starts the
export flow and can inspect what will be shared. Export flows must:

- explain which categories of data are included
- exclude prohibited background telemetry fields unless the user explicitly opts
  into that category
- prefer summaries, counts, and timing data over raw records
- provide a local review step before anything leaves the device
- make deletion and regeneration possible without contacting a remote service

The export format should remain useful when sensitive categories are omitted.

## Consent For Data Leaving The Device

Anything leaving the device requires explicit consent unless it is already part
of a user-directed network operation, such as calling a configured model provider
with the user's prompt. Diagnostics upload, support bundle sharing, and remote
telemetry opt-in must be separate choices from normal local app usage.

Consent copy must name the data categories being sent. It must not rely on broad
phrases such as "usage data" when content-adjacent or workspace-adjacent fields
are included.

## Ticket References

Current and planned telemetry work should reference this contract:

- BST-376: tree snapshot bytes, rehydration, flatten, and row-build timing
- BST-400: renderer long-task telemetry with route and feature context
- BST-401: background CPU and wakeup metrics by process
- BST-402: embedding batch bytes, cache residency, and vectors-in-flight telemetry
- BST-403: DB query histograms by feature area

These tickets may add metrics covered by the default allowed list. If a ticket
needs anything outside that list, it must document the consent and export path
before implementation.

BST-400 is implemented by
`packages/app-shell/src/diagnostics/renderer-long-task-telemetry.ts`. It keeps a
bounded, one-minute in-memory window of durations, coarse app routes, and
enabled feature-flag identifiers only; it never records attribution data, DOM
selectors, paths, filenames, or content. Feature-flag identifiers are accepted
only from an explicitly injected authoritative registry. If an app has no such
registry, diagnostics reports the feature context as unavailable rather than
recording a fabricated empty list.
The telemetry store owns expiry and cap eviction: stale context is removed
without a diagnostics subscriber and released no later than the next
external-store read. A retention-clock failure outside `getSnapshot` releases
samples and dedupe keys immediately, including when a retrying read succeeds, so
no identifier loses its expiry owner. A render-phase `getSnapshot` clock failure
publishes an empty failed snapshot without mutating backing storage; the already
owned retention timer or the next non-render collection/publication entry point
performs the pending destructive cleanup. Dedupe-key expiry is scanned on every
retention pass even when no sample expires. Buffered long-task entries use
their occurrence timestamp for the rolling window and are deduplicated across
observer replay, including after an in-window sample-cap eviction. Performance
entries whose duration is negative, whose start maps after callback delivery,
whose start time is negative, or whose completion exceeds delivery by more than
one millisecond fail observation as malformed timing instead of recording an
impossible sample. The one-millisecond completion tolerance covers sub-millisecond
Performance API rounding only. Performance
Observer does not preserve historical app context, so buffered
samples carry delivery-time route and feature-flag context and diagnostics
labels them as delivery-time context rather than stall-time attribution.
Occurrence timestamps and the one-minute retention boundary use
a single monotonic epoch clock, never the adjustable wall clock.
Module construction is clock-free; collection validates timing, and a missing
timing capability is
reported through a failed in-memory snapshot instead of breaking app-shell
module evaluation. The initial external-store read also returns that explicit
failed snapshot before the observer effect mounts. A failed clock read is not
immediately retried to fabricate a timestamp; the snapshot uses the last
successful monotonic timestamp and keeps the failure latched. An unsupported
snapshot published before any successful clock read therefore carries the
explicit epoch-zero sentinel. Buffered replay
deduplication uses stable Performance entry identity rather than delivery-time
clock mapping, so replacing an observer cannot count the same buffered entry
twice. Dedupe-key capacity eviction uses occurrence time rather than callback
delivery order.
A delivered PerformanceObserver batch performs retention, cap eviction, timer
scheduling, snapshot rebuilding, and listener publication once after inserting
all eligible entries; startup replay therefore produces one snapshot publication
per delivered batch instead of one per sample. Clock failures from collection,
external-store publication, direct recording, reset, or retention expiry all
converge on the same failed snapshot without escaping through renderer effects.
When an operation and the clock both fail, diagnostics preserves the operation
failure and appends the clock failure instead of discarding the originating cause.
Unsupported observation releases retained samples, dedupe keys, and the retention
timer before publishing an explicitly empty window without reading the clock.
Direct recording after observation is known to be unsupported throws instead of
creating a hidden retained window, and the same explicit rejection applies after
observation has failed. A malformed, non-finite-duration, or future-dated
observer entry fails collection visibly while valid sibling entries in that
delivery remain available in the failed snapshot. Their expiry timer remains
owned even if a later batch insertion fails. Distinct malformed causes in one
batch are reported together with their original errors preserved. A delivery
failure reuses the validated delivery timestamp for its failed snapshot instead
of probing the clock a second time; any non-finite injected clock result takes the
normal failed-snapshot path. The observer Performance clock is read after the
delivery epoch clock, so occurrence mapping is conservatively biased slightly
earlier for retention. Disposing a failed inactive observation cannot claim
recovery while that clock remains unusable, and therefore preserves the precise
failure reason. Active, idle, and failed diagnostics labels retain the sample
count so every displayed aggregate has an explicit denominator. Mixed
feature-flag context separately reports the known-context sample count against
the total retained sample count. Reset clears all identifiers but keeps a clock
failure latched rather than reporting idle.
The snapshot is visible in System Diagnostics and is discarded with the
renderer process, so it adds no persistence or factory-reset obligation.
