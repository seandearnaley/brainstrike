# Explorer shell

Owns providers, toolbar/filter composition, workspace/file tabs and the explorer
panel. Use `@brainstrike/file-explorer-ui/shell` through
[`index.ts`](index.ts) for cross-package imports.

`FileExplorerProvider` owns its explorer state and content-loading generation.
`FileSystemProvider` mounts one shared filesystem instance; its `useFileSystem`
throws without that provider rather than creating another root registry. Supply
stable, admitted filesystem/storage adapters from the platform boundary.

Keep the panel as composition over tree, preview and token-indexing surfaces.
File reads retain exact root authority, per-key errors/retry and physical-resource
ownership through provider retirement. Tabs/context actions reuse shared owners.
A selection/cache key is not a filesystem grant or canonical thread writer.

Dependencies point inward to feature slices, core explorer state, adapter
contracts, shared UI/hooks and React. The shell does not import app or assistant
runtime implementations.

See [UI](../../../../docs/agents/ui-conventions.md),
[workspace](../../../../docs/agents/workspace-context.md) and
[shared contribution/validation guidance](../../../../AGENTS.md).
