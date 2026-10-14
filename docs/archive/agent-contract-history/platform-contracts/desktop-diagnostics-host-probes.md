# Main-log window, process counters, and the freeze watchdog — evidence

Supports `docs/agents/platform-contracts.md` § "P2a: NDJSON backstop + persistent Log Viewer source".
Read before changing the `desktopDiagnostics` reads, the process-counter sampler, or the main-thread watchdog worker. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Swarm diagnostics IPC and process counters (2026-09-15)**: two read-only calls
on the `desktopDiagnostics` preload bridge feed the thread debug pack when it is
built; nothing new is written to disk for them.
`desktop-diagnostics:read-main-log-window` (`readMainLogWindow` in
`diagnostics/main-log-window.ts`) validates `{ since, until }` with
`assertMainLogWindowRequest` BEFORE the provider runs: millisecond ISO-8601 UTC
instants exactly as `Date#toISOString()` writes them (the form pino's `isoTime`
stamps on every line, which the reader orders as strings — a whole-second
`…00Z` bound would sort after a `…00.500Z` line),
`until` not before `since`, at most 24 hours, not in the future. The handler is
async, so a malformed request always rejects. It returns the warn-and-above lines
of `brainstrike.log` and its rotated siblings inside the window, oldest file
first, capped at 2000 lines and 2 MiB keeping the newest (`droppedLineCount`,
`truncated`), plus marker counts over EVERY level in the window
(`unhandledRejections`, `wasmAllocationFailures`, `toolTimeouts`,
`emptyChildResults`). The rotated slot count derives from the rotating sink's
`DEFAULT_MAX_FILES`, so the reader cannot drift from the transport. A
crash-truncated line is counted in `malformedLineCount`, never thrown. A
parseable record with no `time` field (the main log written with timestamps
disabled) rejects instead of reading as an empty window, so the pack's manifest
records `hostLog: unavailable: Main log line N of <file> has no ISO "time"
field …`. A missing live log file rejects, and the provider rejects when file
logging is disabled.
Lines were already redacted by `logInternal` before pino.

`desktop-diagnostics:read-process-counters` returns `{ installedAt, samples }`:
the last 240 samples (2 hours at the 30 s `main-process-health` cadence) of heap
and RSS, WebAssembly `instantiate` / `compile` / `Instance` / `Memory` counts with
the last 20 failure messages, and native background task counts by status (or
`backgroundTasksUnavailableReason` when that read failed). The count is read by
`createProcessCounterSampler` (`diagnostics/process-counter-sampler.ts`) as
background-priority scheduled work (`process-counter-sample`, through
`runDesktopScheduledDatabaseWork` and db-main's `getDatabase`), never a raw DB
host call: scheduled work waits out the factory-reset barrier, so a tick cannot
reopen the database while reset closes and replaces the profile. The shutdown
`database` step calls the sampler's `stop()` before the scheduler idle join, so
a submitted sample is drained and later ticks record nothing and never reach
the database; the 30 s interval itself keeps running because it also writes the
`main-process-health` line. The counter wraps the
main process's `WebAssembly` once, installed by the bare side-effect import on
the first line of `main.ts` so later imports (PGlite, tokenizers, xxhash-wasm)
are counted; results and errors pass through unchanged. The `main-process-health`
log line carries each tick's WebAssembly counts and the newest background-task
counts ALREADY in the ring, never an await. A tick that skips its read because
the previous one is still outstanding takes no await, so its
`backgroundTasks: null` entry lands before the line is built: through a long
read the line reports a null count, not the last completed one, and
`previous sample still pending` stays in the ring. The ring is session state cleared by the
`process-counter-ring` factory-reset runtime entry, and `processCounters` is a
`DesktopPlatformDiagnosticsProviderName`, so a throwing provider is reported like
the others. The pack reaches both calls ONLY through `readThreadDebugHostProbe`
(capability probe, never `isElectron()`); a web build or an older preload
records `unavailable: no desktop diagnostics bridge …`. Paired:
`main-log-window.test.ts`, `ipc-desktop-diagnostics.test.ts`,
`webassembly-counter.test.ts`, `process-counter-ring.test.ts`,
`process-counter-sampler.test.ts`, `process-counter-sampler-main-wiring.test.ts`,
`desktop-platform-diagnostics.test.ts`, `thread-debug-host-probe.test.ts` and
`thread-debug-pack.test.ts`.

**Main-thread freeze watchdog (BST-342)**: the watchdog is a typed worker entry
at `apps/desktop/src/diagnostics/main-watchdog-worker.ts`, bundled as the flat
main-process output `dist/main-watchdog-worker.js`. It is never constructed from
an inline string or with `eval`. Packaged builds explicitly put the entry in
`app.asar.unpacked`, and `resolveMainWatchdogWorkerPath` rejects an unexpected
packaged layout instead of trying an ASAR path or another target. Development
resolves `main-watchdog-worker.js` as a sibling of the running bundled
module's own `__filename` (BST-1459), not `app.getAppPath()` — see the
Python-runtime and log-transport entries above for the same invariant and the
`dist/dist/` doubling bug it replaced, and deliberately not `module.filename`
or `import.meta.filename` either (see `bundled-sibling-path.ts`'s docblock:
one is empty under Vitest, the other empty in this file's esbuild `cjs`
output). An empty/missing `__filename` throws rather than falling back to a
`process.cwd()`-relative guess. Pinned
by `apps/desktop/src/__tests__/diagnostics/main-watchdog-path.test.ts`.

The independently-tested `main-watchdog-core.ts` owns the typed config,
heartbeat, suspend/resume protocol and diagnostic calculation. The worker uses
`performance.now()` as its monotonic elapsed clock for heartbeat/check aging;
`Date.now()` is used only for the emitted wall-clock timestamp. The main process
sends its current file-logging state during worker attachment, a heartbeat every
5 seconds, and a new config after every successful runtime logging-preference
change. Enabled file logging requires its configured destination; disabled file
logging sends `logPath: null`, retaining stderr diagnostics without inventing a
file destination.

The worker checks on the same cadence and emits only when heartbeat age is
greater than 20 seconds. CPU fields are per-check deltas
(`cpuUserDeltaMicros` / `cpuSystemDeltaMicros`), never cumulative process totals,
and the CPU baseline advances on every check (including healthy ones). The
worker attaches before the renderer starts loading, so logging IPC cannot race
its initial configuration. Electron main sends `suspend` before handling an OS
suspend and `resume` before handling an OS resume; those messages pause checks
and reset both heartbeat and CPU baselines. Suspension is bounded: if main never
delivers `resume`, two consecutive normal worker check intervals prove the
machine is scheduling again, reset the observation baselines, and re-enable
freeze detection. Lock/unlock does not pause the watchdog. If the worker's own
elapsed check gap exceeds two check intervals (10 seconds), it cannot
independently account for the main thread during that gap, so it resets the
observation baselines before enforcing configuration and requires a subsequent
uninterrupted missed-heartbeat window before reporting. This closes
phase-offset, expired-timer-before-resume, and missing-resume races.

A missing config after an observable freeze window, malformed message, invalid
counter, invalid enabled logging state, duplicate attach/detach, invalid
packaged path, or an fd-2 record that exhausts its bounded write policy throws.
Once the worker's exit event detaches the runtime,
subsequent delivery attempts are logged visibly and return failure to the
internal caller without throwing into unrelated power or logging-preference
orchestration. Node does not acknowledge `postMessage` receipt, so a send racing
worker exit may report enqueue success before the exit event is observed. Worker errors,
message-deserialization errors, and unexpected exits are logged by Electron
main; an exit stops the heartbeat timer and detaches the runtime only after a
confirmed successful initial config delivery. Failed initial attachment leaves
the runtime unattached, so the later worker exit cannot trigger a second strict
detach error. Controller and message-handler throws are also synchronously
written to fd 2 as `MAIN_WATCHDOG_WORKER_FAILED` before the worker exits, so the
failure remains visible while Electron main is frozen. A synchronous watchdog
bootstrap failure is logged at error level and does not make this
diagnostics-only subsystem a fatal dependency of app startup. There is no
alternate watchdog implementation.

On a freeze, the worker writes the structured diagnostic directly to file
descriptor 2 with bounded completion of partial writes and retry for `EAGAIN`,
so delivery does not depend on Electron main's event loop draining a worker
stdio message. It then synchronously appends the identical NDJSON record when a
log path is configured. An append failure
emits a second structured
`MAIN_WATCHDOG_LOG_WRITE_FAILED` record to stderr and keeps checking; the
failure is visible while the independent stderr channel remains usable, rather
than being swallowed or silently disabling the watchdog.
