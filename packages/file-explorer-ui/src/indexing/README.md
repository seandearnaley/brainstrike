# Explorer token indexing

## Ownership

Owns token-counting/cache integration and background token-indexer composition.
This is separate from semantic/native workspace indexing and cannot establish
committed retrieval coverage.

Keep the background integration hook as orchestration. Classification, admitted
content resolution, path normalization, batching and selection-shrink
reconciliation belong to its existing helpers. Preserve root identity, per-key
failures and late-completion generations; a missing capability is not permission
to substitute another filesystem reader.

## Public surface

Use `@brainstrike/file-explorer-ui/indexing` across packages, with exports routed
by [`index.ts`](index.ts). Consumers do not deep-import individual indexing
implementation files.

## Allowed dependencies

Dependencies point toward tree context, token cache, preferences, shared
types/utilities and React, not app or assistant runtimes. Keep token/cache
lifetime within its actual owner and reset lifecycle.

## Focused local test

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/__tests__/use-background-token-indexer-integration.test.tsx src/__tests__/token-cache-context.test.tsx src/__tests__/use-token-counting.test.ts
```

[Explorer contracts](../../../../docs/agents/explorer-search-context-map.md) and
[shared contribution/validation policy](../../../../AGENTS.md) apply. The manifest
and package tests define executable checks; this README does not prescribe another
fixed test list.
