# @brainstrike/file-explorer-hooks

React integration for adapter-backed filesystem access, selection, loading, watcher health, restoration and report generation. Exports are in [`index.ts`](src/index.ts).

- `AdaptersProvider` receives the real filesystem and storage adapters and owns their lifetime. Components never create their own root registries or substitute capabilities.
- `useFileSystem` (low-level) has its own instance state. Shared explorer UI uses the single `FileSystemProvider` from `@brainstrike/file-explorer-ui/shell` so every consumer sees the same mounted roots.
- `useSelectionManager` takes the current selected paths, limit and writer; keep canonical root/composite identities and the selection limit.
- `useReportGeneration` and `createReportGenerationWorker` compose the file loader and explorer context projection.
  - They require the active adapter; missing capabilities and invalid filters fail visibly.
  - Loading keeps per-key accessible/inaccessible results, explicit retry and generation fences.
  - A callback or abort notification alone does not retire physical reads.
- `/file-content-worker` exports `createFileContentWorker`, an adapter-backed async read queue with bounded concurrency; it spawns no Web Worker.
  - Results keep the original composite key: `{ status: 'accessible', content }` or `{ status: 'inaccessible', message }`. Binary, oversized and unreadable files are per-file failures, never content strings.
  - Prefer admitted adapter handles. A handleless absolute read needs a durable root ID, fully qualified root/file paths and the explicit absolute-read capability; missing authority refuses before I/O, with no generic path-reader fallback.
  - Cancellation rejects the batch and stops scheduling; the adapter owns already-admitted I/O, so a rejected promise doesn't prove reads stopped. Don't infer concurrency limits from platform names.
- Contracts: [workspace](../../docs/agents/workspace-context.md), [explorer](../../docs/agents/explorer-search-context-map.md).
