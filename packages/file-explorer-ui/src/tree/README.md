# File Explorer Tree Slice

## Ownership

Owns tree rendering (via shared TreeTable treegrid primitives from `@brainstrike/ui`), lazy loading, file-tree provider state, file-tree index helpers, row-level selection behavior, and tree selection-count projections. Do not reintroduce a local virtual-list hook — TreeTable is the canonical treegrid (see root AGENTS.md TREEGRID CONVERGENCE CONTRACT).

Top churn owned here:
- `optimized-file-tree.tsx`
- `optimized-file-tree-model.ts`
- `optimized-file-tree-selection-counts.ts`
- `use-lazy-file-tree.ts`
- `file-tree-provider.tsx`

`optimized-file-tree.tsx` must stay a composition module. Row model construction, selection state derivation, directory mutation helpers, and selected-directory count calculations belong in the owned helper modules listed above.

## Public surface

Use `@brainstrike/file-explorer-ui/tree` for cross-package imports. The root package barrel delegates to this public barrel; it should not export individual tree implementation files directly.

## Allowed dependencies

Allowed inward dependencies are shell store selectors, file-tree-worker helpers, file-explorer core types, shared hooks, shared UI primitives, platform utils, and React. Tree should not import preview or indexing unless the dependency is explicitly documented and covered by package-local architecture tests.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/optimized-file-tree.test.tsx src/__tests__/optimized-file-tree-selection.test.tsx src/__tests__/optimized-file-tree-query-expansion.test.tsx src/__tests__/optimized-file-tree-selection-mutations.test.tsx src/__tests__/file-tree-provider.test.tsx src/__tests__/use-file-tree-context.test.ts
```
