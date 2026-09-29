# Embedding queue load verification (BST-387) — evidence

Supports `docs/agents/local-inference.md` § "Embedding queue load
verification". Read before changing the shared PGlite instance, the rendezvous
gates, or the adaptive scenario. The single shared `memory://` instance is a
BST-1221 V8-crash mitigation, not a convenience.

## Original text


- `packages/embeddings/src/__tests__/embedding-queue-load.integration.test.ts`
  runs a serialized real-PGlite matrix with 1, 2, 4, and 16 polling loops.
- All scenarios share ONE lazily created `memory://` PGlite closed in
  `afterAll`, with per-scenario state kept disjoint by scenario-prefixed ids
  and dedupe-key-scoped SQL. Do not return to a fresh instance per scenario:
  PGlite close leaves WASM teardown to GC, and the teardown-overlapping-
  instantiation churn was BST-1221's reproducible V8 fatal trigger on the
  PKU-enabled Linux x64 CI runners (see docs/agents/ci-quality.md).
- It records exact peak claimed jobs, vectors and UTF-8 input bytes in flight,
  effective claim limits and returned batch sizes, lease claim count, maximum
  attempts, and completion latency. Absolute latency
  is reported rather than threshold-gated because host load is not a product
  invariant. Claim/completion spies maintain an in-memory set of active claimed
  job IDs, so the observer adds no database query before heartbeat arming.
  Reported latency is not a product baseline. `peakClaimedJobs` is sampled
  post-claim and depends on the worker preserving reserve-before-claim
  ordering. The deterministic gates are
  a pre-claim permit rendezvous proving every requested polling loop starts,
  one claim per job, exact claim limit and returned batch size 1, and observed
  concurrency scaling from 1 to 2 to 4 before flattening at the four-job global
  working-set ceiling when sixteen loops poll. The first-wave rendezvous targets
  `min(concurrency, maxInFlightJobs)`, which makes the overlap proof structural
  without deadlocking loops parked on the in-flight budget.
- The adaptive scenario begins with a slow synthetic model (claim limit 1),
  then accelerates it (claim limit 4), proving the runtime consumes changing
  throughput policy without exceeding the same global budget.
- Focused run:
  `pnpm --filter @brainstrike/embeddings exec vitest run --config vitest.integration.config.mts --maxWorkers=1 --no-file-parallelism src/__tests__/embedding-queue-load.integration.test.ts`.
