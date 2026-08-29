# Live-query parameter comparison benchmark

BST-383 measures the equal-value parameter comparison performed on each render
by `usePGliteLiveQuery`. The benchmark compares the current `JSON.stringify`
key strategy introduced in PR #728 with the recursive `deepEqual` strategy
vendored from its first parent's exact implementation at
`a801ed0c8e63be7065d2ff596bfd2a2e0aea8b7d`. Keeping that snapshot inside the
manual harness prevents later production refactors from silently changing the
historical arm. Each iteration creates a fresh parameter array so the
measurement includes the work required when callers reconstruct equal values
on render.

Run the uncached benchmark manually:

```bash
pnpm --filter @brainstrike/db bench:live-query-params
```

The runner warms both strategies in current/legacy/legacy/current order,
alternates measured order, and reports the median of ten samples with 100,000
iterations per sample. An even sample count gives each strategy the first slot
five times. A
`currentToLegacyRatio` below 1 means the current JSON-key strategy is faster;
a ratio above 1 means the legacy recursive comparison is faster.

Parameter construction deliberately remains inside both timed arms because the
hook pays that caller-allocation-adjacent work when equal values are rebuilt on
render. The absolute per-comparison figures are therefore upper bounds on
allocation plus comparison rather than isolated comparison cost.

## 2026-08-29 baseline

Environment: macOS arm64, Node.js 24.18.0.

| Equal-value parameter shape | Current median | Legacy median | Current / legacy |
| --- | ---: | ---: | ---: |
| Primitive | 6.02 ms | 0.75 ms | 8.02x |
| Array | 9.84 ms | 5.28 ms | 1.86x |
| Complex object | 44.81 ms | 41.40 ms | 1.08x |

This baseline does **not** verify the performance premise recorded on BST-383:
the current JSON-key path is slower for all three equal-value shapes on this
machine. The largest current-path cost measured here is about 0.45 microseconds
per comparison, so this isolated result is evidence against claiming a speedup,
not evidence by itself that another production migration is worthwhile. Retain
the benchmark when changing live-query parameter stabilization, and evaluate
end-to-end render/subscription behavior before changing the default strategy.
