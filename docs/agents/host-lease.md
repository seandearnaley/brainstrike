# Host lease

## Exclusive owner

One lease owns a data root across desktop, CLI and native descendants. Root path,
PID and OS start identity identify the generation; PID alone is insufficient.
An OS-backed lock protects ownership across process loss. A live but unreachable
owner is refused, never killed, replaced or guessed stale. A starting or exiting
owner is waited for under the launch's one deadline: a refused attach, or a race
whose winner releases, waits for that owner to give up the root and acquires
again. Only an owner that keeps the root to the deadline is refused (BST-2142).
A leaving owner is recognized by code, never by message: the closing refusal
crosses the wire as `host-lease.host-closing`, and a lost handshake connection as
`host-lease.connection-closed` (BST-2158). Changing a frame's shape bumps
`PROTOCOL_VERSION`.

Keep discovery and credential records private with owner-only permissions. Validate
record shape, path, generation and process identity before attachment. Public
clients receive the authenticated host protocol, not desktop-private platform
credentials or capabilities. Authentication failure does not start another owner.

## Attachment and lifetime

Register startup/exit listeners before awaited acquisition. A desktop manager owns
only hosts it forks; closing an attachment to a CLI/external host cannot signal
that owner. Electron stays in the adapter, not the shared lease package.

A launch owns the host its starter started until it settles it (BST-2167): an
attachment releases it to its lifetime; a failed attach, a startup deadline, or
a host that left on its own retires it before the launch rejects or acquires
again. The deadline aborts the starter and waits for it to settle. The Node
starter retires with `cancel-startup`, then SIGKILL (the group of a detached
host) if the host has not exited within its cancel-exit bound, and a forced
kill is an error, never a clean retirement.

Three bounds govern a launch (BST-2176):

- **Startup, 30 s** (`startupTimeoutMs`): acquisition. It covers waiting for a
  starting or leaving owner, attaching to an existing owner or a race's winner,
  and starting a host until its starter reports ready. The Node starter's
  readiness deadline, `HOST_STARTER_READY_TIMEOUT_MS`, is also 30 s.
- **Self-started attach, 1.5 s** (`attachTimeoutMs`): fixed when the starter
  reports ready. It bounds that host's record read, handshake and any wait for
  it to leave, and is never clipped by what the startup deadline has left. Only
  the host its starter named gets it: the starter reads that host's PID and OS
  start time at ready, and an owner that replaced it is attached like any other
  once the launch has retired its own host. Any other attach gets the same
  budget, clipped to the startup deadline. A
  self-started launch settles within startup plus attach, plus joining the exit
  of a host it retires.
- **Cancel exit, 10 s** (`HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS`): how long a
  cancelled or retired Node host has to exit before SIGKILL. A longer readiness
  deadline never lengthens it; the starter's `readyTimeoutMs` test seam narrows
  both.

An app-owned host closes when its parent process identity disappears. An ordinary
CLI host closes after its last client and active run lease leave; explicit persistent
start has a different lifetime. Startup without attachment follows the existing
bounded owner policy. Cooperative close fences admission, joins Core/platform/native
tails and SQLite, then removes discovery and releases Root. The requesting
transport remains through its actual response write and final socket join.

POSIX children that inherit Root's descriptor retain its flock; PTY sessions,
SDK stdio MCP servers and short `execFile` calls do not inherit it. Desktop's
registry supervises those processes; a CLI host has no desktop supervisor.
Closing inherited descriptors loses flock protection; a daemon that also leaves
its process group escapes group retirement. Windows uses kill-on-close Job
ownership. See
[ADR-0017's native-process limits](../adr/0017-cli-first-agent-host.md#native-processes-hold-the-root).
A closed transport, deleted record or parent exit does not prove physical
retirement. Failed cleanup retains ownership and remains an error on repeat close.

## Destructive reset

Join every profile writer before acquiring its reset lease. A live external CLI
owner refuses reset; client detach does not release it. Hold the accessible guard
through profile, userData and storage purge. Preserve the lock namespace and its
ancestors. Release only after the destructive phase succeeds; failure keeps the
same owner for retry. Coordination residue is ownership metadata, not application
data or a new persistent namespace.

Decision: [ADR-0017](../adr/0017-cli-first-agent-host.md).
Implementation: `packages/host-lease` and desktop acquisition/reset adapters.
