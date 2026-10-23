# @brainstrike/vector-management

Shared search-embedder composition and indexing-activity status for the
renderer. It observes existing owners; it does not run local inference or own
canonical persistence.

- `SearchEmbedderProvider` / `useSharedSearchEmbedder` share one cached
  `SearchEmbedder` per window across every semantic-search surface, with
  WebGPU device-loss recovery. The provider throws when it is absent rather than
  creating a private embedder.
- `IndexingActivityCoordinator` mirrors Main's index config and the workspace
  sync status into the indexing-activity store.
- `EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS` names the status extension the
  embedding host reports through the shared runtime store.

Exports and scripts live in [`package.json`](package.json) and
[`index.ts`](src/index.ts). See [inference](../../docs/agents/local-inference.md)
and [indexing](../../docs/agents/indexer.md) contracts.
