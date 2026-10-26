# ADR-0026: Lifecycle: readiness by message, liveness by exit, joined quit

- **Status:** Accepted (Sean adopted the lifecycle redesign's recommendations, 2026-10-20);
  R4 amended by [ADR-0027](0027-canonical-electron-quit.md)
- **Date:** 2026-10-20
- **Follows:** [ADR-0015](0015-desktop-platform-ipc-reset-diagnostics.md),
  [ADR-0017](0017-cli-first-agent-host.md), [ADR-0018](0018-derived-sqlite-indexer.md)
- **Supersedes:** the "existing shutdown deadline" language in
  [ADR-0006](0006-scoped-desktop-maintenance.md) and ADR-0015, and every wall-clock
  budget that retired, killed or refused a live peer Brainstrike owns.

## Context

The same desktop build passed on a 2-core Windows machine (agent host attach median
4.6 ms) and failed on a hosted 2-core runner (1,000–1,466 ms for the same work). Core
count was not the variable; thread-pool and scheduler latency was, by 100–300×. No
calibrated number survives that, yet startup and quit were built from them: a 1.5 s
self-started attach budget that retired a host which had already answered, request
deadlines that killed responsive workers, and one 10 s [5 s] quit deadline that
abandoned the running step, skipped every later step (the physical native joins
among them) and exited 1, raced by an E2E harness closing on the same 10 s.

## Decision

The desktop lifecycle follows six rules. They must hold at any machine speed.

1. **R1 Durability.** Every durable fact has one owner and is written through at
   change time. Only three renderer writers keep a write-behind tail of at most 500 ms
   (thread workspace snapshot, Explorer state, panel layout), each with one awaited
   `flush()`. Nothing else in a renderer is joined at close.
2. **R2 Liveness.** A process is dead when the OS says so: utility `exit`,
   `child-process-gone`, `render-process-gone`, port or socket `close`. A slow reply
   is load, not death. No timer may retire, kill, refuse or permanently close admission
   to a live peer we own. A peer we only attach to (an external CLI host) is still
   refused when live but unreachable, and never killed.
3. **R3 Readiness.** A child we fork reports readiness, with what its parent needs, on
   the private channel the fork gave it. No file discovery, polling or socket handshake
   sits between Main and its own child. A stall is a warn and visible state; startup
   fails only on a `failed` message or an exit.
4. **R4 Quit.** Quit is one ordered, joined retirement with no global deadline. Main
   exits 0 once every owner settled. Physical native joins (parcel subscribe and
   unsubscribe, Windows git Job `terminateAndWait`, utility exits, hidden-window
   `closed`) are never skipped. The sequence is finite because each close is a bounded
   ladder we own, not because a clock abandons it. A slow step is logged with its name.
   The E2E harness joins the app's exit under the test timeout and requires exit 0;
   a harness SIGTERM is a failed test.
5. **R5 Timeouts.** A timeout may (a) bound a user-facing operation and refuse that
   operation alone, or (b) escalate a cooperative close of a child we own to a kill we
   own, after which the exit is still joined. It may never retire a live peer, skip a
   physical join, fail unrelated calls, close admission permanently or fall back to
   another write path. Queue time never counts. Each timeout constant names (a) or (b).
6. **R6 Identity.** Root lock with pid and OS start time, the lifetime port, the
   Windows DACL applied at host start and verified on every external lease check, and
   factory-reset deletion under its lease are unchanged.

Owner decisions taken with this ADR: no startup kill of our own host (a stall is
logged and shown); our agent host gets 30 s to exit after close, then `kill()` and a
joined exit; a visible renderer gets 90 s (30 s until 2026-10-26, which escalated
healthy renderers on hosted Windows runners) to acknowledge its close preparation, then
`destroy()` and a joined `closed`; the first window is not gated on host or index
readiness; the Explorer serializer worker is deleted on web too; a slow quit is
logged only, with no "quit anyway" dialog; the E2E delay seam is runtime-gated like the
existing `BRAINSTRIKE_E2E_*` seams.

## Consequences

- Main's quit has no forced exit. `exit(1)` remains only for an orchestration that
  breaks before its steps can run. The backstop and the stale database-close slice are
  deleted.
- Quit's one terminal reason is the typed native-index refusal of kind `closed`,
  reason `shutdown`. Boundaries keep it as a cause and log it at debug.
- Correctness is proven by deterministic delay injection
  (`BRAINSTRIKE_E2E_LIFECYCLE_DELAYS`), with each boundary delayed past the deadline it
  used to race, not by a fast machine.
- The work lands as four PRs: startup readiness (A), joined quit (B), durable UI flush
  (C) and worker cancellation instead of retirement (D). Contracts live in
  [platform contracts](../agents/platform-contracts.md) § "Graceful shutdown
  ownership" and [host lease](../agents/host-lease.md).
