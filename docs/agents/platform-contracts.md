# Platform Contracts: Logging, Factory Reset

> Extracted from AGENTS.md (2026-07-12). Read before adding persistence or changing logging. Keep updated with the code.

## LOGGING (PINO V10)

Centralized logging: packages/utils/src/logger.ts

Usage:
- Use initializeLogging from @brainstrike/utils.
- Set runtime: browser | electron-main | electron-renderer.
- Desktop main:
  - Logs to console + ${app.getPath('logs')}/brainstrike.log
- Web/renderer:
  - Call initializeLogging in main.tsx.

Log levels:
- trace, debug, info, warn, error, fatal, silent
- Configure via:
  - setLogLevel(LogLevel.DEBUG)
  - LOG_LEVEL=debug (env)
- Priority: code > env > defaults.

Structured logs:
- Prefer objects:

  logger.info('User authenticated', { userId: '123', method: 'oauth' });
- Brainstrike's public logger is message-first; its Pino boundary reorders the
  declared `(message, metadata)` overload to Pino's object-first form. Tests
  must prove metadata reaches the transport, not only `addLogListener`.

Scoped loggers:
- createLogger('FileImporter')

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Structured arguments and listener bindings are recursively redacted before transport,
  buffering, or display; transport serializers alone are not a sufficient boundary.
- Add more via redactPaths.

Testing:
- Use addLogListener instead of mocking console.

---

## FACTORY RESET CONTRACT

“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/preferences/src/settings/system/factory-reset-helpers.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys (e.g. `hook-trust-store` — the
      security-sensitive per-root hook approvals; reset drops every approval so a
      re-mounted repo's hooks require fresh review — see TOOL-LIFECYCLE HOOKS).
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Desktop reset order:
1. Dispose embeddings.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

Database-owned assistant persistence added outside Mastra's tables must also
be cleared explicitly. This includes `brainstrike_assistant_message_parents`,
the assistant-ui carousel/branch topology companion store (migration 055), and
`brainstrike_assistant_tool_output_artifacts`, the complete-result store
(migration 068). The artifact relation is independently retained and has no
Mastra FK, so both direct-PGlite reset and desktop `db:clearAll` must delete it
explicitly; only a pre-068 missing relation is tolerated.

Mastra's own `mastra_workflow_snapshot` is the one Mastra-owned table that must
also be cleared explicitly (BST-558). It has an UNBOUNDED lifetime — its only
deletes are `deleteWorkflowRunById` (no production caller) and
`dangerouslyClearAll` (tests) — and a suspended run retains its pending tool
call and arguments, so it must not survive a "true fresh start". It is cleared
in BOTH reset paths: desktop `db-ipc.ts` (`clearLazilyCreatedRelation(tx,
MASTRA_WORKFLOW_TABLE)`) and `db-provider.tsx`'s
`clearWorkflowSnapshotsIfPresent` (used by direct-PGlite clear AND
`purgeTablesTx`). The relation is created lazily by
`PgliteWorkflowsStore.initialize()`, so only a MISSING relation (assistant
never ran) is tolerated; every other delete failure stays visible. The
remaining `mastra_*` tables (`mastra_threads`, `mastra_messages`,
`mastra_vectors`, `mastra_observational_memory`, …) are still NOT in either
list — a known gap, not a ruling.

**A relation that can legitimately be ABSENT must be PROBED, not
deleted-and-caught.** Both reset paths run their whole body inside ONE
transaction, and PGlite is real Postgres: a statement error puts the transaction
into the ABORTED state, after which every command fails with `25P02 current
transaction is aborted, commands ignored until end of transaction block` until
ROLLBACK. Catching the original `42P01` does NOT undo that, and there are no
savepoints anywhere in this repo — so a tolerated missing-relation error rolls
the ENTIRE reset back and the user's Clear Database silently does nothing. Use
`SELECT to_regclass('<table>') IS NOT NULL AS present`, which returns NULL
instead of raising, and skip the `DELETE` when absent (BST-558 review). This
matters most for lazily created relations (`mastra_workflow_snapshot` is created
by `PgliteWorkflowsStore.initialize()` and by NO migration, so "absent" is the
normal state for a never-used assistant), and it is why desktop has BOTH
`clearOptionalRelation` (delete-and-tolerate, for migration-created tables whose
absence is a legacy-schema edge) and `clearLazilyCreatedRelation` (probe-first).
A probed relation's `DELETE` is deliberately NOT wrapped in a catch: nothing in
this repo ever DROPs `mastra_workflow_snapshot`, so the probe/delete race is
unreachable, and a tolerated `42P01` there could not recover anyway — it would
leave the transaction aborted and resurface as a misleading `25P02`.

**The probed table name must come from `MASTRA_WORKFLOW_TABLE`
(`@brainstrike/assistant-contract/mastra-memory-schema`), never a local
literal.** `to_regclass` on a stale name returns NULL, which turns the probe
into a PERMANENT SILENT SKIP — no error, no warn, only a `logger.debug`. Both
production sites and every test import the constant; a hardcoded copy would
survive a Mastra table rename with every test still green. Verified by control:
renaming `TABLE_WORKFLOW_SNAPSHOT` in the contract while `db-provider.tsx` held
the literal left a suspended-run row alive through a full clear
(`expected 1 to be +0`), and importing the constant made it pass.

**Narrow every catch in a purge to `isMissingNamedRelationError`.** A bare
`catch (err) { logger.warn(...) }` cannot be a tolerance inside a transaction:
the first genuine error aborts it, every later statement fails `25P02`, each of
THOSE is swallowed too, the purge returns normally, and `COMMIT` on an aborted
transaction degrades to `ROLLBACK` WITHOUT raising — factory reset reports
SUCCESS having cleared nothing. This was measured, not reasoned: against real
PGlite, an FK violation on `job_queue` with the old bare-catch tail made
`useFactoryReset()` resolve while every table still held its rows. The
`purgeTablesTx` tail now routes through `clearMigratedRelation`, which tolerates
only "relation does not exist" (BST-558 review).

Known remaining debt: the ~14 desktop `clearOptionalRelation` call sites still
delete-and-tolerate rather than probe. That specific defect — a tolerated
`42P01` poisoning the transaction — is unreachable today because every one of
those tables is created by a numbered migration that has already run by the time
a clear starts; unlike the bare catches above, `clearOptionalRelation` already
rethrows everything that is not a missing-relation error, so it cannot mask a
genuine failure.

Two honest caveats on that paragraph, both raised in review (BST-558):

- It does NOT cover every remaining catch. The selection-snapshot block in
  `apps/desktop/src/ipc-domains/db-ipc.ts` (~`:750-757`) still swallows
  everything — it only *logs* non-missing-relation errors and never rethrows,
  the exact pattern removed from `purgeTablesTx`. It does not produce a false
  success on desktop (the next unwrapped `DELETE` raises `25P02` and the handler
  returns `success: false`), but the surfaced message is the misleading
  aborted-transaction error rather than the real cause. Not yet converted.
- A narrowed catch around a `DELETE` inside a transaction still cannot *tolerate*
  a missing relation, only report it more honestly: the tolerated `42P01` has
  already aborted the transaction, so the next statement fails `25P02` and the
  clear dies anyway. `clearMigratedRelation`'s warn branch therefore means "this
  is why the reset is about to fail", not "the reset continued". Probing with
  `to_regclass` is the only form that actually tolerates absence.

Add tests when changing reset behavior — and note that a mocked `tx.query`
CANNOT reproduce aborted-transaction semantics. Reset changes that depend on
them need a real-PGlite `*.integration.test.*`
(`packages/db/__tests__/clear-data.integration.test.tsx`,
`apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`).

### Persistent command-session lifecycle

The desktop command-session registry is main-process, memory-only state. It is
configured once from the same DB-backed workspace-root resolver as git and the
human terminal, survives renderer reloads, and is never written to the database
or browser storage. Therefore it needs no storage deletion, but it MUST be
disposed before process/database teardown:

- graceful shutdown awaits `disposeDesktopCommandSessions()` inside the
  assistant-server shutdown step;
- factory reset owns a `command-sessions` runtime disposer;
- `fs:removeRoot` disposes only sessions owned by the durable DB root id
  returned by its path-keyed disconnect update (adapter ids can diverge); and
- manager disposal clears retained exited output as well as reaping live PTYs.

Bulk disposal must settle every reap attempt and log a missing PTY exit
acknowledgement; one stuck PTY must never skip later application shutdown steps.

Retained-output reads preserve valid UTF-16 surrogate pairs across bounded page
boundaries. A high surrogate without a following low surrogate fails explicitly
with `invalid-buffer`; it must never produce a retry-without-progress page.

Never log or persist command text, cwd, environment, or retained output. Adding
durable restart survival changes the privacy/reset contract and requires a new
reviewed persistence design; it is not a transparent extension of this registry.
The hosted native-tool bridge preserves that rule with transcript-only
allowlist transforms, producer-owned list/output pages, and an explicit
non-durable native-tool partition that artifact settlement must skip. Do not
replace those pages with generic artifact settlement: that would create a
seven-day copy of memory-only PTY data.

### Browser preference hydration

Zustand stores that choose between the Electron storage bridge and
`createBrowserJsonStorage()` must not resolve that platform adapter while the
module graph is still evaluating. Optimized Web chunking can place preferences
and storage exports in mutually dependent chunks; `createJSONStorage` catches a
factory error at that point and constructs a store without the `persist` API.

The `createJSONStorage` callback must return a locally declared async proxy
without reading imported runtime bindings. Zustand can call `getItem` during
store construction, so the proxy crosses a microtask boundary before invoking
its local platform-adapter factory. Successful resolution is memoized so later
browser operations keep their synchronous behavior. A failed resolution clears
the pending promise and is retried by the next operation; factory and operation
errors propagate unchanged. Do not call an imported lazy-storage helper from
this path: Rolldown may fold that binding into the cyclic consumer chunk and
leave it unavailable even after initial chunk evaluation. This preserves the
Web persistence capability without hiding a genuinely broken adapter. The
production-build regression is covered by
`apps/web/e2e/web-db-worker-startup.test.ts`, which treats both console errors
and unhandled page errors during startup as failures in the PR smoke lane.

---

## RUNTIME DATABASE CORRUPTION RECOVERY

Runtime corruption recovery replaces the active local database and reloads the
visible renderer. The failing operation belongs to the old database snapshot
and MUST NOT be retried against the empty replacement.

Desktop order:
1. Invalidate the desktop scheduler generation and reject new DB work until
   renderer reload begins. Every scheduler handed to backfills or other detached
   work must route through the same generation check.
2. Cancel active embedding backfills. Recovery runs inside the single scheduler
   operation after its failing database call has settled. Do not wait for that
   scheduler to become idle from inside recovery: the current operation owns the
   lane. Queued closures can run only after recovery unwinds and must reject
   against the invalidated generation. Background-indexing IPC resolves after
   scheduling and finishes in a detached lifecycle; its terminal failure callback
   MUST classify corruption and enter this same recovery path after lifecycle
   cleanup settles.
3. Unsubscribe renderer live queries.
4. Terminate the DB utility process so all queued requests fail.
5. Back up and replace the active database profile, then initialize migrations.
6. Reload visible windows into the existing bounded startup progress flow.

Recovery is single-flight at the desktop composition root. Hidden renderer
hosts are excluded from visible-window reload routing. Do not replace this with
an unbounded blocking dialog; a recovered IPC call rejects with
`DatabaseCorruptionRecoveredError` and the already-scheduled reload remounts
all renderer state.

---

## AGENT DEVTOOLS PROFILE ISOLATION

The official `dev:agent-debug` launcher owns a temporary Electron profile for
each run. When Agent DevTools is enabled, desktop startup MUST apply the
launcher's absolute `BRAINSTRIKE_E2E_USER_DATA_DIR` to both Electron `userData`
and its nested `sessionData` path before any store or window is created. A
missing path fails startup; it must never fall through to the production
profile. This path isolation does not enable E2E runtime semantics: live
provider, storage, and single-instance behavior remain production-equivalent.

---

## FILE WATCHER SERVICE LIFECYCLE (BST-568)

OS file watching is a PLATFORM capability beneath the assistant runtime —
Mastra/assistant code never owns watcher lifecycle and must not add
round-trip dependencies on this local latency path. Assistant tools consume
indexed state only.

- **One engine**: `@parcel/watcher` behind `@brainstrike/file-system/electron`
  (`parcel-backend.ts` + `parcel-watchers.ts`), explicit backend per OS
  (`fs-events` / `inotify` / `windows`). Unsupported platform, missing
  binding, malformed `BRAINSTRIKE_WATCHER_BACKEND`, subscribe timeout, and
  runtime backend failure all throw or surface typed health — never a
  fallback engine, never polling. `legacy` is a removed value that throws.
- **Lifecycle invariants**: one native subscription per owning renderer and
  resolved root; 10s subscribe timeout with late-resolution unsubscribe;
  disposers idempotent and safe at any time. Duplicate same-owner/root IPC
  registrations (renderer reload, StrictMode cleanup races, or legacy roots
  that resolve to the same realpath) receive distinct logical watchIds that
  share the existing native subscription. Events and health fan out to every
  live logical registration; unwatch removes only its registration and stops
  the native watcher after the last one leaves. `duplicateRegistrations` makes
  sharing visible in the in-memory telemetry. The per-owner cap counts native
  subscriptions, so an in-budget registration may share an existing root at the
  cap. A separate per-owner registration cap bounds retained watchIds and
  per-event IPC fan-out to twice the native-subscription cap. The
  main-process ownership registry also reaps on
  renderer destruction, crash, reload, root removal, and app shutdown
  (registrar disposer). A lifecycle generation rejects path resolution that
  finishes after its renderer context was reaped. No leaked subscription after
  any of these — extend the shared-registration and reaper tests when touching
  this.
- **Synthetic fixture boundary**: active dev inline-fixture roots are immutable
  in-memory trees, so their decorated `watchDirectory` returns an inert
  disposer instead of forwarding a fixture name to OS watcher IPC. The
  decorator remains capability-gated and delegates every foreign/real root to
  the wrapped watcher unchanged.
- **Typed health**: engines emit `starting|healthy|degraded|failed|stopped`
  exactly once per state change; `fs:watch-health` pushes are scoped to the
  owning WebContents with no root-path field on the wire; retry is
  manual-only (`fs:watch-retry`) with escalating 1s/5s/30s throttling and
  single-flight per watchId. Telemetry (`fs:watch-telemetry`) is in-memory
  counters only — deliberately NOT persisted, so it needs no factory-reset
  wiring; do not add persistence here without wiring factory reset.
- **Assistant file-read cursors**: the short `readWorkspaceFile` continuation
  registry is main-process, memory-only state. It survives renderer reloads,
  expires entries after one hour, and is cleared through the
  `read-workspace-file-cursors` factory-reset runtime. It must never move to
  durable storage, and unknown handles must never trigger a fresh-read fallback.
- **Packaging**: asarUnpack for the parcel prebuilds is BINARY-ONLY
  (`**/node_modules/@parcel/**/*.node`) — whole-directory globs corrupt the
  asar under pnpm symlinks (see docs/agents/research/bst-568-parcel-watcher-spike.md).
  Packaged proof: `pnpm --filter @brainstrike/file-system test:packaged` in
  the Native Electron Package CI job.

Full event-pipeline invariants (batching, ignore rules, normalization,
consumers) live in `docs/agents/explorer-search-tapestry.md` ("EXPLORER TREE
LIVE REFRESH").

---

## DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)

Design doc: `docs/error-observability-design-2026-07-23.md`. Cross-cutting,
app-wide diagnostic capture — deliberately SEPARATE from the run-scoped
`brainstrike_assistant_run_events` timeline (different scope, retention, and
sanitization contract; do not relitigate).

**Table**: `brainstrike_diagnostic_events` (migration 073, numbered runner
`packages/db/src/migrations/073-diagnostic-events.ts` AND drizzle
`customMigrations` in `packages/db/src/drizzle/migrate.ts` —
`custom-073-diagnostic-events`). NO foreign keys (same precedent as
`run_usage` 046 / `run_outcomes` 062): correlation ids (`run_id`, `thread_id`,
`resource_id`, `root_id`) are nullable text and orphans are inert. `severity`
is a CHECK-constrained `warn | error | fatal`. `fingerprint` is computed at
write time (`computeDiagnosticFingerprint` in
`packages/utils/src/diagnostics/diagnostic-events.ts`) — a dependency-free
FNV-1a hash over `code|scope|normalized-message` with UUIDs/paths/hex/digits
stripped, so recurring errors with different ids/paths collapse to the same
fingerprint. `session_id` is a per-launch `crypto.randomUUID()`
(`getDiagnosticSessionId` in `diagnostic-sink-bridge.tsx`) correlating events
within one app run.

**Capture**: the existing `addLogListener` seam
(`packages/utils/src/logger.ts`) feeds `DiagnosticSinkBridge`
(`packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`), a
render-nothing component mounted ONLY in the two visible renderers
(`apps/web/src/main.tsx`, `apps/desktop/src/renderer/main.tsx`). Desktop main
and hidden renderer hosts have no PGlite handle of their own, so their warn+
records are pushed to a visible renderer over `logging:durable-record`
(desktop main → renderer) and consumed via the bridge's optional
`forwardedRecords` prop (`ForwardedRecordsSubscription`); a second channel,
`logging:ingest-buffered-record`, exists for pre-attach buffered records. The
bridge's own scope, `DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink'`, is excluded
from both the local listener and the forwarded-record consumer — the
loop guard that stops sink failures from re-entering the sink. Records become
`DiagnosticEvent`s via `logRecordToDiagnosticEvent`, which bounds
message/stack/context (`DIAGNOSTIC_MESSAGE_MAX_CHARS`/`STACK`/`CONTEXT` =
2000/8000/8000 chars, visibly marked via `boundWithMarker`, never silent) and
runs `redactSensitiveLogValue` over context before it is queued.

**Writer** (`DiagnosticEventWriter`,
`packages/utils/src/diagnostics/diagnostic-event-writer.ts`): batched
(`flushBatchSize` 32 events, `flushIntervalMs` 2000ms), never awaited on the
logging call path. `maxPending` (256) is a drop-oldest ring buffer; each drop
increments a counter that materializes into one loud
`diagnostics_events_dropped` marker event (fingerprint
`diagnostics_events_dropped`, severity `warn`) prepended to the next flush —
loss is never silent. After `maxConsecutiveFailures` (5) consecutive flush
failures the writer self-disables (`isDisabled`), drops its pending queue, and
calls `onDisabled`, which the bridge logs loudly via a plain (non-recursing)
`bridgeLogger.error`. `flush()`/`drain()` loop while more events keep arriving
mid-flight so nothing enqueued during an in-flight sink call is stranded. The
bridge also flushes on `visibilitychange` → `hidden`, so events survive tab
close/backgrounding. **Eager flush for high severity**: `DiagnosticSinkBridge`
calls `void writer.flush()` immediately after `enqueue()` whenever
`event.severity !== 'warn'` (both the local `addLogListener` path and the
`forwardedRecords` path) — `error`/`fatal` events do not wait for the batch
window, since `flush()` is single-flight (a concurrent call reuses the
in-flight promise) and browsers do not guarantee async work started inside a
`visibilitychange:hidden` handler completes before teardown. `warn` events
still batch normally on the 2s/32-event thresholds. Web close-durability
remains best-effort even with this: a batch of `warn` events inside the 2s
window can still be lost if the tab is killed (not merely hidden) mid-flush;
desktop's NDJSON file backstop (§7 of the design doc, moved to P2) is the
durable answer for that gap. The design's DB-corruption-recovery generation
subscription (re-arming the writer after a runtime DB swap) is NOT
implemented in P1 — this self-disable-after-repeated-flush-failures behavior,
with its visible `onDisabled` log, is the deliberate P1 substitute; revisit
once P2 surfaces sink health.

**Retention**: `DiagnosticEventsRepository.purge()`
(`packages/db/src/repositories/diagnostic-events-repository.ts`) is a bounded,
oldest-first `DELETE ... WHERE id IN (SELECT ... ORDER BY occurred_at ASC
LIMIT n)` past 30 days (`DIAGNOSTIC_RETENTION_MAX_AGE_MS`) OR past 20,000 rows
(`DIAGNOSTIC_RETENTION_MAX_ROWS`), capped at `DIAGNOSTIC_EVENTS_PURGE_LIMIT`
(500) rows per delete. It is invoked once on `DiagnosticSinkBridge` mount —
never an unbounded `DELETE`, never a trigger. Those two constants are only
the DEFAULTS: since P2b the mount-time purge reads the user's configured
values from `diagnostics-retention-store` (below), and the 500-row cap
applies INDEPENDENTLY to each of the two deletes (aged rows, over-cap rows),
so one `purge()` call can return up to 1000 and may still leave a backlog.

**Factory reset**: new persistence under this table must stay wired in BOTH
paths — desktop `db-ipc.ts` `OptionalRelationTable` list
(`clearOptionalRelation(tx, 'brainstrike_diagnostic_events')`) and web
`db-provider.tsx`'s direct-PGlite reset table list. Both currently include
`brainstrike_diagnostic_events`.

**Debug bundle**: `packages/app-shell/src/diagnostics/debug-bundle.ts`
(collector `collectThreadDebugBundleData` + pure formatter
`formatThreadDebugBundle`, convenience wrapper `buildThreadDebugBundle`),
consumed through the `DebugBundleProvider` seam
(`packages/ui/src/assistant-ui-panel/debug-bundle-context.tsx` +
`packages/app-shell/src/hooks/use-debug-bundle.ts`) by the
`CopyDebugBundleButton` (`packages/ui/src/assistant-ui-panel/copy-debug-bundle-button.tsx`)
on failed assistant messages. `DEBUG_BUNDLE_FORMAT_VERSION = 1` is stamped in
the rendered header (`bundle_format: 1`) so future format changes are
detectable by consumers. Bounded to `DEBUG_BUNDLE_DEFAULT_MAX_BYTES` (200,000
bytes measured via `TextEncoder`, byte length not char length); when over
budget the formatter elides deterministically in three stages (oldest
non-protected transcript messages, then tool-result bodies down to a 200-char
preview, then run-event metadata) and always appends a visible `## Elision
log` footer naming what was cut — it never throws and never elides silently.
Redaction is key-name-based (`redactSensitiveLogValue`, matching
`isSensitiveLogKey`) applied twice: once at capture time
(`logRecordToDiagnosticEvent`'s context) and again over the whole bundle data
object at format time as a belt-and-braces pass — a secret value under an
innocuous key (e.g. `{ note: 'password is sk-live-123' }`) was a known gap in
both passes since neither is value-based. That gap is now partly closed: after
the key-name pass and the elision loop, `formatThreadDebugBundle` runs
`scrubLikelySecretValues` (`packages/app-shell/src/diagnostics/secret-scrub.ts`)
over the final rendered Markdown string — a value-SHAPE scan (API key/token
prefixes, JWTs, Bearer headers, PEM private keys, DB connection-string
credentials) independent of key names. This is the single choke point every
`formatThreadDebugBundle` return path flows through (including the
over-budget/elision-exhausted path), so it covers `buildThreadDebugBundle`
too. Each match is replaced with `[redacted-secret:<kind>]`; when anything was
redacted a final `_Secret scan: <N> value(s) redacted (<kinds>)._` line is
appended. High-precision patterns only — this is a belt-and-braces net for a
specific set of secret shapes, not a general-purpose scanner.

**Paired tests**: `packages/utils/src/__tests__/diagnostic-events.test.ts`,
`packages/utils/src/__tests__/diagnostic-event-writer.test.ts`,
`packages/db/__tests__/migration-073-diagnostic-events.test.ts`,
`packages/db/__tests__/diagnostic-events-repository.test.ts`,
`packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (durable-record
push channel), `packages/ui/src/__tests__/error-boundary.test.tsx`,
`packages/app-shell/src/__tests__/debug-bundle.test.ts` (includes a golden
snapshot), `packages/app-shell/src/__tests__/secret-scrub.test.ts`,
`packages/ui/src/__tests__/copy-debug-bundle-button.test.tsx`,
`packages/app-shell/src/__tests__/use-debug-bundle.test.ts`.

### P2a: NDJSON backstop + persistent Log Viewer source

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

**Desktop NDJSON backstop** (`RotatingNdjsonSink`,
`apps/desktop/src/diagnostics/rotating-ndjson-sink.ts`, wrapped by
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
hand-rolled in `RotatingNdjsonSink` instead.

**Recursion rule**: nothing in the sink path
(`rotating-ndjson-sink.ts`, `error-log-sink.ts`) may import or call
`@brainstrike/utils/logger` — the sink is fed BY a log listener, so logging
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
) — otherwise a real close failure (`RotatingNdjsonSink.close()` deliberately
leaves `fs.closeSync` outside a try/catch; see its comment) would produce
zero output anywhere, a direct "no silent fallbacks" violation in the one
module whose entire job is loud failure reporting. The `errorLogSink` handle
is always nulled from a `finally`, even when `close()` throws, so a partial
failure can never leave a stale handle that a later `recordDurableLog` call
treats as still open.

**Reopen-after-close is real in `RotatingNdjsonSink` and now reachable in
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

**Deferred from the design doc's §7/§9, recorded honestly**: §7's
"`brainstrike.log` (full INFO) keeps existing behavior but gains the same
rotation" was NOT delivered in P2a — only the new `brainstrike-errors.ndjson`
file rotates; `brainstrike.log` still grows unbounded. §9's Log Viewer bullet
promised filters for severity/source/code/time range, a row → detail view
with cause chain, and per-row "Copy as JSON"; P2a delivered the second
`LogSourceAdapter` ("Persistent errors") and severity filtering (via the
viewer's existing level filter) but NOT the dedicated source/code filters,
the time-range filter, a row-detail view, or per-row "Copy as JSON" — the
cause chain is currently visible only as serialized text inside the
args/context column, not a dedicated detail view.

**Persistent Log Viewer source** (`createDurableLogSource` +
`useDurableLogSource`,
`packages/app-shell/src/diagnostics/durable-log-source.ts` and
`use-durable-log-source.ts`, wired into the Session/Persistent switch in
`packages/preferences/src/settings/system/logging-settings-section.tsx`):
gated on `useOptionalPGliteDatabase()` returning a live db handle — NOT
`hasDurableAssistantUsageCapability()` (that gate is desktop-only OM
persistence; diagnostics are written on both web and desktop, so the correct
gate is capability-by-composition, "is there a db handle," never a platform
check). Polls every `DURABLE_LOG_SOURCE_POLL_MS` (5000ms; the viewer's
existing Refresh button already covers on-demand re-fetch, so polling only
needs to cover the gap between refreshes) for up to
`DURABLE_LOG_SOURCE_MAX_ROWS` (2000) warn+ rows. Deliberately bypasses
`DiagnosticEventsRepository.queryEvents` with direct SQL: that repository
method hard-caps `limit` at 200 and its `severity` filter is equality (not a
minimum), so it cannot serve a 2000-row warn-and-above view — the row
mapping (`mapDiagnosticEventRow`) is still reused to avoid duplicating it.
`subscribe()` guards against overlapping polls with a monotonic
`latestRequestId` counter: only the result whose request id still matches
the latest-issued poll is delivered, so a slow tick can never clobber a
newer one that resolved first. The adapter returned by `createDurableLogSource`
is a fresh object on every call by contract; `useDurableLogSource` memoizes
it keyed on the db handle's identity so it stays referentially STABLE across
re-renders — the Log Viewer's effect keys its subscribe/teardown on adapter
identity, so an unstable adapter would restart polling on every render (the
same hazard the desktop `forwardedRecords` prop hit in P1). The NDJSON
export button (`onExportDurableNdjson` in `logging-settings-section.tsx`)
and the viewer share the same bounded `loadEventsAscending` query as their
single source of truth, and `exportNdjson()` deliberately has no try/catch —
a rejected export must propagate so the caller can surface it visibly,
rather than a swallowed failure rendering as a successful-but-empty file.

**Paired tests**: `packages/utils/src/__tests__/diagnostic-event-ndjson.test.ts`,
`apps/desktop/src/__tests__/diagnostics/rotating-ndjson-sink.integration.test.ts`,
`apps/desktop/src/__tests__/diagnostics/error-log-sink.test.ts`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (the
`recordDurableLog handler` describe block covers the two `logging-ipc.ts`
choke points feeding the sink),
`packages/app-shell/src/__tests__/durable-log-source.test.ts`,
`packages/app-shell/src/__tests__/use-durable-log-source.test.tsx`,
`packages/preferences/src/settings/system/logging-settings-section.test.tsx`.

### P2b: status chip, retention preferences, sink health

**Unseen-error status chip** (`DiagnosticsStatusItem`,
`packages/app-shell/src/status-items/diagnostics-status-item.tsx`, mounted in
`app-layout.tsx`'s `rightContent` before `IndexingStatusItem`) backed by
`useUnseenDiagnosticsCount` (`.../diagnostics/use-unseen-diagnostics-count.ts`):
a `usePGliteLiveQuery` `COUNT(*)` over rows newer than the watermark. The
query carries NO severity predicate on purpose — the table's CHECK constraint
already guarantees every row is warn+, so a redundant filter would just invite
someone to "fix" it later. The chip renders `null` at count 0 (no chrome when
nothing is wrong), but BOTH not-knowing states outrank the count, because
this is the only always-visible diagnostics surface: a live-query error
renders "Diagnostics unavailable" rather than the honest-looking `0`, and a
non-null `disabledReason` renders "Diagnostics not recording" — outranking
even a non-zero count, since that count is frozen and stale once the sink is
dead. Without the latter, a disabled sink writes no rows, the count sits at 0
forever, and the status bar silently claims "no errors" precisely when errors
have stopped being recorded; the settings banner alone cannot cover that,
because a user has no reason to open settings while the status bar looks
clean. Clicking marks all seen, opens settings, and routes to
`#settings/logging`.

The watermark (`diagnostics-seen-store.ts`) is **session-scoped, seeded to
`Date.now()` at module load, and deliberately NOT persisted**: a persisted
watermark would replay up to 20,000 retained rows as unread on every launch,
so the chip means "warn+ events since this launch," not "since you last
looked." Do not "fix" this by adding `persist`.

**Retention preferences** (`packages/preferences/src/stores/diagnostics-retention-store.ts`,
persisted): `maxAgeDays` / `maxRows`, chosen from
`DIAGNOSTICS_RETENTION_DAY_OPTIONS` / `DIAGNOSTICS_RETENTION_ROW_OPTIONS`.
Defaults MUST equal `DIAGNOSTIC_RETENTION_MAX_AGE_MS` / `_MAX_ROWS` so
behavior is unchanged until a user edits them (a test asserts the equality by
importing both, rather than hardcoding the numbers twice). Setters **throw**
on a value outside the option list — malformed config is loud, never coerced.
`migrate` sanitizes an unknown persisted payload back to defaults, but note
the standard zustand caveat this repo's other preference stores share: it
runs ONLY on a version mismatch, so a hand-edited payload written at the
CURRENT version is shallow-merged unsanitized. The setter guard is the real
enforcement; `migrate` covers version bumps only.

**Purge path**: the settings card's "Purge now" reaches the repository through
an `onPurgeNow?: () => Promise<number>` **callback prop**, never a repository
import — `app-shell` already depends on `preferences`, so that direction is
circular (same precedent as `onExportDurableNdjson`). Both apps build it from
`useDiagnosticsPurge()` (`packages/app-shell/src/diagnostics/use-diagnostics-purge.ts`),
gated on a db handle. Because a single `purge()` is per-call bounded, a
returned count at or above the per-call limit toasts "more may remain" instead
of implying a full drain; `logging-settings-section.tsx` mirrors that limit as
`DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD` (it must not import `@brainstrike/db`
at runtime) and the section test imports the REAL exported
`DIAGNOSTIC_EVENTS_PURGE_LIMIT`, so drift fails RED rather than silently
under-warning.

**Sink health** (`diagnostic-sink-health-store.ts` → `sinkHealthReason` prop →
amber banner at the top of the logging settings section): the writer's
`onDisabled` callback is the **ONLY** signal a broken sink can ever emit,
because the `DIAGNOSTIC_SINK_SCOPE` loop guard keeps the sink's own failures
out of the table — a disabled sink otherwise renders as an empty Persistent
view, which reads as "no errors happened" rather than "errors are no longer
being recorded". It travels through a module-level store rather than React
context because `DiagnosticSinkBridge` mounts inside `<DbProvider>` but
OUTSIDE `RootLayoutContent`, so no shared provider spans both. `markDisabled`
is idempotent — first reason wins, so a later failure racing the disable
cannot overwrite the root cause shown to the user.

**Factory reset (all three P2b stores)**: the two session stores
(`resetDiagnosticsSeenStore`, `resetDiagnosticSinkHealthStore`) are registered
in `packages/app-shell/src/register-factory-reset-session-stores.ts`; the
persisted `resetDiagnosticsRetentionStoreToDefaults()` is called directly from
`clearBrowserStorage()` in
`packages/preferences/src/settings/system/factory-reset-helpers.ts`, alongside
its sibling persisted stores.

**Paired tests**: `packages/preferences/src/__tests__/diagnostics-retention-store.test.ts`,
`packages/app-shell/src/__tests__/diagnostics-seen-store.test.ts`,
`.../diagnostic-sink-health-store.test.ts`,
`.../diagnostics-status-item.test.tsx`, `.../use-diagnostics-purge.test.tsx`,
`.../diagnostic-sink-bridge.test.tsx` (the configured-retention startup purge
and the writer-disables-populates-health-store cases),
`packages/preferences/src/settings/system/logging-settings-section.test.tsx`
(retention card + sink-health banner describes).
