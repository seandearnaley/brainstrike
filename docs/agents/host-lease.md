# Host lease

## Exclusive owner

One lease owns a data root across desktop, CLI and native descendants. Root path,
PID and OS start identity identify the generation; PID alone is insufficient.
An OS-backed lock protects ownership across process loss. A live but unreachable
owner is refused, never killed, replaced or guessed stale.

Keep discovery and credential records private with owner-only permissions. Validate
record shape, path, generation and process identity before attachment. Public
clients receive the authenticated host protocol, not desktop-private platform
credentials or capabilities. Authentication failure does not start another owner.

## Attachment and lifetime

Register startup/exit listeners before awaited acquisition. A desktop manager owns
only hosts it forks; closing an attachment to a CLI/external host cannot signal
that owner. Electron stays in the adapter, not the shared lease package.

An app-owned host closes when its parent process identity disappears. An ordinary
CLI host closes after its last client and active run lease leave; explicit persistent
start has a different lifetime. Startup without attachment follows the existing
bounded owner policy. Cooperative close fences admission, joins Core/platform/native
tails and SQLite, then removes discovery and releases Root. The requesting
transport remains through its actual response write and final socket join.

Native descendants retain the appropriate POSIX lock or Windows Job ownership.
Do not substitute a closed transport, a process record deletion or a parent exit
for physical retirement. Failed cleanup retains the lock/owner and remains an
error across repeated close calls.

## Destructive reset

Join every profile writer before acquiring its reset lease. A live external CLI
owner refuses reset; client detach does not release it. Hold the accessible guard
through profile, userData and storage purge. Preserve the lock namespace and its
ancestors. Release only after the destructive phase succeeds; failure keeps the
same owner for retry. Coordination residue is ownership metadata, not application
data or a new persistent namespace.

Decision: [ADR-0017](../adr/0017-cli-first-agent-host.md).
Implementation: `packages/host-lease` and desktop acquisition/reset adapters.
