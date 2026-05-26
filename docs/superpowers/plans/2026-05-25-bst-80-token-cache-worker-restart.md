# BST-80 Token Cache Worker Restart Plan

## Ticket Validation

- Linear issue: BST-80, high priority, still open and revalidated in comments.
- Current code latched background token indexer worker failures through the terminal fail path.
- Existing deterministic tokenizer initialization failures must remain terminal.

## Scope

- Add a sliding-window restart limiter for recoverable worker runtime, channel, readiness, and worker-message failures: up to `MAX_RECOVERABLE_WORKER_RESTARTS` (2) restarts in any `RECOVERABLE_WORKER_RESTART_WINDOW_MS` (60s) window.
- Once the cap is hit within the window, escalate to terminal — flapping workers that fail every ~30s no longer restart indefinitely.
- After the window elapses, transient failures get a fresh budget.
- Reject in-flight batches on worker failure instead of silently replaying stale work.
- Preserve structured diagnostics for both recoverable restart logs (incl. `attempt`, `maxAttempts`, `windowMs`) and terminal failures.
- Tighten typing: `RecoverableWorkerContext` const union replaces the stringly-typed context allowlist.
- Restart-timer race when `ensureWorkerReadyRef` is null (effect cleanup races ahead) now escalates to terminal instead of silently bailing.
- Drop the redundant `failWorker`-then-`logger.warn` double-log on terminal restart failure.

## Verification

- RED: Added tests proving one recoverable worker crash restarts and later indexing succeeds.
- RED: Added tests proving repeated recoverable failures surface one terminal worker error.
- NEW: Added a sliding-window-reset test (`resets the restart budget once failures age out of the sliding window`) — burns the 2-restart budget, advances time past 60s, asserts the next recoverable failure is treated as transient with a fresh budget.
- Review follow-up: replaced the 5s stability-window-reset (which allowed unbounded restart cycles spaced > 5s apart) with the sliding-window limiter, tightened typed context, escalated silent-limbo path to terminal, removed duplicate warn entry.
- GREEN: `pnpm --filter @brainstrike/token-cache test` — 134/134 pass
- GREEN: `pnpm --filter @brainstrike/token-cache type-check`
