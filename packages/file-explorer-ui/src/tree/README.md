# Explorer tree

## Ownership

Owns TreeTable row models, lazy-loading composition, tree context and selection
projections. Shared TreeTable remains the treegrid/virtualization owner, including
its two-axis scrollport and accessible keyboard/focus contract.

Keep `optimized-file-tree.tsx` as composition over the existing row-model,
selection-count and directory-mutation helpers. Preserve canonical root/composite
identities, load/error state and explicit selection behavior. Truncation or UI
pseudo-nodes cannot establish complete source membership or file counts.

## Public surface

Use `@brainstrike/file-explorer-ui/tree` across packages. Its
[`index.ts`](index.ts) routes public exports; consumers do not deep-import a new
parallel tree implementation.

## Allowed dependencies

Tree dependencies remain directed toward core explorer state, shell selectors,
tree-worker helpers and shared UI/hooks. Indexing coupling needs the existing
explicit contract/architecture coverage.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/optimized-file-tree.test.tsx src/__tests__/optimized-file-tree-selection.test.tsx src/__tests__/file-tree-provider.test.tsx src/__tests__/use-file-tree-context.test.ts
```

For shared behavior see [UI conventions](../../../../docs/agents/ui-conventions.md)
and [explorer contracts](../../../../docs/agents/explorer-search-context-map.md).
Commands and validation selection live in the package manifest and
[root guidance](../../../../AGENTS.md).
