# Platform, logging and reset

Decisions: [ADR-0015](../adr/0015-desktop-platform-ipc-reset-diagnostics.md),
[ADR-0026](../adr/0026-lifecycle-readiness-liveness-joined-quit.md),
[ADR-0027](../adr/0027-canonical-electron-quit.md),
[ADR-0033](../adr/0033-host-outlives-the-window.md).
Implementation: desktop platform/IPC/reset owners, `packages/app-state`,
`apps/desktop/src/main/desktop-graceful-shutdown.ts`.

## IPC and packaging

- Sensitive invokes authorize the server-owned window role and the sender frame
  against the single configured renderer target before parsing arguments.
  - Preload possession is not authority; unknown roles/frames fail closed.
  - Hidden roles get only their manifest capabilities.
- Every built renderer (visible or hidden) loads one exact document on the
  `brainstrike-app://bundle` origin, served only from the renderer dist by
  `apps/desktop/src/renderer-protocol.ts`.
  - Loaders, navigation and the sender-frame allowlist derive from the same target
    and never admit `file://`.
  - Browser storage (Cache Storage models included) belongs to that origin.
- Shared IPC contracts are type-only (channel names, argument and result types),
  and preload value imports stay pure. Bundles expose only the declared capability
  graph.
  - Main registers an Effect Schema for every invoke's argument tuple
    (`platform/ipc-args.ts`). The one dispatcher decodes it after authorizing the
    sender and before the handler, rejecting extra arguments and undeclared fields.
  - Checks that need Main state (root identity, path containment, the credential
    guard) stay with their owners.
- Native modules, utility entries, Python/CLI helpers and assets resolve from the
  packaged layout. Missing or incompatible assets refuse; a dev path or system
  install is never a packaged fallback.

## Login-shell environment

- Windows keeps the Explorer environment; Main never resolves a login shell on
  win32 (as VS Code does).
  - The only stated exception to "every test runs on every OS": the real POSIX
    login-shell tests in `login-shell-environment.test.ts` skip on Windows, and the
    `skipped: windows` outcome is asserted everywhere.
- A shell silent for 10 s is killed with its process group; launch continues with
  the launch environment and a logged `failed` status shown in the environment report.

## Reset and physical lifetime

- Clear Database deletes canonical content, root grants and the derived state index; keeps
  configuration and credentials.
- Factory Reset also clears configuration, secrets and persistent UI state.
  - Main owns it: wipes userData (sealed credential store included), blanks every
    window, clears session storage (`clearStorageData`; `clearData` skips the app
    scheme) and loads a fresh document.
  - In-memory stores reset because the document is replaced. The renderer clears
    only its window-scoped `sessionStorage` and has no channel that wipes storage,
    settings or secrets.
  - The fresh profile's host restores its open folders; Main keeps no workspace
    ledger of its own to reset (ADR-0029 stage 4).
  - Windows Factory Reset is explicitly unavailable; do not imply otherwise.
- Both resets use the existing admission/retirement owner: join renderer saves and
  retire persisted chat/tab references before host deletion and replacement.
- New durable state must participate in reset.
- Before destructive profile work:
  - fence new admission; join writers, readers, inference, subscriptions and
    pending acquisition
  - hold the profile reset lease through the whole purge
  - keep its lock namespace and Chromium Session container until their own
    cleanup finishes
  - failed cleanup is an incomplete reset with retained ownership, not a restart
- User-confirmed reset is the only destructive recovery. Corruption never silently
  deletes, replaces, repairs or reloads canonical data; keep typed integrity
  failures and diagnostic access. Read-only containment is not health.

## Logging and background owners

- Use the shared logger and bounded structured diagnostics.
  - Redact secrets and sensitive content; keep correlated causes, aggregate
    failures and safe actionable errors.
  - Telemetry is observation, never authority or a second persistent fact.
  - A new diagnostic store adds a reset obligation.
  - Privacy rules: [diagnostics privacy contract](../diagnostics-privacy-contract.md).
- Watchers, command sessions and background tasks own explicit lifetimes.
  - Fence admission synchronously, join late and active resources, attempt
    independent cleanup, report every failure.
  - A timeout, cancellation notice, closed transport or deleted row does not prove
    physical work stopped.
  - Stale callbacks cannot affect replacement generations.
  - Debug sessions use isolated disposable profiles and own their spawned process tree.
- Workspace root disposal fences direct read/list admission and joins their path
  resolution and native completion (alongside mutations and source leases) before
  closing mounted capabilities. Read errors stay with their callers.

## App lifetime (ADR-0033)

- The host outlives the window, not the app: with the Dock (macOS) or a tray (Windows; Linux
  where a StatusNotifierItem host answers on the session bus), closing the last window leaves
  Main and its host running. Without either, it still quits.
- `app-lifetime.ts` owns the decision and the tray; `app-lifetime-electron.ts` injects the
  platform's presence, login item and notification.
- "Keep running in the tray" and the one closed-to-tray notice live in Main's
  `brainstrike-settings` store, so factory reset's userData purge clears them. "Open at login"
  is the OS login item, read back, never copied.
- The tray menu is static, Open and Quit, built once on Windows and Linux. It shows no run
  status and never reads the host; run status belongs in the window and OS notifications. Quit
  is the joined quit below.

## Graceful shutdown

Quit is one ordered, joined retirement with no global deadline (ADR-0026 R4,
amended by ADR-0027).

- Main runs `DESKTOP_SHUTDOWN_STEP_ORDER` once as plain ordered awaits, then closes
  the database and exits 0.
  - A failed step is recorded and the next still runs.
  - A slow step is waited for, never abandoned; its duration goes in the
    completion record.
  - Only an orchestration failure before steps run exits 1.
  - It terminates because each owner's close is a bounded ladder it owns, not
    because a clock gives up.
- A timeout may only escalate a cooperative close of a Main-owned child to a
  Main-owned kill, after which exit/`closed` is still joined (R5(b)). Each such
  constant says so in its doc comment; escalation is a warn, not a failed close.
  - Visible renderer: gets close preparation and is joined to its ACK.
    `render-process-gone`, `unresponsive` or no ACK within 30 s destroys it; its
    `closed` is joined before the failure is reported. The following window close
    overrides `beforeunload` vetoes: app-owned quit is terminal.
  - Agent host: asked to close and its exit joined; after 30 s Main calls `kill()`
    and joins the exit. A content clear is never killed; its deletion completes
    under the lease.
- Ordering:
  - Main prepares its workspace mutations before profile retirement.
  - The agent host retires worktree operations, Git inventory, snapshot
    maintenance, terminals, Explorer reads and root watches, command sessions, language
    servers and shell commands in its own close (ADR-0029). Accepted workflows finish while mounts, git,
    setup and the authenticated catalog stay available; new mutations are refused.
  - The catalog borrower then fences new calls and joins admitted acquisitions and
    replies. A failed deletion keeps its reservation and reports its cause. A
    borrower may get quit's terminal refusal (not a persistence ACK).
  - Physical root cleanup stays in its later step; raw transport close and
    reset/reopen are unchanged.
- Quit's one terminal reason is profile admission's `desktop.profile-closed` refusal
  (`isQuitTerminalRefusal`). Rethrowing boundaries keep it as the cause; logs record
  it at debug.
- File watching:
  - The Explorer's watches run in the agent host (ADR-0029 stage 4), which stops
    them in its own close. Main watches no roots.
  - Root watch owners use `startJoinedRootWatch`, never
    `ElectronFileSystemAdapter.watchDirectory`'s fire-and-forget disposer, and join
    their watches in a shutdown step.
  - The engine is Node's recursive `fs.watch` (arms synchronously; `close()` is
    the whole retirement).
  - Do not add a native watcher add-on with its own threads: @parcel/watcher was
    removed after its Windows backend crashed Main with an access violation.
  - The host Git inventory service follows the same joined-producer rule; it keeps
    its watcher generation through a failed stop and refuses restart until
    retirement succeeds.
- Git runs in the agent host as a plain Node child on every platform, spawned via
  `spawnNativeChild` so it holds the Root (ADR-0017, ADR-0027).
  - No per-command native Job for quit to join; Windows agent commands keep their
    wrapper and Job.
  - The runner settles at the child's `close`. Output past the capture ceiling
    closes the pipe rather than killing git (on Windows a kill hits only the
    `cmd\git.exe` launcher).
- E2E: the harness joins app exit under the test timeout and requires exit 0. A
  harness SIGTERM is cleanup after a failed close, and the test fails.

## Document unload flushes the two durable writers

- Only two renderer writers keep a write-behind tail (ADR-0026 R1, amended by BST-2410):
  - thread workspace snapshot: 500 ms, to the host
  - panel layout resize commit: 150 ms, to its store
- Each registers one awaited flush with `registerDurableFlush`
  (`@brainstrike/app-state/renderer-close`).
  - Nothing else is joined at unload (no reads, producers or hydration).
  - A thread workspace hydration whose read is still pending when the writes
    drain is recorded instead (BST-2281): its baseline goes to a
    `persistDurable` store and it sends no later write. The next document's
    first hydration of that thread resumes from that baseline, so edits made
    while the read was pending survive. The baseline's file panes come from the
    new document, because panes are session-only. A record of another thread is
    dropped.
  - None owns a `beforeunload`/`pagehide` handler.
- Every other durable renderer store is made with `persistDurable`
  (`@brainstrike/storage`): zustand `persist` on `localStorage` under the
  `brainstrike:` key prefix, written synchronously, so nothing is left to join.
  - Main's `clearStorageData()` in factory reset clears them all; a store owns no
    reset code and no store-specific storage, fallback or write-behind.
  - A saved value that is not JSON reads as nothing saved, so the store still
    hydrates; the factory logs it and calls the store's `onUnreadable`.
  - The factory-reset E2E checks that no store's saved value survives a reset.
- Main runs `prepareDocumentUnload` before every unload of a visible document it
  owns, then unloads regardless of the answer:
  - quit's `renderers` step, then the normal window close
  - a user window close (X, Alt+F4, Cmd+W): Main prevents, prepares, then closes.
    The last visible window's close is quit instead only where nothing keeps the app
    running: no Dock, no tray, or the tray turned off (ADR-0033).
  - menu Reload, `desktopLifecycle.requestReload` (failed-chunk recovery, visible
    main frame only) and the developer database reset (flushes before clearing the
    profile). A failed flush is logged and the reload proceeds.
- Renderer side: fence the UI (`inert`), join the flushes, close the host
  transport, ACK Main's reply port.
  - A write refused as unavailable (category `availability`: profile closed, store
    read-only, view closing) has nothing left to deliver: log at warn, flush
    succeeds. This covers a host stopped just before quit.
  - Any other rejection fails the flush; the negative ACK names each cause (the
    context bridge carries only messages).
  - The latch belongs to the document generation; a reload starts a fresh registry.
  - A page never vetoes an unload Main owns.
- Deliberately not prepared:
  - Factory Reset and native content clear (`use-native-content-clear.ts`): a
    flush would write stale state into the cleared profile, so they retire writers
    via `prepareFactoryReset`. The E2E state reset (`reloadClearedRenderer`)
    follows suit; every other E2E reload uses the flushed `reloadRenderer`.
  - The `ui` error boundary's reload: crash recovery, may lose up to 500 ms.
  - Recovery after `render-process-gone`: the renderer cannot answer.
