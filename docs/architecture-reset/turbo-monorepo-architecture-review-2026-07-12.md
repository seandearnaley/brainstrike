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
