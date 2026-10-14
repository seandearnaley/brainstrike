# @brainstrike/file-explorer-hooks

React integration for adapter-backed filesystem access, selection, loading,
watcher health, restoration and report generation. The root exports are defined
in [`index.ts`](src/index.ts).

`AdaptersProvider` receives actual filesystem and storage adapters. Preserve its
owned lifetime; components must not create independent root registries or silently
substitute capabilities. The low-level `useFileSystem` hook has its own instance
state. Shared explorer UI uses the single `FileSystemProvider` instance from
`@brainstrike/file-explorer-ui/shell` so every consumer sees the same mounted roots.

`useSelectionManager` takes the current selected paths, limit and writer;
it is not a zero-argument store lookup. Keep canonical root/composite identities
and the existing selection-limit behavior through those inputs.

`useReportGeneration` and `createReportGenerationWorker` compose the existing file
loader and pure explorer context projection. They require the active adapter;
unavailable capabilities and invalid filters fail visibly. File loading preserves
per-key accessible/inaccessible results, explicit retry and generation fences.
A callback or abort notification alone does not retire physical reads.

Hook signatures and exports live in source and [`package.json`](package.json).
See [workspace](../../docs/agents/workspace-context.md) and
[explorer](../../docs/agents/explorer-search-tapestry.md) contracts, with
[shared contribution/validation policy](../../AGENTS.md).
