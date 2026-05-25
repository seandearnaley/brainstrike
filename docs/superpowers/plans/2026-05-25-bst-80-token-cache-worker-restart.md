# BST-80 Token Cache Worker Restart Plan

## Ticket Validation

- Linear issue: BST-80, high priority, still open and revalidated in comments.
- Current code latched background token indexer worker failures through the terminal fail path.
- Existing deterministic tokenizer initialization failures must remain terminal.

## Scope

- Add a bounded restart path for recoverable worker runtime, channel, readiness, and worker-message failures.
- Keep repeated failures terminal after the restart budget is exhausted.
- Reject in-flight batches on worker failure instead of silently replaying stale work.
- Preserve structured diagnostics for both recoverable restart logs and terminal failures.

## Verification

- RED: Added tests proving one recoverable worker crash restarts and later indexing succeeds.
- RED: Added tests proving repeated recoverable failures surface one terminal worker error.
- GREEN: `pnpm --filter @brainstrike/token-cache test -- src/__tests__/use-background-token-indexer.test.tsx`
- GREEN: `pnpm --filter @brainstrike/token-cache type-check`
- GREEN: `pnpm exec biome check --write packages/token-cache/src/use-background-token-indexer.ts packages/token-cache/src/__tests__/use-background-token-indexer.test.tsx`
