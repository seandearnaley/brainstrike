# Explorer tree

Owns TreeTable row models, lazy-loading composition, tree context and selection projections. Shared TreeTable stays the treegrid/virtualization owner (two-axis scrollport, keyboard/focus contract).

- `optimized-file-tree.tsx` composes the existing row-model, selection-count and directory-mutation helpers.
- Preserve canonical root/composite identities, load/error state and explicit selection. Truncation or UI pseudo-nodes never establish complete membership or file counts.
- Cross-package imports go through `@brainstrike/file-explorer-ui/tree` ([`index.ts`](index.ts)).
- Dependencies point toward core explorer state, shell selectors, tree-worker helpers and shared UI/hooks.
- Focused tests:

  ```bash
  pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/optimized-file-tree.test.tsx src/__tests__/optimized-file-tree-selection.test.tsx src/__tests__/file-tree-provider.test.tsx src/__tests__/use-file-tree-context.test.ts
  ```
