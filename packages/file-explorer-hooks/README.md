# @brainstrike/file-explorer-hooks

React integration for adapter-backed filesystem access, selection, loading, watcher health, restoration and report generation. Exports are in [`index.ts`](src/index.ts).

- `AdaptersProvider` receives the real filesystem and storage adapters and owns their lifetime. Components never create their own root registries or substitute capabilities.
- `useFileSystem` (low-level) has its own instance state. Shared explorer UI uses the single `FileSystemProvider` from `@brainstrike/file-explorer-ui/shell` so every consumer sees the same mounted roots.
- `useSelectionManager` takes the current selected paths, limit and writer; keep canonical root/composite identities and the selection limit.
- `useReportGeneration` and `createReportGenerationWorker` compose the file loader and explorer context projection.
  - They require the active adapter; missing capabilities and invalid filters fail visibly.
  - Loading keeps per-key accessible/inaccessible results, explicit retry and generation fences.
  - A callback or abort notification alone does not retire physical reads.
- Contracts: [workspace](../../docs/agents/workspace-context.md), [explorer](../../docs/agents/explorer-search-context-map.md).
