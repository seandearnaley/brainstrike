# File Explorer Preview Slice

## Ownership

Owns the context preview surface: Tapestry composition and its grouping/pagination inputs, footer layout, token summary presentation, report actions, and workspace context curation.

BST-1211 retired the Table View, so this slice owns exactly one preview surface. There is no tab strip, no column model and no sort state here — columns and per-directory sort belong to the Explorer grid (`../tree`).

Top churn owned here:
- `preview-panel.tsx`
- `preview-panel-footer.tsx`
- `use-preview-panel-state.ts`

## Public surface

Use `@brainstrike/file-explorer-ui/preview` for cross-package imports. Internal file-explorer modules may import concrete files when they are in the same package and the dependency direction remains explicit.

## Allowed dependencies

Allowed inward dependencies are indexing token state, file-explorer shell store types, shared UI components, shared types, and React. Preview should not import app-shell, desktop, web, or assistant runtime internals.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/preview-panel.test.tsx src/__tests__/preview-panel.integration.test.tsx src/__tests__/use-preview-panel-state.test.ts src/tapestry/__tests__/tapestry-view.test.tsx
```
