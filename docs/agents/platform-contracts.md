# Platform Contracts: Logging, Factory Reset

> Extracted from AGENTS.md (2026-07-12). Read before adding persistence or changing logging. Keep updated with the code.

## LOGGING (PINO V10)

Centralized logging: `packages/logging/src/logger.ts`

Usage:
- Use `initializeLogging` from `@brainstrike/logging`.
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
- The Log Viewer keeps records whose bindings are not directly JSON-safe. Its
  shared diagnostic normalizer preserves serializable structure and emits
  explicit markers such as `[Circular]`; an unexpected normalization failure
  renders `[Bindings serialization failed]`. The same normalization owns JSON
  export, so one malformed record never crashes the viewer, silently disappears,
  or breaks export.

Scoped loggers:
- createLogger('FileImporter')

Workspace indexing setup (BST-1340):
- Missing root or managed collection is `unconfigured`, clearing stale progress
  and `lastError` without a durable diagnostic failure. The provider reports
  `waiting` while the database initializes and constructs the sync service only
  once it exists. A missing required database inside the service is an invalid
  dependency and remains an error, as do invalid metadata and runtime failures.
- The provider bootstraps a default Workspace Index for fresh preferences.
  Publishing its collection id re-enters the sync lifecycle, which owns the
  resulting status; bootstrap completion must not overwrite a newer status.
  Public regressions: `workspace-collection-sync-service.test.ts` and
  `workspace-collection-sync-provider.test.tsx` in app-shell background indexing.

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Structured arguments and listener bindings are recursively redacted before transport,
  buffering, or display; transport serializers alone are not a sufficient boundary.
- Add more via redactPaths.
- **Host payloads are never logged, only their shape.** Background-host traffic
  carries user data — the parser host relays source text and ASTs — so a message
  that fails its type guard is described, never dumped:
  `parser-host-manager.ts`'s `summarizeMalformedMessage` logs `messageType` plus
  `keyCount`/`keys`/`type` for an object and `length` for an array (an array's
  keys would be as unbounded as the payload), and nothing else. Every field is
  bounded, because the *shape* is content-controlled too: a mis-serialized frame
  can carry source text in a key or in `type`. Counts are exact; the strings
  behind them are truncated (20 keys, 64 characters). This is a real-fault path,
  not normal traffic: `parser-host-entry` posts `ParserHostParseResponse` frames
  only. Any new host adapter that logs an unrecognized frame follows the same
  rule. Paired tests in `apps/desktop/src/__tests__/main/parser-host-manager.test.ts`:
  "logs a malformed host message at warn as a shape summary, never the payload",
  "bounds the shape summary when the shape itself carries the payload", and
  "summarizes a null, primitive and array frame by shape alone".

Testing:
- Use addLogListener instead of mocking console.
- Unit suites that disable transport output use `configureLogger({ console: false })`.
  In Node, an empty transport set creates a disabled Pino instance instead of
  falling back to Pino's implicit stdout destination. Log listeners remain
  active so tests can assert records without emitting them to the test runner.

## IN-MEMORY PERFORMANCE TELEMETRY

Renderer long-task, embedding-runtime, and database-query performance snapshots are
session-only diagnostics. They are deliberately not written to the diagnostic-event
table, local storage, IndexedDB, or filesystem, so they require no factory-reset wiring.
Embedding worker measurements are source-scoped and removed when their worker terminates.
The bounded telemetry-health failure count and last reason are session-latched so a lost
diagnostic remains visible after source cleanup; renderer restart clears them. Desktop main
only relays the hidden renderer's validated snapshot. Persisting or exporting any
of these snapshots is a contract change: update the diagnostics privacy contract and add
the persistence to every applicable factory-reset path in the same change.

---

## SENSITIVE DESKTOP IPC AUTHORIZATION

Electron preload possession is not an authorization boundary. Sensitive invoke
handlers use `registerAuthorizedInvoke` from
`apps/desktop/src/platform/desktop-ipc-registry.ts` and declare a non-empty set
of server-owned `DesktopWindowRole` values. Authorization runs BEFORE the
handler receives or parses any renderer-controlled argument and has two
factors (BST-1641):

1. **Sender role** — `event.sender.id` is resolved through `window-role.ts`
   and rejected unless it maps to a declared role. Empty and duplicate
   policies are registration errors; unknown senders never inherit
   `visible-ui`.
2. **Sender frame** — `event.senderFrame.url` must match the allowlist in
   `apps/desktop/src/platform/desktop-ipc-sender-frame.ts` (Electron's
   "Validate the sender of all IPC messages" checklist item). The allowlist is
   a pure derivation of the ONE process-wide `DesktopRendererTarget`
   (`apps/desktop/src/desktop-renderer-target.ts`): `main.ts` resolves the
   launch mode once (`resolveDesktopRendererLaunchMode`), builds the target,
   and configures it before any window exists; the visible window
   (`create-window.ts`) and the hidden hosts (`renderer-host-lifecycle.ts`)
   load the document that target names, and the allowlist is derived from the
   same object — so nothing re-derives the launch mode from
   `process.argv`/`app.isPackaged`/test-mode flags on its own, and the
   allowlist cannot trust a document the loaders never load (or reject the one
   they do). A loader that runs before the target is configured throws
   `Desktop renderer target is not configured.` at load time (visible window:
   `createWindow` rejects before any `loadFile`/`loadURL`; hidden host: the
   lifecycle reports `state: 'error'` with that `lastError`, un-retried),
   never as every authorized channel rejecting at first invoke. The target is
   launch-mode-exact: `built`/`test-built` accept ONLY the `file://` document
   at `resolveBuiltRendererPath()` (`dist-root.ts`), and `dev-server` accepts
   ONLY `DESKTOP_DEV_RENDERER_URL`'s origin + pathname — so a packaged app
   never trusts `http://localhost:38181` and a dev app never trusts a stray
   `file://` page. Query and fragment are ignored because hidden hosts load
   the same document as `?mode=<role>&runtimeId=…`; the dev pathname is
   compared for equality after trailing-slash normalization (`/desktop` ≡
   `/desktop/`, which Vite serves interchangeably), so a sibling file, a
   path-prefix spoof (`index.html.evil`, `/desktop-evil`) or another path
   does not match. **Standing rule:** the renderer is a single-document app —
   `RouterProvider` wraps a `BrowserRouter` shell with no routes, links, or
   `navigate` calls — and must stay that way: a history (`pushState`)
   navigation would change the frame's pathname mid-session and silently
   drop the visible window off the dev-server allowlist. A `null`/missing
   `senderFrame` (Electron nulls it after the frame navigated or was
   destroyed), a `WebFrameMain.url` getter that throws (Electron throws
   "Render frame was disposed…" for a disposed frame rather than returning
   null), an off-allowlist URL, and an unconfigured target ALL fail closed
   with a curated `Desktop IPC <channel> …` error; the renderer-controlled
   URL is never echoed into that message. Every rejection (role, missing or
   disposed frame, URL) is also logged in the main process by the
   `DesktopIpcRegistry` scope at `warn` WITH the channel and the rejected
   URL/sender id, where the renderer cannot read it, so allowlist drift and
   dev-server pathname mismatches are diagnosable.
   `createDesktopIpcRegistry({ senderFrameAllowlist })` injects an allowlist
   for unit tests; the desktop test setup configures a deterministic target
   process-wide (`TEST_DESKTOP_RENDERER_TARGET`), and suites that
   `vi.resetModules()` reinstall it on the fresh instance via
   `reconfigureTestRendererTargetAfterModuleReset` (a fresh module instance
   is unconfigured, i.e. fail-closed — by design, not a test bug).

The unauthenticated verb is deliberately the long one:
`registerUnauthenticatedInvoke(domain, channel, { reason }, handler)` requires
a non-empty reason (registration error otherwise) so every opt-out is
reviewable at the call site; the short `registerInvoke` no longer exists. The
reason states WHO holds the channel per the preload manifests
(`dist/preload.js` = `visible-ui`; `dist/hidden-preload.js` = the hidden
roles) and that a sender-role policy is pending. Channels not exposed by any
preload manifest cannot be invoked from a renderer at all, so "exposed only by
the visible-UI preload" is a factual caller set, not an authorization claim.

Sender-authorized domains and their roles (the preload manifests are the
source of truth for who may hold a channel; `hidden-preload.ts` exposes no
`fs:*`, `git:*`, `terminal:*`, `shell:*`, `changes:*`, `browser:*`, or
`command-sessions:*` channel):

| Domain / channels | Roles |
| --- | --- |
| `terminal:*` (create/write/resize/destroy), `command-sessions:*` | `visible-ui` |
| `shell:*` (open-external/open-path/show-item-in-folder) | `visible-ui` |
| `git:*` (all 15, incl. push/commit/switchBranch) | `visible-ui` |
| `changes:*` (resolveView/fileDiff/inventory/rewind*) | `visible-ui` |
| `browser:*` (all 10 pane controls) | `visible-ui` |
| `fs:*` under `registerFileSystemIpcHandlers` (reads, root grants incl. `fs:addRootByPath`/`fs:requestDirectoryAccess`, `fs:readFileByPath`, `fs:readFileByAbsolutePath`, `fs:removeRoot`) | `visible-ui` |
| `db:exec`, `db:transaction` (raw SQL entry points; typed replacement is BST-1234), `db:diagnostics`, `db:scheduler:snapshot`, `db:test`, `db:managed-cache:apply-batch`, `db:managed-cache:invalidate-by-identity`, `db:chunks:insert-and-enqueue-embedding-jobs` — every `db:*` channel the embedding host's `hidden-preload.ts` bridge exposes besides the shared `db:query` | `embedding-host`, `visible-ui` |
| `secrets:*`, `assistant:get-url`/`get-auth`, `provider-auth:*`, `worktrees:*`, `mcp:content:*`, MCP apps/task/elicitation bridges | `visible-ui` (pre-existing) |
| `vector-preferences:read|write|clear` | `embedding-host` (pre-existing; see BST-1380 below) |
| Contract-registered leaf domains (BST-1648, `registerDomain` — authorized by construction): `clipboard:write-text`, `context-files:scan`, `skills:scan`, `user-commands:list`, `user-personas:list` | `visible-ui` |

Still `registerUnauthenticatedInvoke` with a stated reason (sender-role
policy pending, tracked as the BST-1641 follow-up): `db:query` (visible UI +
chunking/embedding hosts), the visible-UI-only `db:ping`, `db:live-query:*`,
`db:clearAll`, `db:resetLocal` and `db:getUserDataPath`,
`logging:get-preferences` (all four roles), `app:power-snapshot`
(visible UI + embedding host), `parser-host:parse` (visible UI + chunking
host), and the visible-UI-only `mcp:*`, `notesVault:*`, `storage:*`/
`preferences:*`, `fs:watch*`, hooks/forge/file-exports/diagnostics/
assistant-checkpoint/embedding-backfill/runtime/agent-chat channels and the hidden-host lifecycle
controls (`*-host:ensure-started|stop|reset|get-status`, `chunking-host:chunk-*`,
`llm-host:*`, `embedding-host:query-embedding`). `tools:execute` is the
unregistered legacy harness (BST-1233).

Provider secrets plus assistant URL/token credentials are visible-UI-only.
Hidden chunking, embedding, and local-LLM windows use the role-selected
`dist/hidden-preload.js` capability manifest and do not receive those bridges.
This packaging boundary is defense in depth: main-process sender authorization
must remain even when a preload omits the channel. Add new sensitive invoke
channels through the authorized registration API and cover both an allowed
sender and hidden/untracked rejection. The browser pane host
(`browser/browser-pane-host.ts`) is sandboxed with NO preload and MCP App
iframes receive no preload either, so neither can reach `ipcRenderer` at all;
the sender-frame factor additionally rejects them by URL if that ever changes.

Paired tests: `apps/desktop/src/__tests__/platform/desktop-ipc-registry.test.ts`
(role rejection, spoofed/null/missing/disposed frame rejection with a valid
`sender.id`, unconfigured-target fail-closed, the main-process warn record,
mandatory reason), `desktop-ipc-sender-frame.test.ts` (allowlist matching
per launch mode, trailing-slash normalization, equality-not-prefix),
`desktop-renderer-target.test.ts` (for every launch mode and window role the
document the loaders load is on the allowlist derived from the same target,
and the other launch mode's document is not), the unconfigured-target
load-time failures in `create-window.test.ts` and
`renderer-host-lifecycle.test.ts`, `privileged-ipc-sender-authorization.test.ts`
(terminal, command sessions, shell, git, changes, browser: allowed
visible-UI, hidden, untracked, and off-allowlist frame per channel, plus the
exact channel set), the same matrix for every contract-registered leaf domain
in `contract-domains-sender-authorization.test.ts`, the `files` sweep in
`ipc-domains/file-system-ipc.test.ts`, and the eight-channel `db:*` role
matrix in `ipc-domains/db-ipc.test.ts`.

Narrowing a manifest can silently REMOVE a capability a hidden host still
depends on. BST-1235 dropped `electronAPI.storage` from the hidden hosts, and
the vector-preferences store quietly degraded to per-host browser storage —
so the embedding host stopped honouring the user's configured device
preference and fail-closed wherever WebGPU was unavailable (BST-1380). Two
standing rules follow:

1. When a hidden host genuinely needs shared persisted state, give it a
   PURPOSE-SCOPED capability, not the unrestricted `storage` bridge. The
   canonical shape is `vector-preferences:read|write|clear`: registered with
   `registerAuthorizedInvoke` for exactly the roles that need it, and carrying
   NO renderer-supplied key — main pins the record, so the capability can
   neither enumerate keys (`getAllKeys`) nor wipe the store (`clear`) nor be
   pointed at another key. Main duplicates the key literal rather than importing
   a renderer store module; a paired contract test pins the two together.
2. A store reached from more than one window role must FAIL VISIBLY when its
   capability is absent, never fall back to browser storage. "Electron renderer
   with no capability" and "web/SSR with no bridge at all" are different states
   and must not share a code path.

The handleless native file-read channel `fs:readFileByAbsolutePath` is also
visible-UI-only. Its typed payload carries both the requested absolute path and
the exact claimed mounted-root path plus its durable RootId. Main resolves the
RootId FIRST in the live `WorkspaceRootRegistry`, verifies the claimed
presentation/canonical path belongs to that same mount, and only then confines
the requested file. Duplicate presentation aliases or a symlink/junction
retarget therefore cannot make insertion order choose authority. Malformed
path/root/rootId assertions execute inside the durable denial logger and emit
exactly one bounded diagnostic record. Renderer-controlled requested paths and
handle RootIds are projected before entering that logger: control and
line-separator characters use visible Unicode escapes, each field is capped at
256 UTF-16 code units, and truncation ends with `…[truncated]`; non-string input
projects to the empty string. Error messages are never copied into the record:
the logger emits a static access/path-validation/filesystem category message
plus only a syntactically bounded safe error code, so native `realpath` text
cannot re-inject a path or line break through metadata. The legacy
`fs:readFileByPath` channel remains a separate generic mounted-path API and is
never a fallback for the scoped capability.

---

## IPC CONTRACT MODULES (BST-1648)

**Preloads import pure sibling modules; the channel manifest is the ONE
place a channel string lives.** `scripts/build-main-config.mjs` bundles
`preload` and `hidden-preload` with the same esbuild `bundle: true` config as
`main`: every RELATIVE import is inlined into `dist/preload.js` /
`dist/hidden-preload.js`, while bare package, `node:*`, and `electron`
imports stay external `require(...)` calls — which a sandboxed renderer can
resolve for `electron` and nothing else. The old "preload imports nothing"
rule (#871) was therefore never a bundler constraint and is replaced by an
allowlist:

- A preload may import any relative module whose transitive VALUE-import
  graph is pure (no `electron`, no `node:*`, no bare package). Type-only
  imports are erased by the bundler and do not count.
  `apps/desktop/src/__tests__/preload-sandbox-imports.test.ts` walks that
  graph from both entries with the TypeScript AST
  (`__tests__/helpers/preload-import-graph.ts`) and fails on the first impure
  edge by file and specifier; `scripts/build-main.mjs` additionally refuses to
  emit a preload bundle containing any `require(` other than `electron`
  (`scripts/preload-bundle-contract.mjs`, pinned on a real write:false
  bundle by `preload-bundle-contract.test.ts`).
- `platform/desktop-ipc-channels.ts` (`DESKTOP_IPC_CHANNELS`) is the one
  manifest. It now also owns the `logging` group (`LOGGING_API_CHANNELS` is a
  re-export of it, because `logging-api-contract.ts`'s validators need
  `@brainstrike/logging`) and the `chunkingHost` / `embeddingHost` / `llmHost`
  groups, whose literals are pinned equal to the `@brainstrike/worker-runtime`
  descriptors in `*-host-shared.ts` by
  `__tests__/platform/desktop-ipc-channel-contract.test.ts` (a preload cannot
  require that package; main keeps using the descriptors). `preload.ts` and
  `hidden-preload.ts` contain NO channel literal: `preload-runtime-contract.test.ts`
  and `hidden-preload-contract.test.ts` flag any string equal to a manifest
  channel, and the hidden test pins the manifest GROUPS the hidden preload may
  reference (`chunkingHost`, `db`, `embeddingHost`, `files`, `llmHost`,
  `logging`, `runtime`, `vectorPreferences`) so the role-scoped hidden
  capability manifest (BST-1235/BST-1380) cannot widen by a stray reference.
- `platform/ipc-contract.ts` is the pure per-domain contract vocabulary:
  `channel<Args, Result>({ channel, roles, parseArgs })`,
  `rawChannel<Args, Result>(…)`, `pushEvent<Payload>({ channel })`, and the
  derived `Handlers<C>` (main) / `Bridge<C>` (preload + renderer `Window`)
  types. `roles` is a non-empty tuple and `parseArgs` is a plain function
  that runs only in MAIN before the handler and THROWS on malformed input
  (no zod in preload, no coercion).
- **Registering a domain is one line per side.** Main:
  `registerDomain(registry, domain, contract, handlers)`
  (`platform/desktop-ipc-registry.ts`) registers every invoke channel through
  `registerAuthorizedInvoke` with `spec.roles` — a contract domain has NO
  unauthenticated path, so Electron's "validate the sender" checklist item is
  satisfied by construction. Per call the order is: both authorization
  factors, then `parseArgs` in main (a throw rejects the invoke), then the
  handler with the parsed tuple. Push events are never registered (a
  main→renderer push is a `webContents.send`). A contract key with no handler
  or a handler with no contract key is a registration error. Preload:
  `exposeBridge(name, contract)` (`createBridgeExposer` in
  `platform/ipc-bridge.ts`, electron surfaces injected) exposes exactly
  `Object.keys(contract)`, each method routed to its manifest channel, with
  the ONE `unwrapIpcResult` for `ipc-result` channels and subscribe-returns-
  unsubscribe for push events. Renderer typing is derived:
  `types/electron.d.ts` declares `window.<name>?: Bridge<typeof xContract>`,
  and each contract pins `BridgeMatches<typeof xContract, PackageBridge> =
  true` against the shared package interface its consumers import
  (`SkillsBridge`, `UserCommandsBridge`, `AssistantPersonasBridge`,
  `ContextFilesBridge`), so app-shell/settings-ui never re-declare a bridge.
  Contract modules live at `ipc-domains/<domain>.contract.ts` and reference
  the manifest entry (`DESKTOP_IPC_CHANNELS.<group>.<key>`) — the manifest
  stays the one literal owner. `settleIpcResult({ category, code }, run)`
  converts a throw-style operation into the envelope (logged in main).
- Migrated so far: `clipboard`, `contextFiles`, `skills`, `userCommands`,
  `userPersonas` (all `visible-ui`). Their parity tests are key-set equality,
  not source regexes: `preload-contract-bridges.test.ts` loads the real
  preload under a mocked `electron` and asserts each exposed key set equals
  `Object.keys(contract)` and routes/unwraps correctly;
  `ipc-domains/leaf-contracts.test.ts` pins `Object.keys(contract)` to the
  package `*_BRIDGE_REQUIRED_METHODS` resolver sets and exercises `parseArgs`;
  `platform/register-domain.test.ts` and `platform/ipc-bridge.test.ts` pin
  the two derivations.
- **Global manifest test (there is deliberately no registry singleton).**
  `createDesktopIpcRegistry` rejects a duplicate channel per INSTANCE only;
  production composes ~38 per-domain instances. `__tests__/main/
  ipc-global-manifest.test.ts` boots the real `main.ts` (module scope and the
  `app.whenReady()` block through window creation) under mocks, captures
  every registry instance through the factory, and asserts over
  `union(getSnapshot())` — the snapshot's production-shaped consumer: no
  channel on two instances, every invoke spec of every glob-discovered
  `ipc-domains/*.contract.ts` registered (push specs never), and every
  registered channel a `DESKTOP_IPC_CHANNELS` literal. A new domain or a
  migrated contract needs no edit there.
- **`main.ts` lifecycle modules (BST-1648 step 4, bookkeeping only).**
  `main/disposer-stack.ts` is the ONE holder of IPC-domain disposers: every
  `registerXIpcHandlers(...)` result is `ipcDisposers.add(label, …)` (no
  per-domain `let unregisterX` slot), and `will-quit` unwinds the stack LIFO
  with every throw isolated and logged by label. The ordering that is
  load-bearing is unchanged: `before-quit` runs `runGracefulShutdown` (the
  deep module; untouched) and only then re-enters `app.quit()`, so `will-quit`
  — and the stack — always run AFTER the graceful steps. `unregisterForgeIpc`
  stays a graceful-shutdown step ('forge', BEFORE 'database') on purpose.
  A second live entry under one label is a registration error; the browser
  pane rebinds per window by retiring the previous handle first.
  `main/logging-preferences.ts` owns the logging-preference STATE (defaults,
  legacy migration, sanitization, persistence, Settings payload, destination
  select/open, on-disk verification, app-ready file-logging re-enable);
  `main.ts` keeps the boot ORDER (createLogger → watchdog → log buffer →
  `initializeLogging` → `applyInitial`). `main/git-awareness-lifecycle.ts`
  constructs the ONE git-inventory / forge / worktree services inside
  `app.whenReady()` and drives the `changes:invalidated` / `forge:prUpdated`
  pushes; `main.ts` keeps them in the slots `runGracefulShutdown` tears down.
  Paired: `__tests__/main/{disposer-stack,logging-preferences,git-awareness-lifecycle}.test.ts`.

**Error-envelope ruling (extends the `mcp:content:*` ruling in
`docs/agents/assistant-providers.md`).** Exactly one failure shape crosses IPC
as data for contract channels: `IpcResult<T> = { ok: true, value } |
{ ok: false, error: { category, code, message } }` (`ipcOk` / `ipcFailure`
in `platform/ipc-contract.ts`). A thrown Error reaches the renderer as
Electron's formatted string, main-process stack included, so contract
handlers never throw for expected failures. `channel()` declares the
`ipc-result` envelope: the handler returns `IpcResult<T>` and the ONE preload
unwrap turns `ok: false` into a clean Error whose message is
`message (category · code)` with `category`/`code` properties, and rejects a
malformed reply by name. `rawChannel()` is for domains whose consumers already
read a typed envelope of their own (`GitResult`, `TerminalResult`,
`NotesVaultResult`) and never throw across IPC; throw-style domains convert to
`IpcResult` as they migrate. Paired: `__tests__/platform/ipc-contract.test.ts`.

---

## FACTORY RESET CONTRACT

“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/app-state/src/factory-reset.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys (e.g. `hook-trust-store` — the
      security-sensitive per-root hook approvals; reset drops every approval so a
      re-mounted repo's hooks require fresh review — see TOOL-LIFECYCLE HOOKS;
      and `worktree-setup-consent.v1` — per-repository approvals and denials for
      `.brainstrike/worktree-setup.sh`, keyed by Git common directory).
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

Storage deletion is fail-visible. Electron renderer storage, secrets, and
settings failures (including a fulfilled secrets response with
`success:false`), IndexedDB `error` / `blocked` events or synchronous deletion
exceptions, CacheStorage failures, and OPFS failures all produce an incomplete
reset result. The IndexedDB enumeration compatibility fallback is the sole
tolerated degradation: browsers without `indexedDB.databases()`, or browsers
where enumeration rejects, still delete the explicit Brainstrike fallback
names. Never convert a failed deletion into reset success.

The main process uses one `getSecretsService()` singleton for secrets IPC,
provider auth, and MCP external bearer resolution. MCP bearer references are
namespaced keys inside that existing encrypted store, not a second credential
database. The bearer transport resolves on every request and never caches token
material, so the existing secrets `clearAll` step is the complete reset
authority: after reset, an already-created transport closure fails visibly as
credential-missing before network I/O. No extra bearer runtime purge exists or
is needed unless token caching is introduced later (which would require this
contract and paired reset tests to change together).

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Dependency-free session stores owned by `app-shell` share one authoritative
resetter list, `APP_SHELL_SESSION_STORE_RESETTERS`; this includes diagnostics
health/seen state, assistant composer commands, browser tabs, thread search,
command palette, quick open, and one-shot worktree checkout intent. Production
registers every list member separately through
`registerFactoryResetSessionStore`, preserving per-store failure isolation,
while `packages/app-shell/vitest.setup.ts` invokes
`resetAppShellSessionStores()` to drain the same list before every test. Do not
maintain a second test-only reset list: that recreates the drift BST-938 found,
where shuffled tests inherited a disabled diagnostic sink or active search from
an earlier test. Component-coupled app-shell stores and feature-package stores
keep their own production registrations plus explicit focused-test setup;
preloading those in the global helper would bind real dependencies before test
modules can install their mocks. The regression in
`packages/app-shell/src/__tests__/session-store-test-isolation.test.ts` pins the
cross-test boundary, while
`register-factory-reset-session-stores.test.ts` pins production registration.

Desktop bundled Python runtime (BST-1061): `resolvePythonBinary` unpacks the
pinned CPython under `app.getPath('userData')/python-runtime/`, so the
wholesale userData wipe in `desktop-factory-reset.ts` covers it with zero
dedicated wiring. That coverage is pinned by the BST-1061 regression test in
`apps/desktop/src/__tests__/main/desktop-factory-reset.test.ts` — if the
unpack dir ever moves outside userData, it needs explicit reset wiring plus an
update here.

`resolveDesktopPythonRuntimeResourcesDir` (`apps/desktop/src/python-runtime/
index.ts`) resolves the SOURCE directory the archive/manifest ship in — a
different, unrelated path from the unpack dir above — and is where BST-1459
found a real bug: it used to derive this from `app.getAppPath()`, which
returns a launch-mode-dependent value (the project root under `electron .`,
but `dist/` itself when Electron is launched with a direct path to
`dist/main.js`, as Playwright's desktop e2e harness does), silently pointing
at `dist/resources/python-runtime/manifest.json` instead of the real
`apps/desktop/resources/python-runtime/manifest.json`. It now resolves via
the running bundled module's own `__filename` instead (same invariant as the
two entries below — deliberately NOT `module.filename`, a synthetic shim
with no `.filename` under Vitest, or `import.meta.filename`, empty in this
file's esbuild `cjs` output; see `bundled-sibling-path.ts`'s docblock),
taking `path.dirname()` TWICE — once to `dist/` (the module's immediate
parent), once more to its parent `apps/desktop/` — because these resources
are a sibling of `dist/`, not of `main.js` itself. This resolver additionally
depends on that immediate parent directory being literally NAMED `dist` — an
IDENTITY check on that one path segment, not a depth check (e.g.
`out/dist/main.js` still resolves correctly; only the parent's basename is
compared, not how many levels it sits below the app root) — which is still
more fragile than the sibling-of-`main.js` pattern the watchdog/log-transport
resolvers use below, since those need no name assumption at all. This one
enforces the identity assumption at runtime: it throws if that parent
directory is not literally named `dist`, rather than silently pointing at the
wrong directory if the bundle output is ever restructured or renamed. Pinned
by `apps/desktop/src/__tests__/main/python-runtime-resources-dir.test.ts`.
Downstream, `resolvePythonBinary` classifies unsupported platforms BEFORE any
manifest I/O — off darwin no target triple exists, so the manifest is never
read and the result is the typed `python_unsupported_platform` condition with
no PATH-Python fallback (pinned by the fixture-less unsupported-platform case
in `apps/desktop/src/__tests__/main/resolve-python-binary.test.ts`).

Desktop MAIN-PROCESS storage (`ElectronStorageAdapter`, one
`electron-storage.json` under `app.getPath('userData')`) is covered by the same
wholesale userData wipe — no per-key wiring. The keys it owns that MATTER for a
fresh start:

- `rootsList` — the connected workspace roots, owned only by
  `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (see
  workspace-context.md, MAIN vs FOCUSED).
- `rootsList.corrupt` — quarantined bytes from a malformed `rootsList`, written
  once alongside an ERROR log by `readStoredRootsOrQuarantine` so a corrupt
  list self-heals instead of bricking root restore. It still holds the paths
  the user had granted, so reset must take it too.
- `recentRootsList` (BST-1395) — the ledger of folders the user has ALREADY
  granted this app (`workspace-recent-roots.ts`). Deliberately SEPARATE from
  `rootsList`: disconnecting a root must not revoke the grant, because the
  grant is what points the picker-less `fs:addRootByPath` — driven by the
  composer workspace bar's Recents list — at a previously granted folder. It
  sits in the SAME trust class as `rootsList` + `fs:restoreRoots`, not above
  it. Reset therefore has to clear it — a surviving ledger would keep offering
  picker-less mounts of folders a "true fresh start" says were never granted.
- `recentRootsList.corrupt` — quarantined bytes from a malformed
  `recentRootsList`, the exact counterpart of `rootsList.corrupt`. Written once
  alongside an ERROR log so a corrupt ledger self-heals instead of bricking
  Recents; covered by the same wholesale userData wipe.
- `notesVaultRoots` (`NOTES_VAULT_ROOTS_STORAGE_KEY`,
  `apps/desktop/src/notes-vault-ipc-handlers.ts`) — the notes-vault sibling of
  `rootsList`: granted vault folders, re-opened without a picker. Same
  reasoning, same wipe.
- `worktreeSettings` (`WORKTREE_SETTINGS_STORAGE_KEY`,
  `apps/desktop/src/assistant-server/worktree-settings.ts`) — the user-chosen
  managed-worktree directory path plus the setup command executed on worktree
  creation. Reset must not leave either a stale custom directory or command.

Managed worktree DIRECTORIES themselves (BST-1390) live OUTSIDE `userData` —
the default is `~/.brainstrike/worktrees` [D3] — so the wholesale userData
wipe above does not cover them, and neither does clearing `worktreeSettings`
(that only clears the STORED preference, not the directory it names). Factory
reset does clear the `brainstrike_worktrees` LEDGER: it is one of the 21
`brainstrike_*` relations in `BRAINSTRIKE_RESET_TABLES`
(`packages/db/src/reset-table-registry.ts`), the set every table-enumerating
reset path clears (see the reset-table registry section below). It does NOT
delete the worktree directories on disk: they can hold uncommitted work, and a
reset silently removing a folder full of it is exactly the failure mode
`archive`'s snapshot gate exists to prevent. Deleting them is a separate,
explicitly confirmed action — and today's reset result carries no path or
count for them either way: `DesktopFactoryResetResult`
(`apps/desktop/src/desktop-reset-platform.ts`) is just `{ success, message? }`,
so a caller who wants to know what happened to the managed directory has to
read it themselves, not read the reset result.
- `lastFolderPath` — presentation-only.

The renderer-facing `storage:*` bridge cannot mutate any of the root/vault
authority keys above (BST-1401). `setItem` and `removeItem` reject them by exact
key, `setItem` rejects non-string IPC values before persistence, and `clear`
enumerates and removes only renderer-owned records. That selective clear fails
closed when the durable file could not be loaded; it never recovers corruption
by erasing authority records it could not preserve. The full
desktop factory-reset handler remains the sole whole-profile wipe; it deletes
the userData entries in main after the reset barrier closes, then calls
`storage.clear()` before replacing the renderer. That post-deletion clear is
required even though the file is gone: the main-process adapter is long-lived,
so its in-memory cache must be emptied before a replacement renderer can read
or later repersist stale authority records. E2E root-ledger
seeding and the E2E reset harness's full clear use separate channels that main
registers only in explicit Electron test mode, so production tests do not
require a production bypass. Preload and main use the same `--test-mode` /
`ELECTRON_IS_E2E_TEST=true` predicate, and the preload builds its seed-key set
from main's authoritative `MAIN_OWNED_DESKTOP_STORAGE_KEYS` tuple directly
(the pure `platform/desktop-storage-authority.ts` module bundles into the
preload — see IPC CONTRACT MODULES below).

That coverage is pinned by
`apps/desktop/src/__tests__/main/desktop-factory-reset-storage-ledgers.test.ts`,
which seeds a REAL `electron-storage.json` (all of the keys above, including
both `.corrupt` quarantines) into a REAL temp userData dir and asserts the file
is gone and `logs` is the only surviving entry. The ordering contract for the
main-process cache clear is pinned by
`apps/desktop/src/__tests__/desktop-reset-platform.test.ts`.

Renderer module-scoped state, `roots/root-registration-events.ts` (BST-1400):
a per-key registration GENERATION counter (`seqByKey`) the await-root-
registration seam uses so `useWorkspaceBar` can await a root's durable id
landing instead of polling the database for it. It is DELIBERATELY NOT
registered with `registerFactoryResetSessionStore` — the one case in this
contract where the right answer is "do not wire it, and say why here so
nobody 'fixes' the omission":
- A reset wipes the DB `roots` table this counter describes but leaves the
  counter itself untouched, so after a reset it can be stale (nonzero for a
  path with no live row). That is harmless because the seam's ONLY consumer
  (`resolveRootIdAfterReconciliation` in `packages/app-shell/src/hooks/
  use-workspace-bar.ts`) never reads the counter as an absolute — it captures
  a snapshot BEFORE its first failed read and only accepts a STRICTLY LATER
  generation, so a stale (pre-reset) count can structurally never satisfy a
  wait captured after it.
- Wiring a resetter would make this WORSE: clearing the counter mid-session
  (the reset-without-reload path this contract exists for) would strand any
  IN-FLIGHT waiter whose captured `since` sits above the post-reset
  generation the reset rebumps to — that waiter can then never be satisfied
  and runs its full bounded timeout, raising a destructive "Folder added, but
  not attached to this thread" toast for a request that should have
  succeeded.

That reasoning is pinned by a test that drives the REAL reset pipeline (not
the module's own test-only `resetRootRegistrationEventsForTests` helper,
which exists only for cross-test isolation) —
`packages/app-shell/src/__tests__/register-factory-reset-session-stores.test.ts`
— `'leaves root-registration-events untouched — it is deliberately NOT wired
into factory reset'`. If this module ever needs a resetter for some other
reason, that test (and this entry) must be updated together, and the
in-flight-waiter regression above must be solved first (e.g. an
`AbortSignal` per waiter) — not merely `seqByKey.clear()`.

If main-process storage ever moves outside `userData` (or gains a preserved
entry name), every one of these needs explicit reset wiring plus an update
here.

Desktop reset order:
1. Quiesce background runtimes. MCP fences complete config operations, installs empty host authority, and purges projections without closing the reusable singleton.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

MCP config admission stays closed across all four steps. Main initiates the
visible-renderer replacement and waits for the replacement React tree's
existing renderer-ready ping; `did-finish-load` alone is not completion. Only
then does the reset coordinator restore the permanent config watcher and reopen
empty authority. If any purge step fails, main restores the captured pre-reset
MCP authority, config projection, selected-path grant, and tool projection
while admission is still closed, installs the watcher, and only then reopens.
If renderer replacement fails after a successful purge, admission remains
closed and the reset failure is visible.

The MCP config-operation queue is non-reentrant. Tracked handlers call only
their `*ForLifecycle` helpers, watcher callbacks stay generation-guarded outside
the queue, and the user-paced native file picker never holds the reset barrier.
Unwatch remains an idempotent teardown operation after admission closes. The
`mcp:content:*` read channels (BST-1585) follow `mcp:status:get`: they reject
while admission is closed and wait on the lifecycle barrier, but never enter the
queue — the content port's own authority watch retires them on replacement.

Every reset runtime is attempted even when another fails. Their original
rejections remain ordered in one `AggregateError`, while the visible message
names every failed runtime; never replace those causes with a names-only error.

The Explorer's file-content LRU, active read machinery, and per-composite-key
terminal error projection are volatile but
still require renderer reset wiring because the web reset path may not reload.
`FileExplorerProvider` registers one session-store resetter that invalidates
all content generations, queued batches, and projected errors, clears the current store's raw
`fileContents` plus its store-owned LRU, clears selections, and advances the
provider content-lifecycle key so hook-local loading refs/state remount empty.
An already-running obsolete read may settle afterward, but its invalidated
generation cannot commit into the reset store. Provider/store identity changes
use the same keyed lifecycle and invalidate the retired authority during the
commit phase.

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
It also includes `brainstrike_canvas_versions` (migration 082), the FK-less
version ledger for thread-owned Canvas documents. All three table-enumerating
reset paths clear it explicitly; thread deletion separately derives its Canvas
stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_tool_call_telemetry` (migration 083), the FK-less,
counts/sizes/ids/booleans-only model-facing tool-cost ledger. All three
table-enumerating reset paths clear it explicitly, and thread deletion derives
its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_token_estimate_calibration` (migration 086), the
FK-less numbers/ids/model/provider-only prompt-token reconciliation ledger. All
three table-enumerating reset paths clear it explicitly, and thread deletion
derives its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_assistant_tool_projection_rewrites` (migration
084), the FK-less stale-tool-history replay overlay. All three table-enumerating
reset paths clear it explicitly, and thread deletion derives its cleanup stage
from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_assistant_compaction_ranges` (migration 088), the
FK-less exact-message conversation-compaction overlay. All three
table-enumerating reset paths clear it explicitly, and thread deletion derives
its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_forge_prs` (migration 110, BST-1391), the
main-process-written pull-request cache keyed on `(repo_common_dir, branch)`.
It is deliberately NOT a thread sidecar (a PR outlives the thread that opened
it, and two threads on one branch share its status), so it has no FK and no
`THREAD_DELETE_SIDECAR_TABLES` entry. All three table-enumerating reset paths
clear it explicitly (`db-ipc.ts`'s `db:clearAll`, `clearViaPGlite`, and
`purgeTablesTx`), because it names remote repositories and branch topology — a
"true fresh start" must not carry that forward. It rebuilds from `gh` on the
next observation. A row may itself represent an OBSERVED ABSENCE (every
PR-specific column NULL, enforced by the migration's own CHECK constraint) —
that is still cleared the same way as a PR row; there is no separate
delete-vs-clear distinction for the two row shapes.

BST-1391's two new notification-preference toggles (`prOpened`, `prChecks` on
`notification-preferences.v1`) need no new reset wiring — they're additional
keys inside the SAME persisted store
`resetNotificationPreferencesStoreToDefaults` already resets from
`clearBrowserStorage` (FACTORY RESET CONTRACT), covered by construction since
`defaultEvents()` sets every key in `NOTIFICATION_EVENT_KINDS`.

`background-indexing-preferences-store` (`background-indexing-preferences.v1`,
owning the per-root `worktreeRootIndexingOptInById` opt-in map PR #2655 /
BST-1453 added) was persisted and purged from storage, but its LIVE in-memory
copy was never in `clearPersistentUiState`'s re-default list — a reset without
a reload (the web path) left a stale opt-in in memory, so the BST-1392 Worktree
Map could render "Indexing enabled" for a root the user just wiped. Fixed by
BST-1392 Layer 2 Step 0: `resetBackgroundIndexingPreferencesStoreToDefaults()`
(mirrors `resetHookTrustStoreToDefaults` / `resetWorkspaceInstructionsPreferencesStoreToDefaults`
— clears persisted storage, then resets the live store via its own `reset()`
action) is now called from `clearPersistentUiState`, covered by
`packages/app-state/src/__tests__/factory-reset-background-indexing-preferences.test.ts`.

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
`purgeTablesTx` in `pglite-direct-transport.ts`.

**The SET those three lists clear is owned by the reset-table registry**
(`packages/db/src/reset-table-registry.ts`, BST-992): all three clear the same
41-relation set (26 `brainstrike_*` — including the principal-bound
`brainstrike_mcp_tasks` handle store, its durable authority-epoch ledger, and the `brainstrike_mind_ops`
op-log, whose tombstones must not outlive the mind they describe (BST-993),
and the `brainstrike_assistant_run_treatments` experiment-treatment store
(BST-1250; retained on thread delete like run_outcomes, but never a true
fresh start) — + 9 core/indexing + the Mastra six), and
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
(migration 118 since BST-1651; previously renderer-lazy bootstrap DDL) are in NO
list on purpose: both cascade from `mastra_threads`
(`ON DELETE CASCADE`), which every list clears. If that FK is ever dropped —
migration 052 dropped its FKs for exactly this kind of reason — they start
silently surviving reset; move them into the registry in the same change.

Desktop factory reset is deliberately different: `resetLocalDatabase` closes
the database and recursively deletes the active profile directory, so it
removes the relations with the whole database rather than issuing
table-by-table `DELETE`s. Do not add a redundant SQL purge to that
directory-delete path.

Two of these relations are still application-created lazily rather than
guaranteed by the migration chain: the vector store creates `mastra_vectors` and
the workflow store creates `mastra_workflow_snapshot`, so a never-used assistant
can legitimately lack either. Migration 117 (BST-1651) moved the four MEMORY
relations — threads, messages, resources, observational memory — into the chain,
though `PgliteMemoryStore.initialize()` still applies the same contract DDL
idempotently because standing its own schema up is Mastra's storage contract.
Every table-enumerating reset path must still PROBE each relation before deleting
it; absence is the only tolerated case, and every genuine probe or delete failure
stays visible.

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
`clearRelationIfPresent` (`packages/db/src/pglite-direct-transport.ts`, used by
BOTH the transport's `clearAllData` — the old `clearViaPGlite` — and
`purgeTablesTx`). Every call site is therefore safe by
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
`pglite-direct-transport.ts`) import the canonical exports.

The renderer used to hold a pinned local literal instead, because that import
reordered bundle chunk init and killed the app at startup. That is FIXED at the
root, not worked around — see the next rule — and the stopgap guard that pinned
the literal is deleted. Do not reintroduce a hand-copied literal here.

**Import those canonical exports freely, but read their values only inside the
function that executes the clear — never at module scope (BST-558).**
Type-position reads in the closed relation unions are erased and remain safe.
Module-scope value initializers run at bundle CHUNK
INITIALIZATION, and the renderer's chunk graph does not guarantee the contract
chunk has evaluated by then. `packages/assistant-data/src/assistant-memory-repository.ts`
used to build its bootstrap DDL in a module-scope template literal interpolating
`MASTRA_MEMORY_TABLES.threads`; adding ONE unrelated static import of
`@brainstrike/assistant-contract/mastra-memory-schema` to `db-provider.tsx`
(the renderer reset code lived there until BST-1653 moved it into
`pglite-direct-transport.ts`, where the same rule applies)
reordered chunk init and the renderer died at startup with `Cannot read
properties of undefined (reading 'threads')` — measured on PR #1978, commit
`df953a2a8` green and `3e8d1b7fd` red. The failure is not always loud: a
property access throws, but a bare interpolation such as `${MASTRA_VECTOR_TABLE}`
splices the literal string `undefined` into the DDL, and in the renderer reset
paths an undefined table name would make `to_regclass('undefined')` return NULL — the
permanent silent skip described above. Build SQL inside the function that
executes it (`buildMastraVectorSchemaSql`; and `requiredAssistantMemoryRelations`
in `assistant-memory-repository.ts`, which reads the same constants to build its
`to_regclass` probe list — the schema-mirroring builder that originally tripped
this defect was retired in BST-1651, but the rule is the reason its replacement
is a function too).

The same rule is why migration 117 carries a LITERAL copy of Mastra's memory DDL
instead of importing `MASTRA_MEMORY_SCHEMA_SQL`: `deriveCustomMigrations()` reads
every `migration.up` during module-scope evaluation of `drizzle/migrate.ts`, and
an uninitialized binding there would splice the string `undefined` into a
migration. The copy is pinned to the contract at the CATALOG level by
`packages/db/__tests__/mastra-schema-migration-parity.test.ts`.

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
- **Silent host death is a real state, and health cannot see it (BST-1328)**:
  on some macOS hosts FSEventStream delivery stops while `subscribe()` still
  resolves and health still reports `healthy` — no error, no `overflow`, just
  nothing. The typed health channel covers the *announced* failures (a dropped
  -events backend error degrades to a root invalidation, log-once, subscription
  alive); it cannot cover this one, because nothing is announced. Tests
  discriminate it with `@brainstrike/file-system/testing/watcher-liveness`,
  which subscribes a RAW binding in a temp dir, touches a sentinel repeatedly,
  and only then runs an `fs.watch` control. Rule: **if the raw binding delivered
  nothing, no code above it can be blamed.** Note libuv's `fs.watch` rides the
  same FSEventStream subsystem on macOS, so "control also silent" is a more
  degraded host, not a different diagnosis. Production deliberately has no such
  canary today; adding one (self-touch a sentinel, expect the event) is the only
  detection that would catch this class in the field.
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
- **Per-subscription ignore override (BST-1112)**: `StartParcelWatchOptions.ignorePatterns`
  (threaded from `WatchDirectoryOptions.ignorePatterns`) lets a caller REPLACE
  `DEFAULT_IGNORE_PATTERNS` for its own subscription only — explicit overrides
  apply to both native ignore globs and the event guard, e.g. a
  main-owned git-metadata watcher that needs `.git/HEAD` events the default
  patterns would drop. `undefined` selects the default layers: the
  `fileFilter.shouldIgnorePath` guard PLUS (BST-1342) the background-indexing
  policy's unconditional excluded-path prefixes (`.claude/worktrees` and
  `.brainstrike/worktrees`),
  applied root-relatively and skipped entirely when the subscription root
  itself sits inside an excluded tree. `StartParcelWatchOptions` and concrete
  Electron `WatchDirectoryOptions` also expose
  `reportDefaultFilteredChanges`, default `false`. With that option false,
  `DEFAULT_IGNORE_PATTERNS` retain their pre-BST-1180 native globs and the
  callback receives no filtered-boundary evidence. Only `ipc-handlers.ts`'s
  MAIN-owned Explorer `fs:watch` dependency passes `true`; this broadens only
  `dist`, `build`, and `.DS_Store` while keeping `.git`, `node_modules`,
  `.pnpm-store`, `.next`, `.turbo`, plus the hard `.claude/worktrees` and
  `.brainstrike/worktrees` exclusions native. The JS guard emits root-relative boundaries without
  exposing detailed Explorer changes. Both watcher and renderer batching cap
  retained boundaries at 64 and surface explicit overflow. Tracked files in
  the retained high-cardinality trees require a future bounded Git-aware
  tracked-path watcher; this option must not broaden the recursive watcher or
  claim silent coverage.
  Notes Vault stays explicitly false. Git inventory keeps its explicit
  `ignorePatterns: []` and is marker-free. Reporting true plus ANY explicit
  override (including `[]`) throws before watcher setup — the configuration is
  ambiguous and never silently coerced. `[]` means "ignore nothing", never a
  silent fallback to defaults. Overrides
  cannot reach the desktop `fs:watch` IPC domain: `StartFileSystemWatch`
  takes no `ignorePatterns`, and that domain deduplicates native
  subscriptions on `(ownerId, resolvedPath)` only. Any future caller that
  threads an override through it MUST add the pattern set to
  `subscriptionKey`, or two registrations for the same root would silently
  share one filter set. Neither option is renderer/wire input; the shared
  Explorer refresh pipeline's broadening is fixed by its concrete main-process
  owner, so "same names, never broader" stays true (see
  `docs/agents/explorer-search-tapestry.md`).
- **Git-inventory watcher dead-on-failure (BST-1112)**: `git-inventory-watcher.ts`'s
  per-repo subscriptions (one per common dir, using the ignore override above)
  mark themselves dead on an `'errored'` signal — visible via typed state, never
  a silent no-op and never an auto-restart — and retry only when an explicit
  `sync()` call still lists that common dir. An `'overflow'` signal is
  different: it forces an IMMEDIATE invalidation (events may have been
  missed, so the whole repo's metadata is treated as stale) WITHOUT marking
  the watcher dead — it stays live and keeps batching normally afterward. The
  trailing debounce that batches interesting events also has a max-wait cap
  (`GIT_INVENTORY_WATCH_MAX_BATCH_MS`, 2000ms): sustained churn (a long
  `git checkout`/rebase/`gc`) would otherwise re-arm the debounce forever and
  starve invalidation indefinitely. Finally, `disposeAll()` is TERMINAL — once
  called, a `GitInventoryWatchers` instance never subscribes again, even if a
  later `sync()` lists a common dir; `git-inventory-service.ts`'s `stop()`
  drops the instance entirely, and a later `start()` always builds a fresh one
  rather than trying to resurrect a disposed instance.
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
independent rolling one-minute buffer of at most 512 duration samples **per
feature** plus a separate bounded arrival-count bucket stream. Query count and
rate therefore remain independent of the duration-sample cap; sample count
remains the number of retained percentile inputs. The collector exposes counts,
failures, p50/p95/max duration, live subscription/update frequency, token-cache
hit rate, and an explicit retained-sample overflow count to System Diagnostics.
Query arrivals, failures, and token lookup/hit totals each use exact bounded
rolling buckets rather than being reconstructed from the capped percentile
samples. Overflow buckets use the evicted sample's occurrence time and therefore
expire with the evicted sample.
Counts use a boundary-inclusive bucket interval and can therefore retain up to
one coarse bucket of events older than the strict duration-sample cutoff. A
nonzero count with zero retained percentile inputs at that boundary is expected.
The card renders every per-feature count, failure, p50/p95/max, and overflow
dimension plus the raw live-update count, so warning attribution is visible;
the one-minute count and its derived per-minute rate are deliberately not shown
together as duplicate values.
External-store notifications are coalesced to one-second updates; while a
subscriber is active, reads return the published snapshot identity until the
coalesced notification publishes a replacement. Producers do not sort or
rebuild snapshots on every query. A monotonic Performance clock owns sample and
count-bucket retention; the wall clock is used only for the externally reported
`snapshotAt`. The per-feature cap therefore evicts the oldest duration sample
directly, while query arrivals and overflow events are bucketed at their
occurrence time. Module
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
tracked separately. A direct unsubscribe stops delivery to the unsubscribed
listener before its async teardown settles, so the scheduler releases its one
supported locally counted listener exactly once on the first teardown attempt.
The scheduled wrapper owns this terminal state itself — it admits exactly one
listener and rejects subscribe/refresh once released — rather than inheriting it
from the raw PGlite handle: as of PGlite 0.5.5 (BST-1283) a raw handle stays live
after one of several listeners unsubscribes, where it previously terminalized for
all of them. Nothing here subscribes twice to one handle, so that upstream change
is inert. Repeated unsubscribe is idempotent, while subscribe and refresh reject
on the released scheduled handle; callers must create a fresh live-query handle.
Folder-wide token-cache preloads record duration/failure with zero lookup and hit
counts.
Concurrent Electron teardown callers share one remote stop attempt;
a rejected stop remains retryable while renderer-local listener and counter
ownership release exactly once. Production wrappers log telemetry failures,
including an unavailable timing clock, at error level while preserving and always
executing the database operation's original success or rejection. Each producer
latches an unavailable clock and logs it once rather than emitting an error for
every subsequent operation. The collector also suppresses repeated timer callbacks
after its retention clock fails; retained metrics become zero, clock-independent
live-subscription ownership continues to update, and an explicit
imperative `snapshot()` read still throws the latched error. External-store reads
instead return one stable snapshot marked `failed` with the precise reason, so a
React diagnostics surface can render the failure without crashing. The clock-free
package regression imports the public database package entrypoint. There is
deliberately no public reset: clearing the singleton could invalidate
live-subscription ownership held by active proxies. Paired coverage
lives in
`packages/db/__tests__/database-query-telemetry.test.ts`,
`database-work-scheduler.test.ts`,
`database-work-scheduler-live-handle.integration.test.ts`,
`use-live-query.test.tsx`, the token-cache and
Drizzle token/file repository tests, and
`packages/app-shell/src/__tests__/system-diagnostics-panel.test.tsx`.

The background token indexer has a separate renderer-local telemetry stream in
`packages/token-cache/src/telemetry.ts`. System Diagnostics subscribes only
while the panel is mounted: `useIndexerTelemetry` creates the subscribing
aggregator inside its effect, and every effect instance disposes that aggregator.
Do not move subscription creation into render or a memo initializer; StrictMode
and abandoned concurrent renders can otherwise retain a raw-event listener after
the panel closes. The panel shows rolling one-minute aggregate latency, cache-hit
rate, throughput, token count, error count, and explicit retained event count.
Expected binary-file exclusions remain terminal file outcomes but never emit an
`indexing_error` event or contribute to that error count.
Cache-hit-only windows render a neutral latency glyph because they contain events
but no timed indexing work; `No samples` remains the whole-window state. The view
receives a deliberately projected aggregate object: raw
events contain composite keys, folder ids, paths, and error messages and must
never cross into the diagnostics card. Token-cache database duration and lookup
hit rate remain owned by the `token-estimation` feature above. The old
selection-change-to-estimate metric is no longer a meaningful asynchronous seam:
selected-token summaries read the already-built in-memory map synchronously, so
do not add a timer or debounce around that read solely for diagnostics.

---

## DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)

Design doc: `docs/error-observability-design-2026-07-23.md`. Cross-cutting,
app-wide diagnostic capture — deliberately SEPARATE from the run-scoped
`brainstrike_assistant_run_events` timeline (different scope, retention, and
sanitization contract; do not relitigate).

**Performance telemetry is a separate in-memory signal, not a fabricated
warning event.** Renderer long tasks (BST-400) are observed only in the visible
renderer by
`packages/app-shell/src/diagnostics/renderer-long-task-telemetry.ts`, retained
in a bounded one-minute/512-sample window, and shown in System Diagnostics.
Only duration, the coarse app route, and enabled feature-flag identifiers are
retained. The app shell accepts feature flags only from an authoritative
app-owned registry; when no registry is wired, the snapshot and System
Diagnostics say that the context is unavailable instead of treating an empty
placeholder as "no flags active." The observer remains mounted across route
changes, requests buffered `longtask` entries so pre-effect startup stalls are
not discarded, and reads current context at delivery time. Feature-registry
availability changes publish immediately rather than waiting for another stall.
Availability shown for a non-empty rolling window is derived from the retained
samples; mixed known/unknown flag context is surfaced as partial and never
rewritten to "no flags active" by a later registry transition.
Retention is owned by the telemetry store: expiry and cap eviction remove stale
context without a diagnostics subscriber and release it no later than the next
external-store read. Any retention-clock failure outside a render-phase
`getSnapshot` releases retained samples and dedupe keys immediately, even if the
failure is transient, so an aborted timer cannot leave identifiers resident
without a replacement expiry deadline.
A render-phase `getSnapshot` clock failure is the one exception: it publishes an
empty failed snapshot and does not mutate backing storage. The already owned
retention timer or the next non-render collection/publication entry point
performs the pending destructive cleanup. Buffered observer entries are retained
from their occurrence timestamp and deduplicated across observer replay. An
observer entry whose duration is negative, whose start maps after delivery,
whose start time is negative, or whose completion exceeds delivery by
more than the one-millisecond Performance API rounding tolerance, is malformed
and fails the observation.
Because the Performance Observer entry has no historical app context, a buffered
sample explicitly carries delivery-time route and feature-flag context; System
Diagnostics labels those fields as delivery-time context and must not imply that
context was captured at the original stall time. Occurrence timestamps, window
pruning, and retention deadlines share the Performance timeline's monotonic epoch
clock; `Date.now()` must not drive this
retention boundary because wall-clock adjustments would split the clocks. The
module singleton is constructed without reading that clock: the first observer,
record, or external-store read validates it, and observer setup publishes a
local `failed` snapshot if the timing capability is unavailable instead of
failing shell import. An initial external-store read before the observer effect
mounts follows the same explicit failed-snapshot path. Injected retention clocks
remain coherent with real `PerformanceEntry.startTime` values by mapping each
entry age into the injected clock domain. Buffered-entry dedupe keys survive
sample-cap eviction until the entry leaves the rolling window, so replay cannot
create a spurious publish.
They use stable Performance entry identity (`startTime` plus duration), never
the delivery-time clock mapping, because replacement observers can deliver the
same buffered entry at different times.
Unsupported or failed `PerformanceObserver` setup is represented explicitly in
the snapshot; it never silently degrades. Unsupported observation releases
retained samples, dedupe keys and the retention timer before publishing an
explicitly empty window without consulting the timing clock; disposing that
inactive observation repeats the release before the caller sees the idle state.
The empty snapshot carries
the last successful monotonic timestamp rather than fabricating a new clock read,
or the explicit epoch-zero sentinel if no clock read has succeeded yet. Direct
recording after unsupported observation is known throws instead of creating a
hidden retained window, and failed observation has the same explicit rejection.
A malformed entry fails and disconnects its observer loudly, but valid sibling
entries from the same delivered batch are retained and published with that failed
snapshot; their expiry timer remains owned even if a later batch insertion fails.
Distinct malformed causes are reported together with their original errors
preserved. A delivery failure reuses the validated delivery timestamp for the
failed snapshot rather than probing the clock again. The observer Performance
clock is read after the delivery epoch clock, conservatively biasing occurrence
mapping slightly earlier for retention. A non-finite or negative long-task
duration or injected clock result fails collection visibly. System Diagnostics
keeps the retained sample count visible on active, idle, and failed cards so
aggregates always have an explicit denominator. Mixed feature-flag context also exposes the
known-context sample count against the total retained sample count; flag counts
must never imply they cover samples whose flag context was unavailable.
Disposing a failed inactive observation preserves its precise reason if the clock
is still unusable rather than claiming recovery. Reset always clears retained
context; when the timing clock is unusable, the failed state remains latched
instead of claiming an idle collector. Do not write routine performance samples
into
`brainstrike_diagnostic_events`: that table is CHECK-constrained to warn+
failure signals, drives the unseen-diagnostics chip, and is the wrong cardinality and
severity model for continuous performance measurements.

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
(`packages/logging/src/logger.ts`) feeds `DiagnosticSinkBridge`
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
`pglite-direct-transport.ts`'s reset table lists. Both currently include
`brainstrike_diagnostic_events`.

**Debug bundle**: `packages/app-shell/src/diagnostics/debug-bundle.ts`
(collector `collectThreadDebugBundleData` + pure formatter
`formatThreadDebugBundle`, convenience wrapper `buildThreadDebugBundle`),
consumed through the `DebugBundleProvider` seam
(`packages/assistant-ui/src/debug-bundle-context.tsx` +
`packages/app-shell/src/hooks/use-debug-bundle.ts`) by the
`CopyDebugBundleButton` (`packages/assistant-ui/src/copy-debug-bundle-button.tsx`)
on failed assistant messages. That footer offers two deliveries — **Copy**
(clipboard) and **Download** (a `.md` file on disk, BST-946) — each building
its OWN bundle: a second click re-runs `buildThreadDebugBundle` rather than
reusing the first result, so every delivery reflects the data at click time
and there is no cache to go stale. Download is the realistic transport at this
size: bundles run up to the 200 KB budget below, past what a chat box or issue
comment accepts.
Filename + save live in `packages/assistant-ui/src/debug-bundle-download.ts`
(`formatDebugBundleFilename` / `downloadDebugBundleFile`) rather than in the
component module, which is component-only by the Fast Refresh module-boundary
contract (`react-refresh/only-export-components` in `eslint.config.js`; the
split predates that gate and was originally attributed to react-doctor, whose
rule id turned out to be alias-only — see the REACT DOCTOR section in
`docs/agents/ci-quality.md`). The filename is
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
`packages/assistant-ui/src/__tests__/debug-bundle-download.test.ts` because the utils
package's vitest environment is `node`; the desktop-bridge route is covered in
the node-env file since it needs no DOM). Five export surfaces today:
`formatDebugBundleFilename` / `downloadDebugBundleFile`, `log-viewer.tsx`'s
`brainstrike-logs-….json`, `logging-settings-section.tsx`'s
`brainstrike-errors-…[-recent<N>].ndjson`, the DB explorer's CSV/ZIP
exports (`packages/db-explorer/src/hooks/use-export-handlers.ts` /
`csv-export-utils.ts`), and the file-explorer preview context report
(`packages/hooks/src/use-report-manager.ts`,
`context[-<root>]-….txt`). All five call `downloadBlobFile` for the SAVE half;
a call site that hand-rolls an anchor save is a regression (all of them got a
half wrong, in different ways, before BST-946), and `file-saver` is gone from
the repo entirely — reintroducing it is the same regression. The FILENAME half
is consolidated for all but one surface; the DB explorer still builds names
via its own `generateCSVFilename` (`csv-export-core.ts`) — open work, and the
desktop route makes it matter: main hard-rejects filenames outside
`[a-zA-Z0-9._-]`, which `formatTimestampedDownloadFilename` guarantees but
ad-hoc builders do not.
`downloadBlobFile` resolves `{ path? }` — on the desktop route that is the
file ACTUALLY written (a collision retargets to a ` (n)`-countered name, never
overwrites), so callers that name the file to the user must use it; the anchor
route resolves `{}` because the browser owns the final name.

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

`downloadBlobFile` is async and has TWO routes, selected by capability (never
`isElectron()`). Desktop: the Electron preload exposes `window.fileExports`
(`file-exports:save-to-downloads` → `apps/desktop/src/ipc-file-exports-handlers.ts`),
and MAIN writes the bytes into the OS Downloads folder with `fs` — no object
URL and no Chromium download item at all, because live CDP probing
(2026-08-03) showed a blob download whose URL is revoked mid-flight can wedge
as a permanently in-progress download item, and wedged items then jam later
downloads for the whole session. Main re-validates the renderer-supplied
filename against the same `[a-zA-Z0-9._-]` charset (no separators, so no
escape from Downloads), and the write is exclusive-create (`O_EXCL`) with a
Chromium-style ` (n)` counter — it NEVER overwrites. A `{ ok: false }` result
becomes a throw at the call site, and a PRESENT-but-malformed bridge throws
rather than falling back to the anchor route — falling back would silently
reintroduce the wedge-prone pipeline (NO SILENT FALLBACKS).
Web (bridge absent): the Blob → object URL → anchor → revoke save, where the
helper owns the object URL's whole lifetime: the revoke is DEFERRED
`DOWNLOAD_BLOB_REVOKE_DELAY_MS` (60 s — the download manager resolves the blob
URL asynchronously in the browser process, and a revoke that wins that race
kills the download after the caller already reported success; the constant's
doc comment records why the old one-macrotask deferral was not a real bound)
on the success path and IMMEDIATE when the click threw — the immediate revoke
on the throwing path is what stops a user retrying a failing export from
pinning one full payload per attempt. Tests of the anchor route must NOT wait
for the revoke on real timers (it is a minute out): either assert the revoke
has not landed in the click's wake scoped to THIS export's URL (the
settings-ui export tests), or use fake timers and drain with
`advanceTimersByTime(DOWNLOAD_BLOB_REVOKE_DELAY_MS)` before restoring a
mocked `URL.revokeObjectURL` (the debug-bundle test). With neither bridge nor
DOM it THROWS rather than no-opping.
The button's phase machine tags every non-idle phase with its action
(`copy` | `download`) so one action's spinner/result/error never appears on
the other's button, and both failure paths render inline (`Copy failed: …` /
`Download failed: …`) in an `aria-live` region. A destination picker (File
System Access `showSaveFilePicker`) was deliberately NOT added — exports go to
the Downloads folder on both routes without prompting. `DEBUG_BUNDLE_FORMAT_VERSION = 1` is stamped in
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
`packages/assistant-ui/src/__tests__/copy-debug-bundle-button.test.tsx`,
`packages/assistant-ui/src/__tests__/debug-bundle-download.test.ts`,
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
`packages/settings-ui/src/settings/system/logging-settings-section.tsx`):
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
`apps/desktop/src/__tests__/diagnostics/main-watchdog-core.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-path.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-runtime.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-worker.integration.test.ts`,
`apps/desktop/src/__tests__/build-main-config.test.ts`,
`apps/desktop/src/__tests__/diagnostics/error-log-sink.test.ts`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (the
`recordDurableLog handler` describe block covers the two `logging-ipc.ts`
choke points feeding the sink),
`packages/app-shell/src/__tests__/durable-log-source.test.ts`,
`packages/app-shell/src/__tests__/use-durable-log-source.test.tsx`,
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`,
`packages/settings-ui/src/settings/system/log-viewer-components/__tests__/log-viewer.test.tsx`,
`packages/ui/src/__tests__/copy-text-button.test.tsx`.

### P2b: status chip, retention preferences, sink health

**Unseen-diagnostics status chip** (`DiagnosticsStatusItem`,
`packages/app-shell/src/status-items/diagnostics-status-item.tsx`, mounted in
`app-layout.tsx`'s `rightContent` before `IndexingStatusItem`) backed by
`useUnseenDiagnosticsCount` (`.../diagnostics/use-unseen-diagnostics-count.ts`):
a single `usePGliteLiveQuery` aggregate over rows newer than the watermark. The
table's CHECK constraint defines the complete warn+ set; two `FILTER` clauses
partition that set for honest labels rather than deciding eligibility: `warn`
stays in the warning bucket, while `error` and `fatal` share the error bucket.
Warning-only rows render `N warnings`; mixed rows render `N errors, M warnings`
visibly and `N errors and M warnings` to assistive technology. The chip renders
`null` when both counts are 0 (no chrome when nothing is wrong), but ALL
not-knowing classes outrank the counts, because
this is the only always-visible diagnostics surface: a live-query error
renders "Diagnostics unavailable" rather than the honest-looking `0`.
Present aggregate values are validated strictly: only a non-negative safe-integer
number or decimal-digit string with no surrounding whitespace is accepted. Null,
blank, non-integer, negative,
boolean, array, object, non-decimal, or otherwise unsafe values render
"Diagnostics unavailable" rather than being coerced via `Number()`. A non-null
`disabledReason` renders
"Diagnostics not recording" — outranking
even non-zero counts, since those counts are frozen and stale once the sink is
dead. Without the latter, a disabled sink writes no rows, both counts sit at 0
forever, and the status bar silently claims "no diagnostics" precisely when
diagnostics have stopped being recorded; the settings banner alone cannot cover that,
because a user has no reason to open settings while the status bar looks
clean. Clicking marks all seen, opens settings, and routes to
`#settings/logging`.

The watermark (`diagnostics-seen-store.ts`) is **session-scoped, seeded to
`Date.now()` at module load, and deliberately NOT persisted**: a persisted
watermark would replay up to 20,000 retained rows as unread on every launch,
so the chip means "warn+ events since this launch," not "since you last
looked." Do not "fix" this by adding `persist`.

**Retention preferences** (`packages/app-state/src/stores/diagnostics-retention-store.ts`,
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
(`resetDiagnosticsSeenStore`, `resetDiagnosticSinkHealthStore`) are reset by
`resetAppShellSessionStores`, which is registered in
`packages/app-shell/src/register-factory-reset-session-stores.ts`; the persisted
`resetDiagnosticsRetentionStoreToDefaults()` is called directly from
`clearBrowserStorage()` in
`packages/app-state/src/factory-reset.ts`, alongside
its sibling persisted stores.

**Paired tests**: `packages/app-state/src/__tests__/diagnostics-retention-store.test.ts`,
`packages/app-shell/src/__tests__/diagnostics-seen-store.test.ts`,
`.../diagnostic-sink-health-store.test.ts`,
`.../diagnostics-status-item.test.tsx`, `.../use-diagnostics-purge.test.tsx`,
`.../diagnostic-sink-bridge.test.tsx` (the configured-retention startup purge
and the writer-disables-populates-health-store cases),
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`
(retention card + sink-health banner describes).
