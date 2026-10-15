# @brainstrike/file-explorer-ui

Explorer composition, treegrid, file tabs and token-status UI.
It reuses core explorer state and shared UI rather than owning another selection,
content loader or virtualization system.

## Compose existing providers

The platform supplies `AdaptersProvider` with admitted filesystem/storage
capabilities. `FileExplorerProvider` owns its explorer store and receives a stable
storage adapter. Mount the shared `FileSystemProvider` once for consumers of the
UI's filesystem hook; a fallback instance would split root state.

Use the declared `/shell`, `/tree`, `/preview` and `/indexing` public subpaths.
Source props and the [`package.json`](package.json) export map define the exact
composition. A placeholder adapter expression or a newly constructed memory
store in each render is not a production persistence recipe.

## Slice contracts

- [Tree](src/tree/README.md): TreeTable row models, lazy loading and selection.
- [Shell](src/shell/README.md): providers, tabs, toolbar and root composition.
- [Indexing](src/indexing/README.md): token cache and counting.
- [Stores](src/stores/README.md): persisted presentation metadata and transient state.

File reads require the exact mounted-root authority. Keep binary/inaccessible
results, selection limits, per-key retry and provider-owned generations visible.
File bytes remain ephemeral. Reuse TreeTable, TabStrip and context-action owners,
including their scrollport, keyboard and focus behavior.

See [UI conventions](../../docs/agents/ui-conventions.md) and
[explorer](../../docs/agents/explorer-search-context-map.md) contracts.
Scripts and dependencies belong to the manifest; contribution/validation rules
live in [root guidance](../../AGENTS.md).
