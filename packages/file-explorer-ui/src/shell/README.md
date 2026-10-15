# Explorer shell

## Ownership

Owns providers, toolbar/filter composition, workspace/file tabs and the explorer
panel.

`FileExplorerProvider` owns its explorer state and content-loading generation.
`FileSystemProvider` mounts one shared filesystem instance; its `useFileSystem`
throws without that provider rather than creating another root registry. Supply
stable, admitted filesystem/storage adapters from the platform boundary.

Keep the panel as composition over the tree and token-indexing surfaces. File
reads retain exact root authority, per-key errors/retry and physical-resource
ownership through provider retirement. Tabs/context actions reuse shared owners.
A selection/cache key is not a filesystem grant or canonical thread writer.

## Public surface

Use `@brainstrike/file-explorer-ui/shell` through [`index.ts`](index.ts) for
cross-package imports.

## Allowed dependencies

Dependencies point inward to feature slices, core explorer state, adapter
contracts, shared UI/hooks and React. The shell does not import app or assistant
runtime implementations.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/file-explorer-panel.test.tsx src/__tests__/use-file-explorer-context.test.ts src/__tests__/file-explorer-provider.test.tsx src/__tests__/file-explorer-sidebar.test.tsx
```

See [UI](../../../../docs/agents/ui-conventions.md),
[workspace](../../../../docs/agents/workspace-context.md) and
[shared contribution/validation guidance](../../../../AGENTS.md).
