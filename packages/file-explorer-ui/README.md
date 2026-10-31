# @brainstrike/file-explorer-ui

Explorer composition, treegrid, file tabs and token-status UI. Reuses core explorer state and shared UI; owns no second selection, content loader or virtualization system.

## Providers

- The platform supplies `AdaptersProvider` with admitted filesystem and storage capabilities.
- `FileExplorerProvider` owns its explorer store and takes a stable storage adapter.
- Mount the shared `FileSystemProvider` once; a second instance would split root state.
- Cross-package imports use the `/shell`, `/tree` and `/indexing` subpaths (full list in [`package.json`](package.json)).

## Slices

- [Tree](src/tree/README.md): TreeTable row models, lazy loading and selection.
- [Shell](src/shell/README.md): providers, tabs, toolbar and root composition.
- [Indexing](src/indexing/README.md): token cache and counting.
- [Stores](src/stores/README.md): persisted presentation metadata and transient state.

## Rules

- File reads require the exact mounted-root authority.
- Keep binary/inaccessible results, selection limits, per-key retry and provider-owned generations visible. File bytes stay ephemeral.
- Reuse TreeTable, TabStrip and context-action owners with their scrollport, keyboard and focus behavior.
- Contracts: [UI conventions](../../docs/agents/ui-conventions.md), [explorer](../../docs/agents/explorer-search-context-map.md).
