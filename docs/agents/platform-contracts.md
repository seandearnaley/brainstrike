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
- Unit suites that disable transport output use `configureLogger({ console: false })`.
  In Node, an empty transport set creates a disabled Pino instance instead of
  falling back to Pino's implicit stdout destination. Log listeners remain
  active so tests can assert records without emitting them to the test runner.

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

Desktop bundled Python runtime (BST-1061): `resolvePythonBinary` unpacks the
pinned CPython under `app.getPath('userData')/python-runtime/`, so the
wholesale userData wipe in `desktop-factory-reset.ts` covers it with zero
dedicated wiring. That coverage is pinned by the BST-1061 regression test in
`apps/desktop/src/__tests__/main/desktop-factory-reset.test.ts` — if the
unpack dir ever moves outside userData, it needs explicit reset wiring plus an
update here.

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
explicitly; only a pre-068 missing relation is tolerated. It also includes
`brainstrike_assistant_thread_groups` and
`brainstrike_assistant_thread_placements`, the durable thread grouping and
manual-order presentation state (migration 054). Every table-enumerating reset
deletes placements before groups, then deletes both before Mastra threads.
It also includes `brainstrike_assistant_run_errors` (migration 076), the
FK-less terminal provider-forensics store: clear it before the lazy parent
run/thread relations in desktop `db:clearAll`, renderer direct clear, and
renderer factory-reset purge so error text and allowlisted response metadata
cannot survive a fresh start.

Mastra owns six assistant-persistence relations, and a true fresh start clears
ALL SIX:

- `mastra_threads`
- `mastra_messages`
- `mastra_resources`
- `mastra_observational_memory`
- `mastra_vectors`
- `mastra_workflow_snapshot`

Every SQL path that enumerates tables clears all six: desktop `db:clearAll` in
`db-ipc.ts`, direct-PGlite `clearViaPGlite`, and direct-PGlite factory reset's
`purgeTablesTx` in `db-provider.tsx`.

**The SET those three lists clear is owned by the reset-table registry**
(`packages/db/src/reset-table-registry.ts`, BST-992): all three clear the same
28-relation set (13 `brainstrike_*` — including the `brainstrike_mind_ops`
op-log, whose tombstones must not outlive the mind they describe (BST-993) —
+ 9 core/indexing + the Mastra six), and
the web factory reset (`purgeTablesTx`) additionally wipes the six seed-free
FACTORY-RESET-ONLY relations (`getFactoryResetOnlyTables()`: the three
caches, `job_queue_metrics`, and the two dimension-index bookkeeping tables)
— desktop factory reset already destroys them with the profile directory, so
this is the web↔desktop convergence. `view_filter_presets` is a MIXED
table — migration-SEEDED defaults plus user-authored presets — so the purge
issues a TARGETED `DELETE … WHERE is_default = FALSE`: user presets converge
with desktop (whose rebuild destroys and re-seeds), while the seeds survive
because the web purge never re-runs migrations. Only
per-path ORDER and mechanics differ (children before logical parents varies by
path, and desktop counts + bare-DELETEs `file_chunks`/`file_records`). The
registry exists because the union CANNOT be derived from the Drizzle schema —
the `brainstrike_*` assistant tables are migration-only raw DDL and the Mastra
six live in the assistant contract — and because the lists had already drifted
once: web's two paths silently omitted `brainstrike_assistant_run_usage`,
`_task_lists`, `_edit_checkpoints`, and `_message_parents` (BST-862's class),
so cost history, task lists, edit-checkpoint before-content, and branch
topology survived a web factory reset. Three instruments keep it closed:

- `reset-table-coverage.integration.test.ts` sweeps `information_schema` on a
  fully migrated database — every existing table must be in the registry or in
  `RESET_EXCLUDED_TABLES` with a written reason, so a new migration forces an
  explicit clear-or-exclude decision.
- Registry↔call-site parity: `reset-table-registry.test.tsx` (both renderer
  paths) and the `db:clearAll` set-equality test in `ipc-handlers-db.test.ts`
  (desktop) assert each path clears exactly its registry set —
  `getResetTables()` for the clear paths, `getFactoryResetTables()` for
  `purgeTablesTx`.
- The test-owned literal fixtures (below) stay deliberately independent of the
  registry so production and tests cannot drift together.

Both probe-helper unions derive from the registry
(`ClearableRelation` is `FactoryResetOnlyTable | ResetTable`; desktop's
`OptionalRelationTable` is `Exclude<ResetTable, 'file_chunks' |
'file_records'>`) — keep them derived, and keep them closed unions.

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events`
(renderer-lazy bootstrap DDL in `assistant-memory-repository.ts`, created by no
migration) are in NO list on purpose: both cascade from `mastra_threads`
(`ON DELETE CASCADE`), which every list clears. If that FK is ever dropped —
migration 052 dropped its FKs for exactly this kind of reason — they start
silently surviving reset; move them into the registry in the same change.

Desktop factory reset is deliberately different: `resetLocalDatabase` closes
the database and recursively deletes the active profile directory, so it
removes the relations with the whole database rather than issuing
table-by-table `DELETE`s. Do not add a redundant SQL purge to that
directory-delete path.

These relations are application-created lazily rather than guaranteed by the
numbered migration runner: the memory store creates threads, messages,
resources, and observational memory; the vector store creates vectors; and the
workflow store creates workflow snapshots. A never-used assistant can therefore
legitimately lack any or all of them. Every table-enumerating reset path must
PROBE each relation before deleting it; absence is the only tolerated case, and
every genuine probe or delete failure stays visible.

`mastra_workflow_snapshot` has an UNBOUNDED lifetime — its only deletes are
`deleteWorkflowRunById` (no production caller) and `dangerouslyClearAll`
(tests) — and a suspended run retains its pending tool call and arguments, so it
must never survive reset (BST-558).

`mastra_vectors` receives an intentional blanket `DELETE`. Do not preserve its
`__index_metadata__` sentinel rows: they describe logical indexes owned by the
assistant session and are data, not durable schema. Mastra re-declares every
logical index through `createEmbeddingIndex` or
`createObservationEmbeddingIndex` immediately before each vector upsert/query
path; `PgliteVectorStore.createIndex` recreates the missing sentinel row and
ensures the physical per-dimension HNSW index before use. That self-healing
declaration contract is what makes a blanket delete correct. Filtering out
sentinel rows would let pre-reset logical index metadata survive a fresh start.

**A relation that can legitimately be ABSENT must be PROBED, not
deleted-and-caught.** Each table-enumerating path runs its whole body inside ONE
transaction, and PGlite is real Postgres: a statement error puts the transaction
into the ABORTED state, after which every command fails with `25P02 current
transaction is aborted, commands ignored until end of transaction block` until
ROLLBACK. Catching the original `42P01` does NOT undo that, and there are no
savepoints anywhere in this repo — so a tolerated missing-relation error rolls
the ENTIRE reset back and the user's Clear Database silently does nothing. Use
`SELECT to_regclass('<table>') IS NOT NULL AS present`, which returns NULL
instead of raising, and skip the `DELETE` when absent (BST-558 review).

There is now exactly ONE clear helper per side and both probe: desktop
`clearOptionalRelation` (`apps/desktop/src/ipc-domains/db-ipc.ts`) and renderer
`clearRelationIfPresent` (`packages/db/src/db-provider.tsx`, used by BOTH
`clearViaPGlite` and `purgeTablesTx`). Every call site is therefore safe by
construction rather than by the coincidence that its table happens to be created
by an already-run numbered migration. Do not reintroduce a delete-and-tolerate
variant alongside them.

A probed relation's `DELETE` is deliberately NOT wrapped in a catch: nothing in
this repo ever DROPs these relations, so the probe/delete race is unreachable,
and a tolerated `42P01` there could not recover anyway — it would leave the
transaction aborted and resurface as a misleading `25P02`.

Probing trades one hazard for another, and the TYPE SYSTEM is what closes the
new one. With delete-and-catch a misspelled table raises a loud `42P01`; with
`to_regclass` it returns NULL, indistinguishable from absence, so it becomes a
PERMANENT SILENT SKIP with every test still green. Both helpers therefore take a
closed literal union (`OptionalRelationTable` / `ClearableRelation`), never a
`string` parameter. Keep it that way.

**Every probed Mastra table name must come from the canonical schema exports
(`MASTRA_MEMORY_TABLES`, `MASTRA_VECTOR_TABLE`, and
`MASTRA_WORKFLOW_TABLE`) in
`@brainstrike/assistant-contract/mastra-memory-schema`, never a hand-copied
literal.** `to_regclass` on a stale name returns NULL, which makes the probe a
PERMANENT SILENT SKIP — no error, no warn, only a `logger.debug`. Verified by
control: renaming `TABLE_WORKFLOW_SNAPSHOT` in the contract while the reset path
held an unpinned literal left a suspended-run row alive through a full clear
(`expected 1 to be +0`). Both production sites (desktop `db-ipc.ts` and renderer
`db-provider.tsx`) import the canonical exports.

The renderer used to hold a pinned local literal instead, because that import
reordered bundle chunk init and killed the app at startup. That is FIXED at the
root, not worked around — see the next rule — and the stopgap guard that pinned
the literal is deleted. Do not reintroduce a hand-copied literal here.

**Import those canonical exports freely, but read their values only inside the
function that executes the clear — never at module scope (BST-558).**
Type-position reads in the closed relation unions are erased and remain safe.
Module-scope value initializers run at bundle CHUNK
INITIALIZATION, and the renderer's chunk graph does not guarantee the contract
chunk has evaluated by then. `packages/app-shell/src/assistant-memory-repository.ts`
used to build its bootstrap DDL in a module-scope template literal interpolating
`MASTRA_MEMORY_TABLES.threads`; adding ONE unrelated static import of
`@brainstrike/assistant-contract/mastra-memory-schema` to `db-provider.tsx`
reordered chunk init and the renderer died at startup with `Cannot read
properties of undefined (reading 'threads')` — measured on PR #1978, commit
`df953a2a8` green and `3e8d1b7fd` red. The failure is not always loud: a
property access throws, but a bare interpolation such as `${MASTRA_VECTOR_TABLE}`
splices the literal string `undefined` into the DDL, and in `db-provider.tsx` an
undefined table name would make `to_regclass('undefined')` return NULL — the
permanent silent skip described above. Build SQL inside the function that
executes it (`buildAssistantThreadRunsSchemaSql`,
`buildMastraVectorSchemaSql`).

Nothing else catches this class: `tsc` types ESM live bindings identically
either way, the schema module imports nothing so there is no source cycle to
detect, and Vitest evaluates real modules in dependency order so unit tests
always see a defined binding. Only a production build has a chunk graph.
Before the structural backstop below (BST-861) landed, E2E was the only thing
that observed it — as an unexplained startup crash. `scripts/verify-mastra-schema-init-order.mjs`
(lint lane, paired test `scripts/__tests__/verify-mastra-schema-init-order.test.mjs`)
enforces it statically instead. It scrapes the guarded names from the schema
module rather than hand-listing them, matches on the imported name so re-export
hops like `packages/agent/src/pglite-mastra-memory/sql.ts` are covered, and stops
at every function boundary so the prescribed fix is not itself flagged. It
supersedes a stopgap (`mastra-workflow-table-literal-contract.test.mjs`, deleted)
that pinned one hand-copied literal in one file and could not see `export … from`,
`await import()`, or the same import added from any other module.

**The structural backstop is an acyclic chunk graph (BST-861).** A cross-chunk
cycle is a NECESSARY PRECONDITION for the cross-chunk form of this class, not
a proxy for it: ESM evaluates a module's dependencies before its own body, so
with an acyclic chunk graph a topological init order always exists BETWEEN
chunks, and every imported binding is initialized before any cross-chunk
module-scope read of it. That is not the whole class: two source modules that
are themselves circular and land in the SAME chunk are concatenated by
rolldown in an arbitrary order, which can throw the identical
`ReferenceError` at init while the chunk graph — which has only one node for
that pair — reports no cycle. The accurate statement is "acyclic chunk graph
AND acyclic source-module graph ⇒ safe"; only the first conjunct is enforced.
The second conjunct is now enforced too (**BST-890**):
`scripts/verify-no-source-cycles.mjs` walks the renderer SOURCE graph from both
app entrypoints and fails the lint lane on any circular dependency. It needs no
build, so it lives on the lint lane rather than inside `build`.

Resolution deliberately does NOT go through tsconfig, which points
`@brainstrike/*` at `packages/*/dist/*.d.ts` and made a first attempt see only
139 modules. It composes the repo's own helpers instead — `workspaceSrcAliases`
(`packages/test-utils/workspace-src-aliases.mjs`) plus
`createAgentBrowserSafeAliasEntries`, the same pair `apps/web/vite.config.mts`
uses — and reaches 813 modules. Static, non-type imports only: `import type` is
erased and dynamic `import()` creates no init-order dependency, while a bare
side-effect `import '…'` does and is counted.

The bundler will not do this for you: a genuine source cycle planted in
`apps/web/src` built successfully, emitted ZERO rolldown circular-dependency
warnings, and left the chunk guard clean. "No circular warnings in the build
log" is a blind instrument.

On its first run this guard found a real cycle: `error-boundary.tsx`,
`theme-settings.tsx` and `theme-toggle.tsx` in `packages/ui` imported their OWN
`@brainstrike/ui` barrel, which re-exports them. **Import the sibling module
directly** — a package must never import its own barrel. That is the same
no-barrel/TDZ ruling as BST-742, and it is now enforced rather than advisory.
`scripts/verify-no-cross-chunk-cycles.mjs` asserts the first conjunct on the
emitted bundle and runs inside `apps/web`'s `build` and `apps/desktop`'s
`build:renderer`, so it cannot be bypassed by a code path that still runs the
build. It CAN be skipped by a turbo cache hit: identical inputs produce an
identical artifact, so a cached build never re-invokes the script — that is
correct, not a gap, but it means "wired into build" is not "runs on every CI
job." Measured at the time it landed: web 362 chunks / 1003 static edges / 0
cycles, desktop renderer 367 / 1036 / 0. Scope: this covers the two RENDERER
bundles only — `apps/desktop`'s `build:main` (the Electron main bundle) is
NOT covered.

The class had already recurred twice in unrelated families before this landed:
the context-action helpers (PR #1292, held today only by a `codeSplitting.groups`
entry in `apps/web/vite.config.mts`) and these schema constants. That recurrence
is why **BST-861** generalizes the INVARIANT rather than the mastra-family AST
guard above: the cycle check covers the cross-chunk form for every constant
family, including the three still held by `codeSplitting.groups` pins in both
vite configs (context-actions #1292, browser-events BST-580, zustand). Those
three pins are safe only because their underlying source-module graphs happen
to be acyclic today — nothing currently verifies that, so a future edit that
introduces a real source cycle inside one of those pinned chunks would ship
undetected. The AST guard is kept anyway because it does something the cycle
check cannot — enforce the coding rule at review time, in seconds, with a file
and line number. A repo-wide AST rule was rejected on measurement: "flag every
module-scope read of an imported binding" returns 431 hits in `app-shell` +
`db` alone, nearly all benign. The CHUNK, not the file or the package, is the
unit of risk for the cross-chunk form.

`packages/db/src/migrations/066-restore-pg-textsearch.ts` interpolates the
imported `QUALIFIED_PG_TEXTSEARCH_VERSION` into its module-scope `up` string.
**Leave it alone — do not "fix" this (BST-860, investigated 2026-07-26 and
closed won't-do).** Two reasons, both load-bearing:

1. **The obvious fix breaks production startup.** Moving `up` to the
   `MigrationCallback` form is valid for the NUMBERED runner only. Production
   runs drizzle `runMigrations`, whose ledger is SQL-string-only:
   `customMigration()` throws `must be a SQL string` for any non-string `up`
   (`packages/db/src/drizzle/migrate.ts:148-155`), and `customMigrations` is
   built at MODULE SCOPE (`:168`) — so a callback `up` throws at import time and
   every launch fails. A lazy getter does not help either: the ledger reads
   `up` at module init to hash and store the SQL. The `Migration.up` type
   accepting `string | MigrationCallback` is a property of the test runner, not
   a licence to use a callback here.
2. **The hazard is retired in the renderer.** The invariant is "acyclic chunk
   graph AND acyclic source-module graph ⇒ safe", and both conjuncts are
   enforced and clean there (`verify-no-cross-chunk-cycles.mjs` on build,
   `verify-no-source-cycles.mjs` on lint). A module-scope read is only dangerous
   when a cycle exists, so if one ever appears in the renderer, lint or build
   fails before runtime does. BST-860 predates both guards.

   Be precise about scope, because migration 066 also ships in ELECTRON MAIN:
   `src/main.ts` → `ipc-domains/db-ipc.ts` → `@brainstrike/db`. Conjunct 1 is
   not merely unenforced there, it is inapplicable — `build-main-config.mjs`
   esbuilds one file per entry, so main has no chunk graph. Conjunct 2 walks the
   two RENDERER entrypoints only, so main's source graph is unverified; what
   protects it is the ordinary bundler guarantee that an acyclic graph is
   concatenated in dependency order. Extending the source-cycle guard to the
   main entrypoints would close that, and is the cheap follow-up if this class
   ever recurs in main.

Residual risk of leaving it: negligible. Intra-package, and it fails LOUDLY —
an undefined binding yields `IF actual_version IS DISTINCT FROM 'undefined'`, so
the DO block RAISEs, unlike the silent `to_regclass('undefined')` skip that
motivated the original concern. Do not hardcode the version literal either:
that reintroduces the hand-copied-constant pattern removed in #1988 to defend
against something two guards already make unreachable.

**No catch anywhere in a purge tolerates a missing relation — the probe does.**
A bare `catch (err) { logger.warn(...) }` could never be a tolerance inside a
transaction: the first genuine error aborts it, every later statement fails
`25P02`, each of THOSE is swallowed too, the purge returns normally, and `COMMIT`
on an aborted transaction degrades to `ROLLBACK` WITHOUT raising — factory reset
reports SUCCESS having cleared nothing. This was measured, not reasoned: against
real PGlite, an FK violation on `job_queue` with the old bare-catch tail made
`useFactoryReset()` resolve while every table still held its rows, and an FK
violation on `roots` in `clearViaPGlite` produced three consecutive
"(table may not exist)" warnings before surfacing as a misleading `25P02`.

Narrowing such a catch was only ever a half-measure — it makes the first real
failure visible as itself, but still cannot let the clear CONTINUE past an
absent relation, because the tolerated `42P01` has already aborted the
transaction. Probing is the only form that actually tolerates absence, so the
narrowed-catch helpers (`clearMigratedRelation`, `isMissingNamedRelationError`,
`isMissingOptionalRelationError`, and the per-table `*IfPresent` variants) are
GONE, collapsed into the two probe helpers above. Do not reintroduce a
message-parsing matcher: asking the catalog is both simpler and correct.

Historical debt now CLOSED (BST-558 follow-up), recorded so it is not
re-litigated: the ~14 desktop `clearOptionalRelation` call sites and the
selection-snapshot block in `db-ipc.ts` both delete-and-tolerated. On the desktop
side the defect was latent rather than live — every one of those tables is
created by a numbered migration that has already run by the time a clear starts —
but it was a loaded gun, and the selection-snapshot block additionally only
*logged* non-missing-relation errors without rethrowing. Both are converted.

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

Each profile carries an `agent-devtools-owner.json` marker naming the owning
launcher pid **and its detached process group**, so a later run can distinguish
a profile abandoned by an abrupt kill from one still being written to. Because
`pnpm dev` is spawned detached, a dead launcher pid alone does not mean the
profile is idle — the tree survives SIGKILL of its launcher. The sweep never
deletes a profile it cannot prove is dead, and never fails a launch. Full
contract in `docs/agents/ci-quality.md`.

Desktop E2E is a separate mechanism and not part of this contract: the
Playwright fixture derives its own `brainstrike-test-user-data-*` path and owns
its teardown. It must never adopt the `brainstrike-agent-devtools-` prefix,
which would expose its profiles to the launcher's sweep.

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

## IN-MEMORY DATABASE QUERY TELEMETRY

`packages/db/src/database-query-telemetry.ts` is the privacy boundary for
BST-403. Producers must choose one fixed feature area (`file-tree`,
`live-query`, `queue-stats`, or `token-estimation`) at the typed call site. Do
not infer feature ownership from SQL text or labels. The collector keeps an
independent rolling one-minute buffer of at most 512 samples **per feature** and
exposes counts, failures, p50/p95/max duration, live subscription/update
frequency, token-cache hit rate, and an explicit retained-sample overflow count
to System Diagnostics. The card renders every per-feature count, failure,
p50/p95/max, rate, and overflow dimension plus both the raw live-update count
and rate, so warning attribution and rate inputs are visible.
External-store notifications are coalesced to one-second updates; while a
subscriber is active, reads return the published snapshot identity until the
coalesced notification publishes a replacement. Producers do not sort or
rebuild snapshots on every query. A monotonic Performance clock owns sample and
count-bucket retention; the wall clock is used only for the externally reported
`snapshotAt`. The per-feature cap therefore evicts the oldest arrival directly,
and overflow events are bucketed at the arrival that exceeded the cap. Module
construction is clock-free; the first collection or external-store read
validates the monotonic clock and fails loudly if it is unavailable.

The collector is memory-only and deliberately process-local. It retains no SQL,
parameters, rows, paths, filenames, queue names, or content, and requires no
factory-reset wiring. Runtime records accept only the declared feature,
duration, failure, lookup, and hit fields; unknown keys and malformed values
throw before a sample is retained, and caller fields are captured exactly once
before validation and retention. Query duration and retention both use the
monotonic performance clock. File-record counts and selected-file token SUMs
are measured alongside the other production reads; SUM samples contribute
duration and failure data with zero lookup and hit counts. Live-query histogram
samples represent start and refresh query executions on both renderer and
Electron paths; subscription lifecycle, update delivery, and teardown are
tracked separately. A rejected direct unsubscribe retains its registered
wrapper and active-subscription ownership until a retry succeeds. Production
wrappers log telemetry failures at error level while preserving the database
operation's original success or rejection. There is deliberately no public reset: clearing the singleton could
invalidate live-subscription ownership held by active proxies. Paired coverage
lives in
`packages/db/__tests__/database-query-telemetry.test.ts`,
`database-work-scheduler.test.ts`, `use-live-query.test.tsx`, the token-cache and
Drizzle token/file repository tests, and
`packages/app-shell/src/__tests__/system-diagnostics-panel.test.tsx`.

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
is a CHECK-constrained `warn | error | fatal`. Migration 076 adds the partial
`bst_diagnostic_events_run_idx (run_id, occurred_at DESC)` because P3 makes
the repository's existing run-id filter a hot correlation path.
`fingerprint` is computed at
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

Hidden-renderer records cross `logging:ingest-buffered-record` through the
transport normalizer in `apps/desktop/src/renderer/main.tsx`. Log listeners
already receive key-redacted values from `redactSensitiveLogValue`; the
normalizer retains that privacy boundary for any unexpected raw `Error`, then
converts unsupported primitives and URLs for IPC. Its `WeakMap` memoizes arrays
and objects before recursion so self- or mutually-referential Error cause graphs
and bindings remain structured-cloneable instead of overflowing the listener
and dropping the record. Diagnostic context serialization visibly replaces
back-edges with `[Circular]` only after direct JSON serialization detects a
cycle, keeping acyclic context on the single redaction/serialization path.
Cause-chain cycles terminate with a visible `[Circular]` entry instead of
repeating to the depth cap. The renderer forwarding listener, redaction,
structured-clone topology, and bounded diagnostic conversion are paired in
`apps/desktop/src/__tests__/renderer/main.test.tsx`; Electron preload/main IPC
coverage remains in the desktop logging integration tests.

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
on failed assistant messages. That footer offers two deliveries — **Copy**
(clipboard) and **Download** (a `.md` file on disk, BST-946) — each building
its OWN bundle: a second click re-runs `buildThreadDebugBundle` rather than
reusing the first result, so every delivery reflects the data at click time
and there is no cache to go stale. Download is the realistic transport at this
size: bundles run up to the 200 KB budget below, past what a chat box or issue
comment accepts.
Filename + save live in `packages/ui/src/assistant-ui-panel/debug-bundle-download.ts`
(`formatDebugBundleFilename` / `downloadDebugBundleFile`) rather than in the
component module, which is component-only by react-doctor's
`only-export-components` contract. The filename is
`brainstrike-debug-bundle-<UTC ISO, colons→hyphens, no millis>[-run-<first 8
chars>].md` — timestamp first so a Downloads folder sorts chronologically,
and colon-free because Windows rejects `:` (an unmangled `toISOString()` in
`anchor.download` does not survive there).

**Agent diagnostics query**: desktop registers the read-risk
`brainstrike.queryDiagnostics` native tool
(`apps/desktop/src/assistant-server/query-diagnostics-tool.ts`) over
`DiagnosticEventsRepository`. `mode=events` returns bounded newest-first rows;
`mode=fingerprints` groups recurring fingerprints with count, first/last seen,
and the latest representative message/source/code/severity. Exact
severity/fingerprint/run/thread and inclusive ISO time filters are shared by
both modes. The schema and repository both hard-cap results at 200, and the
tool applies the native output-character budget after bounding individual
message/stack/context fields. A row/group cap or output-budget cut is visible
through `truncated` and `hint`. The hosted web assistant omits this capability
because its server cannot read browser-local PGlite; it never substitutes a
remote query. The bundle's Download action already satisfies the
save-to-file half of P5 (BST-946), so the native tool does not duplicate file
delivery.

**The diagnostics downloads — filename AND save — go through
`packages/utils/src/browser-download.ts`** (subpath
`@brainstrike/utils/browser-download`; pure-half tests
`packages/utils/src/__tests__/browser-download.test.ts`, DOM-half tests
`packages/ui/src/__tests__/debug-bundle-download.test.ts` because the utils
package's vitest environment is `node`). Exactly three call sites today:
`formatDebugBundleFilename` / `downloadDebugBundleFile`, `log-viewer.tsx`'s
`brainstrike-logs-….json`, and `logging-settings-section.tsx`'s
`brainstrike-errors-…[-recent<N>].ndjson`. It is the idiom for NEW download
paths, but it is not yet the app's only one: the DB explorer's CSV/ZIP exports
(`packages/db-explorer/src/hooks/use-export-handlers.ts`) still build names via
their own `generateCSVFilename` (`csv-export-core.ts`) and hand-roll the save,
so none of the guarantees below apply there. Migrating them is open work — do
not read this section as already covering them.

`formatTimestampedDownloadFilename` builds
`${name}-${UTC ISO, colons→hyphens, no millis}[-${suffix}].${extension}` and is
the single owner of the safe-timestamp rule — callers supply only their own
name/suffix/extension. `name`, `suffix` and `extension` are each sanitized to
`[a-zA-Z0-9._-]`, emptiness is judged AFTER sanitizing (so a suffix of stripped
characters cannot leave a dangling `-`), and a name/extension that sanitizes
away or an invalid `Date` THROWS rather than producing a nameless or
`Invalid Date` download. Do NOT put a raw `toISOString()` in `anchor.download`
in new code. `sanitizeFilenameSegment` is exported for the one caller that must
measure a segment before handing it over (the debug bundle truncates a run id
to 8 characters and wants 8 USABLE ones) — do not keep a private copy of that
charset; two copies that must agree would drift silently.

`downloadBlobFile` owns the Blob → object URL → anchor → revoke save and the
object URL's whole lifetime: the revoke is DEFERRED a macrotask
(`setTimeout(…, 0)`) on the success path and IMMEDIATE when the click threw.
Chromium starts the download during click dispatch, but WebKit can fetch the
blob a task later, so a synchronous revoke silently drops the file there; the
immediate revoke on the throwing path is what stops a user retrying a failing
export from pinning one full payload per attempt. Because the helper owns both
halves, no call site restates either — a call site that hand-rolls the anchor
will get one half wrong (all three did, in different ways, before BST-946).
Tests must therefore assert the revoke through `waitFor`/timer-drain rather
than synchronously, and a test that mocks `URL.revokeObjectURL` must drain the
pending macrotask before restoring the spy or the timer lands on the next
test's spy. Outside a DOM it THROWS rather than no-opping. The button's phase
machine tags every non-idle phase with its action (`copy` | `download`) so one
action's spinner/result/error never appears on the other's button, and both
failure paths render inline (`Copy failed: …` / `Download failed: …`) in an
`aria-live` region. A destination picker (File System Access
`showSaveFilePicker`) was deliberately NOT added — anchor download is the
codebase idiom and needs no capability branch. `DEBUG_BUNDLE_FORMAT_VERSION = 1` is stamped in
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
push channel), `apps/desktop/src/__tests__/renderer/main.test.tsx`
(hidden-renderer transport normalization), `packages/ui/src/__tests__/error-boundary.test.tsx`,
`packages/app-shell/src/__tests__/debug-bundle.test.ts` (includes a golden
snapshot), `packages/app-shell/src/__tests__/secret-scrub.test.ts`,
`packages/ui/src/__tests__/copy-debug-bundle-button.test.tsx`,
`packages/ui/src/__tests__/debug-bundle-download.test.ts`,
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

**Recursion rule**: nothing in the sink path
(`rotating-file-sink.ts`, `error-log-sink.ts`) may import or call
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
depending on worker-thread ASAR loading or silently trying another target. The
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

**Log Viewer diagnostic controls**: the viewer exposes dedicated source and
code selectors populated from the active adapter's records, plus inclusive
local From/To timestamp inputs. Source prefers explicit `logSource` context
and then the runtime binding; missing codes remain a selectable "No code"
case rather than being coerced into an invented value. An invalid time range
is visibly marked and yields no matching rows. Each row has a structured
detail dialog for source, code, fingerprint, message, cause chain, stack, and
context, plus "Copy JSON" routed through the shared clipboard service. Copy
serialization is lazy (on click), cycle-safe, and explicit about values JSON
cannot represent directly, so malformed diagnostic context cannot crash the
table render or silently produce an empty clipboard payload.

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
`apps/desktop/src/__tests__/diagnostics/rotating-file-sink.integration.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport-path.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport-worker.integration.test.ts`,
`apps/desktop/src/__tests__/diagnostics/error-log-sink.test.ts`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (the
`recordDurableLog handler` describe block covers the two `logging-ipc.ts`
choke points feeding the sink),
`packages/app-shell/src/__tests__/durable-log-source.test.ts`,
`packages/app-shell/src/__tests__/use-durable-log-source.test.tsx`,
`packages/preferences/src/settings/system/logging-settings-section.test.tsx`,
`packages/preferences/src/settings/system/log-viewer-components/__tests__/log-viewer.test.tsx`,
`packages/ui/src/__tests__/copy-text-button.test.tsx`.

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
Both `migrate` and the store's sanitized `merge` validate an unknown persisted
payload back to defaults. The merge is required because Zustand skips
`migrate` when the stored version already matches; it preserves live actions
and applies only the sanitizer's complete persisted-data shape. When storage
has no snapshot (`persistedState === undefined`), the shared merge returns the
current store unchanged so defaults or a late hydration cannot overwrite live
state. Hydration sanitizes in memory but deliberately does not rewrite storage.
The shared merge is also installed on the notification, assistant-budget,
permission-policy, skills, background-indexing, hook-trust, subagent-personas,
token, vector, and workspace-instructions preference stores. Stores with custom
storage parsers (panel layouts) and the assistant-memory store's explicit
rehydration sanitizer already enforce the same current-version boundary through
their own specialized paths.

**Purge path**: the settings card always renders its persisted retention
selectors, including while no database handle is available. Only its "Purge
now" row is capability-gated by the optional
`onPurgeNow?: () => Promise<number>` **callback prop**. That callback reaches
the repository without a repository import — `app-shell` already depends on
`preferences`, so that direction is circular (same precedent as
`onExportDurableNdjson`). Both apps build it from `useDiagnosticsPurge()`
(`packages/app-shell/src/diagnostics/use-diagnostics-purge.ts`), gated on a db
handle. Without that capability the card explicitly says the configured limits
apply once the local database is available; the missing action row is never the
only signal that enforcement is deferred. Because a single `purge()` is
per-call bounded, a returned count at or
above the per-call limit toasts "more may remain" instead of implying a full
drain; `logging-settings-section.tsx` mirrors that limit as
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
cannot overwrite the root cause shown to the user. A new database identity
constructs a replacement writer and clears the prior writer's reason; changing
other bridge props for the same database MUST NOT clear it. Each writer's
`onDisabled` callback is generation-scoped, so a retired writer's asynchronous
dispose/flush cannot re-arm stale health after replacement. The replacement
starts clean and re-arms the warning only after its own bounded
`maxConsecutiveFailures` window, so the banner can be briefly clear while that
failure threshold accumulates.

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
