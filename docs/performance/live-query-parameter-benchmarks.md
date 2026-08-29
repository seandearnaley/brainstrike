# Live-query parameter comparison benchmark

BST-383 measures the equal-value parameter comparison performed on each render
by `usePGliteLiveQuery`. The benchmark compares the current `JSON.stringify`
key strategy introduced in PR #728 with the recursive `deepEqual` strategy from
the parent of that commit. Each iteration creates a fresh parameter array so the
measurement includes the work required when callers reconstruct equal values on
render.

Run the uncached benchmark manually:

```bash
pnpm --filter @brainstrike/db bench:live-query-params
```

The runner warms up both strategies, alternates their measurement order, and
reports the median of nine samples with 100,000 iterations per sample. A
`currentToLegacyRatio` below 1 means the current JSON-key strategy is faster;
a ratio above 1 means the legacy recursive comparison is faster.

## 2026-08-29 baseline

Environment: macOS arm64, Node.js 24.18.0.

| Equal-value parameter shape | Current median | Legacy median | Current / legacy |
| --- | ---: | ---: | ---: |
| Primitive | 4.99 ms | 0.63 ms | 7.93x |
| Array | 9.90 ms | 5.39 ms | 1.84x |
| Complex object | 45.24 ms | 41.68 ms | 1.09x |

This baseline does **not** verify the performance premise recorded on BST-383:
the current JSON-key path is slower for all three equal-value shapes on this
machine. The largest current-path cost measured here is about 0.45 microseconds
per comparison, so this isolated result is evidence against claiming a speedup,
not evidence by itself that another production migration is worthwhile. Retain
the benchmark when changing live-query parameter stabilization, and evaluate
end-to-end render/subscription behavior before changing the default strategy.
