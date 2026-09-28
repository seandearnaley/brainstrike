# Platform Contracts: Logging, Factory Reset

> Read before adding any persistence, changing logging, or touching desktop IPC
> authorization. Rules here are true now; the record behind each is in
> `platform-contracts/<topic>.md`.

## LOGGING (PINO V10)

- Initialize with `initializeLogging` from `@brainstrike/logging`, naming the
  runtime (browser, electron-main, electron-renderer); scope with
  `createLogger('FileImporter')`; pass metadata as an object. Level: code, then
  `LOG_LEVEL`, then defaults.
- `logInternal` is the only redaction-safe entry point — every argument passes
  through `redactSensitiveLogValue` before Pino. Never export a raw Pino logger
  from the package entry point, and never add a second redaction pass inside a
  serializer. Why: two implementations that can disagree make the leak depend on
  which path a caller took.
- The error gate (`isErrorObject`, `log-serializers.ts`, shared by redactor and
  serializer) accepts real Errors, cross-realm `[object Error]`, and the redacted
  flattened `message` + `stack` shape — never `instanceof` alone, and never as
  wide as Pino's `isErrorLike`, so a structured rejection carrying only a
  `message` crosses byte-identical. Its `[object Error]` half stays inside a
  try/catch, because `Object.prototype.toString` runs user code.
- Error-shaped output stays byte-identical to bare `pino.stdSerializers.err`, and
  a non-extensible value goes through a descriptor-faithful copy. Why: the std
  serializer mutates its input, so a frozen one throws while logging the failure
  it was called on.
- Redact `apiKey`, `password`, `token`, `secret`, `authorization`, `cookie`;
  extend with `redactPaths`. Structured arguments and listener bindings are
  redacted recursively before transport, buffering, or display.
- Log a host payload's SHAPE, never the payload: exact counts, truncated strings,
  nothing else. `summarizeMalformedMessage` (`parser-host-manager.ts`) is the
  pattern every new host adapter follows.
- Workspace indexing: a missing root or managed collection is `unconfigured` and
  clears stale progress and `lastError`, while the provider reports `waiting`
  during database init. A missing required database, invalid metadata, or runtime
  failure stays an error, and bootstrap never overwrites a newer status.
- Test with `addLogListener`, never a console mock; a suite that silences output
  uses `configureLogger({ console: false })`, which builds a disabled Pino
  instance rather than falling back to stdout.

Settled: one gate, one redaction pass, and `instanceof` is not the gate.
Evidence: `platform-contracts/logging-error-serializer.md`.
Guard: `packages/logging/src/__tests__/error-serializer.test.ts`,
`apps/desktop/src/__tests__/main/parser-host-manager.test.ts`.

## IN-MEMORY PERFORMANCE TELEMETRY

- Renderer long-task, embedding-runtime, and database-query snapshots are
  session-only — no table, storage, IndexedDB, or filesystem — so they need no
  factory-reset wiring. Desktop main only relays the hidden renderer's validated
  snapshot.
- Persisting or exporting any of them is a contract change: update
  `docs/diagnostics-privacy-contract.md` and wire every applicable factory-reset
  path in the same change.

Evidence: `platform-contracts/in-memory-performance-telemetry.md`.

---

## SENSITIVE DESKTOP IPC AUTHORIZATION

- Preload possession is not an authorization boundary. Register a sensitive
  invoke with `registerAuthorizedInvoke` (`platform/desktop-ipc-registry.ts`) and
  a non-empty set of server-owned `DesktopWindowRole` values; both factors run
  before the handler sees or parses any renderer-controlled argument.
- Factor one, sender role: `event.sender.id` resolves through `window-role.ts`
  and is rejected unless it maps to a declared role. An empty or duplicate policy
  is a registration error; an unknown sender never inherits `visible-ui`.
- Factor two, sender frame: `event.senderFrame.url` must match
  `desktop-ipc-sender-frame.ts`'s allowlist, a pure derivation of the ONE
  process-wide `DesktopRendererTarget` that `main.ts` configures before any
  window exists. Nothing else re-derives the launch mode from `process.argv`,
  `app.isPackaged`, or a test-mode flag, and the loaders load the document that
  same target names.
- Keep the renderer a single-document app — a `BrowserRouter` shell with no
  routes, links, or `navigate` calls. Why: a `pushState` navigation changes the
  frame's pathname mid-session and drops the visible window off the allowlist.
- Every rejection fails closed: an unconfigured target throws at LOAD time, and a
  missing or disposed `senderFrame`, a throwing `WebFrameMain.url` getter, or an
  off-allowlist URL yields a curated `Desktop IPC <channel> …` error that never
  echoes the renderer URL, while main logs the channel and the rejected URL or
  sender id at `warn`.
- The unauthenticated verb is deliberately the long one:
  `registerUnauthenticatedInvoke(domain, channel, { reason }, handler)` requires
  a non-empty reason, so every opt-out is reviewable at the call site. The short
  `registerInvoke` does not exist.
- The preload manifests are the source of truth for who may hold a channel, and
  main-process authorization stays even when a preload omits it. Provider secrets
  and assistant URL/token credentials are visible-UI-only; hidden hosts use the
  role-selected `dist/hidden-preload.js`.
- Give a hidden host a PURPOSE-SCOPED capability, never the unrestricted
  `storage` bridge: `vector-preferences:read|write|clear` is the canonical shape,
  role-authorized and carrying no renderer-supplied key, so it can neither
  enumerate nor wipe the store.
- A store reached from more than one window role FAILS VISIBLY when its
  capability is absent; it never falls back to browser storage. "Electron
  renderer with no capability" and "web with no bridge" are different states.
- `fs:readFileByAbsolutePath` is visible-UI-only and resolves the durable RootId
  FIRST in the live `WorkspaceRootRegistry`, verifies the claimed path belongs to
  that mount, then confines the file. A malformed assertion emits exactly one
  bounded diagnostic: escaped, capped renderer strings plus a static category
  message and a bounded error code — never native error text.
- Add a new sensitive channel through the authorized registration API and cover
  both an allowed sender and a hidden/untracked rejection.

Settled: possession is not authorization, and both factors are mandatory for a
contract domain. Evidence: `platform-contracts/sensitive-ipc-authorization.md`
(the full domain/role table and the standing unauthenticated set).
Guard: `apps/desktop/src/__tests__/platform/desktop-ipc-registry.test.ts`,
`desktop-ipc-sender-frame.test.ts`, `privileged-ipc-sender-authorization.test.ts`,
`contract-domains-sender-authorization.test.ts`.

---

## IPC CONTRACT MODULES

- `platform/desktop-ipc-channels.ts` (`DESKTOP_IPC_CHANNELS`) is the ONE place a
  channel string lives. Neither preload holds a channel literal, and the hidden
  preload may reference only the manifest groups its test pins, so the
  role-scoped hidden capability set cannot widen by a stray reference.
- A preload may import any relative module whose transitive VALUE-import graph is
  pure — no `electron`, no `node:*`, no bare package. Type-only imports are
  erased and do not count, and the build refuses to emit a preload bundle with
  any `require(` other than `electron`.
- `platform/ipc-contract.ts` is the pure per-domain vocabulary: `channel`,
  `rawChannel`, `pushEvent`, plus derived `Handlers<C>` / `Bridge<C>`. `roles` is
  a non-empty tuple; `parseArgs` is a plain function that runs only in MAIN,
  before the handler, and throws on malformed input. No zod in preload, no
  coercion.
- Registering a domain is one line per side. `registerDomain(...)` routes every
  invoke through `registerAuthorizedInvoke` with `spec.roles`, so a contract
  domain has no unauthenticated path; per call the order is both factors, then
  `parseArgs`, then the handler. Push events are never registered, and a contract
  key with no handler (or the reverse) is a registration error.
  `exposeBridge(name, contract)` exposes exactly `Object.keys(contract)` with the
  one `unwrapIpcResult` and subscribe-returns-unsubscribe, and each contract pins
  `BridgeMatches<…> = true` against the shared package interface, so no consumer
  re-declares a bridge.
- Exactly one failure shape crosses IPC as data for contract channels:
  `IpcResult<T> = { ok: true, value } | { ok: false, error: { category, code,
  message } }`, and contract handlers never throw for an expected failure. Why: a
  thrown Error reaches the renderer as Electron's formatted string, main-process
  stack included. `rawChannel()` serves domains whose consumers already read
  their own typed envelope (`GitResult`, `TerminalResult`, `NotesVaultResult`).
- A domain keeps a narrow event-aware adapter only when ownership must bind to
  the registry-authenticated `event.sender` — terminal PTYs, notes-vault
  watchers, database scheduler admission and live queries, MCP Apps operations,
  the native config picker. The generic handler receives parsed arguments, not
  the Electron event, so these stay audited exceptions.
- `@brainstrike/types` exports neutral wire data only: no `electron-api` module,
  no `window.electronAPI` augmentation, no `Electron*API` interfaces. The
  database package owns `DesktopDatabaseBridge`, each preload uses its exact role
  type and checks its runtime key set before exposing it, and web keeps the
  capability absent.
- There is deliberately no registry singleton — duplicates are rejected per
  INSTANCE and production composes many. The global manifest test boots the real
  `main.ts` under mocks and asserts over the union of every captured registry, so
  a migrated contract needs no edit there; a new HANDWRITTEN registration cannot
  enter production without a status and reason in
  `__tests__/helpers/manual-ipc-inventory.ts`.
- `main/disposer-stack.ts` is the ONE holder of IPC-domain disposers: each
  `registerXIpcHandlers(...)` result is `ipcDisposers.add(label, …)`, `will-quit`
  unwinds LIFO with every throw isolated and logged by label, and a second live
  entry under one label is a registration error. `before-quit` runs the graceful
  shutdown first, so the stack always unwinds after its steps.
  `main/logging-preferences.ts` owns preference STATE while `main.ts` keeps the
  boot ORDER, and `main/git-awareness-lifecycle.ts` constructs the one
  git-inventory/forge/worktree service inside `app.whenReady()`.
- Electron 44 clipboard writes return `Promise<void>`, so the main handler awaits
  the write inside its catch boundary and a rejection returns
  `ipcFailure('clipboard', 'write_failed', message)`; renderers use the IPC
  bridge. Electron 44 requires macOS 13+ and 64-bit targets, which the builder
  inherits without an override.

Settled: the manifest owns channel literals, preload imports are allowlisted by
purity, and the migration inventory is closed in both directions. Evidence:
`platform-contracts/ipc-contract-modules.md`.
Guard: `apps/desktop/src/__tests__/main/ipc-global-manifest.test.ts`,
`ipc-disposer-ledger.test.ts`, `preload-sandbox-imports.test.ts`,
`preload-contract-bridges.test.ts`, `platform/register-domain.test.ts`,
`scripts/__tests__/desktop-ipc-type-boundary-contract.test.mjs`.

---

## FACTORY RESET CONTRACT

"Factory Reset Brainstrike" means a true fresh start: the renderer boots as if
never used. Wiping the database alone is not enough.

- Wire every new persistent store into `packages/app-state/src/factory-reset.ts`
  and document it next to its helper in the same change.
  `clearPersistentUiState()` covers persistent UI store keys, the Electron
  renderer storage bridge, IndexedDB (enumerated plus a fallback list), and
  CacheStorage.
- Storage deletion is fail-visible: Electron storage, secrets and settings
  failures — including a fulfilled secrets response with `success: false` —
  IndexedDB `error`/`blocked` events or synchronous throws, CacheStorage
  failures, and OPFS failures all produce an incomplete reset. Never convert a
  failed deletion into success. The one tolerated degradation is the IndexedDB
  enumeration fallback to explicit Brainstrike names.
- Re-default a live in-memory store, do not merely purge its storage. Why: the
  web path may not reload, so a purged-but-live store keeps serving pre-reset
  values. `resetHookTrustStoreToDefaults` and its siblings are the shape; call
  them from `clearBrowserStorage()`.
- Dependency-free app-shell session stores share ONE resetter list,
  `APP_SHELL_SESSION_STORE_RESETTERS`; production registers each member
  separately for per-store failure isolation, and the vitest setup drains the
  same list. Do not keep a second test-only list. Component-coupled and
  feature-package stores keep their own registrations plus focused-test setup,
  because preloading them globally binds real dependencies before mocks install.
- Secrets have one authority: `getSecretsService()` backs secrets IPC, provider
  auth, and MCP bearer resolution, and the transport caches no token material, so
  the existing `clearAll` is the complete reset authority. Token caching would
  change this contract and its tests together.
- Desktop userData is wiped wholesale, so the main-process storage keys, the
  bundled CPython unpack directory, and the shadow-git dirs need no per-key
  wiring. If one moves outside `userData`, or `logs` gains a preserved sibling,
  it needs explicit wiring and an update here.
- The renderer `storage:*` bridge cannot mutate the root, recents, or vault
  authority keys: `setItem`/`removeItem` reject them by exact key, `setItem`
  rejects a non-string value, and `clear` removes only renderer-owned records,
  failing closed when the durable file could not be loaded. The desktop handler
  is the sole whole-profile wipe and calls `storage.clear()` after deleting the
  userData entries, so the long-lived main cache cannot repersist stale authority
  records.
- `roots/root-registration-events.ts` is the one module deliberately NOT
  registered as a factory-reset session store, and a test pins the omission. Why:
  its only consumer accepts a strictly later generation than a snapshot captured
  before its first failed read, so a stale counter is unreachable — while
  clearing it mid-session strands an in-flight waiter through its full timeout.
- Desktop reset order: quiesce background runtimes, clear UI state, purge DB
  tables, reload the renderer. Do not skip the reload. MCP admission stays closed
  across all four steps, and main waits for the replacement tree's renderer-ready
  ping — `did-finish-load` alone is not completion — before reopening authority.
  A failed purge restores the captured pre-reset MCP authority, config
  projection, path grant and tool projection while admission is still closed; a
  renderer replacement that fails after a successful purge leaves admission
  closed and the failure visible.
- Every reset runtime is attempted even when another fails. The original
  rejections stay ordered in one `AggregateError` and the message names every
  failed runtime; never replace those causes with a names-only error.
- Volatile renderer state still needs reset wiring when the web path may not
  reload: `FileExplorerProvider` registers one resetter that invalidates content
  generations, queued batches and projected errors, clears raw contents, LRU and
  selections, and advances the content lifecycle key so hook-local refs remount
  empty.
- Database-owned assistant persistence outside Mastra's tables is cleared
  explicitly by all three table-enumerating paths — desktop `db:clearAll`,
  `clearViaPGlite`, `purgeTablesTx` — and classified in the reset registry in the
  same change. A thread sidecar also joins `THREAD_DELETE_SIDECAR_TABLES`; a
  relation outliving its thread does not. A relation cascading from
  `mastra_threads` is deliberately in no list, so dropping that FK means moving
  it into the registry in the same change.
- **The set those three paths clear is owned by
  `packages/db/src/reset-table-registry.ts`.** Read the registry for the members;
  do not restate its size anywhere. Web `purgeTablesTx` additionally wipes
  `getFactoryResetOnlyTables()` and issues a targeted
  `DELETE … WHERE is_default = FALSE` for the MIXED `view_filter_presets`, so
  user presets converge with desktop while migration seeds survive.
- Desktop factory reset is deliberately different: `resetLocalDatabase` closes
  the database and recursively deletes the active profile directory — do not add
  a redundant SQL purge there. Closing the default DB host manager permanently
  retires that owner, retained `RemoteDbClient` methods reject afterwards, and
  Mastra memory's caches key on database object identity, so a retired owner
  fails visibly instead of writing into the replacement profile.
- **A relation that can legitimately be ABSENT must be PROBED, not
  deleted-and-caught.** Use `SELECT to_regclass('<table>') IS NOT NULL AS
  present` and skip the `DELETE` when absent. Why: each path runs in ONE
  transaction and PGlite is real Postgres, so a tolerated `42P01` leaves the
  transaction aborted (`25P02`), rolls the whole reset back, and still reports
  success. There are no savepoints in this repo.
- There is exactly ONE clear helper per side and both probe — desktop
  `clearOptionalRelation`, renderer `clearRelationIfPresent` — and both take a
  CLOSED literal union derived from the registry, never a `string`. Why: with
  `to_regclass` a misspelled name returns NULL, indistinguishable from absence: a
  permanent silent skip with every test green. A probed `DELETE` is deliberately
  not wrapped in a catch, and no catch anywhere in a purge tolerates a missing
  relation — do not reintroduce a message-parsing matcher or a
  delete-and-tolerate variant.
- **Every probed Mastra table name comes from the canonical schema exports** in
  `@brainstrike/assistant-contract/mastra-memory-schema`, never a hand-copied
  literal. `mastra_workflow_snapshot` must never survive reset, because a
  suspended run retains its pending tool call and arguments. `mastra_vectors`
  takes a blanket `DELETE` — do not preserve `__index_metadata__` sentinel rows,
  since Mastra re-declares every logical index before each upsert or query.
  Relations only Mastra's stores create may be missing, so every path probes
  first; absence is the only tolerated case.
- **Import those canonical exports freely, but read their values only inside the
  function that executes the clear — never at module scope.** Type-position reads
  are erased and stay safe. Why: module-scope initializers run at bundle chunk
  initialization, where the contract chunk is not guaranteed to have evaluated,
  and a bare interpolation splices the string `undefined` into SQL. Same reason
  migration 117 carries a LITERAL copy of Mastra's memory DDL.
- Keep both conjuncts of the structural backstop green: an acyclic CHUNK graph
  (`scripts/verify-no-cross-chunk-cycles.mjs`, inside `apps/web` `build` and
  `apps/desktop` `build:renderer`) and an acyclic SOURCE graph
  (`scripts/verify-no-source-cycles.mjs`, lint lane). Why: Rolldown emits no
  circular-dependency warning for a real cycle, so the build log is a blind
  instrument. Scope: the two renderer bundles, not `build:main`.
- **A package never imports its own barrel — import the sibling module
  directly.** Same ruling as BST-742, now enforced rather than advisory.
- Leave `066-restore-pg-textsearch.ts`'s module-scope interpolation alone, and do
  not hardcode its version literal either. Why: drizzle's ledger is
  SQL-string-only and built at module scope, so a `MigrationCallback` `up` throws
  at import time and every launch fails; and the two cycle guards already retire
  the renderer hazard.
- Reset changes that depend on aborted-transaction semantics need a real-PGlite
  `*.integration.test.*`; a mocked `tx.query` cannot reproduce them.

Settled: probing, not catching; the registry owns the set; module-scope reads of
imported constants stay banned; migration 066 stays as it is (closed won't-do).
Evidence: `platform-contracts/factory-reset-storage-keys.md`,
`platform-contracts/python-runtime-paths.md`,
`platform-contracts/desktop-reset-order.md`,
`platform-contracts/reset-table-registry.md`,
`platform-contracts/probe-not-catch.md`,
`platform-contracts/module-scope-chunk-init.md`.
Guard: `packages/db/__tests__/reset-table-registry.test.tsx`,
`reset-table-coverage.integration.test.ts`, `clear-data.integration.test.tsx`,
`apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`,
`main/desktop-factory-reset-storage-ledgers.test.ts`,
`main/python-runtime-resources-dir.test.ts`,
`packages/app-shell/src/__tests__/register-factory-reset-session-stores.test.ts`,
`scripts/__tests__/verify-mastra-schema-init-order.test.mjs`,
`verify-no-source-cycles.test.mjs`, `verify-no-cross-chunk-cycles.test.mjs`.

### Persistent command-session lifecycle

- The desktop command-session registry is main-process, memory-only state that
  survives renderer reloads and is never written to the database or browser
  storage, so it needs no storage deletion — but it MUST be disposed: graceful
  shutdown awaits `disposeDesktopCommandSessions()`, factory reset owns a
  `command-sessions` runtime disposer, `fs:removeRoot` disposes only sessions
  owned by the durable DB root id its disconnect returns, and manager disposal
  clears retained exited output as well as reaping live PTYs.
- Bulk disposal settles every reap attempt and logs a missing PTY exit
  acknowledgement; one stuck PTY never skips a later shutdown step.
- Retained-output reads preserve valid UTF-16 surrogate pairs across bounded page
  boundaries; a high surrogate with no following low surrogate fails explicitly
  with `invalid-buffer`, never a retry-without-progress page.
- Never log or persist command text, cwd, environment, or retained output. The
  hosted native-tool bridge keeps that rule with transcript-only allowlist
  transforms, producer-owned list/output pages, and a non-durable native-tool
  partition that artifact settlement skips. Durable restart survival needs a new
  reviewed persistence design.

Evidence: `platform-contracts/command-session-lifecycle.md`.

### Graceful shutdown ownership (hidden hosts and background indexing)

- `main/desktop-graceful-shutdown.ts` owns the step ORDER and its ONE forced-exit
  budget (`SIGNAL_SHUTDOWN_TIMEOUT_MS`, 5s) for signals and `before-quit`;
  `main.ts` supplies the step bodies. Fix the slow owner; do not raise the budget.
  At the deadline the running step's signal aborts and the forced-exit log names it
  and its elapsed time: a product log, and a CI runner's only actionable clue.
- Shutdown retires embedding-backfill admission FIRST. A request arriving after
  `markDesktopShuttingDown()` cannot restart the host being stopped. Deferred
  HNSW polling stops before database retirement; job rows and index suspension
  stay durable for the next eligible maintenance run.
- The first tracked step closes ordinary renderer windows with
  `BrowserWindow.close()` while their IPC dependencies still exist; hidden hosts
  stay alive for their owning stop commands, and already-admitted database work
  drains through the scheduler before database closure.
- `EmbeddingHostManager.dispose()` refuses new starts BEFORE its cooperative stop
  awaits the renderer, and `RendererHostLifecycle.ensureStarted()` lets a
  `stopping` host settle instead of replacing its window. Shutdown disposal waits
  at most `EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS` (3s), under the 5s deadline;
  ordinary Stop and factory reset keep their 10s wait. A timeout or explicit
  renderer error destroys the owned renderer and rejects, so the tracker records
  a failure rather than a successful stop.
- The embedding worker wakes for `stop()` while awaiting a background permit,
  idle backoff, inter-batch delay, claim-size retry, or error backoff, and a
  stopped permit waiter returns before claiming a job. The stop signal does not
  cancel an embedding already executing.
- Parser host Stop joins every owned generation’s exit and listeners with a 500ms caller wait; timeout rejects while actual cleanup stays owned. A failed kill remains visible and retryable, blocks parsing on that generation, and never acknowledges successful cleanup.
- The assistant HTTP server's stop ends live connections after `close()`; an
  already-closed listener (`ERR_SERVER_NOT_RUNNING`) is a successful repeated
  stop and other close failures stay visible. Why: plain `server.close()` waits
  for every in-flight response.

Settled: admission retirement precedes host stops, and each timeout sits under
the application deadline. Evidence:
`platform-contracts/graceful-shutdown-ownership.md`, `effect-boundary/parser-generation-scope.md`.
Guard: `apps/desktop/src/__tests__/main/desktop-graceful-shutdown.test.ts`, `ipc-embedding-backfill.test.ts`, `embedding-backfill.test.ts`, `embedding-host-manager.test.ts`,
`renderer-host-lifecycle.test.ts`, `apps/desktop/e2e/app-launch.test.ts`, `apps/desktop/src/__tests__/main/parser-host-manager.test.ts`, `parser-host-shutdown.integration.test.ts`.

### Browser preference hydration

- A Zustand store choosing between the Electron storage bridge and
  `createBrowserJsonStorage()` must not resolve that adapter while the module
  graph is still evaluating. Why: optimized web chunking can place preferences
  and storage exports in mutually dependent chunks, and `createJSONStorage`
  catches the factory error there and builds a store with no `persist` API.
- The `createJSONStorage` callback returns a locally declared async proxy and
  reads no imported runtime binding. Successful resolution is memoized so later
  browser operations stay synchronous; a failed one clears the pending promise
  and is retried, and factory and operation errors propagate unchanged.
- Do not call an imported lazy-storage helper from this path. Why: Rolldown may
  fold that binding into the cyclic consumer chunk, leaving it unavailable even
  after initial chunk evaluation.

Evidence: `platform-contracts/browser-preference-hydration.md`.
Guard: `apps/web/e2e/web-db-worker-startup.test.ts`.

---

## RUNTIME DATABASE CORRUPTION RECOVERY

- Recovery replaces the active local database and reloads the visible renderer.
  The failing operation belongs to the old snapshot and MUST NOT be retried
  against the empty replacement.
- Desktop order: invalidate the scheduler generation and reject new DB work until
  reload begins; cancel active embedding backfills; unsubscribe renderer live
  queries; terminate the DB utility process so queued requests fail; back up and
  replace the active profile, then initialize migrations; reload visible windows
  into the existing bounded startup progress flow.
- Every scheduler handed to backfills or other detached work routes through the
  same generation check. Recovery runs inside the single scheduler operation
  after its failing call settled — do not wait for that scheduler to become idle
  from inside recovery, because the current operation owns the lane.
- Recovery is single-flight at the desktop composition root, and hidden hosts are
  excluded from visible-window reload routing. A recovered IPC call rejects with
  `DatabaseCorruptionRecoveredError` and the scheduled reload remounts renderer
  state. Do not replace this with an unbounded blocking dialog.
- Scheduled maintenance is an entry point too. A pass failing with an error
  `isCorruptionError` accepts — the same rule `db:query` uses, never a copy —
  logs `Corruption detected in maintenance; replacing the database without
  retrying.`, enters this path with context `'maintenance'` inside its
  background-lane operation before the lane is released, and rejects with
  `DatabaseCorruptionRecoveredError`.
  `createDesktopDatabaseMaintenanceScheduler` takes `onRuntimeCorruption` as a
  required option with no default, so a composition cannot keep serving a
  database a pass has proven corrupt. A background trigger never narrows the
  response, and the visible-window reload is still required.

Settled: classification stays deliberately narrow (`XX000` excluded), and
maintenance recovers rather than merely logging. Evidence:
`platform-contracts/corruption-recovery-maintenance.md`.
Guard: `apps/desktop/src/__tests__/database-maintenance-scheduler.test.ts`.

---

## AGENT DEVTOOLS PROFILE ISOLATION

- With Agent DevTools enabled, desktop startup applies the launcher's absolute
  `BRAINSTRIKE_E2E_USER_DATA_DIR` to both Electron `userData` and its nested
  `sessionData` path before any store or window is created. A missing path fails
  startup; it never falls through to the production profile. Path isolation does
  not enable E2E runtime semantics: provider, storage, and single-instance
  behavior stay production-equivalent.
- Each profile carries an `agent-devtools-owner.json` marker naming the owning
  launcher pid AND its detached process group. The sweep never deletes a profile
  it cannot prove is dead, and never fails a launch. Why: `pnpm dev` is spawned
  detached, so the tree survives SIGKILL of its launcher.
- Desktop E2E is a separate mechanism: its Playwright fixture derives its own
  `brainstrike-test-user-data-*` path and owns its teardown. It must never adopt
  the `brainstrike-agent-devtools-` prefix.

Evidence: `platform-contracts/agent-devtools-profile.md`. Full launcher contract
in `docs/agents/ci-quality.md`.

---

## FILE WATCHER SERVICE LIFECYCLE

OS file watching is a PLATFORM capability beneath the assistant runtime. Mastra
and assistant code never own watcher lifecycle and add no round-trip dependency
on this local latency path; assistant tools consume indexed state only.

- **One engine**: `@parcel/watcher` behind `@brainstrike/file-system/electron`,
  with an explicit backend per OS. An unsupported platform, missing binding,
  malformed `BRAINSTRIKE_WATCHER_BACKEND`, subscribe timeout, or runtime backend
  failure throws or surfaces typed health — never a fallback engine, never
  polling. `legacy` throws.
- **Silent host death is a real state and health cannot see it.** On some macOS
  hosts FSEventStream delivery stops while `subscribe()` resolves and health
  still reports `healthy`. Discriminate it with
  `@brainstrike/file-system/testing/watcher-liveness`: if the raw binding
  delivered nothing, no code above it can be blamed.
- **Lifecycle**: one native subscription per owning renderer and resolved root;
  10s subscribe timeout with late-resolution unsubscribe; idempotent disposers
  safe at any time. Duplicate same-owner/root registrations get distinct logical
  watchIds sharing one native subscription, and unwatch removes only its own,
  stopping the native watcher after the last leaves. The per-owner cap counts
  native subscriptions while a separate registration cap bounds retained
  watchIds and per-event fan-out. The ownership registry reaps on renderer
  destruction, crash, reload, root removal, and app shutdown, and a lifecycle
  generation rejects path resolution finishing after its context was reaped.
- **Synthetic fixtures**: active dev inline-fixture roots are immutable in-memory
  trees, so their decorated `watchDirectory` returns an inert disposer instead of
  forwarding a fixture name to OS watcher IPC, while delegating every real root
  unchanged.
- **Typed health**: engines emit `starting|healthy|degraded|failed|stopped`
  exactly once per state change; `fs:watch-health` pushes are scoped to the
  owning WebContents with no root-path field on the wire; retry is manual-only
  with escalating 1s/5s/30s throttling, single-flight per watchId.
  `fs:watch-telemetry` is in-memory counters only — deliberately not persisted,
  so it needs no factory-reset wiring. Do not add persistence without wiring it.
- **Assistant file-read cursors**: the `readWorkspaceFile` continuation registry
  is main-process, memory-only, survives renderer reloads, expires after one
  hour, and is cleared through the `read-workspace-file-cursors` factory-reset
  runtime. It must never move to durable storage, and an unknown handle must
  never trigger a fresh-read fallback.
- **Per-subscription ignore override**: `ignorePatterns` REPLACES
  `DEFAULT_IGNORE_PATTERNS` for one subscription only, applying to both native
  globs and the event guard. `undefined` selects the default layers —
  `fileFilter.shouldIgnorePath` PLUS the background-indexing policy's
  unconditional `.claude/worktrees` and `.brainstrike/worktrees` prefixes, applied
  root-relatively and skipped when the root itself sits inside an excluded tree.
  `[]` means "ignore nothing", never a silent fallback.
- `reportDefaultFilteredChanges` defaults to `false`; only the MAIN-owned
  Explorer `fs:watch` dependency passes `true`, broadening only `dist`, `build`
  and `.DS_Store`. Reporting `true` plus ANY explicit override throws before
  watcher setup, because the configuration is ambiguous and must never be
  silently coerced. Both watcher and renderer batching cap retained boundaries at
  64 and surface explicit overflow; neither option is renderer or wire input.
- Overrides cannot reach the desktop `fs:watch` IPC domain, which deduplicates on
  `(ownerId, resolvedPath)` only. Any future caller threading an override through
  it MUST add the pattern set to `subscriptionKey`, or two registrations for one
  root silently share a filter set.
- **Git-inventory watcher**: per-repo subscriptions mark themselves dead on an
  `'errored'` signal — visible via typed state, never a silent no-op and never an
  auto-restart — and retry only when an explicit `sync()` still lists that common
  dir. An `'overflow'` forces IMMEDIATE invalidation without marking the watcher
  dead. The trailing debounce carries a max-wait cap
  (`GIT_INVENTORY_WATCH_MAX_BATCH_MS`, 2000ms), because sustained churn would
  otherwise starve invalidation. `disposeAll()` is TERMINAL.
- **Packaging**: asarUnpack for the parcel prebuilds is BINARY-ONLY
  (`**/node_modules/@parcel/**/*.node`), because whole-directory globs corrupt
  the asar under pnpm symlinks. Packaged proof:
  `pnpm --filter @brainstrike/file-system test:packaged`.

Full event-pipeline invariants (batching, ignore rules, normalization, consumers)
live in `docs/agents/explorer-search-tapestry.md` ("EXPLORER TREE LIVE REFRESH").

Settled: one engine with no fallback, and the ignore override stays out of the
IPC domain. Evidence: `platform-contracts/file-watcher-lifecycle.md`,
`docs/agents/research/bst-568-parcel-watcher-spike.md`.
Guard: `packages/file-system/src/__tests__/parcel-binding.integration.test.ts`,
`apps/desktop/src/__tests__/ipc-domains/file-system-watch-ipc.test.ts`.

---

## IN-MEMORY DATABASE QUERY TELEMETRY

- `packages/db/src/database-query-telemetry.ts` is the privacy boundary.
  Producers choose one fixed feature area (`file-tree`, `live-query`,
  `queue-stats`, `token-estimation`) at the typed call site; never infer feature
  ownership from SQL text or labels.
- The collector is memory-only and process-local, retains no SQL, parameters,
  rows, paths, filenames, queue names, or content, and needs no factory-reset
  wiring. Runtime records accept only the declared feature, duration, failure,
  lookup, and hit fields; unknown keys and malformed values throw before a sample
  is retained.
- Duration samples are a per-feature rolling one-minute buffer with a cap, while
  arrivals, failures, and token lookup/hit totals use separate exact bounded
  rolling buckets, so count and rate stay independent of the sample cap. A
  nonzero count with zero retained percentile inputs at the boundary-inclusive
  bucket edge is expected, not a bug.
- A monotonic Performance clock owns sample and bucket retention; the wall clock
  supplies only the reported `snapshotAt`. Module construction is clock-free, and
  the first collection or external-store read validates the clock and fails
  loudly if it is unavailable.
- External-store notifications coalesce to one-second updates, and while a
  subscriber is active reads return the published snapshot identity until the
  coalesced notification publishes a replacement.
- Production wrappers log telemetry failures at error level while always
  preserving the operation's original success or rejection, and each producer
  latches an unavailable clock and logs it once. After a retention-clock failure,
  imperative `snapshot()` still throws the latched error while external-store
  reads return one stable snapshot marked `failed` with the precise reason.
- The scheduled live-query wrapper owns its own terminal state: it admits exactly
  one listener and rejects subscribe/refresh once released, rather than
  inheriting terminalization from the raw PGlite handle. Repeated unsubscribe is
  idempotent; callers create a fresh handle. Concurrent Electron teardown callers
  share one remote stop attempt, a rejected stop stays retryable, and
  renderer-local listener and counter ownership releases exactly once.
- There is deliberately no public reset, because clearing the singleton could
  invalidate live-subscription ownership held by active proxies.
- The background token indexer has a separate renderer-local stream
  (`packages/token-cache/src/telemetry.ts`). `useIndexerTelemetry` creates the
  subscribing aggregator inside its effect and every effect instance disposes it
  — never in render or a memo initializer, or StrictMode and abandoned concurrent
  renders retain a raw-event listener after the panel closes. The view receives a
  deliberately projected aggregate: raw events carry composite keys, folder ids,
  paths, and error messages and must never cross into the diagnostics card.

Settled: feature area is declared, not inferred; counts and percentile samples
are separate instruments. Evidence:
`platform-contracts/database-query-telemetry.md`.
Guard: `packages/db/__tests__/database-query-telemetry.test.ts`,
`database-work-scheduler-live-handle.integration.test.ts`,
`packages/app-shell/src/__tests__/system-diagnostics-panel.test.tsx`.

---

## DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)

Cross-cutting, app-wide diagnostic capture — deliberately SEPARATE from the
run-scoped `brainstrike_assistant_run_events` timeline (different scope,
retention, and sanitization contract; do not relitigate). Design doc:
`docs/error-observability-design-2026-07-23.md`.

- **Performance telemetry is a separate in-memory signal, not a fabricated
  warning event.** Do not write routine performance samples into
  `brainstrike_diagnostic_events`: that table is CHECK-constrained to warn+
  failure signals, drives the unseen-diagnostics chip, and carries the wrong
  cardinality and severity model for continuous measurement.
- Renderer long tasks are observed only in the visible renderer and retained in a
  bounded rolling window holding duration, the coarse app route, and enabled
  feature-flag identifiers. Feature flags come only from an authoritative
  app-owned registry; with none wired, say the context is unavailable rather than
  treating an empty placeholder as "no flags active", and surface mixed
  known/unknown context as partial.
- Retention is owned by the telemetry store: expiry and cap eviction remove stale
  context without a diagnostics subscriber. Any retention-clock failure outside a
  render-phase `getSnapshot` releases retained samples and dedupe keys
  immediately, even if the failure is transient. A render-phase `getSnapshot`
  clock failure is the one exception: it publishes an empty failed snapshot and
  does not mutate backing storage. The already owned retention timer or the next
  non-render collection/publication entry point performs the pending destructive
  cleanup.
- Unsupported observation releases retained samples, dedupe keys and the
  retention timer before publishing an explicitly empty window without consulting
  the timing clock; disposing that inactive observation repeats the release. An
  unsupported or failed `PerformanceObserver` is represented explicitly and never
  degrades silently.
- Occurrence timestamps, window pruning, and retention deadlines share the
  Performance timeline's monotonic epoch clock; `Date.now()` must not drive this
  retention boundary, because a wall-clock adjustment would split the clocks.
- A malformed entry (negative duration, start after delivery, negative start, or
  completion beyond the one-millisecond rounding tolerance) fails the observation
  and disconnects its observer loudly, while valid siblings from the same batch
  are retained and published with that failed snapshot. Buffered entries dedupe
  on stable Performance entry identity and carry DELIVERY-TIME route and flag
  context that System Diagnostics labels as such.
- **Table**: `brainstrike_diagnostic_events` — numbered migration 073 AND the
  drizzle `customMigrations` entry. No foreign keys: correlation ids are nullable
  text and orphans are inert. `severity` is CHECK-constrained `warn | error |
  fatal`; `fingerprint` is computed at write time so recurring errors with
  different ids or paths collapse together; `session_id` is a per-launch UUID.
- **Capture**: the `addLogListener` seam feeds `DiagnosticSinkBridge`, mounted
  ONLY in the two visible renderers; desktop main and hidden hosts have no PGlite
  handle, so their warn+ records are pushed over `logging:durable-record` and
  consumed through the bridge's `forwardedRecords` prop.
  `DIAGNOSTIC_SINK_SCOPE` is excluded from both consumers — the loop guard that
  stops sink failures re-entering the sink. `logRecordToDiagnosticEvent` bounds
  message, stack, and context VISIBLY through `boundWithMarker` and runs
  `redactSensitiveLogValue` over context before queueing.
- **Writer**: batched and never awaited on the logging call path. `maxPending` is
  a drop-oldest ring buffer and each drop materializes one loud
  `diagnostics_events_dropped` marker prepended to the next flush — loss is never
  silent. After `maxConsecutiveFailures` the writer self-disables, drops its
  queue, and calls `onDisabled`, which the bridge logs through a plain
  non-recursing logger. `error`/`fatal` flush eagerly right after `enqueue()`
  while `warn` batches, because `flush()` is single-flight and browsers do not
  guarantee async work started in a `visibilitychange:hidden` handler completes.
- **Unstorable characters are rewritten at the repository boundary, visibly.**
  `insertBatch` replaces NUL with U+2400 and each lone surrogate with U+FFFD
  across every text column and every JSON key and string value, recording
  per-field counts under the reserved `context.storageReplacements`. Why:
  PostgreSQL `text` rejects NUL and `jsonb` rejects both escapes, and the writer
  re-queues a failed batch whole, so one bad row kills the writer. The rewrite
  must never throw, and `insertBatch` is the only writer to this table — do not
  replace it with per-row retry or silent stripping.
- **Retention**: `DiagnosticEventsRepository.purge()` is a bounded, oldest-first
  delete past a max age OR a max row count, capped per delete — never an
  unbounded `DELETE`, never a trigger. It runs once on bridge mount, reads the
  user's configured values, and applies its cap independently to each of the two
  deletes, so one call can still leave a backlog. Keep
  `brainstrike_diagnostic_events` wired in BOTH reset paths.
- **Full thread debug pack** is an explicit local export — conversation and file
  content, tool arguments and results, captured settings, approvals and live
  decisions, per-leg prompts, parent wakeups, and on desktop the main-process log
  window and process counters — that never uploads and names its included content
  before download. It is the feature-specific content opt-in under
  `docs/diagnostics-privacy-contract.md`, not background telemetry.
- `readThreadDebugSnapshot` resolves the native thread, revalidates the canonical
  authorized delegated graph, and captures every section of its `SECTIONS`
  inventory — the source of truth for included tables and columns — in a single
  SQL statement, with no status filter, row window, or output elision.
  Unauthorized descendants are excluded; missing or deleted threads, invalid
  ancestry, and read failures fail the download visibly.
- The pack is versioned JSON carrying section counts, artifact accounting
  completeness, elision counts, and explicit evidence limitations; empty sections
  never claim that nothing happened. Artifact bytes are decoded before key-name
  and value-shape redaction, and value scanning precedes JSON serialization so
  multiline secrets stay detectable and the JSON stays valid. Derived sections
  sit INSIDE `sections` so both redaction passes cover them, and host evidence is
  fetched at click time, never persisted, recorded as `included` or
  `unavailable: <reason>`.
- **Failure debug bundle**: each delivery — Copy and Download — builds its OWN
  bundle, so every click reflects data at click time and no cache goes stale.
  Filename and save live in `debug-bundle-download.ts`, not the component module,
  which is component-only under the Fast Refresh boundary contract
  (`react-refresh/only-export-components` in `eslint.config.js`; the split
  predates that gate and was originally attributed to react-doctor, whose rule is
  live but warn-only and gates nothing — see the REACT DOCTOR section in
  `docs/agents/ci-quality.md`).
- **Every diagnostics download — filename AND save — goes through
  `packages/utils/src/browser-download.ts`.** A call site that hand-rolls an
  anchor save is a regression, and `file-saver` is gone from the repo:
  reintroducing it is the same regression. `formatTimestampedDownloadFilename`
  owns the safe-timestamp rule, sanitizes each segment to `[a-zA-Z0-9._-]`,
  judges emptiness AFTER sanitizing, and THROWS on a segment that sanitizes away
  or an invalid `Date`. Never put a raw `toISOString()` in `anchor.download`,
  because Windows rejects `:`.
- `downloadBlobFile` is async with TWO routes selected by capability, never
  `isElectron()`. Desktop: main writes into the OS Downloads folder, re-validating
  the filename against the same charset, exclusive-create (`O_EXCL`) with a
  ` (n)` counter — it never overwrites — and a PRESENT-but-malformed bridge
  THROWS rather than falling back to the anchor route, which would silently
  reintroduce the wedge-prone blob pipeline. Web revokes the object URL DEFERRED
  on success and IMMEDIATE when the click threw; with neither bridge nor DOM it
  throws rather than no-opping. A caller that names the file to the user uses the
  resolved `{ path? }`.
- The bundle is bounded by byte length measured with `TextEncoder`. Over budget
  it elides deterministically in three stages — oldest non-protected transcript
  messages, then tool-result bodies to a short preview, then run-event metadata —
  and always appends a visible `## Elision log` footer. It never throws and never
  elides silently.
- Redaction is key-name-based and applied twice (at capture and over the whole
  bundle at format time), then `scrubLikelySecretValues` runs over the final
  rendered Markdown as a value-SHAPE scan independent of key names, at the single
  choke point every `formatThreadDebugBundle` return path flows through. Each
  match becomes `[redacted-secret:<kind>]` and a count line is appended.
  High-precision patterns only: a belt-and-braces net, not a general scanner.
- **Agent diagnostics query**: desktop registers the read-risk
  `brainstrike.queryDiagnostics` native tool over `DiagnosticEventsRepository`.
  Schema and repository both hard-cap results, the tool applies the native
  output-character budget after bounding individual fields, and any cap or budget
  cut is visible through `truncated` and `hint`. The hosted web assistant omits
  this capability and never substitutes a remote query.

Settled: performance samples stay out of the table; the repository boundary
rewrites unstorable characters rather than retrying; one helper owns both halves
of every download. Evidence: `platform-contracts/long-task-telemetry.md`,
`platform-contracts/diagnostic-events-pipeline.md`,
`platform-contracts/thread-debug-pack.md`,
`platform-contracts/debug-bundle-and-downloads.md`.
Guard: `packages/utils/src/__tests__/diagnostic-events.test.ts`,
`diagnostic-event-writer.test.ts`, `browser-download.test.ts`,
`packages/db/__tests__/diagnostic-events-repository.test.ts`,
`thread-debug-snapshot.integration.test.ts`,
`packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx`,
`debug-bundle.test.ts`, `secret-scrub.test.ts`,
`packages/assistant-ui/src/__tests__/debug-bundle-download.test.ts`.

### P2a: NDJSON backstop + persistent Log Viewer source

- The NDJSON wire format writes a `DiagnosticEvent` as one JSON line in a FIXED
  `NDJSON_KEY_ORDER`, declared explicitly rather than derived from literal order,
  so a `biome`/`ultracite` key-sort pass cannot reorder the wire format silently.
  `parseDiagnosticEventLine` returns `null` — never a partial or coerced event —
  for a blank, malformed, or short line, because a crash truncates the last line
  written and a tail reader must skip it.
- **Desktop NDJSON backstop**: `RotatingFileSink` (via `createErrorLogSink`)
  writes `${app.getPath('logs')}/brainstrike-errors.ndjson`, warn+ only,
  size-rotated drop-oldest across a fixed slot count, and is skipped entirely
  under `BRAINSTRIKE_DISABLE_FILE_LOGS=1`, which every desktop `test:e2e*` script
  sets. `writeLine` never throws: an open, write, rotate, or short-write failure
  permanently self-disables the sink and reports once through the injected
  `onFailure`. Constructor guards throw synchronously on malformed config.
- **Load-bearing ruling — do not relitigate**: the sink hangs off the two
  `logging-ipc.ts` choke points (the main-process `addLogListener` tap and the
  `logging:ingest-buffered-record` handler, both already filtered to warn+), NOT
  a pino `customTransports` target. Why: pino transports run in a worker thread
  and see only main-process pino output, missing every renderer and hidden-host
  record forwarded over IPC — most of what this backstop catches. That is also
  why rotation is hand-rolled rather than a new dependency.
- **Recursion rule**: nothing in the sink path may import or call
  `@brainstrike/logging`. The one deliberate exception is a raw `console.error`
  (`reportSinkFailure`), reused by the sink's `onFailure` and by the try/catch
  around record serialization.
- MCP stdio child diagnostics join this path only after
  `McpStdioDiagnosticCollector` has made each line bounded, line-safe, and
  secret-redacted including URL userinfo. Routine lines stay at `debug`; a
  connection failure or unexpected child exit takes one memoized failure report
  per server generation. Never log the raw stderr chunk alongside it.
- **Shutdown ordering**: the `error-log-sink` step is the LAST shutdown step and
  runs AFTER the aggregate failure warn, not merely after `'database'`.
  Reordering it breaks the guarantee that the NDJSON file, the last writer
  standing, captures a shutdown-step failure. Its `close()` failure is logged
  directly rather than pushed into the already-consumed `failures` array, and the
  handle is nulled from a `finally`.
- The graceful-shutdown caller nulls its handle in the same step, so
  `recordDurableLog` becomes a permanent no-op afterwards; the factory-reset
  runtime disposer deliberately does NOT, so the next warn+ record after the
  purge recreates the file. Why: it must close the fd before the purge — on POSIX
  an unlinked-but-open file silently stops landing on disk, and on Windows the
  delete fails while reset still reports success.
- **Factory reset purges the NDJSON mirror, not only the DB rows.** The file
  lives under `logs`, which reset otherwise preserves, so
  `resetDesktopApplicationData` takes an explicit `errorLogFilePaths` list and
  best-effort removes the live file and its rotated siblings in its own pass,
  after `stopBackgroundRuntimes`. A purge failure is logged and tracked in
  `pendingDeletionPaths` — reported, never swallowed — without failing the reset.
  `brainstrike.log` stays preserved.
- **Full INFO-log rotation**: `brainstrike.log` uses the standalone Pino worker
  target `main-log-transport.ts`, bundled as a flat main-process entry. Packaged
  builds put it in `app.asar.unpacked` and the resolver rejects an unexpected
  packaged layout rather than depending on worker-thread ASAR loading.
- Development resolves a flat main-process entry as a sibling of the running
  bundled module's own `__filename` — never `app.getAppPath()` (launch-mode
  dependent, and the source of the `dist/dist/` doubling bug), and deliberately
  not `module.filename` or `import.meta.filename`. An empty or missing
  `__filename` THROWS rather than guessing from `process.cwd()`. The same
  invariant governs the watchdog worker and the Python-runtime resources dir.
- The transport passes Pino's already-delimited bytes unchanged to the same
  `RotatingFileSink`, and a sink failure reports once through the worker's raw
  console channel and disables only the file sink, never the shared transport
  stream. `applyLoggingPreferences` THROWS if Electron main enables file logging
  without an explicit target, because falling back to `pino/file` silently
  restores unbounded growth.
- **Desktop diagnostics reads are read-only and persist nothing.**
  `readMainLogWindow` validates `{ since, until }` BEFORE the provider runs:
  millisecond ISO-8601 UTC instants exactly as `Date#toISOString()` writes them
  (the reader orders lines as strings), `until` not before `since`, at most 24
  hours, not in the future. It returns warn+ lines across the live file and its
  rotated siblings, oldest first, bounded by line and byte caps keeping the
  newest, plus marker counts over EVERY level in the window; the rotated slot
  count derives from the sink's own default. A crash-truncated line is counted,
  never thrown; a record with no `time` field rejects rather than reading as an
  empty window.
- `read-process-counters` returns a bounded ring of heap/RSS samples, WebAssembly
  counts with recent failure messages, and native background-task counts. The
  sampler reads the count as background-priority SCHEDULED work, never a raw DB
  host call, because scheduled work waits out the factory-reset barrier so a tick
  cannot reopen the database while reset replaces the profile. The shutdown
  `database` step stops the sampler before the scheduler idle join, and the ring
  is cleared by the `process-counter-ring` factory-reset runtime. The
  `WebAssembly` wrapper is installed by the bare side-effect import on the FIRST
  line of `main.ts` so later imports are counted, and the pack reaches both calls
  ONLY through `readThreadDebugHostProbe`, never `isElectron()`.
- **Main-thread freeze watchdog**: a typed worker entry, never an inline string
  or `eval`, and there is no alternate implementation.
  `main-watchdog-core.ts` owns the typed config, heartbeat, suspend/resume
  protocol, and diagnostic calculation, using `performance.now()` for elapsed
  timing and `Date.now()` only for the emitted wall-clock stamp. Disabled file
  logging sends `logPath: null` rather than inventing a destination. A malformed
  message, invalid counter or logging state, duplicate attach/detach, invalid
  packaged path, or an fd-2 record exhausting its bounded write policy THROWS,
  while a synchronous bootstrap failure is logged at error level and never makes
  this diagnostics-only subsystem fatal to startup.
- On a freeze the worker writes the structured diagnostic directly to fd 2 with
  bounded completion of partial writes and `EAGAIN` retry, then synchronously
  appends the identical NDJSON record when a log path is configured; an append
  failure emits `MAIN_WATCHDOG_LOG_WRITE_FAILED` to stderr and keeps checking.
  Why: delivery must not depend on a frozen main thread draining worker stdio.
- **Log Viewer controls**: source and code selectors plus inclusive local From/To
  inputs. A missing code stays a selectable "No code" case rather than an
  invented value, an invalid range is visibly marked and matches nothing, and
  Copy JSON serialization is lazy, cycle-safe, and explicit about values JSON
  cannot represent.
- **Persistent Log Viewer source** is gated on `useOptionalPGliteDatabase()`
  returning a live handle — capability-by-composition, never a platform check and
  never `hasDurableAssistantUsageCapability()`, which is desktop-only OM
  persistence. It polls for warn+ rows and deliberately bypasses `queryEvents`
  with direct SQL, because that method hard-caps `limit` low and its `severity`
  filter is equality, not a minimum; the row mapper is still reused.
- `subscribe()` guards overlapping polls with a monotonic `latestRequestId`, so a
  slow tick can never clobber a newer one, and `useDurableLogSource` memoizes the
  adapter on the db handle's identity to keep it referentially STABLE — the
  viewer keys its subscribe/teardown on adapter identity, so an unstable adapter
  restarts polling every render.
- The NDJSON export button and the viewer share the same bounded ascending query
  as their single source of truth, and `exportNdjson()` deliberately has no
  try/catch, because a swallowed rejection renders as a successful-but-empty
  file.

Settled: the sink stays on the logging choke points, the last shutdown step stays
last, and flat main entries resolve from `__filename`. Evidence:
`platform-contracts/ndjson-backstop.md`,
`platform-contracts/desktop-diagnostics-host-probes.md`,
`platform-contracts/log-viewer-sources.md`.
Guard: `packages/utils/src/__tests__/diagnostic-event-ndjson.test.ts`,
`apps/desktop/src/__tests__/diagnostics/rotating-file-sink.integration.test.ts`,
`error-log-sink.test.ts`, `main-log-transport-path.test.ts`,
`main-log-window.test.ts`, `process-counter-sampler.test.ts`,
`main-watchdog-core.test.ts`, `main-watchdog-worker.integration.test.ts`,
`packages/app-shell/src/__tests__/durable-log-source.test.ts`,
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`.

### P2b: status chip, retention preferences, sink health

- The unseen-diagnostics chip is one `usePGliteLiveQuery` aggregate over rows
  newer than the watermark. The table's CHECK constraint defines the complete
  warn+ set; two `FILTER` clauses partition it for honest labels rather than
  deciding eligibility, with `error` and `fatal` sharing the error bucket.
- The chip renders `null` only when both counts are 0, and ALL not-knowing
  classes outrank the counts, because this is the only always-visible diagnostics
  surface. A live-query error renders "Diagnostics unavailable" rather than an
  honest-looking `0`; a non-null `disabledReason` renders "Diagnostics not
  recording", outranking even non-zero counts, since those counts are frozen once
  the sink is dead. Aggregate values are validated strictly — only a non-negative
  safe integer or a whitespace-free decimal-digit string — and anything else
  renders "Diagnostics unavailable" rather than being coerced via `Number()`.
- The watermark is **session-scoped, seeded at module load, and deliberately NOT
  persisted**: the chip means "warn+ events since this launch". Do not "fix" this
  by adding `persist`, which would replay the whole retained backlog as unread on
  every launch.
- Retention preferences are persisted, chosen from the declared option lists, and
  their DEFAULTS must equal the repository's `DIAGNOSTIC_RETENTION_MAX_AGE_MS` /
  `_MAX_ROWS` — asserted by importing both, never by hardcoding the numbers
  twice. Setters THROW outside the option list; malformed config is loud, never
  coerced.
- Both `migrate` and the store's sanitized `merge` validate an unknown persisted
  payload back to defaults, and with no stored snapshot the shared merge returns
  the current store unchanged. Why: Zustand skips `migrate` when the stored
  version already matches, and a late hydration must not overwrite live state.
  Hydration sanitizes in memory and deliberately does not rewrite storage, and
  the shared merge is installed on the sibling preference stores too.
- The settings card always renders its persisted retention selectors; only the
  "Purge now" row is capability-gated by an optional callback prop gated on a db
  handle, because `app-shell` already depends on `preferences` and a repository
  import would be circular. Without the capability the card says the limits apply
  once the local database is available — a missing action row is never the only
  signal. A returned purge count at or above the per-call limit toasts "more may
  remain" instead of implying a full drain; the section mirrors that limit as its
  own constant while its test imports the REAL exported limit, so drift fails RED.
- The writer's `onDisabled` is the ONLY signal a broken sink can emit, because the
  loop guard keeps the sink's own failures out of the table. It travels through a
  module-level store, not React context, because `DiagnosticSinkBridge` mounts
  inside `<DbProvider>` but outside `RootLayoutContent`. `markDisabled` is
  idempotent — first reason wins.
- A new database identity constructs a replacement writer and clears the prior
  reason; changing other bridge props for the same database MUST NOT clear it,
  and each writer's `onDisabled` is generation-scoped so a retired writer's async
  dispose or flush cannot re-arm stale health.
- Factory reset: the two session stores are reset by `resetAppShellSessionStores`;
  the persisted retention store is re-defaulted directly from
  `clearBrowserStorage()`.

Settled: the watermark stays session-scoped, and a not-knowing state always
outranks a count. Evidence: `platform-contracts/p2b-diagnostics-stores.md`.
Guard: `packages/app-state/src/__tests__/diagnostics-retention-store.test.ts`,
`packages/app-shell/src/__tests__/diagnostics-status-item.test.tsx`,
`diagnostic-sink-health-store.test.ts`, `use-diagnostics-purge.test.tsx`,
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`.

### Delegation resource accounting reset

- The delegation budget, child-budget, and step-reservation relations belong to
  the application database. Both direct-transport reset paths and desktop IPC
  reset clear them, and the shared reset registry classifies all three. There is
  no separate persistent queue or filesystem accounting store.
- Native host shutdown drains active work before reset; unresolved output remains
  charged on ordinary restart.

Settled: whole-profile no-resurrection coverage exists and does not replace
table-by-table `db:clearAll` proofs. Evidence:
`platform-contracts/delegation-reset-coverage.md`.
Guard: `apps/desktop/e2e/delegated-factory-reset.desktop.test.ts`.
