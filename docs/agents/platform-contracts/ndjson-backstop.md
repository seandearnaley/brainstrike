# The desktop NDJSON backstop and the full INFO-log rotation — evidence

Supports `docs/agents/platform-contracts.md` § "P2a: NDJSON backstop + persistent Log Viewer source".
Read before changing `RotatingFileSink`, where the sink hangs off the logging choke points, the shutdown step order, or the factory-reset purge of the mirror. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Design doc: `docs/error-observability-design-2026-07-23.md` §7 (desktop file)
and §9 (UI surfaces). Wire format shared by both:
`serializeDiagnosticEventLine`/`parseDiagnosticEventLine`/
`serializeDiagnosticEventsNdjson`
(`packages/utils/src/diagnostics/diagnostic-event-ndjson.ts`) write/read a
`DiagnosticEvent` as one JSON line in a FIXED key order (`NDJSON_KEY_ORDER`,
declared explicitly rather than derived from object literal order) so a
`biome`/`ultracite` key-sort pass elsewhere in the codebase can never silently
reorder the wire format. `parseDiagnosticEventLine` returns `null` — never a
partial/coerced event — for a blank, malformed, or short-of-required-fields
line; this is deliberate, since a process crash can truncate the last line
written to the desktop file mid-write, and a tail-reader must skip that
partial line without the whole read throwing.

**Desktop NDJSON backstop** (`RotatingFileSink`,
`apps/desktop/src/diagnostics/rotating-file-sink.ts`, wrapped by
`createErrorLogSink`, `apps/desktop/src/diagnostics/error-log-sink.ts`):
writes `${app.getPath('logs')}/brainstrike-errors.ndjson`, warn+ only,
size-rotated at 10 MB × 5 files (the live file plus 4 rotated siblings,
`.1`…`.4`; the highest slot is dropped and every other slot promoted one
place on each rotation — drop-oldest, never unbounded growth). Skipped
entirely under `BRAINSTRIKE_DISABLE_FILE_LOGS=1` (every desktop
`test:e2e*` script sets this; the sink must not start writing files during
Playwright lanes). `writeLine` never throws — an open/write/rotate failure
(including a short `fs.writeSync` — a truncated line on disk is exactly the
kind of silent corruption "no silent fallbacks" forbids) permanently
self-disables the sink and reports the failure exactly once through an
injected `onFailure` callback; every write after that is a silent no-op by
design (the caller, a log listener, must never see the sink throw).
Constructor guards (`maxFiles < 2`, `maxBytes < 1`) throw synchronously —
malformed config fails setup immediately rather than surfacing later as a
confusing runtime write failure.

**Load-bearing ruling — do not relitigate**: the sink hangs off the two
`logging-ipc.ts` choke points (the main-process `addLogListener` tap and the
`logging:ingest-buffered-record` IPC handler, both already filtered to
warn+ by `DURABLE_PUSH_LEVELS`), NOT a pino `customTransports` target. Pino
transports run in a worker thread and only ever see main-process pino
output; they would MISS every renderer/hidden-host record forwarded over IPC,
which is most of what this backstop exists to catch. This is also why there
is no new rotating-log dependency (`pino-roll` etc.) — the rotation logic is
hand-rolled in `RotatingFileSink` instead.

MCP stdio child diagnostics join this existing path only after
`McpStdioDiagnosticCollector` has made each line bounded, line-safe, and
secret-redacted, including URL userinfo. Routine lines stay at `debug` and in
the bounded session snapshot; they are not persisted. A connection failure or
unexpected child exit takes one memoized failure report per server generation:
at most the last five sanitized diagnostics plus the number omitted. That one
`warn` is eligible for both the renderer diagnostic-event writer and the
desktop NDJSON backstop. The production `logging-ipc.ts` addLogListener choke
point, not a test-only listener, owns that handoff. Never log the raw stderr
chunk alongside it.

**Recursion rule**: nothing in the sink path
(`rotating-file-sink.ts`, `error-log-sink.ts`) may import or call
`@brainstrike/logging` — the sink is fed BY a log listener, so logging
from inside it would re-enter that listener and recurse without bound. The
one deliberate exception is a raw `console.error` (`reportSinkFailure` in
`error-log-sink.ts`), reused by both the sink's `onFailure` and the
try/catch around `logRecordToDiagnosticEvent`/`serializeDiagnosticEventLine`
in `recordLogRecord` (a BigInt anywhere in `record.args`/context throws out
of `JSON.stringify`; the record is dropped and reported once rather than
letting that throw escape into whatever code emitted the original log call).

**Shutdown ordering** (`apps/desktop/src/main.ts`,
`runGracefulShutdown`): the `error-log-sink` step is the LAST shutdown step,
and it runs after the aggregate `if (failures.length > 0) logger.warn(...)`
that logs every earlier step's failures — not merely after the `'database'`
step. Reordering it (e.g. closing the sink alongside `'database'`, or before
the aggregate warn) breaks the guarantee that the NDJSON file, "the last
writer standing," captures a shutdown-step failure (a throwing
`closeDatabase()`, say): closing the sink first makes `recordDurableLog` a
no-op for that very warn call, and the backstop would contain no trace of
it.

**Known gaps, recorded honestly**: `main.ts` has Electron side effects at
import time and no unit-test seam around `runGracefulShutdown`, so the
shutdown ordering above and the `BRAINSTRIKE_DISABLE_FILE_LOGS` construction
skip are inspection-verified only, not covered by an automated test. The
NDJSON file's `sessionId` is a fresh per-launch `randomUUID()`, independent
of the renderer's `getDiagnosticSessionId()` DB `session_id` — deliberately,
since the NDJSON backstop and the PGlite-backed DB sink are meant to be
independent failure domains — but it means a line in the file and a row in
`brainstrike_diagnostic_events` cannot be joined on `sessionId` alone.

**Shutdown-step failure reporting**: the `error-log-sink` step's result is
deliberately NOT routed through the aggregate `failures` array/warn — that
array's one consumer (the `if (failures.length > 0) logger.warn(...)` above)
has already run by the time this LAST step executes, so pushing into it here
would never be read by anything. A `close()` failure is instead logged
directly (`logger.error('Failed to close the durable NDJSON error log', ...)`
) — otherwise a real close failure (`RotatingFileSink.close()` deliberately
leaves `fs.closeSync` outside a try/catch; see its comment) would produce
zero output anywhere, a direct "no silent fallbacks" violation in the one
module whose entire job is loud failure reporting. The `errorLogSink` handle
is always nulled from a `finally`, even when `close()` throws, so a partial
failure can never leave a stale handle that a later `recordDurableLog` call
treats as still open.

**Reopen-after-close is real in `RotatingFileSink` and now reachable in
production via the factory-reset path**: `close()`'s doc comment describes
(and the class actually implements) a `writeLine` call after `close()`
transparently reopening the file rather than dropping the write. Two desktop
callers exercise `close()` with two different intents:

- Graceful shutdown (`main.ts`'s `error-log-sink` shutdown step) nulls its
  `errorLogSink` handle in the SAME step that calls `close()`, so
  `recordDurableLog` becomes a permanent no-op for the rest of the process's
  life once that step runs — a forced-shutdown timeout logged later by
  `scheduleForcedProcessExit` reaches console/`brainstrike.log` but never
  this NDJSON file. This is a deliberate choice, not a bug: nulling the
  handle keeps "the sink is torn down" simple and matches every other
  shutdown step's teardown-then-forget pattern.
- Factory reset (`main.ts`'s `error-log-sink` reset-runtime disposer, part
  of the `runtimes` list passed to `createDesktopFactoryResetHandler`) calls
  `close()` WITHOUT nulling `errorLogSink`. This runs before the purge below
  (`stopBackgroundRuntimes` completes before `resetDesktopApplicationData`
  deletes the files), specifically to avoid deleting a still-open file:
  on POSIX that would unlink the path while the live fd kept writing to the
  orphaned inode (records silently stop landing on disk until rotation or
  process exit); on Windows the delete would fail outright while the fd held
  the file open, yet reset would still report success. Leaving the handle
  non-null means the very next warn+ record after the purge reopens (really:
  recreates, since the file is gone) `brainstrike-errors.ndjson` from
  scratch — this is the first production path that actually exercises the
  reopen behavior; it was previously reachable only from this class's own
  tests.

**Factory reset purges the NDJSON mirror, not only the DB rows**: factory
reset (`desktop-factory-reset.ts`) already wipes
`brainstrike_diagnostic_events`. Without an explicit purge the NDJSON
backstop would survive that reset intact: the file lives at
`${app.getPath('logs')}/brainstrike-errors.ndjson`, and `logs` is in
`PRESERVED_USER_DATA_ENTRY_NAMES` — the very folder factory reset otherwise
leaves alone (it can also sit entirely outside `userDataPath`, e.g. on
macOS). `resetDesktopApplicationData` takes an optional `errorLogFilePaths`
list; `main.ts` passes
`listErrorLogFilePaths(path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME))`
(`error-log-sink.ts`) and the reset function best-effort `rm`s each path
(live file + rotated siblings) in its own pass, independent of the userData
entry loop that skips `logs` entirely. A purge failure is logged and
tracked in the result's `pendingDeletionPaths` — reported, never swallowed —
but does not fail the overall reset (the database + userData wipe that
already succeeded matters more than one diagnostics mirror file).
`brainstrike.log` (the full INFO log) is untouched by this purge and stays
preserved, same as before. The purge itself always runs AFTER
`stopBackgroundRuntimes` (see `resetDesktopApplicationData`'s call order),
which is what guarantees the `error-log-sink` disposer above has already
closed the fd by the time these `rm` calls execute.

**Full INFO-log rotation (BST-854)**: `brainstrike.log` now uses the standalone
Pino worker target `apps/desktop/src/diagnostics/main-log-transport.ts`, bundled
as the flat main-process entry `dist/main-log-transport.js`. Packaged builds
explicitly put that entry in `app.asar.unpacked`, and
`resolveMainLogTransportPath` rejects an unexpected packaged layout rather than
depending on worker-thread ASAR loading or silently trying another target.
Development resolves `main-log-transport.js` as a sibling of the running
bundled module's own `__filename` (BST-1459) — not `app.getAppPath()`, which
is launch-mode-dependent and can already point at `dist/` itself (see the
watchdog entry below and the Python-runtime entry above for the same
invariant and the bug it replaced), and deliberately not `module.filename`
(a synthetic shim with no `.filename` under Vitest) or `import.meta.filename`
(empty in this file's esbuild `cjs` output) either — see
`bundled-sibling-path.ts`'s docblock. An empty/missing `__filename` throws
rather than falling back to a `process.cwd()`-relative guess. Pinned by
`apps/desktop/src/__tests__/diagnostics/main-log-transport-path.test.ts`. The
target passes Pino's already-delimited bytes unchanged to the same
`RotatingFileSink` used by the diagnostic backstop: 10 MB × 5 files,
drop-oldest slot math, encoded-byte accounting, short-write failure, and
append/mkdir preference semantics. It coalesces complete records up to each
rotation boundary, preserving line-granular rotation without a synchronous
write per record. Sink failure reports exactly once through the worker's raw
console channel and disables only the file sink; it does not error the shared
Pino transport stream and take the console target down with it. The ordinary
`file` logger configuration carries the custom target through both
initialization and every runtime preference reconfiguration;
`applyLoggingPreferences` throws if Electron main enables file logging without
an explicit target, because falling back to `pino/file` would silently restore
unbounded growth.
`brainstrike.log` and its rotated siblings remain deliberately PRESERVED by
factory reset. They are the full operational log, not a plaintext mirror of
the reset diagnostic table. Shutdown still owns no new main-thread sink handle:
Pino's worker lifecycle is unchanged, while the warn+ NDJSON sink remains the
explicit last graceful-shutdown writer described above.
