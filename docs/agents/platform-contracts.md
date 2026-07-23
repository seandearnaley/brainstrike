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

Add tests when changing reset behavior.

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
  disposers idempotent and safe at any time. A duplicate same-owner/root IPC
  registration (renderer reload or StrictMode cleanup race) transfers the
  existing native subscription to a fresh logical watchId instead of starting
  Parcel again; a later unwatch for the stale watchId is harmless, and
  `duplicateReplacements` makes this visible in the in-memory telemetry. The
  main-process ownership registry also reaps on
  renderer destruction, crash, reload, root removal, and app shutdown
  (registrar disposer). No leaked subscription after any of these — extend the
  replacement and reaper tests when touching this.
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
