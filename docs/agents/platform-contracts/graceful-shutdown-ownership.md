# Shutdown ordering, the forced-exit budget, and the measured forced exits — evidence

Supports `docs/agents/platform-contracts.md` § "Graceful shutdown ownership (hidden hosts and background indexing)".
Read before adding or reordering a shutdown step, or before raising a shutdown timeout. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
### Graceful shutdown ownership (hidden hosts and background indexing)

`main.ts` runs its ordered shutdown steps under ONE forced-exit budget
(`SIGNAL_SHUTDOWN_TIMEOUT_MS`, 5s), armed for both signals and `before-quit`.
Do not raise that budget to absorb a slow
step; fix the owner. Settled rulings, each with a paired test:

- The forced-exit log names the step still awaiting completion and its elapsed
  time (`shutdown-step-tracker.ts`). That record is the only actionable fact a
  CI runner leaves behind, so it is a product log, not temporary instrumentation.
- `before-quit` delays Electron's normal window closing while app cleanup runs.
  After retiring embedding-backfill admission, the first tracked step closes
  and joins ordinary renderer windows
  with `BrowserWindow.close()` / `closed`, while their IPC dependencies still
  exist (`close-desktop-renderers.ts`). Hidden chunking/embedding/LLM windows
  stay alive for their owning stop commands. Normal close preserves unload and
  window-state hooks; macOS activation cannot recreate a producer and
  second-instance and macOS `open-file` requests cannot enqueue work or show a
  window during this drain.
  Already-admitted database work then drains through the existing
  scheduler before database closure. The new `joins renderer IPC producers before
  closing their hosts` case in `app-launch.test.ts` keeps real renderer DB/chunking
  requests active across quit and rejects observed renderer console errors and
  main-process IPC failures. Renderer console capture is observational until the
  page closes; process output and the owned-process exit assertion remain available
  through shutdown.
  Its owned-process close assertion uses a 5s test deadline; the application retains
  the separate existing `SIGNAL_SHUTDOWN_TIMEOUT_MS` 5s forced-exit budget above.
- Shutdown retires embedding-backfill admission FIRST
  (`cancelAllDesktopEmbeddingBackfills()` before any host step), and a backfill
  that arrives after `markDesktopShuttingDown()` is refused before it touches
  the host (`ipc-embedding-backfill.test.ts`). Background indexing keeps
  requesting backfills until its renderer dies; each request would otherwise
  restart the host the next step is stopping. Job rows stay durable.
- `EmbeddingHostManager.dispose()` refuses new starts BEFORE its cooperative
  stop awaits the renderer (`embedding-host-manager.test.ts`), and
  `RendererHostLifecycle.ensureStarted()` lets a `stopping` host settle instead
  of replacing its window (`renderer-host-lifecycle.test.ts`). Replacing the
  window mid-stop used to orphan the stop wait and let a timed-out stop destroy
  the replacement. Shutdown disposal waits at most 3s (`EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS`),
  below the unchanged 5s application deadline. Ordinary Stop and factory reset
  retain their existing 10s wait. Timeout or an explicit renderer
  error still destroys the owned renderer and retires its lifecycle, but rejects
  so the shutdown tracker records the failure instead of reporting a successful stop.
- The embedding worker wakes for `stop()` while awaiting a background permit,
  idle backoff, inter-batch delay, claim-size retry, or error backoff via a stop
  signal (`embedding-worker-stop-idle.integration.test.ts`). A stopped permit
  waiter returns before claiming any job, even if its permit never arrives.
  Already-running batch work remains bounded by the existing `leaseMs` stop join;
  the stop signal does not cancel an embedding already executing. The first
  attributed local forced exit named `embedding-host` at 4998 ms: the host's
  cooperative stop was waiting for a worker parked in a 30 s idle poll.
- The assistant HTTP server's shutdown stop ends live connections after
  `close()` (`close-http-server.ts`, paired real-socket integration test). An
  already-closed listener (`ERR_SERVER_NOT_RUNNING`) is a successful repeated
  stop; other close failures remain visible. Plain `server.close()`
  waits for every in-flight response, and the first attributed CI forced exit
  named `assistant-server` at 5000 ms in the bare app-launch smoke case.

---
### Update (2026-09-24, BST-1819): the orchestration moved out of `main.ts`

`main/desktop-graceful-shutdown.ts` now owns the step order
(`DESKTOP_SHUTDOWN_STEP_ORDER`), the single forced-exit budget, the MCP
ordering check, the warn-before-sink order and the forced-exit log, on top of
effect-kit's `runShutdownSequence`. The in-flight tracking that
`shutdown-step-tracker.ts` did is part of that helper now; the file is gone.
`main.ts` keeps the step bodies. Step names, order, the 5s budget and every
log message are unchanged. At the deadline the running step's `AbortSignal`
now aborts before the forced-exit log. Record:
`docs/agents/effect-boundary/phase-three-lifecycle.md`.

### Update (2026-09-26): deferred HNSW recovery joins shutdown ownership

The worker-write Electron smoke passed, but shutdown canceled a backfill whose
HNSW index was suspended with two scoped jobs pending. Its deferred recovery
polled again after the DB host retired and logged a false terminal rebuild
failure. The deferred poll now observes shutdown before querying; the durable
suspension is reconciled by the next eligible maintenance run. This does not
change the embedding host's three-second stop timeout, which remains a separate
fail-visible shutdown step.

### Update (2026-09-29, BST-1872 L1): the DB host close is awaited

Before: `DbHostManager.close()` raced the close acknowledgement against 2 s, then
called `host.kill()` (Electron's `kill()` is SIGTERM on POSIX) without awaiting
`exit`, and the next request forked a second host at once, so two hosts could touch
one pgdata while the first died. A transaction-request or init timeout terminated the
host the same way. A SIGTERM cannot end a host wedged in synchronous WASM, so it was
never a wedge escape either.

Now `close()` resolves only when the database is proven closed AND the host process
is gone. The waits are `db-host-close-budget.ts` (ack 2 s, exit after SIGTERM 1 s,
exit after SIGKILL 0.5 s):

- ack ok: SIGTERM, await `exit` (any code is fine, the database is closed); no exit in
  time: SIGKILL, then `exit-timeout` if that still does not end it.
- exit before ack: always `exited-unclean`, carrying the code.
- ack timeout: SIGTERM, then any exit is always `exited-unclean` (carrying the code); no exit:
  SIGKILL and `killed`.
- ack error (the host's close failed): SIGKILL, `close-failed`.

The rule: a close is clean only when the host acknowledged it. The exit code is never
proof. Measured with the repo's Electron 44.4.5 on macOS (`utilityProcess.fork` of a
trivial child; 2026-09-29):

| child | terminated by | exit `code` |
| --- | --- | --- |
| no signal handlers | `child.kill()` (Electron API) | **0** |
| no signal handlers | `process.kill(pid, 'SIGTERM')` | 15 |
| no signal handlers | `process.kill(pid, 'SIGINT')` | 2 |
| no signal handlers | `process.kill(pid, 'SIGHUP')` | **0** |
| no signal handlers | `process.kill(pid, 'SIGKILL')` | 9 |
| `process.on('SIGTERM')` handler that calls `process.exit(0)` | `child.kill()` or SIGTERM | 0 (the handler ran) |
| handler that calls `process.exit(7)` | SIGTERM | 7 |

So a host with no handler that `kill()` ends reports 0, exactly what a clean exit
reports. JS SIGTERM and SIGINT handlers do run in the utility process, which the host's
own signal handling (L2) relies on.

Request and init timeouts SIGKILL, log at error with the request diagnostics, and no
replacement forks until the exit is observed. Nothing forks once
`markDesktopShuttingDown()` has run (`DbHostUnavailableError`); a host that already
exists still serves shutdown-time work. Not done here: signal handling in the host and
main, and the reserved database-close slice of the shutdown sequence (L2).

### Update (2026-09-29, BST-1872 L1 review round): the exit is the only barrier

Review of the awaited close found that its "wait for the exit" barrier was a promise for the
kill, not the exit, so a failed or unanswered SIGKILL released the next fork while the old host
could still own the data directory. The invariant now: no DB host forks, and no close reports
success, while a previous host may be alive; the only proof it is gone is its observed `exit`.
Admission that meets a departing host waits at most `DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS`, then
rejects with `DbHostUnavailableError`; it never forks and never waits unbounded. Fixes:

- A. `#departingHost` holds the detached `DbHostProcess` itself; only its own `host.exited`
  continuation clears it (identity-checked). `killWedgedHost`'s result gates nothing.
- B. One `#admit()` gate, re-run after every wait, guards every request that can fork
  (`send()` for every non-close kind, which is also how `getDatabase()` initializes). It stays
  synchronous when nothing departs so a request issued before `close()` is posted before the
  close envelope. `#ensureHost()` also refuses to fork while a host departs.
- C. Requests issued while `close()` runs reject with `DbHostUnavailableError` instead of
  queueing behind the close and forking a host after it.
- D. A repeated `close()` with no live host waits for the departing host's exit and rejects
  `exit-timeout` while it is still alive; it is never a silent success.
- E. A SIGKILL the OS refuses (EPERM) is caught inside the shared kill path, logged at error,
  and counts as "not exited", so every close rung reports `exit-timeout` and no caller sees a raw errno.
- F. `DbHostProcess.forceKill()` sends nothing once the exit was observed: the pid may belong
  to an unrelated process by then.
- G. The kill log follows the logger's `(message, context)` order. While a close is in flight
  `#terminateHost` returns early on purpose: the request-timeout `rejectAll` also fails the
  close request, which drives the close ladder's SIGKILL.
- Follow-up 1. The barrier also survives replacement of the default manager. When `retire()`
  rejects inside `closeDbHostManager()`, the failed manager is kept as `unexitedDefaultManager` before
  `defaultManager` is cleared. While its `hasDepartingHost()` is true, `getDbHostManager()` throws
  `DbHostUnavailableError` and builds nothing, so close, reset and reinitialize cannot fork a second
  host over the first. Once the exit is observed the slot is cleared and a new manager is built. A
  repeated `closeDbHostManager()` with no default manager waits at most one post-SIGKILL budget on
  that host and rejects `exit-timeout` while it is alive: finding D one level up. A close that
  ended with the host's exit observed (`close-failed`, `exited-unclean`, `killed`) sets no barrier
  and replaces the manager as before.
- Follow-up 2. `DbHostProcess` registers its `exit` listener in the constructor body, not inside the
  `exited` promise executor. A failed fork (no handle) or a throwing `once` now throws to the
  caller, as a failed fork always did; inside the executor it rejected `exited`, which nothing awaits
  until a close, and surfaced as an unhandled rejection that failed a CI shard.
