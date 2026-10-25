# Host lease

## Exclusive owner

One lease owns a data root across desktop, CLI and native descendants. Root path,
PID and OS start identity identify the generation; PID alone is insufficient.
An OS-backed lock protects ownership across process loss. A live but unreachable
owner a launch did not start is refused, never killed, replaced or guessed stale.
A starting or exiting owner is waited for under the launch's one deadline: a
refused attach, or a race whose winner releases, waits for that owner to give up
the root and acquires again. Only an owner that keeps the root to the deadline is
refused (BST-2142).
A leaving owner is recognized by code, never by message: the closing refusal
crosses the wire as `host-lease.host-closing`, and a lost handshake connection as
`host-lease.connection-closed` (BST-2158). Changing a frame's shape bumps
`PROTOCOL_VERSION`.

Keep discovery and credential records private with owner-only permissions. On
Windows, host start sets the data root's private owner and DACL natively
(`secure-fs-native`), on one directory handle, and every check of an owner a
launch did not start verifies them the same way; neither starts a process, and a
failed check fails the launch (BST-2237). A launch never re-reads or re-verifies
the host it started: that host's ready report carries its record. An elevated
Windows token defaults new objects' owner to `BUILTIN\Administrators`. So every
Windows process entry that can create host-lease or state-store objects first
imports `@brainstrike/secure-fs-native/default-owner`, which makes the user the
process's default owner. Administrators is never accepted as an owner, and an
existing root another principal owns is still refused (BST-2246; the entry list
is in `scripts/__tests__/windows-default-owner-entry-contract.test.mjs`). Validate
record shape, path, generation and process identity before attachment. Public
clients receive the authenticated host protocol, not desktop-private platform
credentials or capabilities. Authentication failure does not start another owner.

## Attachment and lifetime

Register startup/exit listeners before awaited acquisition. A desktop manager owns
only hosts it forks; closing an attachment to a CLI/external host cannot signal
that owner. Electron stays in the adapter, not the shared lease package.

A launch owns the host its starter started until it settles it (BST-2167): an
attachment releases it to its lifetime; a failed attach, or a host that left on
its own, retires it before the launch rejects or acquires again.

Readiness is a message, and liveness is an exit (lifecycle R2, R3). A started
host reports `ready` on its private parent channel, carrying its host record;
its starter checks that the record names the process it started (PID and OS
start time). The launch attaches from that record: no host.json read, root-lease
or DACL re-check, polling or deadline. A start ends only with the `ready` report,
a `failed` report, the host's exit, or its caller cancelling (quit during
startup). Main logs one warning, naming the stage it is waiting on, if no
`ready` arrives within 10 s; it never acts on it.

Desktop Main attaches its own host over the host's socket, from the ready
record, with no deadline; only the socket closing, the host's exit or the lease
closing ends that attach. The socket stays because Main's catalog client rides
the lease attachment, as a `public-socket` client: a private `desktop-ui` port
would widen what that client may call. Admission (`native-index-profile-admission.ts`)
is the one place that starts another host, once, after a failed start's release
is joined. The first window waits for neither the host nor the index.

The bounds that remain apply only to owners a launch did not start (R5(a), the
R2 exception: not ours to wait on):

- **Startup, 30 s** (`HOST_STARTUP_TIMEOUT_MS`, or `startupTimeoutMs`),
  measured from the launch's start: waiting for a starting or leaving owner, and
  the handshake with an existing owner or a race's winner; a live but unreachable
  owner is refused at it. The handshake has no tighter bound of its own: a loaded
  runner slows it 100-300 times, and a 1.5 s bound refused live CLI hosts. It never
  bounds the start or attach of the launch's own host.
- The caller's `signal` (quit) ends either wait at once with its own reason
  (BST-2279): quit has no deadline of its own to bound them (ADR-0026).
- **The Node (CLI) starter** keeps its own ladder, an R2 exception on the
  external CLI path this redesign did not convert: readiness 30 s
  (`HOST_STARTER_READY_TIMEOUT_MS`), then `cancel-startup`, then SIGKILL (the
  group of a detached host) if the host has not exited within the one close
  budget (`CHILD_CLOSE_BUDGET_MS`, ADR-0030). A forced kill is an error, never a
  clean retirement. It attaches the host it started over its socket under a
  startup bound measured from its ready report, and starts again if another owner
  replaced that host.

An app-owned host closes when its parent process identity disappears; it has no
startup grace, because Main's lifetime channel alone ties it to Main. An ordinary
CLI host closes after its last client and active run lease leave; explicit persistent
start has a different lifetime. A CLI host no client ever attached closes once its
startup grace has elapsed and no run lease is held, including a run it recovered on
start that releases after the grace. A client its launcher connects privately (a
port, not the socket) counts as attached like a socket client. Cooperative close fences admission, joins
Core/platform/native tails and SQLite, then removes discovery and releases Root.
The requesting transport remains through its actual response write and final socket
join.

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
