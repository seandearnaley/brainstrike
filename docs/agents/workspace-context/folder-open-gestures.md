# OS folder-open gestures — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before adding an entry point that connects a folder, or changing the open-request queue, the File menu, argv parsing, or the window handshake (BST-1393 W6).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

- **Low-friction folder connection — the OS-gesture delivery machinery
  (BST-1393, spec §7 [D10]).** Five gestures ask this app to connect a folder:
  File ▸ Open Folder… (⌘O), File ▸ Open Recent, `brainstrike <path>` /
  `second-instance` argv, macOS `open-file` (also what a click in the Dock's
  recent-documents list delivers, since every grant-recording mount calls
  `app.addRecentDocument`), and a Finder folder dropped on the composer's
  workspace bar. All five converge on ONE renderer seam — `useConnectFolder`
  (`packages/app-shell/src/workspace-connect/use-connect-folder.tsx`, see the
  workspace-bar section below for the seam + drop details) — and that seam
  calls the existing picker-less `fs:addRootByPath`. W6 added no third
  authorization door.
  - **Main→renderer travels over the `window.workspace` bridge**
    (`workspace:open-folder-picker`, `workspace:open-path`, plus the
    renderer→main `workspace:open-path-ready` ping and the preload-local
    `getDroppedPath` = `webUtils.getPathForFile`). A bridge of its own rather
    than a fourth `window.platform` member (ruling B1): the platform bridge's
    exact-set pin is duck-typed by object literals in
    `context-action-registry.test.ts`, which a new required member would
    silently invalidate. `packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts`
    is canonical for the required-method set, the five-member
    `WorkspaceOpenOrigin` union (`argv` · `drop` · `menu-recent` ·
    `open-file` · `second-instance`, each side compile-time pinned), and the
    TWO exact refusal strings the renderer's remedy matcher shares with
    main's `resolveGrantedRootHandle` — the renderer strips the
    `ipcRenderer.invoke` error envelope (`IPC_INVOKE_ENVELOPE` in
    `use-connect-folder.tsx`, kept byte-identical with
    `hooks/use-workspace-bar.ts`'s copy) before matching, so the remedy fires
    against the enveloped production rejection, not just the bare unit-test
    string. The stripper matches ANY `*Error:` name after the envelope, not
    only the literal `Error:` — main throws the refusal as an `AccessError`
    and the class NAME survives IPC serialization
    (`Error invoking remote method 'fs:addRootByPath': AccessError: …`); a
    literal-only stripper left `AccessError: ` on the message and silently
    degraded the remedy to the generic toast (caught by the BST-1393 L5 e2e
    against the real built app, invisible to every unit fixture that spelled
    the envelope with a plain `Error:`).
  - **File ▸ Open Folder… (⌘O) does not open a dialog in main.** The menu
    item (`apps/desktop/src/application-file-menu.ts`, pure and unit-tested)
    pushes `workspace:open-folder-picker` to the FOCUSED window and the
    renderer runs the SAME `addRootDirectory()` the Folder chip's Add
    folder… runs, so grant recording, recents refresh and the reconciliation
    nudge stay on one path. The menu callbacks forward Electron's
    click-handler window (the `(_menuItem, browserWindow)` idiom the View
    items use) and `getFocusedWindow()` is only the fallback —
    `getFocusedWindow()` alone is null whenever the app is not the OS-active
    application, which made a programmatic `getMenuItemById(...).click(...)`
    (the e2e's only way to drive the menu) a silent no-op. A ⌘K "Open folder…" command rides the same
    renderer flow (`createGlobalCommands`'s targetless-command idiom).
  - **File ▸ Open Recent projects main's own `recentRootsList` ledger**,
    capped at 10 rows (`FILE_MENU_RECENT_LIMIT` — the ledger's 50 is storage
    hygiene, not a menu bound), newest-first, labelled by basename with the
    full path as tooltip, and DISABLED (not hidden) when empty. It rebuilds
    on a coalesced 250 ms schedule whenever the root-grant subscriber fires
    (the same subscriber that calls `app.addRecentDocument`). **There is NO
    "Clear Menu" row** — a deliberate deviation from the original W6 plan:
    clearing only `app.clearRecentDocuments()` left every visible row
    unchanged (a button that visibly does nothing), and clearing the ledger
    from a menu item would silently revoke picker-less grants. Emptying the
    ledger is "Remove from recents" ([D9]), still deferred.
  - **A recent-menu click sends `workspace:open-path` with
    `origin: 'menu-recent'` directly to the focused window; the
    launch-scoped producers go through `createWorkspaceOpenQueue`**
    (`apps/desktop/src/workspace-open-queue.ts`): `open-file` is registered
    at MODULE scope (macOS fires it before `whenReady`, and it stays
    registered in E2E mode because `app.emit('open-file', …)` is the only
    way that entry point is e2e-observable), launch argv is enqueued ONCE
    inside `whenReady` (never re-enqueued by `activate` recreations), and
    `second-instance` is registered only when NOT in E2E mode (ruling L3 —
    e2e cannot launch a competing process; its parse is `folder-argv.test.ts`'s
    and its delivery is the same queue the `open-file` e2e proves).
    **The unpackaged app-path skip in `resolveFolderCandidatesFromArgv` is
    by IDENTITY (`app.getAppPath()`), never by argv position** (BST-1393 L5,
    observed live 2026-08-27): Chromium regroups the argv it delivers to the
    first instance's `second-instance` handler as
    `[program, ...switches, ...positionals]` — injecting its own switches —
    so the `electron .` app-path positional lands at an arbitrary index; a
    fixed `slice(2)` mis-parsed it into a folder-open candidate for the repo
    checkout (and would silently mount it if the repo is in the recents
    ledger). Only the FIRST positional matching `appPath` OR `appEntryPath`
    (the running bundle's `__filename` — recognizes the FILE-entry spelling
    `electron <path>/dist/main.js`, where `app.getAppPath()` is dist/
    itself, BST-1459) is skipped: positional relative order survives the
    regrouping, so that is the implicit app argument; a later duplicate is
    an explicit `electron . .` request and stays a candidate. An empty
    `appPath`/`appEntryPath` THROWS (`path.resolve('')` would silently alias
    the cwd). Packaged parsing never consults either.
    Candidates pass `filterDirectoryOpenCandidates` first: non-directories
    and unstat-able paths are loudly skipped BEFORE the IPC channel, capped
    at `MAX_PENDING_OPEN_REQUESTS` (16, oldest dropped with a warn) before
    the sync stat loop so a runaway `second-instance` cannot stall main.
  - **Queue delivery is gated on a TWO-condition handshake, per window**
    (BST-1393 PR #2682 re-review — both halves exist because single-signal
    versions each shipped a Critical bug): `loadFinished` tracks
    `did-start-loading`/`did-stop-loading` (the WebContents-level SYMMETRIC
    pair — `did-finish-load` is main-frame-only, so pairing it with
    `did-start-loading` strands the queue after a subframe-only load, e.g.
    the canvas surface's artifact `<iframe>`), and `rendererReady` is the
    renderer's own explicit ack: `WorkspaceConnectHost` pings
    `workspace:open-path-ready` in the SAME effect that subscribes
    `onOpenPath`, because a loaded document is not a mounted listener and
    Electron never replays a `send` nobody heard. `rendererReady` resets
    ONLY on a real main-frame document replacement (`did-start-navigation`
    with `details.isMainFrame && !details.isSameDocument`) — resetting it on every
    `did-start-loading` would clear it on a canvas-iframe navigation with no
    second ping ever coming. The ready channel is registered ONCE at module
    scope (`apps/desktop/src/workspace-open-ready-ipc.ts`; the IPC registry
    rejects double registration) and routed per window via a
    `webContents.id`-keyed callback map that `createMainWindow` populates
    and `closed` cleans up — the id is CAPTURED at registration, never read
    inside the `closed` handler, because the `win.webContents` getter itself
    throws "Object has been destroyed" once `closed` has fired (an uncaught
    main-process exception on every window close until the L5 fix; pinned by
    `workspace-open-lifecycle.test.ts`'s destroyed-getter case). The queue
    also detaches on `closed` explicitly, because `isDestroyed()` still
    reports `false` while a window is dying.
  - **Delivery ≠ authorization**: the queue is a buffer of REQUESTS. Every
    delivered path still goes through `isWorkspaceOpenPathRequest` narrowing
    (malformed payloads dropped with a log, never coerced) and the seam's
    `fs:addRootByPath` gates. Nothing in this machinery calls
    `recordRecentRoot`.
  - Paired tests: `apps/desktop/src/__tests__/workspace-open-queue.test.ts`,
    `workspace-open-ready-ipc.test.ts`, `main/workspace-open-lifecycle.test.ts`,
    `folder-argv.test.ts`, `application-file-menu.test.ts`, and the BST-1393
    describe in `apps/desktop/e2e/add-root-ui.smoke.desktop.test.ts`
    (root-header menu + Open in Terminal `pwd` falsifier, File menu driven
    from main, `open-file` granted-mounts / never-granted-refuses end to
    end).

