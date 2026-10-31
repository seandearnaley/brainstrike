# Platform, logging and reset

## IPC and packaging

Sensitive invokes authorize both the server-owned window role and sender frame
against the single configured renderer target before parsing arguments. Preload
possession is not authority; unknown roles/frames fail closed. Hidden roles receive
only their manifest capabilities.

Built renderers, visible and hidden, load one exact document on the bundled
`brainstrike-app://bundle` origin, served only from the renderer dist by the
confined protocol handler (`renderer-protocol.ts`); loaders, navigation and the
sender-frame allowlist derive it from the same target and never admit the old
`file://` document. Browser storage, Cache Storage models included, belongs to
that origin. Shared IPC contracts and preload value imports
remain pure; Node/runtime validation belongs on the main side. Bundles expose only
the declared capability graph, not arbitrary bridges.

Native modules, utility entries, Python/CLI helpers and runtime assets are
resolved from the actual packaged layout. Missing or incompatible assets refuse;
a development path or system installation is not a packaged fallback.

## Login-shell environment

Windows keeps the Explorer environment; Main does not resolve a login shell on
win32 (the same as VS Code's resolver). This is the one stated exception to the
rule that every test runs on every OS: the `login-shell-environment.test.ts`
tests that start a real POSIX login shell are skipped on Windows, and the
`skipped: windows` outcome is asserted on every OS.

A shell that has not printed its environment within ten seconds (VS Code's
bound) is stopped with its whole process group, and launch continues with the
launch environment and a `failed` status Main logs and the environment report
shows.

## Reset and physical lifetime

Clear Database deletes canonical content, root grants and derived indexes while
retaining configuration/credentials. Factory Reset also clears configuration,
secrets and persistent UI state. Both use the existing admission/retirement owner:
join renderer saves and retire persisted chat/tab references before host deletion
and replacement. New durable state participates in reset. Main owns Factory
Reset: it wipes userData, blanks every window so no old document can write, clears
the session's storage, and loads a fresh document. Live in-memory stores return to
defaults because the document is replaced, so no store resets itself; the renderer
clears only its window-scoped `sessionStorage`, which no session API reaches.

Before destructive profile work, fence new admission, join writers, readers,
inference, subscriptions and pending acquisition, then hold the profile reset
lease through the entire purge. Preserve its live lock namespace and Chromium
Session container until their own cleanup APIs finish. Failed cleanup remains an
incomplete reset with retained ownership, not a successful restart. Windows
Factory Reset remains explicitly unavailable; do not imply platform acceptance.

User-confirmed reset is the destructive recovery boundary. Corruption never
silently deletes, replaces, repairs or reloads canonical data. Preserve typed
integrity failures and diagnostic access; read-only containment is not health.

## Logging and background owners

Use the shared logger and bounded structured diagnostics. Redact secrets and
sensitive content while preserving correlated causes, aggregate failures and
safe actionable errors. Telemetry is an observation, never authority or a second
persistent fact. Adding a diagnostic store adds a reset obligation.

Long-lived watchers, command sessions and background tasks own
explicit lifetimes. Fence admission synchronously, join late and active resources,
attempt independent cleanup and report every failure. A timeout, cancellation
notice, closed transport or deleted row does not prove physical work stopped.
Stale callbacks cannot affect replacement generations. Debug sessions use
isolated disposable profiles and own their whole spawned process tree.
Workspace root disposal fences direct read/list admission and joins their path
resolution and native completion alongside mutations and source leases before
closing mounted capabilities (BST-2251). Read errors remain owned by their callers.

## Graceful shutdown ownership

Quit is one ordered, joined retirement with no global deadline
([ADR-0026](../adr/0026-lifecycle-readiness-liveness-joined-quit.md) R4, as amended
by [ADR-0027](../adr/0027-canonical-electron-quit.md)). Main runs
`DESKTOP_SHUTDOWN_STEP_ORDER` once as plain ordered awaits, each step until it settles,
then the database close, then exits 0. A failed step is recorded and the next step
still runs. A slow step is waited for, never abandoned, so a later physical join is
never skipped; its duration is in the completion record. Only an orchestration that breaks before its
steps can run exits 1. The sequence is finite because each owner's close is a bounded
ladder it owns, not because a clock gives up on it.

A timeout on this path may only escalate a cooperative close of a child Main owns to
a kill Main owns, after which the exit or `closed` is still joined (R5(b)); each such
constant says so in its doc comment. Escalating is a warn, never a failed close:

- A visible renderer gets Main's close preparation and is joined to its ACK.
  `render-process-gone` or `unresponsive` destroys it; no ACK within 30 s destroys
  it; either way its `closed` is joined before the preparation reports the failure.
  The window close that follows overrides a page's beforeunload veto and destroys a
  renderer that crashes or hangs mid-close: app-owned quit is terminal.
- The agent host is asked to close and its exit joined; after 30 s Main calls
  `kill()` and joins the exit. A content clear is never killed: its deletion
  completes under the lease, whose exit is joined without a rung.

Terminal quit prepares Main's workspace mutations before profile retirement; the
agent host retires its worktree operations, Git inventory, snapshot
maintenance, terminals, command sessions, language servers and shell commands in its
own close (ADR-0029). Accepted workflows finish while
mounts, git, setup and the authenticated catalog remain available; new mutations are
refused.
The catalog borrower then fences new calls and joins admitted acquisitions and
replies through ACK or error. A failed deletion retains its reservation and reports
its cause. A borrower not authenticated before quit may receive the existing
terminal native-index refusal; that is not a persistence ACK. This preparation
leaves physical root cleanup in its later step and never changes raw transport close
or reset/reopen.

Quit has one terminal reason: the typed native-index refusal of kind `closed`,
reason `shutdown`. Boundaries keep it as the cause of whatever they rethrow, and a
log site that classifies it records it at debug, never as an error.

Main's root watch owners use the joined producer (`startJoinedRootWatch`),
never `ElectronFileSystemAdapter.watchDirectory`'s fire-and-forget disposer, and
each joins its watches in a graceful-shutdown step. The engine is Node's
recursive `fs.watch`: it arms synchronously, and `close()` is its whole
retirement, on the event-loop thread. @parcel/watcher was removed because its
Windows backend freed a subscription while the kernel and its backend thread
still used it (EXCEPTION_ACCESS_VIOLATION in Main); do not bring back a native
watcher add-on that runs threads of its own.
The host's Git inventory service follows the same joined-producer rule; it retains
its watcher generation through failed stop and refuses restart until retirement
succeeds.

Git runs in the agent host as a plain Node child on every platform (ADR-0027),
spawned through `spawnNativeChild` so it holds the Root (ADR-0017); there is no
per-command native Job for quit to join. Windows agent commands keep their wrapper and
Job. The git runner settles at the child's `close`; output past its capture ceiling
closes the pipe instead of killing git, since a kill on Windows reaches only the
`cmd\git.exe` launcher and leaves the real git running in the repository.

The E2E harness joins the app's exit under the test timeout and requires exit code
0. A SIGTERM from the harness is cleanup after a failed close, and the test fails.

## Every document unload flushes the three durable writers

Only three renderer writers keep a write-behind tail (ADR-0026 R1): the thread
workspace snapshot (500 ms, to the host), Explorer persistence through the desktop
storage writer (100 ms, to Main's storage) and the panel layout's resize commit
(150 ms, written through to its store). Each registers one awaited flush with
`registerDurableFlush` (`@brainstrike/app-state/renderer-close`); the shared
primitive is `createWriteBehindWriter` (`@brainstrike/storage`). Nothing else is
joined at unload: not reads, not producers, not hydration. None of the three owns a
`beforeunload` or `pagehide` handler. (Editor view state stays in the document's own
localStorage and flushes synchronously on `pagehide`; Main does not join it.)

Main runs the one flush (`prepareDocumentUnload`) before every unload of a visible
document it owns, then unloads the document whatever the answer:

- quit's `renderers` step, then the normal window close;
- a user's window close (window-X, Alt+F4, Cmd+W): Main prevents it, prepares the
  document, then closes the window again past the interception. On Windows and
  Linux the last visible window's close is the app's quit instead, and quit prepares
  and closes it;
- menu Reload, a renderer's `desktopLifecycle.requestReload` (failed-chunk recovery,
  visible-UI main frame only) and the developer database reset, which flushes the
  documents before it clears their profile. A failed flush is logged and the reload
  proceeds: the document is replaced either way.

The renderer fences its UI (`inert`), joins the flushes, closes its host transport
and acknowledges Main's private reply port. A write its owner refused as unavailable
(category `availability`: the profile closed, the store read-only, the view closing)
settled with nothing left to deliver, so it is logged at warn and the flush succeeds.
The case that needs this is a host stopped just before quit: the write waits on the
frame's one reconnect, which quit's fenced profile refuses with its terminal reason.
Outside quit the same write reaches the relaunched host. Any other rejection fails
the flush, and the negative ACK names each cause, since the context bridge carries
only an error's message. The latch belongs to that document
generation; a reloaded document starts a fresh registry. A page never vetoes an
unload Main owns.

These reloads are deliberately not prepared:

- Factory Reset (`factory-reset-panel.tsx`, then Main's replacement of every
  visible window) and native content clear (`use-native-content-clear.ts`): their
  durable state is being wiped, so a flush would write the old document's stale
  state back into the cleared profile. They retire their writers through
  `prepareFactoryReset` instead. The desktop E2E harness's state reset follows the
  same rule (`reloadClearedRenderer`); every other E2E reload uses
  `reloadRenderer`, the flushed path users get.
- The `ui` error boundary's reload is crash recovery for a document that may be
  broken; it can lose the last write-behind tail (at most 500 ms).
- Crash recovery after `render-process-gone`: the renderer is dead and cannot
  answer.

Decisions: [ADR-0015](../adr/0015-desktop-platform-ipc-reset-diagnostics.md);
graceful shutdown, [ADR-0026](../adr/0026-lifecycle-readiness-liveness-joined-quit.md).
Implementation: desktop platform/IPC/reset owners, `packages/app-state` and
`apps/desktop/src/main/desktop-graceful-shutdown.ts`.
