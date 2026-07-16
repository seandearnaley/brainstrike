# Turbo monorepo architecture review — 2026-07-12

Full report: [`turbo-monorepo-architecture-review-2026-07-12.html`](./turbo-monorepo-architecture-review-2026-07-12.html)

## Method

Four parallel analysis agents, cross-checked against each other and against
official docs fetched the same day:

1. **Package graph** — dependency extraction across all 41 workspace
   `package.json` files present at measurement time (the repo has grown since;
   figures below are a 2026-07-12 snapshot), cycle check, build-tooling
   inventory, tsconfig/project-references audit, and a read of the existing
   `architecture/domain-map.json` boundary contract.
2. **CI lanes** — every `.github/workflows/*.yml` file, the bespoke
   `scripts/run-turbo-command.mjs` / `scripts/check.mjs` orchestration, plus
   real run durations and failure rates pulled via `gh`.
3. **History mining** — 6 months of `git log --numstat` churn, package
   co-change coupling, and ~900 merged PRs classified by theme/size.
4. **2026 idioms research** — web-grounded canonical answers on Turborepo 2.x
   (`--affected`, Boundaries, remote cache), pnpm catalogs, merge queues, TS
   project references/tsgo, and Vitest 4 projects, each with source URLs.

## Headline findings

- The **package dependency graph is a clean DAG** with zero cycles and zero
  grandfathered exceptions in the homegrown domain-boundary contract
  (`scripts/architecture-domain-boundaries.mjs`) — a genuinely rare, worth-
  protecting state.
- The debt is concentrated in **build mechanics**: 18 packages double-compile
  (`tsc -b` *and* tsup over the same sources), renderer-only packages ship a
  `dist/` that nothing ever executes (both app bundlers alias every workspace
  package to `src`), and `test` depends on `^build` even though tests import
  source directly — so a one-line edit to `packages/types` invalidates the
  build of 33 of 40 packages before a single test runs.
- **CI test execution was the only expensive, uncached step.** Turborepo
  remote caching was live and working for builds, but test selection had been
  moved off Turbo onto raw `pnpm --filter`, so every run re-executed
  everything, including a ~42-minute uncached full re-test on every push to
  `main`.
- The **nightly regression tier had gone silently red**: web-e2e, desktop-e2e,
  and performance had each failed 10/10 recent scheduled runs, with no failure
  notification.
- History mining reframed the whole review around **agent throughput**: the
  repo merges ~17 PRs/day (one human orchestrating AI agents), and 60–70% of
  `agent`/`preferences` package commits also touch `apps/desktop` — the
  assistant server living in app code defeats affected-path CI filtering for
  roughly a fifth of all work.

## Ranked recommendations (R1–R12)

See the full report for evidence, grounding, and risk notes on each. Short
form:

| # | Recommendation | Horizon |
|---|---|---|
| R1 | Resurrect/guard the silently-red nightly regression tier | This week |
| R2 | Route CI test execution through Turbo's remote cache | This week |
| R3 | Cut the `^build` tax: declaration-only builds, no double-compiles | This week |
| R4 | Ungate smoke E2E from the Unit job | This week |
| R5 | Extract `packages/assistant-server` out of `apps/desktop` | This month |
| R6 | One module-resolution registry instead of four | This month |
| R7 | Demote the Coverage lane from every-sync to on-demand | This month |
| R8 | Adopt pnpm catalogs; retire syncpack | This month |
| R9 | Workflow hygiene: composite action, cache re-key, event pruning, ARM runners | This month |
| R10 | Split the god packages (`utils`, `types`, `preferences`, `ui`) along their measured seams | This quarter |
| R11 | Restructure `AGENTS.md` before it outgrows its readers | This quarter |
| R12 | Modernization audit: TS7 lane, Turbo 3.0 deprecations, boundaries-advisory | This quarter |

## Implementation status (as of 2026-07-12)

The "this week" tier landed the same day, plus follow-on work surfaced by it:

- **R1** — #1612 clones `nightly-coverage.yml`'s failure-notification pattern
  into `web-e2e.yml`, `desktop-e2e.yml`, and `performance.yml`. The underlying
  regressions were separately root-caused and fixed in #1614, #1615, #1616.
- **R2** — #1610 routes Unit test execution through
  `turbo run test --filter=...`, with an evidence-based audit carving out 8 of
  43 test lanes (`cache: false`) whose pass/fail depends on inputs Turbo
  doesn't hash (native addons, real-PGlite-under-wall-clock lanes). Surfaced
  and fixed a class of pre-existing PGlite `beforeEach` hook-timeout flakes in
  `embeddings` and `apps/desktop` along the way.
- **R4** — #1608 ungates smoke E2E from the Unit job.
- **R9** (partial) — #1609 prunes unused `claude.yml` triggers and deletes
  dead config (`tsconfig.solution.json`, a stale `knip.jsonc` entry).
- **R11** — landed independently via #1607 (lean root `AGENTS.md` + on-demand
  per-subsystem docs) and #1613 (`packages/ui/AGENTS.md`).

**Known follow-up, measured after merge:** the push-path Unit win did not
fully materialize — the 8 cache-safety carve-outs (notably `apps/desktop`,
serialized at `maxWorkers: 1`) still dominate wall-clock on a full-repo run.
The proposed next stage splits each carved package's `test` task into a
cacheable subset and a narrower `cache: false` integration subset, so only the
genuinely env-sensitive lanes stay uncached.

Remaining recommendations (R3, R5–R8, R10, R12) are proposed as follow-up PR
series, each independently testable in an isolated worktree.

## Implementation status (as of 2026-07-15)

The remaining recommendations from the 2026-07-12 status above have now been
executed across two more PR series (B and C), plus a data point on the
deferred merge-queue call. Six factual premises from the original review were
measured during execution and found false — see "Corrections" below; the
original text above is unchanged.

- R1, R2, R4, R9-partial, R11 — landed 2026-07-12 (#1608–#1613), as above.
- **R3** — Series B, all merged 2026-07-14: #1650 (script hygiene), #1649
  (`globalDependencies` narrowing + guard), #1651 (test-lane src-alias
  registry + execution guard), #1652 (Unit phase split), #1658 (topo transit
  node; whole-repo test graph 39 build tasks → 3). Series B's audit overturned
  R3's premises — see correction 1.
- **R6, R7, R8, R9-remainder, R12a** — Series C, all merged 2026-07-14/15:
  #1662 (orphan deletion), #1663 (lane-manifest verification — the §7
  "derive coverage-lanes from test-lanes" recommendation was already
  implemented; both scripts already imported one shared manifest, so the task
  became verification + doc correction), #1664 (Coverage → its own
  once-per-lifecycle workflow), #1666 (TS7 parity findings; outcome: do not
  adopt yet), #1667 (one module-resolution registry), #1668 (composite setup
  action + content-hashed arch-namespaced turbo cache key), #1669 (pnpm
  catalogs replace syncpack, with CI enforcement), #1670 (Static + Unit →
  `ubuntu-24.04-arm`).
- **R5, R10** — deferred to a planned Series D (in planning as of 2026-07-15).
  **R12b** (Turbo 3.0 prep / `cacheMaxAge`) deferred, with measured reasons in
  #1668. **R12c** (boundaries-advisory) deferred.
- §6's "merge queue deliberately deferred" ruling got a data point: Series C
  hit a real cross-PR integration failure (C2's Playwright-pin guard reads
  `@playwright/test`'s version; C6 catalogued it, so the guard crashed on the
  literal string `'catalog:'`), caught by PR CI on the integrated tree and
  fixed in #1669. The tripwire (red-main incidents) was not hit; the deferral
  stands.

### Corrections (2026-07-15)

> **Correction.** Six factual premises above and in the full report were
> measured during execution and found false. The original claims are left as
> written; corrected figures follow.

1. **R3's "18 packages double-compile"** — false: it was double *parse*, not
   double *compile* (`emitDeclarationOnly` was already set everywhere; tsup
   was always the sole JS emitter). "Tests import source directly" was also
   false for 13 of 18 packages until #1651 made it true.
2. **R7's "11–14 min per sync" for Coverage** — measured Coverage runs are
   5–9.5 min. The mechanism (per-sync waste) was right; the magnitude was
   overstated. Measured saving on 5 sample PRs: 21 coverage runs → 5 under the
   new on-demand model.
3. **R9's "Static's fixed 8–13 min floor"** (the lint-cache prize) — measured
   Static total is ~197s on typical pushes; the 8m+ figures were cold
   whole-repo-invalidation runs. Lint is ~91s, and 6 of `lint:ci`'s 8 chained
   commands are inherently whole-repo scanners. Lint caching was deferred —
   the realistic prize is ~40–60s on a cache hit.
4. **R9's ARM expectation** — ARM is not faster: Static measured 2.7–3.0 min
   on arm64 vs. 2.9–3.1 min on x64 (parity, not a speedup). The win is purely
   the 37% cheaper per-minute rate. turbo's cache key is also
   architecture-agnostic (hash omits CPU arch; `runner.os` reports `"Linux"`
   on both), and the remote cache replays x64-produced results on ARM — so ARM
   buys the rate discount, not independent per-arch validation. Recorded in
   `docs/agents/ci-quality.md`.
5. **R8's "`catalogMode: strict` to reject drift"** — pnpm's strict mode does
   not reject a hand-edited literal for a catalogued dep: `pnpm install` exits
   0 and resolves a second, parallel version; only
   `pnpm add <pkg>@<off-catalog-version>` is rejected. #1669 ships the real
   enforcement, `scripts/verify-catalog-references.mjs` (Static job) — a check
   syncpack never had, since it was never wired into CI.
6. **R12a's TS7 adoption** — parity fails: 64/67 type-check invocations match
   byte-for-byte, but `apps/desktop/tsconfig.main.json`'s
   `moduleResolution: "node"` is a removed option under TS7, and the paired
   fix (`module`/`moduleResolution: Node16`) yields 88 errors under *both*
   compilers — adoption is blocked on a full CJS→ESM migration of the
   Electron main process. Findings + a re-runnable parity guard shipped in
   #1666 (`docs/series-c-ts7-parity-findings.md`).
