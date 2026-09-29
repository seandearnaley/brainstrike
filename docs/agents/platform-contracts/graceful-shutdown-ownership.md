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
- exit before ack: `exited-unclean`, carrying the code, unless the marker proves the close
  (below).
- ack timeout: SIGTERM, then an exit is `exited-unclean` (carrying the code) unless the
  marker proves the close; no exit: SIGKILL, then `killed` unless the marker proves it.
- ack error (the host's close failed): SIGKILL, `close-failed`.

The rule: a close is clean iff the host acknowledged it, or, after exit, the clean-shutdown
marker `<profile>/.db-clean-shutdown` exists and its `pid` equals the exited host's pid
(remembered while the process was alive: Electron clears `pid` at exit; the path is
`joinProfileDirectory()`, which main reaches through `resolveDesktopDatabaseProfileDirectory()` and the host through its `getAppDataPath()`). The exit code is never proof. An
unreadable marker is logged at error and counts as no proof. Measured with the repo's Electron 44.4.5 on macOS (`utilityProcess.fork` of a
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

The host's side is fail-closed too. Before, `tryCloseDatabaseInstance`,
`closeLocalDatabase` (ignoring a `syncToFs` failure), the failed-open close and
`resetLocalDatabaseInternal` (ignoring a close failure before `rmSync`) all swallowed
errors and released the process lock anyway. Now `closeLocalDatabase` throws
`DatabaseCloseError` (`stage: 'sync' | 'close'`, sync still followed by the close) and
keeps `.db-process.lock`; a failed close after a failed open logs and keeps the lock but
leaves the open error primary; reset and factory reset abort before any backup or
deletion, so a close failure leaves the database in place. A clean close writes
`.db-clean-shutdown` (tmp file, fsync, rename, directory fsync) before releasing the
lock; opening records `previousShutdown` (`clean`, `unclean`, `new-database`) in
`DatabaseDiagnosticsSnapshot` and removes the marker before the database opens, so a
crash later reads as unclean. The marker lives in the profile directory, so a reset
deletes it with the rest of the profile.

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
- Round 2, A. `close()` with no live host now sets `#closing` too (`close()` in `db-host-manager.ts`; a
  close with nothing departing stays a no-op). Before, a request waiting in `#admit` could fork a
  fresh host at the moment that close reported closed. It now re-checks, sees `#closing`, and rejects
  with `DbHostUnavailableError`. Guard: "rejects a request waiting on the barrier when close() runs
  with no live host, and forks nothing".
- Round 2, B. Intended, not a code change: after a failed close, once the host's exit is observed, a
  later `close()` or `closeDbHostManager()` RESOLVES. Nothing owns the directory, and the missing
  clean-shutdown marker records that session as unclean, so the next open reports `unclean`. Guard:
  the `afterExit` case of "never reports a repeated close as success while the host may still be
  alive" (both the manager and the default-manager variants). It is also in `close()`'s JSDoc.

### Update (2026-09-29, BST-1872 L1 review round): the failed close is sticky

Review of the fail-closed close found it released the guarantee one call later: after a close
failed, `db` was null, so the next `closeDatabase()` returned early as a success, a reset went
on to back up and delete the directory, and a lazy open passed the process lock (re-entrant for
its own process) and opened a second PGlite over the first. Fixes, all in `db-main.ts` unless noted:

- H. `mutableState.closeFailure` is set by every failed close of a live handle: `closeLocalDatabase()`
  (sync or close stage) and the failed-open cleanup. While set, `closeLocalDatabase()` (checked
  BEFORE its "nothing to close" return) throws a `DatabaseCloseError` of the same stage whose
  `cause` is the first failure; every reset and corruption-recovery entry rejects through it
  before any backup or `rmSync`; initialization rejects (`initializeMainDatabaseInternal`, before
  the process lock) saying the handle may still own the data directory and BrainStrike must
  restart. The lock stays and only process exit clears the state (the test reset helper aside).
  `DatabaseDiagnosticsSnapshot.closeFailure` exposes `{ stage, message }`. The host's `close`
  handler already answers a rejection as `ok: false`, so main's ladder SIGKILLs the host; the
  next host reads no marker, so its open is unclean and WAL replay runs.
- I. Runtime corruption recovery therefore fails closed when the close fails: it never deletes a
  directory a handle may own. Intended, not a regression.
  Superseded by BST-1870 L4: runtime corruption recovery no longer exists; an integrity error
  contains the database and never resets it (`platform-contracts.md` § DATABASE INTEGRITY CONTAINMENT).
- J. `db` is assigned only after the pgvector validation; the handle being opened lives in a
  separate `openingHandle` that only the failed-open cleanup reads. Before, `getLocalDatabase()`
  and `initializeLocalMainDatabase()` returned `db` without awaiting the single-flight promise, so
  a concurrent caller could receive the unvalidated handle. The DB host's serial queue
  (`db-host-entry.ts` `drainQueue`) hid this in production; the module's own API did not.
- K. The marker is consumed by the open attempt: a failed open leaves none, so the next open
  reports `unclean` (conservative by design).
- L. Only an open removes a marker, and only a close of an opened database writes one. A host that
  never opened the database writes none, so a stale marker naming its (reused) pid can only
  certify the close of a host that held no database, which is true.
- N. `writeCleanShutdownMarker` removes its `.tmp` when the rename fails (a failed cleanup logs at
  warn), and `hasCleanShutdownMarker` accepts only a regular file, not a directory at the path.
- Round 2, C (round 3 wording). `closeAfterFailedInitialization()` always tries to close the failed
  handle (releasing its WASM instance and file handles), then releases the lock only if no close
  has ever failed, this one or an earlier one. Since D, the "earlier one" case cannot be reached
  through a close racing an open; the rule is one condition, not a separate branch. The guard
  test covers a close that waits for a failing open whose own cleanup close fails.
- Round 2, D. `closeLocalDatabase()` first awaits an in-flight open (`settleInFlightOpen()`), then
  closes what that open produced; every reset and corruption-recovery entry goes through it, so
  nothing is backed up or deleted while a handle is opening. `resetLocalDatabaseInternal()` also
  loops until no open is in flight after its close (the code after the loop is synchronous, so no
  open can start between that check and the deletes). The open never awaits a reset, so it cannot
  deadlock. Failed opens are already recorded and reported to their callers, so the wait ignores them.
  Round 3: the loop gives up after three closes if something reopens the database on every lock
  release (it would otherwise livelock), rejecting with a message that nothing was deleted.
- Round 2, E. `writeCleanShutdownMarker` removes its `.tmp` after a failure in ANY step of the write
  (open, write, fsync or rename), with the same warn-on-cleanup-failure rule, and still throws.
- Round 2, F. A directory at the marker path is not a marker and cannot be unlinked as one, so
  every open fails as a `filesystem` failure before the database opens and deletes nothing.
  Fail-closed and intended; the marker must be removed by hand. Pinned in `db-main.close.test.ts`.
  Linux reports the unlink as `EISDIR` where macOS reports `EPERM`; both are filesystem codes
  (the Linux CI run caught the missing `EISDIR`).

### Update (2026-09-29, BST-1872 L2a): the DB host closes itself on signals

**Why the host closes itself.** `pnpm dev` runs `concurrently --kill-others` under turbo.
`concurrently` 10.0.5 (`kill-on-signal.js`) forwards SIGINT, SIGTERM and SIGHUP to every command
and kills through `tree-kill` 1.2.2, which on darwin walks `pgrep -P` and signals every
descendant, children first; `kill-others.js` sends SIGTERM to the rest when any command exits.
So main AND the DB host receive the signal directly, while main reaches its database step last on
turbo's external force-kill clock. Rejected: ignoring the signal and letting main drive the close
(waits on that clock, risking a SIGKILL mid-checkpoint), `--kill-signal SIGKILL` (reintroduces hard
kills), moving Vite into Electron (larger, not needed). A JS handler does run in a utility process
(measured with the real app, Electron 44.4.5: the log shows `DB host received SIGINT` and the host exits 0).

**What it does.** `beginClose` is single-flight. The host stops serving, rejects the queued
backlog with `DB host is closing (SIGINT).`, lets the in-flight envelope finish (never the close
envelope itself), unsubscribes live queries, then calls the same `closeDatabase()` a close
envelope always used, which writes the marker. It posts `lifecycle` messages (`closing`, `closed`,
`close-failed`), answers diagnostics while closing, joins a `close` envelope to the close in flight,
and rejects every later data envelope (before, one queued behind `close` lazily re-opened PGlite).
It exits 0 only after a successful close, but the code is informational: main proves a clean close
by the acknowledgement or the marker naming the host's pid, never by the exit code. The exit waits
one macrotask after the close settles, so the replies to the in-flight and joined `close`
envelopes (posted from promise callbacks) are queued first: main sends `close` and the tree-kill
signal reaches the host at almost the same moment. The wait orders the replies before the exit; it
does not guarantee their delivery, so the marker, not a reply, stays the proof.
A later signal after `closed` exits 0 at once (its replies are long posted); after `close-failed`
it exits 1 at once. The host's log line and `lifecycle` messages are best effort: a host that
exits promptly can lose what it posted just before exiting (one E2E run in four lacked the log
line), so the marker naming the host's pid, not a message, is the proof of a clean close.
`isDbHostToMainMessage` checks a `lifecycle` message field by field (`state` in `closing | closed |
close-failed`, `reason` in `request | SIGINT | SIGTERM | SIGHUP`); a malformed one is logged as
malformed and never trusted, because main refuses to fork on it.

**A signal during a transaction.** The in-flight envelope finishes, queued transaction envelopes
(a commit among them) are rejected with `DB host is closing`, and the close still completes; the
open transaction is never committed. Measured with the repo's PGlite on a real data directory:
`BEGIN; INSERT` (2 rows visible inside), `close()`, reopen: 1 row, so the uncommitted work is
discarded when the database closes. `db-host-entry.signals.test.ts` pins the host's side (the
queued commit is refused and never reaches `exec`, and the close completes).

**A failed close.** `closeDatabase()` rejecting makes the host exit 1 without a marker (only a
fully clean `closeLocalDatabase` writes one), keep `.db-process.lock`, log
`DB host failed to close the database` and announce `close-failed`. It is never retried: the close
is single-flight, later signals exit 1 without re-entering it, and a later `close` envelope is
answered with the first failure. That also holds against the sticky `closeFailure` of `db-main.ts`
(note H above), which would reject any second attempt anyway.
`db-host-entry.db-main.test.ts` drives the signal path through the real host entry over the real
`closeLocalDatabase` with an injected engine failure (sync and close stage) and asserts no marker
file, the lock kept, exit 1 and no second attempt; its control shows the marker written, naming the
host pid, before the exit 0 of a clean signal close.

**A signal mid-open.** The open is the in-flight envelope (`init`, or the lazy open inside a data
envelope), so the close waits for it through the serial queue, and `closeLocalDatabase()` waits for
any open in flight again (`settleInFlightOpen()`): two layers, each sufficient on its own, so
nothing ever closes underneath an open. The same test file pins both outcomes: the open settles and
its handle is what gets closed (marker written, exit 0), and an open that then fails is cleaned up
by its own failure path, so the signal close finds nothing to close and exits 0 with no marker.

**A signal before the database was ever opened.** `closeLocalDatabase()` has no handle to close, so
it writes no marker and leaves one from an earlier session untouched; the host still announces
`closed` and exits 0. That marker names the earlier session's pid, so it is no proof for this host,
barring pid reuse: if the OS gave this host the earlier pid, main would read the marker as proof and
refuse a replacement. That fails closed (restart BrainStrike), and the close ladder shares it. `db-host-entry.db-main.test.ts` pins it (a mutation that writes the marker without a handle
turns the test red).

**Main's side composes with the departing-host barrier.** A host that closes on a signal aimed at
it and exits is simply an attached host that exited: the manager's `exit` handler detaches it
through `#detachHost` (already exited, so no departing host is left behind) and records why no
replacement may fork, `unavailableAfterOwnExit()`. Main closes a host only by detaching it first,
so an attached host that closed itself received a signal: it announced that, or, when the
announcement was lost, the clean-shutdown marker names its pid (read through the same profile
directory as the close ladder, with the pid remembered before the exit). An unreadable marker is
no proof and is logged. That reason lives in the same `#unavailable` slot as retirement, which
`#assertActive()` checks first in `#admit()` and `getDatabase()`, so no request forks a replacement
and none waits on an exited host. A host main closed itself (the ladder's SIGTERM included) is
detached before it exits and never counts, marker or not.

**Known gap: every lifecycle announcement lost.** Main forks no replacement once it receives a
`lifecycle` message with a signal reason in any state (`closing`, `closed` or `close-failed`) or
reads a marker naming the host's pid. A failed close writes no marker, and neither does a signal
close before any open, so if every announcement is also lost, main sees an unexplained exit and the
next request forks a replacement while main is still serving. The replacement opens the directory
as after a crash: the dead host's lock is reclaimed as stale (`isPidAlive`), and the missing marker
makes the open unclean. Nothing is deleted, and the never-opened case changed nothing on disk.
Loss is not rare: `DB host received <signal>` is posted over the same port in the same tick just
before `closing`, and one E2E run in four lacked that line, so `closing` was most likely lost in
those runs too; their database was open, so the marker proved the clean close. Accepting `closed`
and `close-failed` as well (`db-host-manager-close.test.ts`) helps only against an isolated loss:
they are posted later, closer to the exit, so a loss at exit takes them before it takes `closing`.
Not closed, because nothing else tells this exit apart from a crash; the exit code is never proof.

### Update (2026-09-29, BST-1872 L2b): main's signal handlers and the reserved database-close slice

**Why the database close has its own slice.** One 5 s budget covered eleven steps, the database
tenth. At the deadline the running step aborts and later steps do not run, so a slow earlier step
skipped the only step whose skip damages durable state; every other skipped step loses only
in-memory work. A clean run measured `database` 441 ms and all steps 767 ms (main log, 2026-09-29
04:58:48). The close is now `DesktopShutdownRunPlan.closeDatabase`, run after the ordered steps
whether they finished or the deadline aborted one, bounded by `DB_HOST_CLOSE_BUDGET_MS` (3.5 s).
The forced exit waits for it (`exit(1)` after it), the backstop covers both budgets, and the
durable error log closes last. `database` became `database-drain` (it stops what issues database
work) and `error-log-sink` left the sequence. A failed close after a deadline is logged at error,
through a guard, so a throwing logger cannot cancel the `exit(1)`. "Fix the slow owner, never
raise a budget" stands.

**After a deadline the database closes without its drain.** The aborted or skipped
`database-drain` (trigger graph, sampler, live-query cleanup, scheduler idle join) has not run,
so admitted work may still be in flight. That is accepted and needs no extra code: the DB host
rejects every queued envelope with `DB host is closing`, lets the in-flight one finish, then
closes, and the callers of the rejected work get a typed error instead of a hang.

**The close budget is the end-to-end bound.** `DB_HOST_CLOSE_BUDGET_MS` = 3500 ms = ack 2000 +
exit after SIGTERM 1000 + exit after SIGKILL 500: `closeDatabase()` awaits
`DbHostManager.close()`, whose waits are exactly those three rungs (the departing-host wait is a
single 500 ms rung, and a host with nothing to close returns at once). `db-host-manager-close.test.ts`
pins it both ways: a host that survives every signal settles at exactly the budget, not a
millisecond earlier, and an acknowledgement landing just before its timeout still fits. Worst-case
signal-shutdown exit time: the 5000 ms step deadline plus 3500 ms = 8500 ms, and the backstop
fires at 8750 ms (plus `DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS`, 250 ms) if the orchestration itself
failed.

**Measured, Electron 44.4.5, macOS (2026-09-29): main's JS signal handlers.** A probe main with
`process.on('SIGINT'|'SIGTERM'|'SIGHUP')`:

| handler registered | first signal | later signal |
| --- | --- | --- |
| at module scope | handler never runs; Electron's own handler calls `app.quit()` (`before-quit`, exit 0) | with quit prevented, the default action killed main (`code=null signal=SIGINT`) |
| inside `app.whenReady()` | handler runs (window creation and a forked utility process change nothing) | handler runs every time |

So the original `process.once` in `main.ts` never ran, which is why "Received shutdown signal"
never appeared, and Electron's one-shot conversion is what a second signal defeats. In the real
app the `whenReady` registration alone still did not run: `when-exit` 2.1.5 (electron-store 11 ->
conf 15 -> atomically 2.1) calls `process.once` for SIGHUP/SIGINT/SIGTERM at import and re-raises
the signal against the process; Node arms libuv's watcher only for a signal's FIRST listener, and
Electron's handler displaced that early watcher. `main/shutdown-signals.ts` therefore installs
from `app.whenReady()` and drops the existing listeners first, so ours arms a fresh watcher; they
are not restored (each is logged by name), because they exist to die by the signal and this
shutdown ends through `app.quit()`, where their `exit` hooks still run. Real app, three SIGINTs 40 ms apart: before,
main died from SIGINT mid-shutdown (only "MCP runtime shutdown cleanup completed" logged); after,
`Received shutdown signal`, two `Shutdown already in progress; ignoring signal`, `Graceful
shutdown completed` (`trigger: signal`), exit 0. A signal before ready still reaches Electron's own
handler (quit through `before-quit`); a second one before ready cannot be caught. Linux and Windows
are unmeasured: if the re-arm fails there, the first signal still quits through `before-quit`.
A failure while installing the handlers is logged at error (through a guard, so a throwing logger
cannot escape) and never stops boot. A signal whose listeners the install had not yet removed still
quits through Electron's own handler (`before-quit`, the graceful run); one whose listeners it had
removed takes its default action and skips the graceful run, which the error log says.

### Update (2026-09-29, BST-1872 L2c): the signal E2E

`e2e/shutdown-signals.desktop.test.ts` delivers to the real app the pattern `concurrently`'s
tree-kill and the tty group produce: SIGINT to the DB host, SIGINT twice to main, then SIGTERM to
both. It expects exit 0 within 10 s with no `forcing exit`, and the log to show
`Received shutdown signal`, `Shutdown already in progress; ignoring signal` and `Graceful shutdown
completed` (`trigger: signal`). The clean-shutdown marker must exist and name the HOST's pid (only
the host writes it), and after `restart()` the next boot reads `previousShutdown: 'clean'` with the
inserted row present.

The host's own `DB host received SIGINT` log is not asserted: one run in four lacked it, because
what the host posts can be lost when it exits soon after. `closing` goes out over the same port in
the same tick right after that line, so it is lost the same way, which is why the marker, not a
message, is the proof of a clean close and why the manager falls back to the marker when it decides
not to fork a replacement.

The negative control SIGKILLs main and then the host (main first, so a renderer request can never
fork a replacement host in the gap): no marker, and the next boot reads `unclean`. The host also
dies with main on its own: measured 3 times on macOS (Electron 44.4.5), `SIGKILL` of main alone
left main gone after 22, 18 and 19 ms and the host gone after 75, 70 and 70 ms (polled with
`kill -0` for up to 10 s), so the positive spec needs no host SIGKILL in its failure path; the
negative control still kills it explicitly, which is deterministic rather than a race. The positive
test waits for the process's `close` (stdout drained, so the log assertions see the whole run, and
the DB host, which inherits main's stdio, must be gone too); the negative control waits for `exit`,
because a SIGKILLed tree can leave a sibling holding the pipe open and `close` would then time out
for a reason unrelated to the crash being simulated.

A real-app run before the after-ready fix failed at `Received shutdown signal`, with the graceful
run logged as `trigger: before-quit`. The spec runs in the regression project, not the smoke lane.
It is skipped on Windows, which has no catchable POSIX signal (`process.kill` ends the process at
once). It has only run on macOS: the first Linux regression run is the measurement for the
after-ready listener replacement. `ElectronHarness.endOutOfBand` marks such an exit intentional
first, so `ElectronProcessExitGuard` does not fail the test for it, and keeps the app until its
exit is confirmed: if the test body throws or returns with the process still running, the harness
SIGKILLs and awaits it before rethrowing, so a failed run cannot leak an Electron process. The
spec asks for `LOG_LEVEL=info` through `test.use({ electronEnv })`, which the harness passes to
every launch (restarts included) ahead of its own variables, never by mutating `process.env`.

**Not done: Step 0.** It needs a person at the terminal (turbo/concurrently pgids, which process got
which signal, ms from Ctrl-C to turbo's force kill). The E2E delivers the signal pattern instead. If
turbo force-kills before the marker is written, file a follow-up; do not work around turbo here.
