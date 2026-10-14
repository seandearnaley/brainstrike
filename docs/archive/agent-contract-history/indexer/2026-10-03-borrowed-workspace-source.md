# Borrowed workspace source ownership

Workspace ingestion borrows narrow operations from the same pinned main mount,
shares existing traversal and scheduling policy, and joins physical retirement.

The source port exports `CanonicalWorkspaceLease`, `CanonicalSourceInventoryPort`
and `CanonicalWorkspaceSourceDependencies` from canonical ingestion. Composition
supplies actual PG inventory and a lease backed by `WorkspaceRootRegistry`'s
existing native mount. SecureRoot never crosses the process boundary or gets
reconstructed from a canonical path. Signals remain local; transport adapters
project generation and explicit cancellation through their existing protocol.
Borrow close releases only the borrow's admitted operations and subscription.

The Node-only secure read leaf moves the existing result/error mapping, accepts
Uint8Array output and forwards a caller's smaller byte bound. Native listing stat
is preserved; the native read API does not provide fstat. Only missing listing
size uses the existing UTF16 content.length behavior after reading. Existing NUL,
binary and inaccessible-content gates still run before canonical preparation.

The portable scan extraction retains full/scoped discovery, path normalization,
truncation reporting and removal inference. Browser app-shell modules wrap those
shared implementations; canonical source matches actual catalog identities by
root/path and emits unresolved metadata without minting IDs. Retained collections
do not borrow a root and preserve nullable identities.

`CanonicalWorkspaceIngestionRuntime` reuses the existing indexing coordinator.
Watch changes arrive from the one main Parcel producer and its existing batcher.
Native watch passes enumerate the full affected root, force reads for changed
nonremoved file paths and retain the native-covered unchanged stat shortcut.
Full scan readiness remains the existing complete writer manifest predicate.

The async Parcel disposer fences callback and queued-stat admission immediately,
then joins actual unsubscribe and admitted stats. Failure retains retry ownership.
Late acquisition after a subscribe timeout is also joined. If late unsubscribe
fails before a disposer can be returned, `ParcelWatchRetirementError` carries
`retire()` for the main watch owner to retain and explicitly retry. Successful
retirement is idempotent; failed retirement does not release the mount.

Paired tests cover bounded discovery, real identities, truncated retention,
held read/listing retirement, revocation, late subscription acquisition and
failed unsubscribe retry. The child proof imports built public packages in plain
Node with no source aliases or renderer globals. Parent owns one real native root
and Parcel subscription; child owns actual discovery/coalescing/parser/publication
orchestration. Catalog and publication persistence ports are controlled fixtures.
It checks canonical recording parity, real changes/deletion, ignored traversal,
unchanged survivor skips, symlink and binary refusal, held native-read
acknowledgement joining, shared root survival, watch unsubscribe and child exit.
Native truncation uses an explicit fixture authority cap of one inspected entry.
This is source/process qualification, not actual PG/native writer or full desktop
application acceptance.

## Late acquisition rejection correction

Independent review of the source delivery found that a timed-out subscribe which
later rejected was wrapped as a cleanup failure. Its retry closure chained onto
that same permanently rejected acquisition, despite there being no acquired
subscription. The false owner could prevent a mount from retiring forever.

Startup now distinguishes rejected acquisition from acquired subscription cleanup.
Rejected acquisition joins admitted event work, then reports both the original
timeout and late acquisition error in an AggregateError with no unsubscribe retry
owner. A successful late acquisition whose unsubscribe fails still reports
`ParcelWatchRetirementError` retaining that actual subscription and its explicit
idempotent cleanup retry. Public exports and signatures are unchanged.

The paired fake-time regression holds an admitted event stat across timeout and
late acquisition rejection. It requires startup to remain pending until that stat
settles, preserves both startup errors and refuses a fabricated cleanup owner.
The original delivery fails before joining the stat; the corrected behavior and
existing genuine unsubscribe failure/retry cases pass.
