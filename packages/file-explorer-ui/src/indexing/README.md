# Explorer token indexing

Owns token counting, the token cache and background token-indexer composition. This is separate from native workspace indexing and never establishes retrieval coverage.

- The background integration hook only orchestrates; classification, content resolution, path normalization, batching and selection-shrink reconciliation live in its helpers.
- Preserve root identity, per-key failures and late-completion generations. A missing capability is no licence to substitute another filesystem reader.
- Cross-package imports go through `@brainstrike/file-explorer-ui/indexing` ([`index.ts`](index.ts)).
- Dependencies point toward tree context, token cache, preferences, shared types/utilities and React; never app or assistant runtimes.
- Focused tests:

  ```bash
  pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/use-background-token-indexer-integration.test.tsx src/__tests__/token-cache-context.test.tsx src/__tests__/use-token-counting.test.ts
  ```
