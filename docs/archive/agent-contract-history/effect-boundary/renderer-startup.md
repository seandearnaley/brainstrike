# Renderer startup retry and readiness ownership

Supports `docs/agents/effect-boundary.md` § "Desktop composition refactors".

## Decision (2026-09-25, BST-1828)

Use Effect retry policies for visible development renderer connection and
hidden-host page loading. Effect callback completion and always-run finalization
own the hidden-host readiness wait's listener, pending registration and timer.
Promise APIs, window construction, role assignment and successful-window
ownership remain with the existing main-process lifecycle. This is not a Layer
graph or a new shutdown/reset owner.

The visible window keeps one deterministic URL, its 30 production attempts,
200 ms spacing between failures, exact log context and final cause. Test mode
retains its single attempt. A successful attempt and an exhausted policy add no
trailing wait. No alternate renderer URL or built-file fallback is introduced.

Hidden hosts keep three load attempts. Only the load failure is retryable;
target resolution, construction, role assignment, cleanup and disposal failures
remain terminal. A failed window is removed from the role registry and destroyed
before another is constructed. The next attempt waits for its `closed` event or
the existing 300 ms maximum, with the listener installed before destruction.
This is resource-release waiting, not a fixed backoff: the retry schedule itself
must not add spacing. Publishing the in-flight window before loading preserves
acceptance of the renderer's first status report.

Readiness registration still happens in the calling turn. Each wait settles once
and releases its resources on success, error, timeout or lifecycle rejection.
The native timeout remains inside the resource owner to preserve the existing
`setTimeout` input semantics. Initial predicate throws retain their original
value; later predicate throws retain their existing Error normalization.

## Qualification

The pinned RC's `Schedule.spaced` plus bounded repetitions models visible retry;
`Schedule.recurs` models hidden retry after the existing resource-release wait.
No unstable import or Effect runtime outside effect-kit is introduced.

The focused startup suites passed 75 tests. Characterization covers the 30-attempt
production policy, early window closure, terminal construction/disposal failures,
same-turn readiness, independent waiters, predicate and snapshot failures, and
timer/listener release. Removing `Effect.ensuring` made resource-cleanup tests
fail; reducing the production retry allowance to zero failed with one attempt
instead of 30. Both mutations were restored. Snapshot construction now runs
inside Effect so a factory failure rejects and finalizes the waiter instead of
escaping the EventEmitter callback and retaining its resources.

The main/test TypeScript programs and strict Effect diagnostics passed. The
canonical desktop build passed all 50 tasks. On base `39fcd7038`, main.js changed
from 2,698,158 raw / 574,862 gzip bytes to 2,699,453 raw / 575,228 gzip: +1,295
raw / +366 gzip using `gzip -9 -c`. Effect remains external, so this measures
bundled application code. No renderer or preload Effect import was added.
After rebasing onto parser-main `0cb0e3dd6`, the main bundle changed from
2,701,117 raw / 575,430 gzip bytes on that base to 2,702,411 raw / 575,799
gzip: +1,294 raw / +369 gzip. This is the incremental startup cost after the
provider-auth and parser-host changes.

The local readiness-wait benchmark used mocked Electron, 50 warmups and 500
successful wait cycles in each of three runs. Base median latency was
0.002125 / 0.002083 / 0.001958 ms (p95 0.004125 / 0.004125 / 0.004375 ms);
the candidate was 0.004250 / 0.004292 / 0.004000 ms (p95 0.008000 /
0.008083 / 0.008375 ms). The Effect owner roughly doubles this isolated
microtask cost; every cycle ended with zero retained listeners and timers.
These figures characterize the local mocked path, not Electron startup latency.
