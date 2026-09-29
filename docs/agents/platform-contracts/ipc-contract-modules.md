# Contract-module migration: manifests, bridges, registration, envelopes — evidence

Supports `docs/agents/platform-contracts.md` § "IPC CONTRACT MODULES".
Read before adding an `ipc-domains/*.contract.ts`, changing a preload import, or touching `registerDomain` / `exposeBridge` / the `IpcResult` envelope. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

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
  reference (`chunkingHost`, `embeddingHost`, `files`, `llmHost`, `logging`,
  `runtime`) so the role-scoped hidden
  capability manifest (BST-1235/BST-1380) cannot widen by a stray reference.
  Hidden database capabilities instead come from the pure role-specific
  `databaseChunkingContract` / `databaseEmbeddingContract`; their exact key
  sets and manifest channels are pinned by the hidden-preload runtime tests.
  The embedding host's `vectorPreferences` bridge is now derived from the pure
  storage-preferences contract, so `hidden-preload.ts` imports that contract
  instead of referencing the `vectorPreferences` manifest group directly.
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
  `ContextFilesBridge`, `GitBridge`, `ChangesBridge`, `ForgeBridge`,
  `WorktreesBridge`, `CommandSessionBridge`, `TerminalBridge`), so
  app-shell/settings-ui never re-declare
  a bridge.
  Contract modules live at `ipc-domains/<domain>.contract.ts` and reference
  the manifest entry (`DESKTOP_IPC_CHANNELS.<group>.<key>`) — the manifest
  stays the one literal owner. `settleIpcResult({ category, code }, run)`
  converts a throw-style operation into the envelope (logged in main).
- **Universal types do not own desktop capabilities (BST-996).**
  `@brainstrike/types` exports neutral database, assistant-selection, and
  file-system wire data only. It has no `electron-api` module, no
  `window.electronAPI` augmentation, and no `Electron*API` bridge interfaces.
  The database package owns `DesktopDatabaseBridge` and its capability reader;
  the desktop app composes distinct visible UI, chunking host, and embedding
  host API roles from that owner type, the shared host protocols, the UI layout
  capability, and desktop-local file-system, live-query, and storage shapes.
  Each preload uses its exact role type and checks its runtime key set before
  exposing it; the embedding role also owns the scoped vector-preferences
  capability. Other packages read the narrow owning capability they use, while
  web keeps the capability absent. The recursive TypeScript AST boundary and
  its negative-control fixture are pinned by
  `scripts/__tests__/desktop-ipc-type-boundary-contract.test.mjs`.
- Migrated so far: `changes`, `clipboard`, `commandSessions`, `contextFiles`,
  `database`, visible-UI `fileSystem`, `forge`, `git`, `notesVault`, `skills`, `terminal`, `userCommands`,
  `userPersonas`, `worktrees`, MCP, visible-UI `storage` / layout / settings,
  and the embedding-host-only `vectorPreferences` capability. MCP's pure manifests cover all 31
  invokes and seven pushes. Root, content, elicitation, and Tasks handlers use
  `registerDomain`; the native config picker and five Apps operations retain
  narrow event-aware adapters because their ownership is bound to the
  registry-authenticated `event.sender`. The preload derives each channel
  method and subscription, then composes the public MCP object. The sole
  channel-less method is `apps.readResource`: it first resolves the live server
  generation and then calls the contract-derived content bridge. Existing MCP
  raw replies, including the `{ ok, result }` content envelope, remain byte-shape
  compatible; the preload still unwraps content into the established public
  promise behavior.
  The file-system contracts cover 17 invokes and the two watcher pushes. The
  three read methods retain one narrow preload decoder that turns the existing
  wire error payload into the public string-or-clean-Error behavior. The
  parser-host channel remains a separate chunking-renderer capability.

  The production registry inventory is closed in both directions by
  `__tests__/main/ipc-global-manifest.test.ts`: its 219 registrations must equal
  the 138 unique contract invoke channels plus the 81 entries in
  `__tests__/helpers/manual-ipc-inventory.ts`. That explicit complement records
  36 worker/logging/workspace protocol registrations, one parser-host
  capability, and 44 renderer-facing registrations still eligible for later
  migration. A new handwritten registration cannot enter production without a
  status and reason in that inventory.
  Storage's two E2E-only channels remain a narrow conditional adapter: they
  exist only when Electron test mode is active and are authorized for
  `visible-ui`. Exporting them in the discoverable contract would incorrectly
  require production registration in the global manifest. The visible preload
  derives the production storage bridge and overrides only `clear` and
  main-owned-key `setItem` routing in E2E mode.
  Git's 15 operations plus every Changes, Forge, and Worktrees invoke use
  `rawChannel` so valid calls retain each domain's established result envelope;
  their contract parsers
  reject structurally malformed direct IPC input before root resolution or
  handler entry and preserve omitted or explicit-`undefined` defaults for
  push/stage/unstage. Domain semantics such as non-empty roots, paths, refs,
  limits and branch names remain in the main-side handlers so their existing
  `GitResult` failures do not turn into rejected invokes. Changes and Forge
  declare their main-to-renderer invalidations with `pushEvent`; `registerDomain`
  deliberately skips those specs. Forge's temporary unauthenticated exemption
  is gone. `commandSessions` uses `registerDomain` directly. Terminal invokes
  derive their channels, roles, parsers, preload bridge, and renderer type from
  `terminalContract`, but their main adapter remains event-aware: PTY ownership
  must be bound to the registry-authenticated `event.sender` and push output only
  to that renderer. The generic domain handler deliberately receives parsed
  arguments rather than Electron's event, so this adapter is the narrow audited
  exception instead of widening every domain handler's authority. Notes vault
  likewise keeps its established `NotesVaultResult` envelopes with `rawChannel`.
  Its ten eventless operations use `registerDomain`; `watch` and `unwatch` use
  the same narrow event-aware registration pattern so watcher ownership remains
  bound to the registry-authorized `event.sender`, and `onChanged` is a push
  event registered by neither adapter. Database
  follows that same narrow event-aware pattern: scheduler admission and live
  query ownership still receive the authenticated `IpcMainInvokeEvent`, while
  channel, sender roles, raw envelope, and argument parsing come from
  `database.contract.ts`. Visible `db` / `dbLive` / `getUserDataPath` and the
  exact hidden chunking and embedding database subsets are built from those
  contracts. The live update bridge deliberately retains one shared
  `ipcRenderer` listener and fans out to local subscribers rather than creating
  one Electron listener per hook. Their parity tests are
  key-set equality, not source regexes: `preload-contract-bridges.test.ts` loads
  the real preload under a mocked `electron` and asserts each exposed key set equals
  `Object.keys(contract)` and routes/unwraps correctly;
  `ipc-domains/leaf-contracts.test.ts` and
  `ipc-domains/git-adjacent.contracts.test.ts` pin `Object.keys(contract)` to
  the package `*_BRIDGE_REQUIRED_METHODS` resolver sets and exercise `parseArgs`;
  `ipc-domains/terminal.contracts.test.ts` owns the equivalent terminal and
  command-session key, raw-envelope, push-event, role, and parser proof;
  `ipc-domains/notes-vault.contract.test.ts` owns the equivalent notes-vault
  key, raw-envelope, push-event, role, channel, and parser proof;
  `ipc-domains/git.contract.test.ts` owns the equivalent Git key, raw-envelope,
  channel, role and structural-parser proof;
  `platform/register-domain.test.ts` and `platform/ipc-bridge.test.ts` pin
  the two derivations.
- Electron 44 clipboard writes return `Promise<void>`. The main-side
  `ipc-clipboard-handlers.ts` must await the write inside its catch boundary:
  success means the write settled, and rejection returns
  `ipcFailure('clipboard', 'write_failed', message)`. The rejection spec in
  `__tests__/ipc-clipboard.test.ts` must fail when the await is removed.
  Renderers use the existing IPC bridge; Electron 44 removes their clipboard
  module. The synthetic clipboard import in `preload-sandbox-imports.test.ts`
  still tests rejection of an impure sibling module, without executing it.
  Electron 44 requires macOS 13+ and 64-bit targets. The desktop builder has
  no minimum-system-version override, 32-bit target, or custom ANGLE library
  handling; it inherits Electron's minimum. Signing/notarization remains
  BST-1627's separate release work.
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
