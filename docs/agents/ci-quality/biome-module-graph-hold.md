# Biome 2.5.3/2.5.4 module-graph hold — evidence

Supports `docs/agents/ci-quality.md` § "Biome 2.5.8 cleared the 2.5.3/2.5.4
module-graph hold" (BST-1273, cleared 2026-08-15). Read this when a Biome bump
panics, reformats test files en masse, or leaves `biome-ignore` directives
dead. The contract holds the rules; this file is the record of why.

`@biomejs/biome` is pinned to exactly 2.5.8 (root + `apps/web`; the two must
stay in lockstep). History: Biome 2.5.3/2.5.4 hit a module-graph panic
(`module_resolver.rs:500:33`, "index out of bounds") **deterministically 39
times** on this codebase — triggered by `nursery/noFloatingPromises` resolving
cross-module callback return types (upstream biomejs/biome#10963, same class as
#10885/#10940). 2.5.2 contained the same panic site but only hit it via a rare
scheduling-dependent race (#10953). The fix is upstream commit `e62f6b6`
(2026-07-16), released after 2.5.4.

The old hold required a release containing `e62f6b6` and a full
`pnpm exec biome check .` with zero "Biome encountered an unexpected error" /
panic output. The 2.5.2 → 2.5.8 bump satisfied both conditions: repeated full
runs over all 4376 files produced zero panic output. No live release condition
gates future Biome bumps. Keep the root and `apps/web` pins in lockstep and
repeat the full panic-free check for every bump; those are verification
guardrails, not a hold at 2.5.8.

Two things the 2.5.3–2.5.8 window changed on this repo, both already absorbed:
- **Formatter.** `it.each([...])('title', fn)` no longer hugs the callback when
  the call head overflows `lineWidth`, so it breaks the arguments instead. This
  is a test-only pattern; 76 test files reformatted, net −65 lines. Two files
  that sat exactly at the 1000-line `noExcessiveLinesPerFile` cap
  (`packages/embedding-worker/test/streaming-worker-client.spec.ts`,
  `packages/queue/src/__tests__/browser-workerpool.test.ts`) were pushed over
  and were shrunk by collapsing verbose literals — the cap was NOT raised and
  neither file was added to the `noExcessiveLinesPerFile` override list.
- **`lint/performance/noDelete` narrowed.** It no longer fires on
  `delete process.env['X']`, so 11 `biome-ignore` directives for it went dead
  and were demoted to plain rationale comments. 7 other `noDelete` suppressions
  in the repo still fire — do not bulk-remove them.

`nursery/noFloatingPromises` (the repo's only error-level nursery rule)
surfaced **no** new violations at 2.5.8.
