# Explorer shell

Owns providers, toolbar/filter composition, workspace/file tabs and the explorer panel.

- `FileExplorerProvider` owns explorer state and the content-loading generation.
- `FileSystemProvider` mounts one shared filesystem instance; its `useFileSystem` throws outside the provider instead of creating another root registry.
- Adapters come from the platform boundary and must be stable.
- The panel composes the tree and token-indexing slices.
  - File reads keep exact root authority, per-key errors/retry and physical-resource ownership through provider retirement.
  - A selection or cache key is not a filesystem grant or thread writer.
- Cross-package imports go through `@brainstrike/file-explorer-ui/shell` ([`index.ts`](index.ts)).
- Dependencies point inward (feature slices, core explorer state, adapter contracts, shared UI/hooks, React); never app or assistant runtimes.
- Focused tests:

  ```bash
  pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/file-explorer-panel.test.tsx src/__tests__/use-file-explorer-context.test.ts src/__tests__/file-explorer-provider.test.tsx src/__tests__/file-explorer-sidebar.test.tsx
  ```
