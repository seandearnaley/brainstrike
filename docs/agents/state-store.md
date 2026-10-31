# Canonical SQLite state

## Writer and durability

StateStore has one serialized writer. Core commits accepted commands, run events,
decisions, usage, workspace metadata and their atomic projections through it.
Renderer state and derived indexes are readers/projections, not additional durable
owners. Acknowledgement means the transaction committed with the existing SQLite
WAL/durability policy, not merely queued or copied to UI state.

Keep parameterized statements, runtime row decoding and bounded public reads.
Preserve canonical IDs and append ordering across reopen/replay. Current schema
creation and populated same-schema recovery are required; legacy conversion is
not. Read-only metadata inspection must not stamp versions or perform DDL.
Corruption refuses or contains reads without deleting/replacing canonical data.
A state DB that fails `integrity_check` opens read-only, and `health()` names the
failure. The host serves it as `state/health/read`; desktop's damaged-store notice
reads it and offers a re-read and a host restart, which reopens the store so it
checks itself again. Neither changes the damaged file. Its writes are
refusals, not failures: the store raises `StateStoreReadOnlyError` (a thread
refusal carries `storeDamage`), and the host sends both as the typed
`state.read-only` refusal, so callers that write on startup stop quietly.

Purge, thread delete and blob GC: `state-deletion.ts` orchestrates them over the
writer's `deletion-domain.mjs` ops, its derived index and its write chain.

Settings the host serves as catalog domains (for example the search index config,
`index/config` through `host/index-config`) are rows of the same writer; the
catalog endpoints borrow it and are never a second store.

## Root and content identity

The root lease supplies writer authority through acquisition, admitted work and
physical close. Preserve PID/start/generation checks and OS lock ownership; neither
a saved path nor an attachment can take over a live owner. Root records and thread
bindings carry actual canonical identity, while mount descriptors and UI choices
are projections. A data root's identity is `canonicalRoot`: the OS's own realpath
(`fs.realpathSync.native`). The lock records it, and every check that a lock,
profile or reset target is that root derives it there. Node's JS `realpathSync`
keeps another case or an 8.3 short name, so a second derivation refused a
launcher's own host on Windows.

Content-addressed blobs store canonical edit baselines and current-format content
through their existing owner. Hashes and scope must match the bytes; a transient
cache or derived embedding does not become another source of truth. Delete/purge
joins referencing work before collecting blobs and canonical records.

## Deletion, reset and interchange

Preserve transaction scope and referential integrity for thread/subtree/root
removal. Derived index cleanup is a separately joined resource; it must not race
late canonical writes or turn a root deletion into whole-profile retirement.
Failures retain the owner and data needed for retry.

Clear and Factory Reset use the existing profile barrier/reset lease; consumers
must stop writes and retire durable view references before content destruction.
The store has no export or import; unsupported developer data is not silently
converted, repaired or deleted.

Decisions: [ADR-0011](../adr/0011-run-log-and-state-store.md) and
[ADR-0020](../adr/0020-greenfield-data-lifecycle.md).
Implementation: `packages/state-store` and `packages/agent-host`.
