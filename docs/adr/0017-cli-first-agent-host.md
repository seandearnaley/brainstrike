# ADR-0017: A CLI-first agent host; the GUI is a client

- **Status:** Accepted. Amended by [ADR-0029](0029-main-is-a-launcher.md) (what Main keeps as
  platform capabilities) and [ADR-0030](0030-one-process-supervisor.md) (one process
  supervisor). CLI retrieval is refined by
  [ADR-0026 (two-lane search)](0026-two-lane-agent-search.md).
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): the host's embedding port (BST-2435) and
    its workspace index are deleted; the indexer port now serves only the host state index.
  - 2026-11-11 (BST-2477): Main's lease close no longer probes the Root's flock; see
    [Native processes hold the Root](#native-processes-hold-the-root).
- **Date:** 2026-10-02
- **Ticket:** BST-1914; implementation BST-1941 to BST-1946

## Context

- The reset report first placed the agent host in Electron main. The owner then required the
  agent to run headless too, and a host tied to Electron cannot serve a CLI.
- Comparable products run one long-lived host with every UI as a client (Codex app-server, VS
  Code's Agent Host Protocol).
- Cost of doing it from M3: about two to three more weeks.

## Decision

- **One Electron-free Node host process, `brainstrike-host`.**
  - Desktop main starts it with `utilityProcess.fork` and bridges MessagePorts; the CLI runs the
    same bundle under plain Node.
  - Electron main is a launcher and platform-capability provider, not the host.
- **Clients attach over JSON-RPC 2.0 (`vscode-jsonrpc`)** on stdio, a local socket / Windows
  named pipe, or an Electron MessagePort.
  - `initialize` carries a 32-byte token (constant-time compare) and negotiates the protocol
    version.
  - `log/subscribe {threadId, fromSeq}` replays then follows, publishing only after commit.
  - Approvals, questions, plans and elicitation are log events any client can answer.
- **One host per data root.**
  - The host takes the data-root lock and writes `<dataRoot>/host.json` (pid, start time,
    endpoint, token, protocol and host versions; 0600 in a 0700 directory).
  - A record is stale only when its pid is dead and the Root's flock is free. A live pid, or a
    flock held by a surviving native process, is refused. A live but unreachable host is refused,
    never killed.
- **Platform services come through `HostPlatform` adapters:** secret store, browser opener,
  embedding port, notifier, indexer port, explicit data root. No runtime `electron` imports.
- **CLI retrieval** originally defaulted to FTS5 BM25 + trigram + grep, using vectors only when
  the desktop had built them. ADR-0026 since made the core tools read the disk and the index an
  optional lane, and the retrieval decision (BST-2428) removed that lane on 2026-11-01.

### Standalone model and credential selection (approved 2026-10-08)

- A new headless host accepts an explicit stateless `--model` from the canonical model registry.
  Core captures it as run intent. It does not read Desktop's enabled-model setting or add a
  settings writer.
- An attached CLI keeps the existing host's admission authority; unsupported selections refuse
  without substitution.
- A credential backend is chosen only via trusted startup arguments; the keyring service or
  absolute file path must be explicit. Both shells share one credential facade and file format.
  Credential values never enter the host record or run intent.

### Host thread workspace binding

- Bindings live in the Core thread log through `thread/workspace/binding/read` and
  `thread/workspace/binding/update`, committed as `workspace.binding.updated` (operating root,
  checkout and secondary-root metadata).
- One host owner per thread; no shadow row, table, identity or backfill. See the
  [state store](../agents/state-store.md) for current storage ownership.
- Switching a checkout to Local clears branch, worktree and local-return hints in the same commit.
- The platform validates scope changes before committing.
- Each admitted run captures the binding in its run snapshot. Recovery, asynchronous selection,
  cached interaction responses and effect dispatch revalidate that capture; later bindings do not
  replace it.
- `roots.id` and `brainstrike_worktrees.id` are authority; saved paths and view state are not.
  Missing capabilities refuse.

### Persisted MCP authority and explicit host stop (approved 2026-10-07)

- **MCP authority:**
  - The configured-server owner supplies a versioned, immutable, non-secret description; Core
    captures it in the run snapshot keyed by admitted tool IDs.
  - Reconstruction compares the capture before rebuilding the binding or accepting an approval.
    Missing capture refuses.
  - Private arguments, environment, headers, credentials and unproven OAuth/bearer principals are
    not hashed or compared; they remain visible restart capability gaps.
- **`host/stop {}`** (authenticated) uses the lease lifecycle.
  - Success means Core, platform and native work joined, SQLite closed, the host record removed
    and the Root released.
  - The transport stays open only to write the response; the host's `closed` Promise joins the
    final socket close.
  - Failed cleanup reports an error and keeps the Root. No durable thread command, no PID-kill
    fallback.

### Native processes hold the Root

Amended 2026-10-09. Since `d18fa2ec4` the host runs `executeCommand`, so a SIGKILLed host could
leave a command running (reparented to pid 1) while a contender took the Root. An flock(2)
belongs to its open file description, so a descendant that inherits it keeps the lock after its
parent dies.

- **POSIX:** the Root is also an exclusive flock on `<dataRoot>/lock/root.flock`, taken right
  after a generation is claimed (`tryExclusiveFlock` in `secure-fs-native`). A claim that finds
  it held is withdrawn and names the owner of the surviving process.
- **All native children start via `spawnNativeChild`**, which passes the Root's descriptor as an
  extra stdio slot. A host that released its Root refuses further spawns.
- **Desktop Main supervises** its host's native processes: the host reports pid, start time and
  process group; on unexpected utility exit Main sends SIGTERM, then SIGKILL after 2,000 ms.
  Main's lease close succeeds once those groups are gone; it takes no hold of the Root (amended
  2026-11-11, below).
- **A CLI host has no supervisor:** surviving native processes keep the Root refused until they
  exit.
- **Windows** has no inheritable lock; the host joins a kill-on-close Job Object
  (`windows-job-native` `initialize()`) before starting any native process.
- **Known gaps** (processes that do not hold the flock; Main's registry ends them after the host
  dies):
  - descendants that close inherited descriptors or double-fork (a double fork also escapes the
    process group);
  - command sessions (node-pty duplicates only the pty into fds 0–2; SIGHUP on hang-up);
  - stdio MCP servers (`StdioClientTransport` uses `[pipe, pipe, stderr]`; stdin reaches EOF);
  - short `execFile` calls (git) and ripgrep searches, otherwise bounded by their own
    timeouts.

**Amendment (Sean, 2026-11-11, BST-2477).** Main no longer probes the Root's flock when it
closes a lost or finished host. The probe took the flock and released it at once, so it was
itself a hold: a next owner that took the Root at that instant was refused as `native-tail`,
naming the previous host although nothing it started survived, and a close that ran after the
next legitimate owner took the Root failed as though a native process still held it (merge queue
run 42926212906). The next owner's own `RootLock.acquire` is the one place that reports a
surviving native process: it finds the flock held, withdraws its claim and refuses the Root as
`native-tail`, naming the host that started it. Lost-host recovery, Factory Reset (its reset
lease is a `RootLock.acquire`) and the next launch all meet that refusal before they open or
delete anything under the Root.

## Consequences

- The acceptance suite runs through the protocol: over stdio with no Electron in the process
  tree, and over MessagePort in desktop E2E.
- CLI secrets use `@napi-rs/keyring`. Headless Linux without Secret Service fails visibly and
  needs `--credential-store file` (0600).
- Desktop secrets (owner decision 2026-10-28): `sealed-file`, the same private file with each
  value sealed by Main's `safeStorage` and lent to the host (ADR-0029). Per-secret keyring items
  made signed releases prompt for the keychain repeatedly.
- Windows needed a process start-time source for the lock; resolved (`GetProcessTimes` in
  `packages/state-store/src/lock.ts`).
- A host forked by the app dies with the app. A CLI-started host exits when its last client
  leaves and no run is active, unless started with `brainstrike host start`.
- MCP App UI is a client capability; the CLI shows the tool-result text and points to the desktop
  app.

## Sources

- BST-1941 (discovery and data-root lease), BST-1942 (host process and protocol), BST-1943
  (`HostPlatform` adapters), BST-1944 (CLI v1), BST-1945 (parity and attach), BST-1946 (CLI
  retrieval).
- The architecture reset report (2026-10-01): "Where the loop runs" and P4.
