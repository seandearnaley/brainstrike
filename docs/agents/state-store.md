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
- Settings the host serves as catalog domains are rows of the same writer; catalog endpoints borrow it and never form a second store.

## Host state index

- The conversation search index (`packages/indexer`, `state-index.sqlite`) is a derived projection of committed state, never a second writer. The agent host runs it on a worker thread (`host-state-index-owner.ts`).
- Any stored schema but `INDEX_SCHEMA_VERSION` refuses as `rebuild-required`; the host owner destroys the file and rebuilds it from the state root.
- Liveness is the worker's exit, never a clock. A retired worker's exit is joined and the next request starts a new one; three consecutive replacements with none served stop it (`state-index.retired`).
- Catch-up sends bounded `catchUpStateStep` requests before a catch-up, rebuild or thread-scoped read. The worker projects at most one more step and otherwise refuses as `state-behind`, so no request carries a backlog.
- The only clock is the close window (ADR-0030 `closeMs`): a worker still running at its end gets one kill, and its exit is still joined.
- Close asks the index's writer thread to close, whether it is ready or still starting; a starting writer answers once it has opened its database. Close never terminates a starting writer: a thread terminated inside better-sqlite3's native initialisation aborts the whole host process, before the state DB is closed (BST-2472). Only the close window's kill still ends one.

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
  - State DB version 15 creates this table where it is missing. A `roots` table without `canonical_path` is dropped with its source catalog rows instead of inferring an identity, and the person opens those folders again; a table that has it keeps its rows.
- A project is a row of `projects` with an id of its own. `project_folders` says which project the folder at a canonical path belongs to (ADR-0034, owner decisions 2026-11-10).
  - The roots domain is their only writer. `register` gives a folder its project in the commit that records the folder, so the root registry stays the one owner, and a folder registered from version 16 on always has a project. A root record carries it as `projectId`.
  - A root recorded as a managed worktree has no project of its own (`projectId` is null): it is a checkout of its repository. A record's kind is set when the folder is first recorded, so a folder opened first and adopted as a worktree afterwards keeps the project it had. A reader that groups threads goes by the thread's checkout, not by this field.
  - A folder the person picks again where it now resolves (`repin`) keeps its project. The project's folder row moves with it. While another record still resolves to the old place, the new place joins the project as a second row instead. When the new place already has a project, the folder joins that one.
  - State DB version 16 creates both tables and writes no rows. A folder recorded before it has a null `projectId` until it is next registered. A launch registers each open folder it mounts; a folder that was removed, or cannot be mounted, stays without one.
  - A state DB that opens damaged is not upgraded, so one from before version 16 has neither table. Its folders are read with a null `projectId`.
  - Clear Database deletes both tables' rows with `roots`.
- A scratch folder is a folder the host made for a thread sent with no folder while none was open (ADR-0034 scratch threads). `scratch_folders` records each one with its thread (`path`, `thread_id`, `created_at`; one per thread), and its root's kind is `scratch`.
  - The roots domain is the only writer. `register-scratch` records the folder and its root in one commit; it refuses a folder already recorded (as a root or as a scratch folder) and a thread that has one. The root's kind comes from that record, so no other registration can make a root `scratch`. `forget-scratch` deletes both together.
  - A scratch root is live, never open (`open_position` NULL, also when `register` records it again at a launch) and has no project. `list-scratch` lists every one, for the registry's restore; `scratch-of-thread` reads a thread's.
  - State DB version 17 rebuilds `roots` with every row it holds (SQLite cannot widen its `kind` CHECK in place) and creates `scratch_folders`. A state DB that opens damaged is not upgraded, so one from before version 17 has no scratch folders, and `scratch-of-thread` probes for the table.
  - Clear Database deletes `scratch_folders` rows with `roots`. The folders themselves stay on disk under the profile, as worktrees do; Factory Reset deletes the profile.
- Content-addressed blobs store canonical edit baselines and current-format content through their existing owner.
  - Hashes and scope must match the bytes; a transient cache or derived embedding never becomes a source of truth.
  - Delete and purge join referencing work before collecting blobs and canonical records.

## Deletion, reset and interchange

- Keep transaction scope and referential integrity for thread, subtree and root removal.
- Derived index cleanup is a separately joined resource. It must not race late canonical writes or turn a root deletion into whole-profile retirement.
- Failures keep the owner and the data needed for retry.
- Clear and Factory Reset use the existing profile barrier and reset lease; consumers stop writes and retire durable view references before content is destroyed.
- The store has no export or import. Unsupported developer data is never silently converted, repaired or deleted.
