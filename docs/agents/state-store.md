# Canonical SQLite state

Decisions: [ADR-0011](../adr/0011-run-log-and-state-store.md), [ADR-0020](../adr/0020-greenfield-data-lifecycle.md).
Implementation: `packages/state-store` and `packages/agent-host`.

## Writer and durability

- StateStore has one serialized writer.
  - Core commits accepted commands, run events, decisions, usage, workspace metadata and their atomic projections through it.
  - Renderer state and derived indexes are readers or projections, never extra durable owners.
  - Acknowledgement means the transaction committed under the existing WAL/durability policy, not that it was queued or copied to UI state.
- Keep parameterized statements, runtime row decoding and bounded public reads. Keep canonical IDs and append order across reopen and replay.
- Current-schema creation and populated same-schema recovery are required; legacy conversion is not.
- Read-only metadata inspection never stamps versions or runs DDL.
- Corruption refuses or contains reads; it never deletes or replaces canonical data.
  - A state DB that fails `integrity_check` opens read-only and `health()` names the failure.
  - The host serves it as `state/health/read`. Desktop's damaged-store notice reads it and offers a re-read and a host restart (which reopens and rechecks the store). Neither changes the damaged file.
  - Writes are refusals, not failures: the store raises `StateStoreReadOnlyError` (a thread refusal carries `storeDamage`) and the host sends both as the typed `state.read-only` refusal, so startup writers stop quietly.
- `state-deletion.ts` orchestrates purge, thread delete and blob GC over the writer's `deletion-domain.mjs` ops, its derived index and its write chain.
- Settings the host serves as catalog domains (e.g. the search index config, `index/config` through `host/index-config`) are rows of the same writer; catalog endpoints borrow it and never form a second store.

## Memory calculation

- Mastra memory calculation never runs on the writer thread.
  - The store starts the worker (`memory-calculator-worker.mjs`) when it opens and never awaits it, so neither open nor the first send waits for its 1-2 s module load. It stops at close, Clear and reset.
  - The worker only calculates: it opens no database and writes nothing.
- StateStore reads the input, the worker returns a delta, and the delta commits on the writer's write chain only if the resource's revision is unchanged since the read.
- One resource's memory mutations run one at a time; appends and other resources continue.
  - Purge, thread deletion and their replay enter the lanes of the thread's resources first, so earlier memory work commits first and later work reads what they leave.
- A conflict, crash or module load failure fails that request visibly (`MemoryCalculatorError` for the worker). No retry, no fallback to the writer; the next request starts a fresh worker.
- Without `memoryCalculatorModule`, native requests are refused.

## Root and content identity

- The root lease supplies writer authority through acquisition, admitted work and physical close.
  - Keep PID/start/generation checks and OS lock ownership; neither a saved path nor an attachment can take over a live owner.
- Root records and thread bindings carry real canonical identity; mount descriptors and UI choices are projections.
- A data root's identity is `canonicalRoot`, the OS realpath (`fs.realpathSync.native`).
  - The lock records it, and every check that a lock, profile or reset target is that root derives it the same way.
  - Node's JS `realpathSync` can keep another case or an 8.3 short name, so a second derivation would refuse a launcher's own host on Windows.
- A workspace root record carries the folder's grant-time identity (`roots.canonical_path`) and its place among the open folders (`roots.open_position`; NULL is a removed folder kept for its identity).
  - The agent host's root registry is their only writer.
  - `register` refuses a recorded path that now resolves to another folder unless the person picked it afresh (`repin`).
  - Greenfield: these columns are part of the current schema, not an upgrade step.
- Content-addressed blobs store canonical edit baselines and current-format content through their existing owner.
  - Hashes and scope must match the bytes; a transient cache or derived embedding never becomes a source of truth.
  - Delete and purge join referencing work before collecting blobs and canonical records.

## Deletion, reset and interchange

- Keep transaction scope and referential integrity for thread, subtree and root removal.
- Derived index cleanup is a separately joined resource. It must not race late canonical writes or turn a root deletion into whole-profile retirement.
- Failures keep the owner and the data needed for retry.
- Clear and Factory Reset use the existing profile barrier and reset lease; consumers stop writes and retire durable view references before content is destroyed.
- The store has no export or import. Unsupported developer data is never silently converted, repaired or deleted.
