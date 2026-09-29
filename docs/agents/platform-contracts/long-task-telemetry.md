# Renderer long-task telemetry: retention, clocks, failed snapshots — evidence

Supports `docs/agents/platform-contracts.md` § "DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)".
Read before changing long-task retention, its clock handling, or how System Diagnostics renders a failed window. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---

**Performance telemetry is a separate in-memory signal, not a fabricated
warning event.** Renderer long tasks (BST-400) are observed only in the visible
renderer by
`packages/app-shell/src/diagnostics/renderer-long-task-telemetry.ts`, retained
in a bounded one-minute/512-sample window, and shown in System Diagnostics.
Only duration, the coarse app route, and enabled feature-flag identifiers are
retained. The app shell accepts feature flags only from an authoritative
app-owned registry; when no registry is wired, the snapshot and System
Diagnostics say that the context is unavailable instead of treating an empty
placeholder as "no flags active." The observer remains mounted across route
changes, requests buffered `longtask` entries so pre-effect startup stalls are
not discarded, and reads current context at delivery time. Feature-registry
availability changes publish immediately rather than waiting for another stall.
Availability shown for a non-empty rolling window is derived from the retained
samples; mixed known/unknown flag context is surfaced as partial and never
rewritten to "no flags active" by a later registry transition.
Retention is owned by the telemetry store: expiry and cap eviction remove stale
context without a diagnostics subscriber and release it no later than the next
external-store read. Any retention-clock failure outside a render-phase
`getSnapshot` releases retained samples and dedupe keys immediately, even if the
failure is transient, so an aborted timer cannot leave identifiers resident
without a replacement expiry deadline.
A render-phase `getSnapshot` clock failure is the one exception: it publishes an
empty failed snapshot and does not mutate backing storage. The already owned
retention timer or the next non-render collection/publication entry point
performs the pending destructive cleanup. Buffered observer entries are retained
from their occurrence timestamp and deduplicated across observer replay. An
observer entry whose duration is negative, whose start maps after delivery,
whose start time is negative, or whose completion exceeds delivery by
more than the one-millisecond Performance API rounding tolerance, is malformed
and fails the observation.
Because the Performance Observer entry has no historical app context, a buffered
sample explicitly carries delivery-time route and feature-flag context; System
Diagnostics labels those fields as delivery-time context and must not imply that
context was captured at the original stall time. Occurrence timestamps, window
pruning, and retention deadlines share the Performance timeline's monotonic epoch
clock; `Date.now()` must not drive this
retention boundary because wall-clock adjustments would split the clocks. The
module singleton is constructed without reading that clock: the first observer,
record, or external-store read validates it, and observer setup publishes a
local `failed` snapshot if the timing capability is unavailable instead of
failing shell import. An initial external-store read before the observer effect
mounts follows the same explicit failed-snapshot path. Injected retention clocks
remain coherent with real `PerformanceEntry.startTime` values by mapping each
entry age into the injected clock domain. Buffered-entry dedupe keys survive
sample-cap eviction until the entry leaves the rolling window, so replay cannot
create a spurious publish.
They use stable Performance entry identity (`startTime` plus duration), never
the delivery-time clock mapping, because replacement observers can deliver the
same buffered entry at different times.
Unsupported or failed `PerformanceObserver` setup is represented explicitly in
the snapshot; it never silently degrades. Unsupported observation releases
retained samples, dedupe keys and the retention timer before publishing an
explicitly empty window without consulting the timing clock; disposing that
inactive observation repeats the release before the caller sees the idle state.
The empty snapshot carries
the last successful monotonic timestamp rather than fabricating a new clock read,
or the explicit epoch-zero sentinel if no clock read has succeeded yet. Direct
recording after unsupported observation is known throws instead of creating a
hidden retained window, and failed observation has the same explicit rejection.
A malformed entry fails and disconnects its observer loudly, but valid sibling
entries from the same delivered batch are retained and published with that failed
snapshot; their expiry timer remains owned even if a later batch insertion fails.
Distinct malformed causes are reported together with their original errors
preserved. A delivery failure reuses the validated delivery timestamp for the
failed snapshot rather than probing the clock again. The observer Performance
clock is read after the delivery epoch clock, conservatively biasing occurrence
mapping slightly earlier for retention. A non-finite or negative long-task
duration or injected clock result fails collection visibly. System Diagnostics
keeps the retained sample count visible on active, idle, and failed cards so
aggregates always have an explicit denominator. Mixed feature-flag context also exposes the
known-context sample count against the total retained sample count; flag counts
must never imply they cover samples whose flag context was unavailable.
Disposing a failed inactive observation preserves its precise reason if the clock
is still unusable rather than claiming recovery. Reset always clears retained
context; when the timing clock is unusable, the failed state remains latched
instead of claiming an idle collector. Do not write routine performance samples
into
`brainstrike_diagnostic_events`: that table is CHECK-constrained to warn+
failure signals, drives the unseen-diagnostics chip, and is the wrong cardinality and
severity model for continuous performance measurements.
