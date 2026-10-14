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

## Root and content identity

The root lease supplies writer authority through acquisition, admitted work and
physical close. Preserve PID/start/generation checks and OS lock ownership; neither
a saved path nor an attachment can take over a live owner. Root records and thread
bindings carry actual canonical identity, while mount descriptors and UI choices
are projections.

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
Export/import validate the supported current format and retain canonical identity
and authority constraints; unsupported developer data is not silently converted,
repaired or deleted.

Decisions: [ADR-0011](../adr/0011-run-log-and-state-store.md) and
[ADR-0020](../adr/0020-greenfield-data-lifecycle.md).
Implementation: `packages/state-store` and `packages/agent-host`.
