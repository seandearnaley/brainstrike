# File Explorer Indexing Slice

## Ownership

Owns file-explorer token indexing UI and token-cache integration. This slice is responsible for background token indexer wiring, token budget controls, token meters, and the token cache provider surface consumed by app settings and diagnostics.

Top churn owned here:
- `use-background-token-indexer-integration.ts`
- `token-cache-context.tsx`
- `use-token-counting.ts`

## Public surface

Use `@brainstrike/file-explorer-ui/indexing` for cross-package imports. The root package barrel may re-export this slice, but should not export individual indexing implementation files directly.

## Allowed dependencies

Allowed inward dependencies are file-explorer tree context, token-cache, preferences, db types, shared utils, and React. Indexing should not import app-shell, desktop, web, or assistant runtime internals.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/use-background-token-indexer-integration.test.tsx src/__tests__/token-cache-context.test.tsx src/__tests__/use-token-counting.test.ts
```
