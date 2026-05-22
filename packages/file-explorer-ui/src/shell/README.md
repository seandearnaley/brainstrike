# File Explorer Shell Slice

## Ownership

Owns file-explorer composition, providers, app/tab host wiring, toolbar/filter UI, file-system context, selection-manager context, and the left-panel composition point.

Top churn owned here:
- `file-explorer-panel.tsx`
- `use-file-explorer-context.ts`
- `file-explorer-provider.tsx`

## Public surface

Use `@brainstrike/file-explorer-ui/shell` for cross-package imports. `file-explorer-panel.tsx` should continue moving toward a thin composition module over shell, tree, preview, and indexing surfaces.

## Allowed dependencies

Allowed inward dependencies are tree, preview, indexing, file-explorer core, file-system, storage, selection-rules, shared UI, shared hooks, and React. Shell should not import app-shell, desktop, web, or assistant runtime internals.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/file-explorer-panel.test.tsx src/__tests__/use-file-explorer-context.test.ts src/__tests__/file-explorer-provider.test.tsx src/__tests__/file-explorer-sidebar.test.tsx
```
