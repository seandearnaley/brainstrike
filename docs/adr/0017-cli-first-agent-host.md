# ADR-0017: A CLI-first agent host; the GUI is a client

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914; implementation BST-1941 to BST-1946

## Context

The reset report placed the agent host in Electron main first, moving it to a utility
process after v0.1. The owner then required the agent to run headless as well. A host
tied to Electron cannot serve a CLI, and comparable products run one long-lived host
with every UI as a client: the Codex app-server and VS Code's Agent Host Protocol are
the named peers. Doing it from M3 costs about two to three more weeks.

## Decision

- The agent runs entirely in one Electron-free Node host process, `brainstrike-host`.
  Desktop main starts it with `utilityProcess.fork` and bridges MessagePorts; the CLI
  starts the same bundle under plain Node. Electron main is a launcher and a provider
  of platform capabilities, not the host.
- Clients attach over JSON-RPC 2.0 (`vscode-jsonrpc`), one schema over stdio, a local
  socket or Windows named pipe, or an Electron MessagePort. `initialize` carries a
  32-byte token, compared in constant time, and negotiates the protocol version.
  `log/subscribe {threadId, fromSeq}` replays, then follows, publishing only after
  commit. Approvals, questions, plans and elicitation are log events any client can
  answer.
- One host per data root. The host takes the data-root lock and writes
  `<dataRoot>/host.json` (pid, start time, endpoint, token, protocol and host
  versions; mode 0600 in a 0700 directory). A record is stale only when its pid is
  dead AND the Root's flock is free, and only a stale record is taken over. A live
  pid, or a held flock from a surviving native process, is refused; a live but
  unreachable host is refused by pid and never killed. See "Native processes hold
  the Root" below.
- Platform services come through `HostPlatform` adapters: secret store (keyring),
  browser opener, embedding port, notifier, indexer port and an explicit data root.
  The host bundle has no runtime `electron` imports.
- CLI retrieval defaults to FTS5 BM25 plus trigram plus grep. It uses vectors only
  when the desktop indexer already built them for that root and a query embedder is
  available.

### Standalone model and credential selection

The M3 owner approved explicit stateless `--model` selection against the existing
canonical model registry for a newly started headless host on 8 October 2026.
Core captures the immutable run intent in its existing log. This client policy
does not infer Desktop Main's persisted enabled-model setting or create another
settings writer. An attached CLI retains the existing host's admission authority;
unsupported selections refuse without substitution.

An explicit credential backend selection travels only through trusted process
startup arguments to the platform factory. The keyring service or absolute file
path must be supplied explicitly; no namespace or fallback is inferred. Both
shells reuse the same serialized credential facade and private native file
implementation, retaining their existing account names and file shape. Selection
does not store credential values in the host record or run intent.

### Host thread workspace binding

Host-owned thread bindings use the existing Core thread log and durable command
identities, through `thread/workspace/binding/read` and
`thread/workspace/binding/update`. `workspace.binding.updated` stores the merged
existing operating-root, checkout, secondary-root and Forge metadata keys.
The transitional legacy-thread writer is not a supported old-data route under
[ADR-0020](0020-greenfield-data-lifecycle.md). At adoption, its removal was assigned
to the M4 integration branch. Current development branches from `main`; the
[database contract](../agents/database.md) describes current storage ownership.
Current-schema threads have one host owner, with no shadow history row, new table,
identity or backfill. Checkout transitions borrow the existing atomic metadata
projection; switching to Local removes prior branch,
worktree and local-return hints in the same commit.

The live platform validates scope changes before committing them. Each admitted
run captures the Core-owned binding in its existing run snapshot, and recovery
revalidates that capture against the current owners. The same capture is checked
after asynchronous selection, for cached interaction responses, and before effect
dispatch after the live permission read. Later thread bindings do not replace it. `roots.id` and
`brainstrike_worktrees.id` are authority; saved paths and workspace view state
are not. Missing live capabilities refuse. This protocol prerequisite does not
qualify Desktop catalog/worktree, pinned-mount or GUI acceptance by itself.

### Persisted MCP authority and explicit host shutdown

Sean approved the persisted-authority proposal on 7 October 2026 after the real
A-to-B pending-approval restart incident. The existing configured-server owner
supplies a versioned immutable non-secret description; Core captures it in the
existing run snapshot, keyed by the existing admitted tool IDs. Reconstruction
compares that capture before constructing the replacement binding or accepting
approval. No second store, writer, identity, alias or backfill is introduced.
Missing required current-format capture refuses explicitly. Private arguments,
environment, headers, destination credentials and unproved OAuth/bearer principals have no
secret hash or surrogate comparison; they remain visible restart capability
gaps. Existing bearer credential record IDs can detect replacement but cannot
prove the principal remained unchanged when their private values were edited.

Authenticated `host/stop {}` uses the sole lease lifecycle. Success means Core,
platform and native tails joined, SQLite closed, the host record was removed and
Root released. The requesting transport remains only through the actual JSON-RPC
response write; the host's `closed` Promise also joins its final socket/server
close. Failed cleanup reports an error and retains Root. This lifecycle operation
creates no durable thread command and does not use a PID-kill fallback.

### Native processes hold the Root

Amended 9 October 2026. Since `d18fa2ec4` the host itself runs `executeCommand`, so a
command's parent is the host. In the ordinary utility-loss case a SIGKILLed utility
left its command running, reparented to pid 1. The lock judged only the record's
pid, so a contender took the Root while that command still ran, and nothing ended
the command. An OS check showed the primitive that fits: an flock(2) belongs to its
open file description, so a descendant that inherited the descriptor keeps it after
its holder is SIGKILLed, and it frees when the last such process exits.

- On POSIX the Root is also an exclusive flock on `<dataRoot>/lock/root.flock`, taken
  right after a generation is claimed (`tryExclusiveFlock` in `secure-fs-native`).
  A claim that finds it held is withdrawn, so the earlier record stays newest, and
  the refusal names that owner as having started the surviving process.
- Every native process the host starts goes through one helper,
  `spawnNativeChild`, which passes the Root's descriptor as an extra stdio slot.
  A host whose Root was released refuses further spawns.
- Desktop Main supervises its host's native processes. The host reports each
  process's pid, start time and process group over the platform connection. When
  the utility exits unexpectedly, Main sends SIGTERM to each live group, then
  SIGKILL after the executor's own 2,000 ms grace. Main's lease close succeeds only
  after those groups are gone and the Root's flock is free.
- A CLI-started host has no supervisor: its surviving native processes keep the
  Root refused until they exit.
- Windows has no inheritable lock. The host puts itself in a kill-on-close Job
  Object (`windows-job-native` `initialize()`) before it starts any native process,
  so its native processes end with it.

Known limits. These processes do not hold the Root's flock.

- A descendant that closes its inherited descriptors (`closefrom`, or a
  daemon-style double fork) no longer holds the Root. A double fork also leaves
  its process group, so nothing ends it.
- Command sessions: node-pty 1.1.0 spawns with `POSIX_SPAWN_CLOEXEC_DEFAULT` and
  duplicates only the pty into fds 0-2 (`node-pty/src/unix/pty.cc` lines 703-750).
  Main's registry ends each session's group after the host dies, and the pty hangs
  up (SIGHUP).
- stdio MCP servers: the SDK's `StdioClientTransport` spawns with stdio
  `[pipe, pipe, stderr]` (`@modelcontextprotocol/client` 2.1.0, `dist/stdio.mjs`
  lines 79-83). Main's registry ends each server after the host dies, and its stdin
  reaches EOF.
- Short `execFile` calls (git, ripgrep): `execFile` takes no stdio option. Main's
  registry ends them after the host dies; their own timeouts bound them otherwise.

## Consequences

- ADR-0007 is worded by thread, not process: inference never runs on a thread that
  serves the UI, the run log or the client protocol.
- The acceptance suite runs through the protocol: over stdio with no Electron in the
  process tree, and over MessagePort in desktop E2E.
- The secret store is `@napi-rs/keyring` in both shells. Headless Linux with no Secret
  Service fails visibly and requires `--credential-store file` (0600).
- Windows needs a process start-time source for the lock; that blocks M3.
- A host forked by the app dies with the app. A CLI-started host exits when its last
  client leaves and no run is active, unless started with `brainstrike host start`.
- New threads bypass today's HTTP assistant server. MCP App UI is a client
  capability; the CLI shows the tool-result text and points to the desktop app.

## Sources

- BST-1941 (discovery and data-root lease), BST-1942 (host process and protocol),
  BST-1943 (`HostPlatform` adapters), BST-1944 (CLI v1), BST-1945 (parity and
  attach), BST-1946 (CLI retrieval).
- The architecture reset report (2026-10-01): "Where the loop runs" and P4.
