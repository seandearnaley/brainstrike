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
'mastra_workflow_snapshot')`) and `db-provider.tsx`'s
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
Known debt: the ~14 `clearOptionalRelation` call sites carry the same latent
defect, unreachable today only because every one of those tables is created by a
numbered migration that has already run by the time a clear starts.

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
(`DIAGNOSTIC_RETENTION_MAX_ROWS`), capped at 500 rows per purge call. It is
invoked once on `DiagnosticSinkBridge` mount — never an unbounded `DELETE`,
never a trigger.

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
