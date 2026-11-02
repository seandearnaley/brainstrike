# ADR-0029: Main is a launcher; workspace services live in the agent host

- **Status:** Accepted (Sean chose Option B of the "Main as a thin launcher" decision,
  2026-10-25)
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): Main's native index is deleted, so
    `workspace/roots/mounted`, the index's read handles and its part in root data deletion
    (stage 4) are gone. The host deletes a folder's data on its own.
  - 2026-11-02: per-folder data deletion (`workspace/roots/delete-data`, `fs:deleteRootData`)
    is removed with the Explorer's "Also delete folder data" option. Disconnecting a folder
    keeps its record.
- **Date:** 2026-10-25
- **Amends:** [ADR-0017](0017-cli-first-agent-host.md) (what "provider of platform
  capabilities" covers) and [ADR-0027](0027-canonical-electron-quit.md) decision 3 (the
  native-thread join on Main retires once no native work runs there)
- **Follows:** [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md)

## Context

ADR-0017 says Electron main is "a launcher and a provider of platform capabilities, not
the host". In practice Main still owns most workspace services. Measured on `main` at
3a45a050:

- Main's import graph holds 351 desktop files (62.6k lines) and 27 workspace packages;
  246 of those files (43.3k lines) load in Main only.
- Main serves about 199 renderer IPC channels in 36 domains, and about 45 methods the
  agent host calls back for its own tools (`platform/*`, `desktop-read/*`, MCP stores).
- Quit runs 12 ordered steps (`DESKTOP_SHUTDOWN_STEP_ORDER`). Most exist only because a
  Node-only service lives in Main: child processes, file system, git inventory, MCP
  runtime, main catalog.

Native work in Main is why ADR-0027 keeps joining `@parcel/watcher` subscribes and root
reads on Main's own threads: work that outlives Node's environment crashes Main
(BST-2244, BST-2250), and a crash in Main ends the whole app. ADR-0027 records 22
teardown fixes in six days.

The host already shows the target shape. Command sessions run in the host and Main
relays them to the Terminal panel (`host-tool-process.ts`). Renderers already hold a
direct MessagePort to the host, and the host already holds the Root and the state
store's single writer.

Two alternatives were weighed. Keeping Main as is costs nothing now and keeps the quit
and crash class. A separate Electron-free workspace process isolates crashes best, but
the worktree ledger and snapshots write durable data, so it would borrow
the host's writer across a process boundary, and it adds a third readiness, liveness and
close lifecycle that the CLI would not share.

## Decision

1. **Main does only what needs Electron.** Main keeps:
   - windows, menus, dialogs, clipboard, `shell`, privileged protocols and power;
   - the browser pane (`WebContentsView`, CDP);
   - the credential store (`safeStorage`), lent to the host as it is today;
   - starting utility processes (`utilityProcess.fork`) and joining their exits;
   - the renderer flush and shutdown-time exit labelling (ADR-0027).
2. **Node-only workspace services move into the agent host**, under
   `@brainstrike/host-capabilities`, the existing Electron-free owner of native tools,
   hooks and MCP: git and changes; worktrees, snapshots and rewind; terminals and
   LSP; file watching and Explorer reads; skills, commands and personas; MCP control.
   Renderers call them over the port they already hold; Main relays nothing.
3. **One owner per service at every step.** Each stage moves one area and deletes Main's
   copy, its IPC contract and its host callback method in the same change. No service
   runs in both processes, and nothing falls back to Main.
4. **Native children start through `spawnNativeChild`.** Terminals and LSP servers hold
   the Root flock like every other native process the host starts (ADR-0017, "Native
   processes hold the Root").
5. **Index activation follows the retrieval decision.** It moves only if that decision
   keeps the derived index; otherwise it is deleted, not moved. (2026-11-01: the
   decision removes the index, [ADR-0035](0035-workspace-retrieval-is-live-search.md);
   index activation is deleted.)

## Stages

Each stage ships alone, runs the Windows queue lane and the quit E2E specs, and removes
its Main side and quit step:

1. This ADR.
2. Skills, commands and personas (2a), then the whole git cluster (2b): worktrees,
   snapshots and rewind, Git and Changes. The host called these back, and the
   panels read them over IPC; both callers now use host methods, gated to the
   desktop's private client, and the `platform/*` methods, IPC domains and the
   `snapshot-maintenance` and `git-inventory` steps go. Personas report
   availability against Main's model catalog, so they move with it. The git cluster
   moves as one stage because its services share one inventory, ledger and resolver.
3. Terminals and LSP. The Terminal panel's terminals and command-session inventory
   become host methods gated to the desktop's private client, with a per-connection
   `terminal/event` stream; a connection's terminals end when it closes. Language
   servers, command sessions and shell commands already ran in the host, so Main's
   copies held nothing: the `terminal` and `commandSessions` IPC domains, their
   preload bridges, the `child-processes` step and the matching reset stops go, and
   a disconnected root's language servers are evicted in the host.
4. File watching and Explorer reads. `@parcel/watcher` leaves Main; the `file-system`
   step and ADR-0027's native-thread join go. Every watch already runs on Node's
   `fs.watch`, which closes on the event loop. The Explorer's watches are host
   methods gated to the desktop's private client, with a per-connection
   `workspace/files/event` stream; a connection's watches end when it closes, and
   the `fs:watch*` IPC domain goes. Explorer reads (`workspace/files/list`, `read`,
   `exists`) follow the same gate over the host's live catalog roots, and Main's
   `fs:read*`/`fs:exists` channels and E2E mock tree go. The root registry follows
   (owner decision, 2026-11-01): the host's registry is the one writer of the open
   folders (`roots.open_position`), their grant-time identity (`roots.canonical_path`)
   and the recent-folders ledger, served as `workspace/roots/*` to the desktop's
   private client, and the one owner of each folder's `SecureRoot`, which the
   Explorer's reads and watches borrow. A reopen whose path resolves to another folder
   is refused and shown as needing reconnect. Main keeps only the folder picker
   (`platform/workspace/pick-folder`), its menu and OS recents
   (`platform/workspace/roots-changed`) and the native index's read handles, opened
   on the host's mounted roots. The host removes a folder first and the index learns
   afterwards; a scan in flight on it ends as cancelled. `lastFolderPath`, Main's
   storage adapter and the reset profile reopen go. `fs:deleteRootData` stays in Main
   while the native index does: the host reserves the folder's deletion first, which
   refuses before anything is removed and fences the folder from every read, watch and
   run borrow; the index's sources stop around the host's `workspace/roots/delete-data`,
   which consumes the reservation. The `file-system` step goes once the native
   index's watches have left.
5. MCP control, then index activation if the retrieval decision keeps it. (2026-11-01:
   it does not, ADR-0035. Explorer search already runs in the host as
   `workspace/files/search`; this stage is MCP control alone, and the index is deleted.)

Quit then ends as: factory reset, renderers, `host/stop`, join utility and hidden
renderer exits, database close.

## Consequences

- A native crash in a watcher, pty or LSP pipe ends the host, not the app. The host's
  existing restart and interrupted-run recovery apply; open terminals end with it.
- The CLI gets the same workspace services from the same bundle.
- Panels served by the host are ready when the host reports `ready`, not when Main is.
  The first window still waits for neither. Before stage 2, measure Main `ready` to first
  window and host spawn to `ready` on macOS and Windows.
- Moved code is tested as plain Node, without Electron mocks.
