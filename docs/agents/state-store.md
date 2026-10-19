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
checks itself again (BST-1880). Neither changes the damaged file. Its writes are
refusals, not failures: the store raises `StateStoreReadOnlyError` (a thread
refusal carries `storeDamage`), and the host sends both as the typed
`state.read-only` refusal, so callers that write on startup stop quietly
(BST-2144).

The browser writer (`@brainstrike/web-state-store`, ADR-0011's 2026-10-15
amendment) runs the same `schema.mjs`, `run-log.mjs`, `catalog-domains.mjs`,
`state-truth-reader.ts` and their imports on sqlite-wasm. Keep those modules free of static Node imports; reach a Node-only
fast path through `process.getBuiltinModule`, as the run-log crc does.
Purge, thread delete and blob GC are shared the same way: `state-deletion.ts`
orchestrates them over a writer's `deletion-domain.mjs` ops, its derived index
and its write chain. `__tests__/portable-modules.test.ts` bundles every shared
module for the browser.

The web app's writer worker (`@brainstrike/web-writer`) composes the derived
index beside the state DB as a writer extension, in the same pool and under the
same lease. Extension ids are part of the wire protocol, so tabs of builds that
compose different extensions refuse each other's writer. The index's projection
identity names the app build in place of desktop's producer-source hash; a tab
without a build is refused, whether it would lead or follow, and the index
rebuilds from the log when the build changes.
The browser writer runs `StateDeletion` with the derived index as its
`IndexerPort`: `purge` and `deleteThread` are writer ops, and no tab unlinks a
blob directly. Without the derived index both are refused, as on desktop.
It serves the source catalog and workspace roots on desktop's domains too, with
desktop's rules: a source change or root deletion needs the derived index, and
the sources it retires are collected after. A browser root's path is its handle
key, `/fsa/<rootId>` (`webRootPath`), an absolute POSIX path so the shared
workspace path rules treat it as a root, and registration refuses a key that names
another root; the tab keeps the File System Access handle in IndexedDB under
that id. The root domain is given the host's notion of a
granted path, so desktop keeps requiring absolute OS paths.
After each committed append the writer announces every thread's new sequence
numbers to every tab, the appending one too (`WebStateStore.subscribeLog`);
a live reader of a thread reads the rows it hears of, and no tab polls the log.

The file index (`fileIndexExtension`) is a worker the writer starts on the lease
holder, with the scoped store in its own pool, `<pool>--files`
(`webStateExtensionPool`), which factory reset sweeps with the store's. It
serves desktop's `ScopedIndexerPort` as `files.*` ops, authorized for the
catalogs' live roots, collections and their files when it opens (an import in
no collection has no scope and is left out); `files.reauthorize` reopens it
after they change. Its ops are `concurrent`: they run outside the writer's
request order, so a chat append never waits behind index work.
`files.scan({ rootId, folder })` runs desktop's workspace ingestion runtime in
the worker (`file-ingestion.ts`): the shared catalog, publication, scan
admission and inventory over a File System Access lease. The tab hands over the
folder it holds the user's grant for (a grant is asked for in a window, never in
a worker); the worker reaches the catalogs through `WebStateWriterContext.request`,
in the writer's request order. A root keeps the folder its runtime started on. Retirement waits for it to
release its pool. A coded failure crosses the wire with its code, so
`WebFileIndex` raises desktop's `IndexerError`.

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
