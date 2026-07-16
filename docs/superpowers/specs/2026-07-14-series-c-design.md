# Series C design — CI cost + registry consolidation (2026-07-14)

Follow-on to Series B (R3 build mechanics, all merged 2026-07-14: #1650, #1649,
#1651, #1652, #1658). Implements the remaining "this month" tier of the turbo
monorepo architecture review (PR #1624): R7, R9 remainder, R6 completion, R8,
plus R12a (TS7) pulled forward and the small Series B deferrals. Structural
work (R5 assistant-server extraction, R10 god-package splits, rest of R12) is
explicitly Series D.

## Context that shapes this series

- Post-B4, the build tax is gone (whole-repo test graph: 39 build tasks → 3).
  The remaining PR-pipeline cost is job-level waste, not graph mechanics: the
  Coverage job re-runs per sync (11–14 min), Static has a fixed 8–13 min floor
  (uncacheable lint + TS6 type-check), and everything runs on x64.
- First warm post-B4 push (#1657) ran Unit in 40m55s — but that commit touched
  the model catalog (db + agent), near worst-case invalidation. Uncached
  carve-out lanes and broad-invalidation commits now dominate Unit wall-clock.
- B3 built a guard-enforced, exports-derived module-resolution registry
  (`packages/test-utils/workspace-src-aliases.mjs`); R6's "one registry"
  goal is finished by extending it, not by introducing `vite-tsconfig-paths`
  (decision log below).

## Decisions (settled with user 2026-07-14 — do not relitigate)

1. **Scope**: CI cost + registry tier. R5/R10/R12b,c deferred to Series D.
2. **R7 shape**: Coverage runs on `ready_for_review` + re-triggerable via a
   `coverage` label — once per PR lifecycle, not per sync. Nightly threshold
   gate remains the enforcement backstop.
3. **Orphan**: `packages/queue-telemetry-collector` is deleted (zero-consumer
   evidence from the Series B audit, re-verified in-PR before deletion).
4. **TS7 posture**: verify-then-adopt in one PR. Diff TS6 vs TS7 diagnostics
   across every type-check lane; switch pure-CLI lanes only on full parity.
   TS-API consumers stay pinned 6.x (includes our own guard scripts that use
   `ts.createSourceFile`). No parity → the PR lands as a findings report.
5. **R6 mechanism**: the B3 registry is the single source (not
   vite-tsconfig-paths). Rationale: already exports-derived +
   existence-validated + execution-guard-enforced through four adversarial
   review rounds; expresses the deliberate dist-alias exceptions (web aliases
   file-explorer to dist for its worker build); zero new dependencies. tsconfig
   `paths` is *verified against* the registry by a guard, not generated.
6. **Declaration-only builds for renderer-only packages: won't-do.** The
   payoff evaporated when B4 removed `^build` from the test graph; the
   remaining benefit doesn't cover the renderer-alias risk.

## PR split (8 PRs, safest-first)

Workflow chain — serialized, all touch `.github/workflows/test.yml`:

- **C1 — R7 Coverage demotion.** Behavior contract: coverage runs ~once
  per PR lifecycle (`ready_for_review` + `coverage` label re-trigger); other
  test.yml jobs unaffected. **Shape:** move Coverage into its own
  `.github/workflows/coverage.yml` — do **not** add `labeled` to `test.yml`
  (that workflow produces the five required checks; a `labeled` subscription
  would fire/skip/cancel them on every label add). ~25% of PR pipeline cost.
- **C2 — R9a workflow dedup.** One composite setup action
  (pnpm→node→optional turbo cache; callers keep their own `actions/checkout`
  — a local `./path` composite cannot contain checkout or it never resolves);
  re-key the actions/cache `.turbo` layer on lockfile+turbo.jsonc hash
  (performance.yml pattern) instead of per-job-per-sha; single-source the
  Playwright image pin. Evaluate Turbo 2.10 `cacheMaxAge`/`cacheMaxSize` as
  replacement for the LRU-prune half of `scripts/run-turbo-command.mjs` if
  trivial, else defer to Series D.
- **C3 — R9b ARM runners + cacheable lint.** Move lint/type/unit-eligible
  lanes to `ubuntu-24.04-arm` (37% cheaper); Electron/Playwright/native lanes
  stay x64. Make lint per-package cacheable (Biome is file-local and
  deterministic; eslint targets 4 fixed dirs), keeping secret-scan and
  contract checks uncached. **Gated on both probes below.**

Independent lanes — parallel:

- **C4 — R12a TS7 verify-then-adopt** (decision 4). Prize: Static's ~5.5-min
  type-check step (TS7 claims 8–12×).
- **C5 — R6 completion** (decision 5): web vitest aliases → registry spread
  (desktop converted in B4); both apps' **Vite** configs consume a
  registry-derived module with explicit dist-alias exceptions; new guard
  asserting root tsconfig `paths` matches the registry;
  `scripts/verify-workspace-src-aliases.mjs` extended to `apps/*`.
- **C6 — R8 pnpm catalogs.** `catalog:` protocol in pnpm-workspace.yaml +
  `catalogMode: strict` + `cleanupUnusedCatalogs`; retire syncpack (dep + the
  4 root `deps:*` scripts); Renovate catalog support. Skip `trustPolicy`
  (verified broken — memory: pnpm trustPolicy no-downgrade). Expect a one-time
  full cache bust from lockfile churn; note it in the PR.
- **C7 — delete `packages/queue-telemetry-collector`** (decision 3).
- **C8 — derive `coverage-lanes.mjs` from `test-lanes.mjs`** so the #1101
  "register in BOTH registries" footgun becomes structurally impossible (the
  review's §7-endorsed improvement — generation, not removal).

## Operating model

Series B model with the upfront audit slimmed to **two targeted probes**
(Series C claims are mechanically checkable, unlike R3's premises):

1. **ARM probe** (gates C3): dispatch Static + Unit on `ubuntu-24.04-arm`
   from a probe branch; inventory native deps (node-pty, secure-fs-native,
   Electron downloads) to decide lane placement.
2. **Lint-cacheability probe** (gates C3's lint half): confirm lint inputs are
   fully hashed — the B4 config-load-gap guard pattern applies.

Discipline carried over from Series B:

- Worktree-isolated implementation lanes; draft PRs; adversarial review every
  round; merge only when every review comment is addressed/declined with a
  reply AND all checks are green (a green `review` check is not the review).
- Every workflow-touching PR (C1–C3) validates the push path via
  `gh workflow run test.yml --ref <branch>` (the #1066/#1207 lesson — PR
  checks exercise a different path).
- Cost claims proven from actual run timings before/after, never estimates.
- Credential handling is user-only; verify-by-log.
- Unrelated flakes/infra fixes go in their own PR.

## Success criteria (measured)

- Coverage job executions per PR lifecycle ≈ 1 (from N syncs).
- Static wall-clock drop from lint cache hits + TS7 (if adopted).
- Runner-cost delta for lanes moved to ARM.
- Module-resolution: one source, guards green across packages + apps + root
  tsconfig; zero hand-synced alias blocks remaining in vitest configs.
- syncpack absent; strict catalog enforcing single versions.

## Explicitly deferred (Series D candidates)

R5 assistant-server extraction (+ panel-prop pipeline flattening), R10
god-package splits, R12b Turbo 3.0 deprecation audit (unless C2 lands
`cacheMaxAge` trivially), R12c turbo boundaries advisory, merge queue
(tripwire: adopt if red-main incidents recur), shared platform-composition
seam (explore after R5).
