# File Explorer Preview Slice

## Ownership

Owns preview-pane rendering, preview table state, footer layout, token summary presentation, report actions, and workspace context curation surfaces.

Top churn owned here:
- `preview-panel.tsx`
- `preview-table.tsx`
- `use-preview-panel-state.ts`

## Public surface

Use `@brainstrike/file-explorer-ui/preview` for cross-package imports. Internal file-explorer modules may import concrete files when they are in the same package and the dependency direction remains explicit.

## Allowed dependencies

Allowed inward dependencies are indexing token state, file-explorer shell store types, shared UI components, shared types, and React. Preview should not import app-shell, desktop, web, or assistant runtime internals.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/preview-panel.test.tsx src/__tests__/preview-panel.integration.test.tsx src/__tests__/preview-table.test.tsx src/__tests__/use-preview-panel-state.test.ts
```
