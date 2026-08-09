# CI & Quality Gates: PR Flow, React Doctor

> Extracted from AGENTS.md (2026-07-12). Read before changing workflows, doctor.config.ts, or knip config. Keep updated with the code.

## PR CI FLOW

Pull requests use plain GitHub Actions workflows. There is no custom planner,
no generated CI artifact, no CI routing labels, and no local command registry.

Rules:
- Do not add CI **routing** labels. The removed custom planner used labels to
  decide WHICH CI ran; that stays dead. The one permitted label is `coverage`
  (see "Coverage is a separate workflow" below) — an on-demand re-run request
  for an ADVISORY job, not routing, and it can only ever ADD work, never skip
  a required check.
- Do not commit generated CI proof artifacts.
- Do not reintroduce the removed custom proof/planner commands or any custom
  planner script.
- Required PR checks should be the always-present checks from `.github/workflows/test.yml`.
  As of the Series C R7 split this is exactly: `Static`, `Unit`, `Build`,
  `Web E2E`, `Desktop E2E`. `Coverage` is deliberately NOT required.
- Web and desktop E2E smoke workflows run on every PR.
- Full web and desktop E2E regression runs on `schedule` or explicit
  `workflow_dispatch`.
- Pushes to `main` run static, unit, build, web smoke, and desktop smoke.

### The package-boundary gate runs first in Static (BST-967)

The `Static` job runs `pnpm exec turbo boundaries` as its first substantive
step (right after the secret scan), and the ORDERING is the invariant, not a
style choice: the analyzer scans build output as well as source, so any step
that materializes `dist/` before it — `type-check` (whose turbo task
`dependsOn: ["build"]`), any `pnpm build`/`pnpm --filter X build`, or a cache
restore of real build outputs — reintroduces phantom violations from stale
artifacts (observed live: `dist/turso/*` files from an unmerged branch flagged
a dependency no source on `main` imports). On the fresh checkout the step sees,
a non-zero exit means a REAL source violation.

Deliberate crossings carry inline `// @boundaries-ignore <reason>` comments at
the import site. The contract tests in
`scripts/__tests__/turbo-boundaries-gate.test.mjs` keep all of this honest:
they prove the gate can fail (fixture workspace with a violation → non-zero
exit, clean fixture → zero), assert the Static step stays ordered before any
dist-producing step, and require every ignore comment to carry a substantive
reason. Division of labor with the custom checker:
`architecture-domain-boundaries.mjs` owns cross-DOMAIN direction rules; `turbo
boundaries` owns package-escaping imports and undeclared dependencies. Known
blind spots (tracked, not solved here): CLI-flag dependencies such as the
coverage provider (BST-1017) and non-import reaches via `fileURLToPath` are
invisible to the analyzer.

The analyzer's reach widens across Turbo patch releases, so a Turbo bump can
surface a pre-existing crossing with no source change: 2.10.8 reports
`packages/chunking-worker/bench/tree-sitter-cost.mjs`'s relative
`../../text-splitter/src/index.ts` dynamic import, which 2.10.5 did not (same
tree, same 3705 files / 50 packages — 2.10.5 clean, 2.10.8 one issue). That one
is annotated, not rewritten: the bench must measure current text-splitter
SOURCE, and `@brainstrike/text-splitter` exports only `./dist`, so the package
specifier would silently benchmark a stale build. Expect to triage new findings
this way on the next bump rather than assuming the tree regressed.

### App test-tsconfig programs (`tsconfig.test.json`)

`apps/web` and `apps/desktop` type-check their test files through a dedicated
`tsconfig.test.json` in the `type-check` chain. Both set `"paths": {}` so
workspace deps resolve to built `dist` declarations (each produced under its
own package's tsconfig) instead of recompiling foreign sources under the app's
ambient shims. Two consequences to keep in mind:

- `type-check:test` needs deps built first. Turbo's `type-check` task
  (`dependsOn: ["build"]`) covers CI and `pnpm type-check`; a bare
  `pnpm --filter <app> type-check` in a fresh clone will not have `dist/`.
- The app's production `src` files reached from tests are checked TWICE under
  two different resolution graphs (src-paths in the main program, dist in the
  test program), so `type-check:main` passing does not imply `type-check:test`
  passes on the same file. Desktop additionally excludes its renderer-only
  PGlite shims (`src/types/pglite*.d.ts`) from the test program — an ambient
  `declare module` would otherwise shadow the real `@electric-sql/pglite`
  types for everything the tests pull in. The test programs also set
  `declaration: false`: a `noEmit` program never emits d.ts, and inheriting
  `declaration: true` makes exported `vi.fn()` mocks fail TS2883 portability
  checks that vary with pnpm store layout.

### Vercel Preview is advisory

The Vercel GitHub integration reports a `Vercel` commit status on pull
requests, but it is intentionally absent from the default-branch ruleset's
required checks. The merge gate is the five always-present `test.yml` checks
listed above. This separation prevents provider capacity from being confused
with a code-quality result while keeping real Preview failures visible.

When `Vercel` is red:

1. Inspect the status description and target deployment before classifying it.
   A provider-capacity description (rather than a build or deployment failure
   log) means no build was evaluated; an actual failed deployment or build log
   is a product failure and remains blocking. Do not depend on a specific
   provider URL slug because integration URLs can change.
2. Verify the current repository ruleset rather than relying on an old PR or
   this prose. `gh api repos/seandearnaley/brainstrike/rulesets/4797672`
   should match the required checks listed above under
   `required_status_checks`.
3. For capacity-only failures, do not push a no-op commit or restart the
   45-minute GitHub Actions pipeline. Once the exact-head required checks and
   reviews are clean, the PR may merge with the advisory capacity status red.
4. Do not claim Preview QA occurred when capacity prevented a deployment. If
   the change specifically requires a live Preview acceptance check, restore
   capacity and perform that check before merge.

This is not a silent-success fallback: the original Vercel status stays red
and visible. Repeated quota exhaustion is an account-capacity problem to
provision, not a reason to weaken or rewrite the integration. Vercel documents
deployment and concurrency quotas in its
[platform limits](https://vercel.com/docs/limits); GitHub documents that only
[status checks selected by a ruleset are required to pass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

### Deterministic agent-behavior evals (BST-589)

`packages/agent/src/__tests__/agent-behavior-eval.spec.ts` runs Mastra
`runEvals` through the real BrainStrike agent runtime with scripted
`LanguageModelV2` fixtures. It is a zero-network, zero-LLM-cost unit-lane gate
covering tool selection, error-free tool execution, and plan-mode omission of
mutation tools. Every deterministic gate must average exactly `1.0`; a Mastra
`failed` verdict fails Vitest. The suite also keeps a deliberately misbehaving
control so a gate that can no longer detect its target cannot pass silently.

The same spec demonstrates scored quality tracking with a deterministic
threshold miss. Its expected Mastra verdict is `scored`, not `failed`, so it is
advisory evidence and never weakens or replaces the merge-blocking gates. Real
provider/model evals remain outside the merge gate and must use the package's
`*.integration.spec.ts` lane if added later.

### Quiet-head admission before PR fan-out (BST-597)

Every `pull_request` run of `test.yml` first enters the `Quiet-head admission`
job on `ubuntu-slim`, GitHub's 1-core $0.002/min runner. The gate waits 120
seconds, then reads the PR through the GitHub API and compares its current head
SHA with the immutable head SHA in this run's event payload. If they match, it
releases the complete existing job graph. If the PR advanced, the gate succeeds
with a visible notice and `admitted=false`, so the superseded SHA's seven
expensive jobs never start. Workflow-level `cancel-in-progress` remains the
first line of defense: a new `synchronize` event normally cancels the old gate
during its cheap sleep; the API comparison closes the remaining ordering race.

This is an admission delay, not CI routing. It uses no labels and never selects
a reduced test plan. The latest quiet PR head always runs the full graph,
including all five stable required contexts (`Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E`) plus both native jobs and the non-required
`Browser tests` lane (BST-994 — Vitest browser-mode suites for db/ui/storage
in the pinned Playwright container; expensive enough that it keeps the same
quiet-head gate, and `quiet-head-admission-contract.test.mjs` verifies it).
Web and desktop E2E retain their `build` dependency. Push and
`workflow_dispatch` events are admitted immediately, so their behavior is
unchanged apart from the dependency edge.

The gate is deliberately fail-closed: `pull-requests: read` is its only added
permission, and a missing event SHA, missing API SHA, or API error fails the
admission job visibly instead of guessing that the run is current. Do not add a
fallback that releases work when currency cannot be established. Each of the
five required jobs uses `always()` plus an explicit first-step failure when the
admission job itself fails. This is required because GitHub otherwise skips a
job whose dependency failed, and a skipped required check can satisfy branch
protection. A normal superseded-head decision keeps the admission job successful
with `admitted=false`, so those same jobs remain skipped without allocating
their runners. Contract coverage lives in
`scripts/__tests__/quiet-head-admission-contract.test.mjs` and runs in the
Static job through `pnpm test:scripts`.

Why this exists: the measured GitHub Actions sample for 2026-07-15..19 reached
44 concurrent Linux jobs, and 513 of 1,641 `Test` workflow runs (31.3%) were
cancelled. `Test` represented roughly 92% of the modeled Actions bill. Paying
about $0.004 to hold a PR head for two minutes is materially cheaper than
starting the full fan-out during edit/push bursts.

### Biome pinned at 2.5.2 — do NOT bump to 2.5.3/2.5.4 (2026-07-18)

`@biomejs/biome` is pinned to exactly 2.5.2 (root + `apps/web`). Biome
2.5.3/2.5.4 hit a module-graph panic (`module_resolver.rs:500:33`,
"index out of bounds") **deterministically 39 times** on this codebase —
triggered by `nursery/noFloatingPromises` resolving cross-module callback
return types (upstream biomejs/biome#10963, same class as #10885/#10940).
2.5.2 contains the same panic site but only hits it via a rare
scheduling-dependent race (#10953); if `pnpm run lint` ever spews these
panics on 2.5.2, just re-run (or `RAYON_NUM_THREADS=1` as a one-off).
The real fix is upstream commit `e62f6b6` (2026-07-16, unreleased as of
2.5.4). Bump only to a release containing it, and verify with
`pnpm exec biome check .` (zero "Biome encountered an unexpected error")
before landing.

### Static and the Unit fan-in run on arm64 (Series C R9b)

`static` and the lightweight `unit` fan-in in `test.yml` run on
`ubuntu-24.04-arm`, not `ubuntu-latest` (x64). arm64 runners became available
for private repos on 2026-01-29 and cost 37% less per minute than x64. Probe P1
measured this specific: `pnpm install --frozen-lockfile` (the native-deps/node-gyp set,
the main risk), lint, script tests, secret scan, and the 6 `cache: false`
`test:integration` suites (real PGlite, embeddings — the heaviest,
native-dependent work in the workflow) all genuinely ran and passed on
arm64. Wall-clock was AT PARITY with x64 (~3.0m either arch) — arm64 is
**not** faster here, only cheaper per minute; do not claim a speedup.
`native-windows` stays on GitHub's `windows-latest` runner.

### Performance lane (performance.yml) — calibrated budgets only (BST-1038)

The nightly performance lane (`performance.yml`, cron 07:23 UTC + dispatch)
gates on the budget assertions inside `apps/web/e2e/performance/*.test.ts` —
there is no separate diff step. Its contract, written after the lane spent
three months permanently red (zero green runs in 1,000 retained; budgets
were local-dev constants x a flat 2.0 multiplier with no CI-derived floors):

- **Every CI budget that has breached under controlled measurement carries a
  calibrated `GITHUB_ACTIONS_MINIMUMS` floor** in
  `apps/web/e2e/utils/performance-config.ts`, with provenance (run ids, date,
  runner class, observed range) in the adjacent comment. Metrics that have
  never breached stay on the multiplier budgets and are calibrated from
  observed data on their FIRST breach — never floor-bumped reactively, and
  never tightened or introduced from a local measurement (local is an order
  of magnitude faster than the shared runner — the "~62ms" incident).
- **Recalibrate by controlled dispatch**: N `workflow_dispatch` runs of
  `performance.yml` on ONE SHA (sequentially — the concurrency group cancels
  parallel dispatches), floor = observed worst x ~1.5 headroom.
- **No `--max-failures` truncation**: the lane must report its full breach
  surface, or its scope cannot be measured.
- A calibrated-lane breach is a REAL signal: file it as a regression ticket
  with the measured values, do not bump the floor to silence it.

### Primary Linux x64 jobs run on Ubicloud (BST-765)

`unit-shard`, `build`, `native-electron`, `web-e2e`, and `desktop-e2e` in
`test.yml` run on `ubicloud-standard-4`. That runner preserves the
4-vCPU/16-GB class used for the x64 work while moving the measured, dominant
Linux x64 lanes to the connected Ubicloud runner fleet. The boundary is
deliberate:

- quiet-head admission remains on GitHub `ubuntu-slim`
- Static and the Unit fan-in remain on GitHub ARM
- all four physical Unit rows use one fixed Ubicloud runner class (two DB
  native shards plus the heavy and rest rows)
- Native Windows remains on GitHub Windows
- coverage, scheduled, review, and auxiliary workflows are unchanged

The Unit matrix moved as a whole after GitHub's ARM pool terminated the
`rest` shard without a failing test assertion on five consecutive attempts
across two exact PR heads (runs 30158896583 and 30175303301 on 2026-07-25).
Do not route individual shards to different providers: keeping one fixed
runner contract avoids a provider-selection layer while preserving the exact
partition, integration concurrency, and required `Unit` fan-in.

The four physical rows still form three logical package partitions:
`db`, `heavy`, and `rest`. Only `db` repeats its Turbo package filter; its two
rows supply `DB_TEST_SHARD=1/2` and `DB_TEST_SHARD=2/2` to the single
`@brainstrike/db#test` invocation, whose Vitest config applies the native
shard. The variable is appended only to the package-level DB Turbo task:
Turbo CLI passthrough is forbidden here because it also reaches dependency
and transit tasks. `scripts/unit-shard-partition.mjs` rejects
missing, duplicate, mixed-count, or divergent-filter rows, so duplicating the
DB package cannot become a double-run or an empty half silently. Do not apply
this pattern across packages: it is valid here because DB is one package and
one Vitest project.

Do not add a provider-selection layer or an automatic GitHub fallback. An
Ubicloud provisioning failure must queue or fail visibly; rollback is an
explicit revert of the runner-label change. Existing cache and setup actions
stay unchanged because Ubicloud's transparent cache supports the standard
GitHub cache actions. Contract coverage lives in
`scripts/__tests__/ubicloud-runner-contract.test.mjs`.

The Static job caps the monorepo type-check with Turbo's official
`TURBO_CONCURRENCY=4` environment variable.
Unbounded scheduling repeatedly exhausted the arm64 runner after the workspace
reached 43 packages: Turbo received a shutdown signal while launching more than
30 type-check tasks and the shell exited 137 without a TypeScript diagnostic.
Keep the cap on the CI invocation rather than weakening package coverage or
changing local developer defaults. The exact workflow command is guarded by
`scripts/__tests__/quiet-head-admission-contract.test.mjs`.

**Non-obvious trap for future maintainers:** the turbo *remote* cache
(`TURBO_TOKEN`/`TURBO_TEAM`) is arch-agnostic — turbo's cache hash does not
include CPU architecture, and `runner.os` reports `"Linux"` on both x64 and
arm64 GitHub-hosted runners. So an arm64 lane will mostly **replay**
x64-produced remote-cache entries rather than independently validate on
arm64 (benign for this repo's JS/dts/log outputs, which are
arch-independent, but worth knowing before treating a green arm64 run as
proof of arch-independent correctness for something that isn't). Whichever
arch runs first populates the shared remote cache for both. The *local*
`.turbo` `actions/cache` layer (`setup-workspace/action.yml`) is correctly
arch-namespaced (`${{ runner.os }}-${{ runner.arch }}-turbo-...`, added in
C2/#1668) so it cannot cross-restore an incompatible entry — that guard
just doesn't extend to the remote cache.

**Native (node-gyp) build outputs are the exception to "arch-independent"
and MUST NOT be turbo-cached.** `@brainstrike/secure-fs-native` compiles an
arch/ABI-specific `.node` into `build/**`. When its turbo `build` task cached
that output, the arch-blind remote cache let the arm64 Static/Unit jobs
populate an entry that the x64 Coverage job (`ubuntu-latest`) then replayed —
so `apps/desktop`'s coverage lane, which loads the real addon via its
`*.integration.test.*` files, died with `secure_fs_native.node: cannot open
shared object file` on every PR touching `apps/desktop` (PR #1749 shipped a
runner-side rebuild; the follow-up made the fix structural). Its `build` task
is now `cache: false` (`packages/secure-fs-native/turbo.json`), matching the
same package's long-standing `test` policy, so every runner node-gyp-rebuilds
the addon for its own ABI. Any future native/node-gyp package added to the
monorepo must do the same — never cache a compiled binary on turbo's
source-only, arch-blind hash.

### Coverage is a separate workflow (`.github/workflows/coverage.yml`)

Coverage used to be a job inside `test.yml` running on every `synchronize` —
11-14 min of re-instrumentation on EVERY push. Series C R7 demoted it to once
per PR lifecycle: it runs on non-draft `opened`, `ready_for_review`, non-draft
`reopened`, or an explicit `coverage` label add. It does NOT run on
`synchronize`. `nightly-coverage.yml` remains the authoritative threshold gate;
per-PR coverage is advisory Codecov patch signal only.

When DB is directly changed, the advisory workflow isolates its coverage from
the recursive package runner. It executes the same native Vitest `1/2` + `2/2`
shard set as required Unit and nightly coverage, sequentially on the single
2-vCPU host, then uses `--merge-reports`. Other affected packages retain
`--workspace-concurrency=4` and explicitly exclude DB. This boundary is
load-bearing: run 30704747207 let DB share the host with another package and a
10-second type-contract test timed out after 24 minutes. Do not widen that test
or serialize every package; keep only the PGlite-heavy DB task isolated.

#### The embeddings integration lane is serialized (BST-1072, settled 2026-08-01)

`packages/embeddings`'s `test:integration` runs
`--maxWorkers=1 --no-file-parallelism`, following the `apps/desktop` precedent.
It is NOT an instance of the "don't serialize every package" rule above: that
rule is about CPU contention, this is about **memory**.

The before-state, corrected (the first version of this section claimed the lane
ran with "no cap of any kind" on "the 2-vCPU runner"; review caught both): the
integration config inherits `pool: 'forks'` and `maxWorkers: '50%'` from
`vitest.config.mts`, and `Unit (rest)` runs on the 4-vCPU/16-GB Ubicloud class
(see the `unit-shard` comment in `test.yml`), so the lane ran **2 workers** and
the serialization is 2 → 1. The 2-vCPU figure belongs to `coverage.yml`'s
`ubuntu-latest` host in the section above, a different workflow.

The in-lane flag is also not the only concurrency knob: `test.yml` invokes
`pnpm turbo run test:integration … --concurrency=2`, so a SECOND integration
lane from the SAME `rest` partition (agent, web, file-import…) can share the
box with embeddings — desktop/ui/file-explorer-ui/app-shell cannot, they run
in the separate `heavy` matrix row. The memory accounting is therefore 2 × the
measured **~1.9 GB RSS per worker** (real PGlite plus WASM embedding heaps)
PLUS the co-scheduled rest-partition lane's peak, against 16 GB. Anyone
re-measuring must hold that cross-package factor constant.

**What is proven vs. plausible.** Proven: the crash is concurrency-dependent
and not a bug in one test — the victim VARIES (across two failing runs on
PR #2213 the file that never reported was `embedding-worker-model-resolution`
once and `embedding-worker-batch` the other time), and the serialized lane
passes. The worker died with `[vitest-pool]: Worker exited unexpectedly` and
the job reported `Test Files 11 passed (12)` — the twelfth file never reported
at all. Supporting the MEMORY account specifically: the crash never reproduced
on a developer Mac (74/74) even though a Mac runs `maxWorkers: '100%'` —
strictly MORE concurrent workers than CI's 2 — with far more RAM, so worker
count alone does not produce the crash; available memory does. NOT directly
observed: the precise ceiling that killed the worker. Memory pressure from two
workers plus a co-scheduled lane is the best-supported account, not a captured
OOM kill.

It surfaced on any PR marking embeddings as AFFECTED — which includes editing a
widely-depended-on package such as `assistant-contract`, not just root config —
so it repeatedly failed the required `Unit` check for changes that touch no
embeddings code (5 of 6 observed runs).

Do not remove these flags to speed the lane up without first re-measuring peak
RSS against the runner's 16 GB with the turbo `--concurrency=2` co-lane held
constant.

#### Codecov statuses are non-gating (settled 2026-07-26 — do not relitigate)

The ruleset requires exactly five contexts — `Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E` — all produced by `test.yml`. `codecov/patch` and
`codecov/project` are NOT among them, so a failing Codecov status can never
block a merge; it only renders a red X and an `UNSTABLE` merge box.

`codecov.yml` nonetheless carried the comment *"Keep patch coverage blocking
instead"*, contradicting both `test.yml` and this document. Two sources plus the
ruleset agreed; `codecov.yml` was the outlier and was simply wrong. Resolved by
making the config match reality in Codecov's own documented way:
`coverage.status.patch.default.informational: true` — the status still posts and
still shows the percentage, it just never fails
(<https://docs.codecov.com/docs/commit-status>). `target`/`threshold` are kept
deliberately so the number remains visible.

Two independent reasons patch coverage must not gate here, both measured:

- **PR uploads are affected-only**, so patch % is systematically understated. On
  PR #2024 Codecov reported **27.86%** while the three changed source files
  measured **97.5% / 98.07% / 98.21%** locally.
- **A stacked PR has no BASE report**, so Codecov cannot compare at all and says
  so: *"Please upload report for BASE"*. `codecov.allow_pseudo_compare` (default
  true) does not rescue this — it substitutes a parent commit for skipped-CI and
  merge-commit bases, not for a branch that never uploaded a report.

The authoritative gate is unchanged: `nightly-coverage.yml` →
`pnpm coverage:enforce` (`scripts/enforce-coverage.mjs`), full unfiltered
coverage with ratcheted per-package thresholds, which opens an issue on failure.

`scripts/verify-codecov-status-contract.mjs` (run by `pnpm test:scripts` in the
Static job) enforces this. Two properties it must hold, and the first review of
it found six violations of the first:

- **Never pass vacuously.** Codecov reads `coverage.status.<type>` as a MAP OF
  CONTEXTS, so every child of an enabled status must itself be disabled or
  explicitly `informational: true`. That single rule covers the shapes that
  previously slipped through: an empty or array status block, settings written
  flat without a `default:` wrapper, a scalar context (`default: true`), an
  empty mapping, and a status-level `informational:` shorthand that is not
  documented and would have waved through a still-gating `default`.
- **Never fail a valid config.** `pnpm test:scripts` runs in the REQUIRED Static
  check, so a false positive blocks every merge — worse than the red X this
  removed. Hence `off` is matched case-insensitively (`yaml` v2 uses the YAML
  1.2 core schema, where bare `off` is the STRING `'off'`, not a boolean), and
  unknown keys under `coverage.status` are REPORTED, not fatal: Codecov
  publishes exactly `codecov/project`, `codecov/patch` and `codecov/changes`, so
  nothing else there can gate.

It also searches every location Codecov reads config from — root, `dev/`,
`.github/`, as `codecov.yml` or `.codecov.yml` — and fails if two exist, since
which one wins is undocumented and a second file could silently change the
effective config.

**Re-gating is a two-part change**: PR uploads must become complete AND the
context must be added to the ruleset. Doing one without the other re-creates the
contradiction.

Nightly package coverage uses six static GitHub Actions matrix shards plus two
native Vitest DB shards and a DB merge job. Five package shards isolate the
measured heavyweight lanes; the sixth is a negative-filter remainder, so a new
package with a `test:coverage` task is covered automatically instead of
requiring registry maintenance. Each DB row uploads Vitest's blob report under
its native `1/2` or `2/2` identity. The merge job requires exactly two blobs,
runs Vitest's own `--merge-reports` coverage union, and uploads one DB JSON tar
archive. The final `coverage` job still fails closed unless all seven package
archives (six general plus the one natively merged DB archive) are present,
restores them into one workspace, and is the only job that runs
`coverage:prepare-workspace`, `coverage:enforce`, the merged report, and
Codecov. Each shard emits its blob plus a text summary; it does not render the
unused HTML/Clover report tree. Do not replace this with a generated planner
or raise the original shared timeout: the split preserves one authoritative
threshold decision while giving slow packages independent failure and timeout
domains.

Native packages may retain a `test:coverage` alias that deliberately runs their
real addon tests without instrumentation. The artifact-completeness check
requires JSON only from coverage-producing scripts (those invoking
`--coverage`); it still fails when any instrumented package omits its artifact.
This distinction does not exempt instrumented code or relax a threshold.

**Why its own file, and why you must not merge it back into `test.yml`:** the
label trigger requires subscribing to the `pull_request` `labeled` action.
`test.yml` is the SOLE producer of all five required status checks, so if it
subscribed to `labeled`, every label add would fire it and each required job
would need an `if:` guard — reporting a `skipped` check run for every required
context. Measured on PR #1664: merges are NOT blocked (`skipped` satisfies a
required check — `gh pr view --json mergeable` returned MERGEABLE), BUT the
merge box renders the LATEST check run per context, so all five required checks
displayed as `skipping` instead of `pass`. The `codex` label is already in use,
so this would hit a real flow. Splitting the file means `test.yml` never fires
on `labeled` and green stays green. It also avoids a footgun: under the guard
design, every NEW job added to `test.yml` would have to remember an `if:` guard
or silently run on label churn.

`coverage.yml` sets `cancel-in-progress: false` deliberately — it subscribes to
`labeled` for ALL labels (GitHub cannot filter label names at the trigger
level), so an unrelated label creates a run whose job is skipped; since
workflow-level concurrency is evaluated before job-level `if:`, that no-op run
would otherwise cancel an in-flight 11-14 min Coverage run.

### `pnpm check` is a mirror of test.yml, not a second CI definition (BST-1009)

`scripts/check.mjs` is the local gate. It has ZERO workflow references and is
not in `lefthook.yml`, so it is pure human/agent convenience — which is exactly
why a false green there is dangerous: it is the thing people cite as "CI-
equivalent" before pushing.

It was one. The pre-BST-1009 plan ran `lint-all`, `build`, `type-check`,
`test:coverage:split`, `coverage:enforce`, `test:browser`,
`test:e2e:functional`, `test:e2e:desktop` — a second, divergent definition of
CI whose divergences were silent:

- `test:coverage:split` → `test:coverage:base` =
  `pnpm -r --filter '!@brainstrike/db' --filter '!@brainstrike/embeddings' run test:coverage`.
  **A green `pnpm check` had never run `packages/db`** — the largest suite in
  the repo and the one turbo task that can never be replayed from a cache hit.
- It omitted three Static gates: `pnpm secrets:scan`, `pnpm exec turbo
  boundaries`, and **`pnpm test:scripts`** — i.e. the
  gate that runs the guard-script tests did not run in the local gate that
  guard scripts exist to protect (BST-836 again, one level up).
- `lint-all` = `pnpm lint && pnpm format`, which **writes** (`biome check .
  --fix`); CI's `lint:ci` is read-only. A gate must not rewrite the tree it is
  judging.
- It ran whole E2E suites where CI runs the smoke *lanes*.

The rewrite conforms to `test.yml` rather than paraphrasing it. Rules that must
survive future edits:

- **Turbo-native where CI is turbo.** The unit lanes are
  `turbo run test --concurrency=4` then `turbo run test:integration
  --concurrency=2` under `TURBO_TEST_MODE=unit`, unfiltered — CI's three Unit
  shards are an affected-set PARTITION of those same two tasks, and unfiltered
  is their union. Never reintroduce a `pnpm -r` filter list here; that is the
  shape that drifted.
- **Read-only lint by default.** `--fix-lint` is the explicit opt-in to the
  writing chain.
- **The install is `--frozen-lockfile`**, matching
  `.github/actions/setup-workspace`. A plain `pnpm install` silently UPDATES
  `pnpm-lock.yaml` when a workspace manifest has drifted from it and continues
  green, while CI rejects that same input — a false green in the install step
  of the script that exists to stop false greens.
- **The Playwright lanes run under `CI=true`, and nothing else does.** Both
  `playwright.config.ts` files branch on `config.isCI` for `forbidOnly`,
  `fullyParallel`, `globalTimeout`, `retries`, `workers`, `reporter`, the
  Chromium launch args and `trace`, and the `e2e/utils` helpers key their wait
  budgets off `CI` too — so without it a stray `test.only` in an `@web-smoke`
  test passes the lane locally while the required Web E2E job rejects the same
  source. Playwright's `--forbid-only` flag was considered and REJECTED: it
  repairs one of ~10 CI-conditioned divergences. **Do not hoist `CI` to the
  whole run (BST-1050)**: it would change the WORKLOAD of the unit lanes, not
  just their environment — `getTimeoutMultiplier()` returns 2 under `CI`, and
  `packages/vector-management`'s base vitest config switches on a 70% line
  threshold when `CI === 'true'`. It belongs to the four Playwright
  invocations and nowhere else; the parity test asserts both halves.
- **Vitest timeout parity uses `TEST_TIMEOUT_MULTIPLIER=2`, not `CI=true`.** The
  four Unit workflow steps, Nightly Coverage's Turbo steps, root Vitest battery
  scripts (`test`, `test:fast`, browser and coverage), and every Vitest phase of
  `pnpm check` set the dedicated variable explicitly. Turbo declares it in the
  unit, integration, browser and coverage task families' `env` rather than
  `passThroughEnv`: timeouts can change pass/fail, so the value must be part of
  the cache key and must not disappear in strict environment mode. Using `2`
  everywhere preserves cache sharing between official PR and push paths while
  avoiding CI-conditioned coverage changes locally. The cacheable `test` task
  also hashes `CI` itself: CI changes Vitest worker counts and some package
  coverage workloads, so replaying a local green under CI would be unsound even
  with the same timeout multiplier. Direct package/editor invocations
  intentionally retain the unscaled base unless the caller opts into
  `TEST_TIMEOUT_MULTIPLIER=2`; that keeps isolated iteration honest while
  allowing a contention-bearing run to request the gate policy explicitly.
  `getTimeoutMultiplier()` gives the explicit variable precedence, accepts only
  a positive plain decimal no greater than 10, and throws on malformed or
  runaway values; with no explicit value, the existing CI=2 and DEBUG=5
  defaults remain. That validation contract applies where Vitest timeout policy
  is consumed; native `node --test` tasks do not read this setting and are not
  silently choosing a fallback timeout from it.
- **`--full` is additive**, not a swap: the required-check mirror plus
  `nightly-coverage.yml`'s threshold gate and the full E2E regression lanes.
  `--fast` drops only the lanes CI fans out to separate runners (Browser tests,
  E2E) and reports those omissions in the banner. `--fast --full` is rejected
  because it would otherwise request contradictory E2E selections; `--no-coverage`
  is valid only with `--full`. Coverage is deliberately NOT in the default
  plan, because it is not a required check.
- **`--continue=dependencies-successful` (mirroring the Build job) changes
  turbo's scheduling, not its exit code.** `runStep()` rejects on ANY non-zero
  exit and the orchestrator is fail-fast, so a `--continue` run still fails the
  whole command. A test proves this with a real `exit 3`.
- **A CI gate that is not run locally must be DECLARED**, never quietly
  dropped. `CI_GATES_NOT_RUN_LOCALLY` in `check.mjs` names platform exclusions;
  `uncoveredCiGates()` adds any gates omitted by the selected mode flags before
  printing the banner. The static list currently holds exactly the two native
  jobs (`native-windows`: needs a Windows host; `native-electron`:
  electron-builder packaging for the runner's own platform, non-required,
  ~25 min).

`scripts/__tests__/check-ci-parity.test.mjs` (Static job, via
`pnpm test:scripts`) holds the line. It parses every `run:` step in `test.yml`
and requires each to be (a) mapped to a plan step id `buildPlan()` emits,
(b) named in `CI_GATES_NOT_RUN_LOCALLY` with a reason, or (c) listed as runner
plumbing in its `PROVISIONING_STEPS` set. Anything else fails, so a NEW CI gate
cannot be silently missed.

**It compares COMMANDS, not names**, and that distinction is the contract.
`gateInvocations()` reduces both the CI `run:` text and the mapped plan
command(s) to the set of pnpm scripts, turbo tasks and node scripts each
actually invokes (splitting on newlines/`&&`/`;`, seeing through
`pnpm --filter X <script>`, `pnpm turbo run`, this repo's
`run-turbo-command.mjs -- run`, and a `dbus-run-session --` prefix), then
requires the CI set to be a subset of the plan set. Asserting only that a
mapped id still exists was itself the drift class: `pnpm test:scripts` could
become `pnpm test:scripts && pnpm run new-gate` with the contract still green
and the new gate running in CI and nowhere else. A CI step whose token set
comes back EMPTY fails unless it is declared in `SHELL_GATE_STEPS` naming the
test that covers its drift (only `build › Validate CSS bundle` today, covered
by the byte-floor/duplicate-layer comparison).

Per BST-836 every part of that is control-tested — a synthetic `check.mjs` with
a gate deleted from the plan; another with an exclusion entry deleted; a
MUTATED `test.yml` whose `Script tests` step gains `&& pnpm run
new-uncovered-gate`; and the parity assertion run with `SHELL_GATE_STEPS`
emptied — each must make it throw. `gateInvocations` has its own control
asserting it really extracts the shapes both sides are written in, because a
comparator that silently returned nothing would make every command comparison
vacuous. Both mutation helpers fail loudly if their own edit matched nothing:
that already fired once on this branch when `biome check --write` sorted object
keys out from under a literal anchor.

The mapping is exhaustive in BOTH directions: a missing entry surfaces as an
unmapped step, and a STALE entry — one naming a step `test.yml` no longer has —
fails its own test, because otherwise it would quietly shrink what the contract
checks while every test stayed green.

The local CSS validation is `scripts/validate-css-bundle.mjs`, a small Node
script rather than the workflow's POSIX shell snippet, so it makes the same
byte/pattern assertions on Windows as on Unix; its paired controls prove both
failure modes still fail. CI's half of that step is still inline shell, which
is why it remains in `SHELL_GATE_STEPS` — that entry now means "CI's command is
unparseable by the comparator", not "nothing verifies this".

What this deliberately does NOT catch: a mapped CI command that gains or
changes a FLAG the local plan does not mirror (say `lint:ci --max-warnings=0`).
The token model compares which gates run, not their every argument. Snapshotting
each `run:` block verbatim into the test was tried and rejected — it is a
hand-maintained second copy of `test.yml`, the exact shape this section exists
to remove, and its failure mode invites a paste-and-move-on update rather than a
decision. The arguments that actually carry a contract are asserted
individually, read live from the workflow: the Unit lanes' `--concurrency=4`
and `--concurrency=2`, and Build's `--continue=dependencies-successful`.

Local-vs-CI difference that is stated rather than hidden: `turbo boundaries`
scans build output as well as source and CI runs it on a checkout with no
`dist/`, so a stale local artifact can produce a phantom violation. That is a
loud failure — `pnpm clean` and re-run before treating it as a real finding.

### Guard-script entrypoint contract (BST-836)

Every `scripts/verify-*.mjs` MUST run its check when executed directly and MUST
export `main({ repoRoot })`. Four of them (`verify-catalog-references`,
`verify-config-load-hash-coverage`, `verify-no-vitest-worker-mutation`,
`verify-workspace-src-aliases`) previously shipped as pure libraries with no
`main()` invocation, so `node scripts/verify-catalog-references.mjs` exited 0
while checking nothing. Control-tested: injecting a literal `"typescript":
"6.0.3"` into a package manifest — the exact drift the guard exists to catch —
still produced exit 0.

Enforcement was never missing; each paired test asserts the real-repo verdict
under `pnpm test:scripts` in the Static job. The damage was evidentiary — that
exit 0 was cited as proof in a PR body, and a green from a script that cannot go
red is indistinguishable from a real one.

`scripts/__tests__/verify-script-entrypoints.test.mjs` holds the line, and its
MONEY TEST is the load-bearing half: it drives every `main()` against an empty
directory and fails any that report success. A `function main() {}` no-op
satisfies the static "has an entrypoint" check while reproducing the bug exactly,
as does a `main()` that accepts `repoRoot` and ignores it — both are covered.

Consequences when adding a guard: thread `repoRoot` through to the check rather
than closing over a module-level constant, and make the CLI's verdict identical
to the paired test's (e.g. `verify-workspace-src-aliases`'s `main` passes
`appsRoot` explicitly because the CI-wired test does — a CLI checking a narrower
tree than CI is a second, weaker verdict wearing the same name).

`verify-tokenizer-asset-bundle` and `verify-no-cross-chunk-cycles` are the
shape exceptions: each inspects a build artifact, so it takes a bundle
`directory` instead of a repo root.

### Desktop E2E process-exit guard (BST-1087)

Desktop E2E fixture teardown is a correctness boundary, not cleanup-only.
Every process launched by `ElectronHarness` is registered with
`ElectronProcessExitGuard`. Any exit before the fixture begins intentional
close fails the owning Playwright test with the recorded code and signal, even
when the test body already passed. Once intentional close begins, both graceful
exit and the harness's bounded forced-termination path are accepted. Before
marking a close intentional, the guard checks the child process's recorded exit
state so a reaped process cannot be misclassified while its Node `exit` event is
still pending. The anti-vacuity floor applies after a context successfully
launches; a skipped test or a launch that already threw is not replaced by a
fixture-teardown error. Restart uses the same close/guard path and must surface
close failures; if close and process health both fail, both errors are retained.
Do not restore the former warn-and-relaunch behavior.

### E2E lane-coverage contract (BST-1010)

`scripts/e2e-lane-coverage.mjs` (paired test:
`scripts/__tests__/e2e-lane-coverage.test.mjs`, run in the Static job via
`pnpm test:scripts`) statically proves that every Playwright spec in `apps/web`
and `apps/desktop` is selected by some lane CI actually invokes.

BST-1010 was filed as a *nightly selection audit* — run the full suite, diff it
against affected-selection. Both premises were wrong and the ticket was reduced:
the nightly already exists (`web-e2e.yml` cron 07:37, `desktop-e2e.yml` cron
07:53, both running `test:e2e:lane:full-regression`), and the cited bug class
(BST-891/816/817) is not a selection bug at all. It is lane wiring, computable
from source with no suite run. Two live instances the guard found on `main`:
`workspace-index-background-indexing.test.ts` carried `@web-indexing`, a tag no
lane grepped, on a `@stateful` describe that the broad pass grep-inverts; and
`production-csp.test.ts` carried `@stateful`, no lane tag, and appeared in zero
lane file lists. Both ran in no CI job. Each got a serialized dedicated lane —
deleting the `@stateful` tag to sweep them into the parallel broad pass would be
wrong, since one writes to the DB and the other runs PGlite search plus a real
local embedding.

Three assertions, over both apps: every `@web-*`/`@desktop-*` tag routes at
least one title somewhere; every TEST is reachable from at least one lane; every
explicitly targeted `test:e2e*` package script and inline workflow lane names
files that exist and selects a non-empty set. The third assertion intentionally
does not claim to model broad package scripts with no file list: their default
project selection can include suites outside this lane sweep (notably web
performance), while targeted scripts must state `--project` so the answer is
exact. The raw package-script floor protects discovery of the overall
`test:e2e*` surface. A separate floor is applied to the list this assertion
actually consumes: one explicitly targeted non-lane desktop invocation and none
for web today. That applicable count is printed in every verdict, and the paired
money test removes the desktop invocation and observes the floor fail.

**Reachability is resolved per test title, not per spec file** (review finding on
PR #2180). A file-granular answer marks a whole spec covered as soon as any ONE
of its titles is selected, so an untagged `@stateful` test sitting beside an
ordinary test the broad pass picks up reads as fully covered while running in no
CI job — the guard's own bug class, one level down. The failure output names the
dark `file:line` and title, because naming the file alone does not tell the
author which test is dark. The shape is not hypothetical: 11 real spec files
currently mix tag sets within one file (e.g. `git-panel.desktop.test.ts` has one
`@smoke` test that only the smoke lane can reach plus six the regression project
covers, and `embedding-worker-renderer.memory.desktop.test.ts` has one untagged
test that only full-regression reaches among eight `@desktop-embedding-*`
siblings). All are currently covered; the per-title check is what keeps them
honest. A whole-file `KNOWN_UNREACHABLE_SPECS` exemption is valid only while
EVERY title in the file is dark — partial coverage fails the entry rather than
letting it hide the titles still dark.

What holds it honest:

- **Selection is modelled exactly, not heuristically.** Reachability applies real
  Playwright semantics (explicit file list, project `grep`/`grepInvert`,
  command-line `--grep`/`--grep-invert`) to the real title paths parsed from each
  spec's AST via `listPlaywrightTitleEntries` in the shared
  `e2e-playwright-title-tags.mjs`. Anything unmodellable — an unknown
  `--project`, a positional that is not a spec path, a `--flag value` form the
  parser does not know, a `tag` that is not a literal — THROWS rather than being
  assumed benign.

  `titlePath` reproduces `TestCase._grepTitleWithTags()` exactly: for each
  ancestor suite its title THEN its tags, then the node's own title, then its own
  tags, space-joined. Two things that are easy to get wrong and were verified
  against real Playwright 1.61 `--list` rather than assumed:

  - **Tags inherit.** A tag on a describe routes every test nested inside it.
  - **`{ tag: '@x' }` counts.** Playwright's options form is NOT part of any
    title string, but it IS in the grep string. Reading title literals only made
    the guard wrong in both directions and hid three real desktop orphans
    (`agent-devtools`, `local-runtime-probe`, `secrets-settings` — each a
    `test.describe(..., { tag: '@smoke' }, …)` that the `regression` project
    grep-inverts and the smoke lane's file list omitted). There are 23
    options-form tag usages across `apps/*/e2e`; the array form
    (`tag: ['@a', '@b']`) is supported too.

  Both sibling consumers of this parser — `check-e2e-destructive-tags.mjs` and
  `check-e2e-readiness-contracts.mjs` — were silently affected by the same gap: a
  `{ tag: '@destructive' }` or `{ tag: '@stateful' }` describe was invisible to
  them, so each would have reported a FALSE POSITIVE on it (over-strict, not
  under-strict). No spec uses those two tags in options form today, so both
  scripts' real-repo verdicts are unchanged — but they are now correct for that
  shape rather than accidentally unexercised.
- **Only CI-invoked lanes supply coverage.** A lane is CI-invoked if a scoped
  workflow runs it or the `full-regression` aggregate runner references it. Detached
  package scripts cannot mark a spec covered merely by existing.
- **`LANE_WORKFLOW_FILES` is explicit, and that is the safe direction.** The
  `@desktop-embedding-*` lane is written inline in `desktop-e2e.yml` rather than
  as a package script, so workflows must be scanned. An inline lane in an
  unlisted workflow makes the guard report its specs as unreachable (loud red),
  never the reverse. Scanning every workflow is the UNSAFE direction:
  `local-desktop-e2e.yml` is a dispatch-only whole-suite shard run, and counting
  it would mark every desktop spec reachable and make the sweep vacuous.
- **Floors and self-cleaning exemptions.** `MINIMUMS` refuses to report a green
  when discovery collapses, and floors BOTH spec files and test titles — a parser
  regression returning zero titles per file would leave the file count healthy
  while every reachability question went vacuous. `KNOWN_UNREACHABLE_SPECS`
  entries fail if the listed spec becomes reachable, becomes only partly dark, or
  stops existing, so an exemption cannot rot into a permanent hole. It is
  currently empty after the inline desktop embedding lane adopted its former
  crash-b orphan.
- **The money test.** Per the BST-836 lesson below, the paired test drives the
  checker against a synthetic fixture repo carrying a planted orphan tag and
  orphan spec and asserts a non-zero exit, plus a clean control fixture, plus
  failure paths for a dangling lane file, a grep that matches nothing, a lane no
  CI entrypoint reaches, and — the case that verifies per-title granularity — a
  file holding one covered test and one dark sibling. That last case was
  control-tested against the pre-fix per-file logic and goes red there, which the
  other fixtures do not.

**Full-regression execution is fail-late, not shell-short-circuited (BST-1059).**
`apps/web` names the broad pass and ten serialized stateful/destructive lanes as
separate package scripts. `scripts/run-e2e-lane-sequence.mjs` invokes every one,
records each result, and exits non-zero after the final lane if any failed. A
failure in the broad or middle lanes therefore cannot starve tail lanes. The
workflow remains bounded: lane-level Playwright global timeouts total 130
minutes, eleven fresh web-server starts are capped at one minute each, and
`web-e2e.yml` allows 165 minutes total, leaving 24 minutes for install/build
overhead. Do not replace the runner with an `&&` chain or reduce the workflow
timeout below the aggregate lane and startup budgets.

**What a green does NOT prove:** that an externally cancelled or job-timed-out
run completed. The aggregate runner closes the ordinary lane-failure blind
window and prints per-lane START/PASS/FAIL plus a final failure summary, but a
static reachability verdict is not a run-artifact audit.

### The `__vitest_worker__` mutation guard (was: @vitest/runner teardown patch)

The "every test passes but vitest exits 1" flake (`Vitest failed to access its
internal state` thrown from a stray 100ms task-update `Timeout`, first seen in
CI run 29183123865, root-caused in BST-591) was caused by TEST CODE deleting
the `__vitest_worker__` global — a file-explorer coverage test did this to
simulate a non-test runtime. Vitest's task-update throttle timer is
legitimately armed mid-run; if it fires while that global is absent, the
worker crashes with an unhandled error. The window only collides under
event-loop starvation, so the flake surfaced in loaded full-graph/CI runs and
never in isolation. A pnpm patch on `@vitest/runner` that cancelled the timer
at end-of-run shipped 2026-07-12 and was later shown to be a placebo (an
end-of-run stray timer no-ops on already-flushed packs); it was removed in
BST-592 and the repo now carries ZERO `patchedDependencies` by policy — fix
dependencies upstream or at config level, never via `pnpm patch`.

Regression guard: `scripts/verify-no-vitest-worker-mutation.mjs` (test:
`scripts/__tests__/vitest-worker-global-mutation.test.mjs`, run in the Static
job via `pnpm test:scripts`) forbids `delete`/`Reflect.deleteProperty`/
assignment/`vi.stubGlobal` of `__vitest_worker__` in any test file under
`packages/` or `apps/`. To exercise "not running under a test framework"
branches, mock a detection seam instead — see
`packages/file-explorer/src/persistence/test-environment.ts`.

### Workspace-src alias guard (`pnpm test:scripts`)

`scripts/verify-workspace-src-aliases.mjs` (guard test:
`scripts/__tests__/verify-workspace-src-aliases.test.mjs`, run in the Static job
via `pnpm test:scripts`) prevents the #1066/#1207 regression class: a package
test lane importing another `@brainstrike/*` package at RUNTIME while its vitest
config declares NO workspace-src aliasing resolves that dep from BUILT `dist`
(via package `exports`) — stale/broken dist then silently passes.

The shared registry `@brainstrike/test-utils/workspace-src-aliases`
(`workspaceSrcAliases(packagesDir)`, a committed plain `.mjs` — no build step)
derives EXACT aliases from each package's own `exports` map: regex-exact package
root + each exported code subpath -> validated `src` file (missing source
throws). Asset exports (css/json/icons), src-pointing exports, and prebuilt
`*.worker` bundles get no alias; unexported subpaths are NOT captured (they fail
loudly under node resolution); a same-name wildcard export (preferences `./*`)
gets a validated narrow prefix. Package vitest configs spread it (config-local
mocks/dedicated helpers go BEFORE the spread — vitest `resolve.alias` is
first-match). `@brainstrike/agent` is excluded (Mastra/Node deps): consumers use
`createAgentBrowserSafeAliasEntries`. `@brainstrike/workers` has no `src/` dir:
consumers alias its subpaths explicitly.

The guard EXECUTES each discovered vitest config (base + integration + mutation +
models, and each inline project — projects do NOT inherit top-level
`resolve.alias`). Discovery is the `vitest.*config*.*` filename convention made
a CHECKED invariant: every vitest `--config`/`-c` reference in package scripts
and every stryker `configFile:` must be in the discovered set, else the guard
throws. Per config/project it closes the runtime `@brainstrike/*` specifier set
to a FIXPOINT over the src-resolved graph (a specifier that resolves into
another workspace package's source pulls in that package's non-test specifiers
— so transitive chains like embeddings → embedding-worker(src) → worker-runtime
are checked), then simulates vitest's first-match alias resolution: the winning
entry must point at an existing non-dist source path, and an unaliased
specifier must not resolve to `dist` via the dep's `exports` map. So dist-pin
overrides, imported-but-unspread registries, per-dependency gaps, bare mutation
configs, and transitive src-graph gaps all FAIL. Because the guard imports the
configs under plain node ESM, config-relative imports need explicit extensions
(e.g. `../config/src/vitest-browser.ts`). Legitimate built-artifact consumers
go in `WORKSPACE_SRC_ALIAS_ALLOWLIST` with a reason string (NO silent
fallback). This was the R3 enabler for dropping `test.dependsOn: ["^build"]` —
DONE in Series B4: `test`/`test:integration`/`test:coverage` now
`dependsOn: ["topo"]`, a synthetic no-op **transit node** (`topo`,
`dependsOn: ["^topo"]`) that carries the upstream SOURCE-hash cascade WITHOUT
building anything, so a `packages/types` edit no longer rebuilds ~39 packages
before a test runs. Plain deletion of the edge would be a stale-green landmine
(tests import upstream source, so a cached dependent must still re-hash when an
upstream's source changes); the transit node REPLACES the edge instead of
removing it. `topo` hashes the FULL default inputs (no test-file exclusions —
`__tests__/` dirs contain importable helper modules and no guard enforces
"never imported cross-package", so narrowing was reviewed out as a stale-green
vector; test-only over-invalidation is the cheaper failure mode). Explicit build edges survive in per-package
`turbo.json` where a test genuinely consumes a built artifact:
`@brainstrike/logging#test` needs its own `build` (logger-dist-singleton test
imports logging's `dist` by file URL); `@brainstrike/utils#test` needs its own
`build` (typescript-build-contract test inspects emitted files);
`@brainstrike/db#test`/`#test:coverage`
need `@brainstrike/utils#build` (migration-runner-types test's nested
`ts.createProgram` resolves utils types from `dist` — vitest aliases can't
intercept tsc); `@brainstrike/secure-fs-native#test`/`#test:coverage` need
their own `build` (the tests load the compiled `.node` addon — and the edge
must NOT be replaced by an inline `pnpm build &&` in the test script: that
shape raced turbo's concurrently-scheduled `build` task as two simultaneous
`node-gyp rebuild`s in one directory ("make: No targets specified and no
makefile found"; reproduced 2026-07-19). Guarded by
`scripts/__tests__/native-addon-build-uncached-contract.test.mjs`; the
`native-windows` job bypasses turbo and therefore builds explicitly before
testing).

BOTH native lanes are also `cache: false`, not just `build`. `build` being
uncached guarantees a FRESH binary; it does not guarantee anything LOADED it,
so a cacheable `test`/`test:coverage` would replay a logged green without ever
dlopening the addon — the exact hazard the package's `test` task documents.
`test:coverage` is the easy one to miss because the ROOT `test:coverage` task
caches (unlike root `test:integration`), and `nightly-coverage.yml` runs
`turbo run test:coverage`. The guard above resolves EFFECTIVE cacheability
(package override → root task → turbo default) for every turbo-scheduled test
lane of a native package.

Because these lanes no longer build inline, invoking them OUTSIDE turbo and
without a prior build (`pnpm --filter @brainstrike/secure-fs-native test`, or a
bare `pnpm test:fast` / `test:coverage:base`, which use recursive `pnpm -r`
rather than turbo) finds no addon. This matches `@brainstrike/logging` and
`@brainstrike/utils`, whose built-artifact tests fail the same way without a
prior build, and the `check.mjs`
gate is safe because it runs `build` before the turbo test lanes sequentially
(BST-1009 replaced its `test:fast`/`test:coverage:split` steps with the same
`turbo run test` / `turbo run test:integration` invocations CI uses, so the
addon arrives through turbo's own `#build` edge either way). A preflight
(`test/ensure-addon.cjs`) turns that case into an actionable message naming the
build command instead of `bindings`' generic "Could not locate the bindings file".
It deliberately CHECKS rather than builds: auto-building on a miss would silently
reuse a stale addon after a C++ edit, and it would reintroduce a second build
declaration. The apps needed NO build edges: the B4 clean-state proof run
exposed gaps in their hand-maintained vitest alias maps (specifiers falling
through `exports` to dist — invisible while `^build` guaranteed dist existed),
closed by aliasing instead: apps/web gained the missing root aliases
(assistant-contract, chunking-worker, context-actions, file-system,
indexing-contract, storage); apps/desktop now spreads this same
`workspaceSrcAliases` registry (array-form alias, locals first) plus an
agent-root→src alias mirroring web (the registry deliberately excludes agent).
NOTE: this guard only checks `packages/*` — the app configs are outside its
scope, so app alias gaps surface as loud clean-state resolution failures, not
guard findings. Desktop's agent-client-loader test keeps a mirror of the
loader's FALLBACK_PROVIDERS that must stay in sync (raw createRequire there
bypasses vitest aliases and needs dist, absent by default post-B4). See the
Series B turbo-monorepo architecture review.

### TypeScript 7 CLI with the TypeScript 6 compatibility API (BST-1011)

All bare `tsc` commands use the TypeScript 7 native compiler. The catalog's
`@typescript/native` alias installs `typescript@7.0.2` at the root and owns the
`tsc` bin. The catalog's existing `typescript` name resolves to the official
`@typescript/typescript6@6.0.2` compatibility package: it owns `tsc6` and the
classic programmatic API, but deliberately does not own `tsc`. This is the
TypeScript team's supported side-by-side topology; do not replace it with two
aliases of the ordinary `typescript` package, which recreate an ambiguous bin.

Repository scripts, ESLint, Stryker, DB compiler tests, and the desktop
runtime-host boundary import `typescript` as a library and must continue to
resolve major 6. Type-check/build scripts execute `tsc` and must resolve major
7 from both root and package scope. `scripts/__tests__/typescript-compiler-wiring.test.mjs`
derives both the type-check-package and API-consumer sets dynamically, applies
anti-vacuity floors, checks the installed package/bin identities, and executes
both compilers. API-consumer discovery comes from `git ls-files`, so ignored
build/coverage output cannot change the census between a developer tree and CI;
an unresolvable consumer is reported as a violation instead of crashing test
module initialization, and workspace-state collection is lazy so failures occur
inside a named test. Package-manager subprocesses use the repository's
cross-platform spawn helper; do not call extensionless `.bin` shims directly.
Its mutation controls prove a swapped major, a native API consumer, an
unresolvable consumer, a compiler patch bump without renewed parity evidence,
editor TSDK drift, or a compatibility package shadowing `tsc` all fail loudly.
The complete wiring file costs about 1.4 seconds locally (seven tests, including
three compiler-version subprocesses) inside the roughly 14-second script-test
phase; keep that cost explicit if more process probes are added.

Desktop packaging is a separate boundary from workspace module resolution.
`apps/desktop/src/__tests__/build-main-config.test.ts` requires the concrete
TypeScript 6 implementation to be a production dependency and requires its
Electron Builder unpack rule. Its mutation control removes both seams and
asserts the exact violations, preventing a source-tree-only LSP green from
hiding a packaged-app failure.

`scripts/ts7-parity-check.mjs` compares every discoverable `--noEmit` command
under `tsc6` and `tsc`, checking binary majors before discovery. It deliberately
does not claim parity for `apps/web`'s emitting `tsc --build --force`; that path
must be verified in a clean isolated worktree so one compiler's declarations
cannot affect the other. The adoption evidence and reproduction commands live
in `docs/series-c-ts7-parity-findings.md`.

### Turbo 2.10 configuration audit and 3.0 preparation (BST-1013)

The root config opts into Turbo 2.10's `futureFlags.globalConfiguration` and
uses the Turbo 3.0 `global.concurrency` / `global.inputs` shape. This is a
mechanical config migration: a before/after `turbo run build type-check lint
test --dry=json` selected the same 47 packages and 235 task nodes. Under this
future flag, Turbo no longer reports these files in `globalCacheInputs.files`;
it injects them into each executable task's resolved inputs instead.
`scripts/__tests__/turbo-global-configuration.test.mjs` therefore expands the
configured globs, runs the pinned Turbo binary, and checks every executable
task at that actual boundary. Its floors require at least 10 matched global
files, 47 packages, 230 total task nodes, and 160 executable tasks. Mutation
controls remove one real input from one task and empty the task selection, and
prove both cases fail visibly. The structural tsconfig contract separately
proves the future flag/layout and the load-bearing tsconfig globs; its controls
reject the legacy layout and a missing preset input. Keep both controls when
editing the global block. On the same machine and base revision, the complete
script-test phase moved from 14.23 seconds / 781 tests to 15.00 seconds / 784
tests: +0.77 seconds (+5.4%). The Turbo dry-run is memoized within the test file
so the money controls do not spawn it twice.

**`global.concurrency` is the build/test calibration; the dev floor lives on
the dev script.** `turbo run dev` selects every workspace `dev` task and turbo
refuses to start when concurrency is <= the number of persistent tasks in the
selection — a property of that selection, not a parallelism budget. Raising the
global value to satisfy it is what produced the 28 → 29 → 30 → 31 → 32 treadmill
and, at 40 tasks vs. concurrency 40, a `pnpm dev` that failed outright. The
global value stays pinned at 40 (structurally, in the tsconfig contract) and the
root `dev` script carries `--concurrency=100`.

Be precise about who inherits the global value: not every CI invocation caps
itself. The Unit lanes pass `--concurrency=4` / `=2`, Type check sets
`TURBO_CONCURRENCY=4`, native-electron and coverage pass `=4` — but the **Build**
job (`test.yml`, `runs-on: ubicloud-standard-4`) runs `pnpm turbo run build`
with no cap and inherits the global number, as do local `pnpm build` /
`pnpm check`. Its effective parallelism is bounded by the build DAG's width, but
the global value is the ceiling, so treat a change to it as a change to Build.

`turbo-global-configuration.test.mjs` enforces the dev cap against a memoized
`turbo run dev --dry=json`: it must exceed both the planned persistent-task
count AND the workspace package count. The second bound is the one that retires
the treadmill — turbo can never plan more `dev` tasks than there are packages,
so a cap above the package count can never bind, and the guard goes red while
`pnpm dev` still works rather than on the commit that breaks it. Controls cover
a cap equal to the task count, a cap that clears the task count but not the
package count, a collapsed dev sweep, and a dev script with no cap at all. The
same file also pins `$schema` to the `package.json` Turbo version, so a bump
cannot leave editors validating against the previous release's schema.

Arithmetic over a planned graph assumes turbo enforces the rule at all, and
neither `--dry` nor `--graph` exercises that check while the real `dev` graph
cannot be run in a test (it launches every watcher). A money test therefore
proves the rule on a two-package fixture at the pinned binary: concurrency 2
against 2 persistent tasks must be rejected naming the floor, concurrency 3
must succeed. That is the file's dominant cost — measured on one machine, it
moved from 1.06 s / 2 tests to 5.88 s / 4 tests, roughly 3.7 s of which is the
fixture's two real turbo runs. Keep the fixture if a future turbo changes the
rule; without it the arithmetic could quietly guard nothing.

The same audit found no active repository use of Turbo 2.9's deprecated
`turbo-ignore`, `turbo scan`, `--parallel`, Turbo's `--no-cache`, daemon flags,
non-HTML `--graph` output, legacy remote-cache flags/environment variables, or
`prune --scope`. The only `--no-cache` match is Alpine's unrelated
`apk add --no-cache` in `scripts/setup-headless-display.sh`. Do not enable the
remaining 3.0 future flags speculatively: `filterUsingTasks` would change the
settled explicit affected filters in `test.yml`; the affected/watch/prune flags
have no adopted call site; `longerSignatureKey` needs the real remote-cache
signing setup to validate; and the diagnostic-only flag has no CI benefit.

Package-config composition was evaluated and deliberately not adopted. The ten
package `turbo.json` files now represent seven behavior classes; five are
unique cache-safety or cross-input contracts. Only app-shell/db-explorer/
vector-management and secure-fs-native/windows-job-native repeat behavior.
Introducing a config micro-package for groups of three and two would add graph
and ownership surface, while extending an operational package would couple
unrelated owners. Turbo's native `extends` is still the required mechanism if
a stable repeated policy grows large enough to justify a shared owner; do not
invent a merger or config registry.

Turbo 2.9's stable `query affected` was also evaluated but is not a CI planner.
Against `origin/main..HEAD` with no package change it correctly returned zero;
against the BST-1011 root/lockfile change it returned 48 package nodes including
the workspace root, or 46 with `--tasks test`. That offers no saving over the
Unit job's explicit `...[origin/$BASE_REF]` filters, cannot weaken the always-on
web/desktop smoke checks, and would create a second selection/reconciliation
seam. `scripts/run-turbo-command.mjs` also appends `--cache-dir`, which run
commands accept but `turbo query affected` rejects. Because no repository query
entrypoint was adopted, the bounded run wrapper was not broadened for an
unsupported command.

### Root clean orchestration

The root `pnpm clean` command stays on the shared Turbo command wrapper so it
retains the same grouped logs and run summary as the other root graph commands.
The root `clean` task is uncached, declares no outputs, and has no dependency
edges. Every workspace package with a `build` script must declare `clean`;
TypeScript and app packages remove local `dist`/`.tsbuildinfo`, while native
addon packages remove their local node-gyp `build` directory. The command,
complete build-package coverage, and resolved task graph are guarded by
`scripts/__tests__/package-scripts-canonical-form-contract.test.mjs`.
That test invokes Turbo's JavaScript entrypoint through `process.execPath`;
do not execute the generated `turbo.cmd` shim directly, because Node 24 rejects
batch files passed to `execFileSync` on Windows.

### Stale-dist pruning before non-cleaning tsc builds (2026-07-30 cache poisoning)

tsc's incremental builder never deletes outputs whose sources are gone, and the
nested Turbo run by apps/web + apps/desktop `prebuild`/`predev`
(`scripts/run-turbo-command.mjs`) snapshots each package's whole `dist/**` into
the machine-global cache (`~/Library/Caches/BrainStrike/turbo`). A branch
switch that deletes sources therefore leaves orphaned compiled files in `dist`,
and the next cache save immortalizes them: cold runs restore the poisoned
archive verbatim even after local deletion, tripping `turbo boundaries`
(2026-07-30 incident: 16 boundary issues, 125 poisoned archives purged).

The guard: every build-chain script (`build`, `prebuild`, `postbuild`,
`build:*`) that runs an emitting tsc (any form without `--noEmit` — `-b`,
`--build`, `--project ... --emitDeclarationOnly`, bare `tsc`) must either
clean `dist` first or prepend `node <depth>/scripts/prune-stale-dist.mjs`.
The pruner resolves the package's real tsc program (tsconfig
extends/include/exclude respected, via the TypeScript config loader) and
deletes dist artifacts no program source would emit. Program membership — not
filesystem existence — is the orphan test: a `dist/foo.test.js` whose
`src/foo.test.ts` still exists but is tsconfig-excluded is an orphan (most
wired packages exclude `**/*.test.*`, and compiled tests import vitest — the
exact `turbo boundaries` shape). Two carve-outs: outputs of on-disk
`.js`/`.jsx` sources outside the program are kept (bundler entries like
file-explorer's `.worker.js`), and `.json` pruning activates only when the
program itself contains json sources (db's `drizzle/migrations.json`) — a
generated dist json (a `{"type":"commonjs"}` marker, a copied manifest) is
produced, not compiled, and deleting it would not self-heal. Residual class,
accepted: a generated dist json inside a json-compiling package.

Pruning — not cleaning — is deliberate for the wired packages: it preserves
incremental builds, and it is safe under concurrent builds of the same package
(the reason agent's tsup pins `clean: false`) because a concurrent build only
emits files whose sources are in the current program, so the prune set is
disjoint from its writes. That disjointness silently depends on tsup NOT
code-splitting (hashed split chunks have no source counterpart and would be
pruned out from under a sibling build), so the wiring contract statically
requires `splitting: false` in every pruned package's tsup config. After
BST-1014, `agent` and `file-explorer` are the complete live intersection of
pruned packages and real bundle boundaries; the paired test pins its
anti-vacuity floor to both while continuing to discover and inspect every future
intersection member. The pruner
itself requires `tsconfig.json` with rootDir `src` and outDir `dist` and
per-file emit — anything else throws, and such a package must clean instead. `ui`'s
`pnpm run clean:generated` cleans stray compiled JS in `src`, not `dist` — it
does not satisfy this contract (ui's `dist/prompt-management` was a proven
poisoning vector behind exactly that prefix). The contract scans build-chain
scripts only: `type-check`'s emitting `tsc --build --force` (apps/web) cannot
create orphans or archives — only `build` has `dist/**` outputs, and the prune
before every snapshot-producing build launders dist before archiving. The
wiring contract, pruner behavior, entrypoint controls, and the `turbo.jsonc`
`global.inputs` hash entry for the pruner (editing it must invalidate
cached builds) are guarded by `scripts/__tests__/prune-stale-dist.test.mjs`.

### Canonical package build strategies (BST-1014)

Non-native typed packages have two JavaScript build classes, derived from
`scripts.build` rather than from a package registry:

- **Libraries use TypeScript emit.** A plain library builds JavaScript and
  declarations together with `tsc -b`. All 30 libraries with the canonical
  `rootDir: src` / `outDir: dist` layout prepend
  `node ../../scripts/prune-stale-dist.mjs`; it removes deleted-source artifacts
  without discarding `.tsbuildinfo`, so a normal build does not turn
  TypeScript's project-reference builder into a forced clean rebuild. The sole
  tsc-only layout exception is `workers`: its source files live at the package
  root, outside the pruner's deliberately narrow safety contract, so it keeps an
  explicit clean. This is derived from resolved compiler layout, not a package
  allowlist. A TypeScript-emitted library does not retain a tsup config, tsup
  dependency, or tsup watch command.
- **tsup is for real bundle boundaries.** Eight packages require bundling:
  `chunking-worker`, `embedding-worker`, `file-tree-worker`, and `token-cache`
  package browser workers/WASM/assets; `agent` produces the self-contained
  hosted-web boundary; `assistant-service` and `assistant-wire` retain the CJS
  surface consumed by the Node16 web API project; and `file-explorer` emits the
  renderer's worker-storage artifact. Adding a ninth bundler is an architectural
  decision, not a convenient way to emit a second module format.
  This is the compatibility boundary for BST-1014, not an endorsement of tsup as
  the R10 endpoint: upstream marks tsup unmaintained and recommends tsdown. A
  replacement must preserve the custom worker/WASM/assets and CJS contracts and
  carry measured artifact and wall-clock evidence; swapping emitters inside the
  library migration would combine those risks and make regressions unattributable.
- **Native addons remain native builds.** `secure-fs-native` and
  `windows-job-native` use `node-gyp`; the build-strategy guard recognizes that
  structural class rather than pretending a TypeScript or tsup command owns the
  native artifact.
- **Node-compatible emitted ESM is compiler-enforced.** Libraries migrated from
  tsup extend `packages/config/tsconfig/node-library.json`, whose `module` and
  `moduleResolution` are `NodeNext`; declare `type: module`; expose the one emitted
  runtime artifact through `types` + `default`; and spell local TypeScript imports
  as `.js` in source. TypeScript therefore rejects extensionless relative imports,
  directory imports, invalid package-export subpaths, and missing JSON attributes
  during every editor/type-check/build pass. A `require` export condition is not a
  synonym for “Node can require synchronous ESM”: it must point to a real CJS
  artifact. A CommonJS composition boundary that consumes one of these libraries
  uses native dynamic `import()` (and an explicit `resolution-mode: import` for
  type-only imports) rather than forcing the library back into dual-format
  bundling. The Vercel API's Node16 check proves both are load-bearing: a static
  logger import fails TS1479 and a plain type-only import fails TS1541. The route
  memoizes the import lazily inside the first request so a failed seam is observed
  by that request, never left as a module-initialization rejection. Playwright's
  TypeScript loader is a distinct CommonJS
  transform boundary: a Node-side E2E helper imports the narrowest side-effect-
  free contract subpath it needs instead of a package barrel that transitively
  loads browser-oriented `import.meta` modules. Desktop assistant mocks pin this
  through `@brainstrike/assistant-contract/assistant-stream-session`; the desktop
  smoke lane is the runtime proof.
- **Browser-only emit keeps Bundler resolution.** `file-explorer-hooks` is a
  React/Vite library whose public surface imports the browser-only `ui` barrel.
  That barrel's declarations intentionally model a bundler and contain
  extensionless re-exports; consuming them under NodeNext loses named exports
  behind `skipLibCheck` (TS2305 at the hook tests). The package therefore extends
  the shared Bundler config while still using the same canonical `tsc -b` build.
  Module resolution follows the runtime that loads the emitted graph; it is not
  a second build strategy.

`scripts/verify-package-build-strategies.mjs` (alias
`lint:package-build-strategies`, present in both lint chains) enforces the two
classes, the native-addon exception, the exact bundler budget, incremental-safe
cleanup for every compatible src-to-dist library, removal of every supported tsup config-file
shape/dependency/dev command, canonical `tsup.config.ts` for current bundles,
NodeNext manifest conditions, and that every dist code export is an output of
the package's parsed TypeScript program. TypeScript's config loader resolves
array and indirect `extends`; the guard does not approximate inheritance or
re-parse module syntax. Discovery comes from workspace manifests and resolved
compiler configs; there is no identity mapping file. Its anti-vacuity floors
cover typed build packages, tsc-only libraries, incremental-safe pruned
libraries, and NodeNext consumers. The
paired `scripts/__tests__/verify-package-build-strategies.test.mjs` money tests
mutate each protected seam, while a real compiler control observes NodeNext
rejecting an extensionless ESM import with TS2835.

### Agent declaration build split

`@brainstrike/agent` declarations are emitted by the package's composite
TypeScript project before tsup bundles JavaScript. Every agent tsup config
inherits `dts: false`; do not restore tsup's declaration-bundler worker or its
separate compiler-options override. The canonical `tsconfig.json` owns the
assistant-contract path mapping and emits every public entry declaration plus
the internal declaration graph those entries reference.

Development runs a project-only TypeScript watcher and the tsup watcher as
named sibling processes through the package's direct `concurrently`
dependency. The declaration watcher must use `tsc --project`, not
`tsc --build`: referenced packages own separate Turbo watchers, so build mode
would create multiple processes that can concurrently emit into the same
dependency `dist` directories. The watcher supervisor must terminate the
sibling when either process exits, so a failed declaration watcher cannot
leave a stale-but-running JavaScript watcher. The build order, disabled tsup
DTS worker, project-only declaration watch, and two-watcher topology are
guarded by `scripts/__tests__/agent-declaration-build-contract.test.mjs`.

### tsup clean/dts invariants (`pnpm lint`, BST-746)

`scripts/verify-tsup-build-invariants.mjs` (alias `lint:tsup-build-invariants`,
in both the `lint` and `lint:ci` chains; guard test:
`scripts/__tests__/verify-tsup-build-invariants.test.mjs`) generalises the rule
above from `@brainstrike/agent` to every workspace package. A package whose
`build` runs `tsc -b` must not let tsup `clean` the outDir (TypeScript wrote the
`.d.ts` files into it first, and tsup's clean is not concurrency-safe against the
sibling workspace builds that concurrent app prebuilds trigger) and must not let
tsup emit declarations (the separate declaration-bundler worker duplicates
`tsc -b` and causes severe build startup contention).

BST-746 originally proposed a `createTsupConfig` factory in
`@brainstrike/build-utils`. Measured and REJECTED — do not relitigate: at that
time only 9 of 18 configs were simple, and they genuinely diverged on
`sourcemap`, `format`, `target` and `splitting`. A factory would also have added
8 build-graph edges or hit the config-load hash-gap class
`verify-config-load-hash-coverage.mjs` guards. BST-1014 resolved the ordinary
library duplication by removing tsup from those packages, not by abstracting
their obsolete configs; the eight remaining configs describe real, divergent
bundle boundaries.

The invariant is CONDITIONAL, and the class is DERIVED from each package's
`build` script rather than hand-listed. **TypeScript-owned** — `agent`,
`assistant-service`, `assistant-wire`, `embedding-worker`, and `file-explorer` —
runs `tsc -b`/`tsc --build` then tsup, and is governed. **tsup-owned** — exactly
`chunking-worker`, `file-tree-worker`, and `token-cache` — runs tsup ALONE
(`type-check` is a separate `tsc --noEmit`), so tsup is the only possible
declaration emitter and `dts: true` is REQUIRED there. A flat "every config sets
clean/dts false" rule is false for those three. The exemption carries the
INVERSE obligation (a tsup-owned package that enables no declaration emit
FAILS), so it cannot be used as a parking spot to silence a violation; a test
pins the exempt set to those three names so growing it is deliberate.

Three rulings, all enforced and all with failure-path tests:

1. **Dynamic values are rejected**, not assumed safe. Only the literal `false`
   passes; `!options.watch`, a ternary, an env read, and the non-boolean shapes
   tsup accepts (`clean?: boolean | string[]`, `dts?: boolean | string |
   DtsConfig` — every non-false value ENABLES the behaviour) all fail. The guard
   reads source text and cannot prove an expression is false at build time.
   `clean: !options.watch` is not a false positive because every config using it
   is tsup-owned; in a `tsc -b` package it SHOULD fail, since `options.watch` is
   falsy during a plain `pnpm build`.
2. **`clean` and `dts` must be STATED EXPLICITLY** in a governed config that
   exists. tsup's defaults already match, so omission is currently harmless —
   which is the problem: `text-splitter` set neither while the guard claimed all
   governed packages were "pinned", an unverified assertion (the vacuous-green
   class the discovery floors exist to prevent), and deleting `clean: false` from
   a config would have been a silent no-op. The lower-level guard still models
   config-less tsup CLI invocations so its own flag detector cannot be bypassed,
   while the canonical package-build guard rejects that third real-tree shape.
3. **Every declaration-emit spelling is modelled**, verified against the
   installed tsup 8.5.1 rather than from memory: config keys `dts` AND
   `experimentalDts`, plus four CLI flags — `--dts`, `--dts-only`,
   `--dts-resolve`, `--experimental-dts`. tsup normalises
   `if (flags.dts || flags.dtsResolve || flags.dtsOnly)`, so `--dts-only` and
   `--dts-resolve` each enable emit ON THEIR OWN; they are not modifiers of
   `--dts`. `experimentalDts` may be omitted but never enabled.

Discovery floors (`MIN_TSUP_CONFIGS` = 8,
`MIN_TYPESCRIPT_OWNED_PACKAGES` = 5) refuse to run rather than report a vacuous
green — the second catches a collapsed classification, where discovery looks
healthy but the governed class has emptied out. Config parsing is line-shaped
with comments blanked (preserving line
numbers, which are printed in the report) after normalizing Windows CRLF input
to LF; a permissive cross-check THROWS on any
guarded token the line shape did not parse, so an unmodelled shape fails loudly
instead of escaping.

### App bundle chunk ceiling and tokenizer asset

Both app Vite builds use a 1,300 kB JavaScript chunk warning ceiling. This
accepts the measured local-first worker runtimes (browser bootstrap, PGlite,
and Transformers) plus the current renderer/main, context-preview, and
workspace-sync entry chunks while preserving a warning for growth beyond the
largest reviewed output. Do not raise the ceiling to accommodate tokenizer
data.

The browser `o200k_base` table is resolved through Vite's `?url` asset contract
and fetched only when an accurate-token-counting worker first initializes.
Keep the table out of JavaScript chunks and out of both apps' initial HTML
module-preload closure. Heuristic counting must not fetch the table. The
runtime behavior and both app ceilings are pinned by the tokenization package's
strict-counter/worker-lite tests and app Vite-config tests.

`@brainstrike/tokenization` is an ordinary tsc-only library and the sole source
owner. Its root exposes only synchronous constants, heuristics, and cost helpers;
its only public subpaths are the strict-counter and worker-lite modules that have
real consumers. Importing the root cannot pull tokenizer assets into an eager
graph. `chunking-worker` and `token-cache` bundle those shared entrypoints into
their own isolated artifacts; neither owns a source shim or imports the other
worker package.

The `chunking-worker` and `token-cache` tsup builds must install the shared
`tokenizerAssetPlugin` so their published worker artifacts preserve that URL
contract instead of parsing the table into JavaScript. Both package build
scripts run `verify-tokenizer-asset-bundle.mjs`; do not remove that post-build
guard when changing their bundle topology.

Both app builds install the shared
`createCspQualifiedEvalWarningFilter`. It suppresses Rolldown's `EVAL` warning
only for the exact web-tree-sitter 0.25.10 and PGlite 0.5.3 files whose real
runtime paths were exercised under the production CSP without `unsafe-eval`
(BST-573/594). The package versions and PGlite chunk filename are intentionally
pinned: an upgrade, a new emitted module, a different warning code, or an eval
from any other dependency must surface normally and require fresh review.
Never replace this with a code-only or package-wide warning suppression.

### Desktop development dependency freshness

`apps/desktop` runs `scripts/ensure-desktop-dev-deps.mjs` before every
development launch, including `dev:agent-debug`. Agent-debug runs that preflight
to completion before loading the Windows Job Object addon, then starts the
internal `dev:runtime` script under the initialized Job. This order is
mandatory on Windows: a loaded native addon cannot be replaced by node-gyp, so
loading the Job Object first would make a cold dependency build fail with
`EPERM`. The helper must always ask Turbo to build the exact `build-utils` +
`agent` + `ui` dependency graph.
Turbo's content hashes and cache are the freshness authority; checking only
whether `dist` files exist is forbidden because branch updates can leave
tool schemas, prompts, or provider code silently pinned to an older commit.
On a warm graph this check is cache-only and does not rebuild the desktop
renderer or unrelated packages. A non-zero Turbo result remains a visible
startup failure.

The shared `fullReloadOnCompilerHotspots` Vite plugin is the development HMR
boundary for cross-package React providers and stores. A hotspot update must
first call Vite's `moduleGraph.invalidateModule` for every affected module with
one shared invalidation set, the update timestamp, and importer invalidation
enabled; only then may it broadcast `full-reload` and return `[]`. Returning an
empty module set without that explicit invalidation leaves cached importer
transforms pointing at different timestamped module identities, which can make
a context consumer fail to see its mounted provider after reload. The contract
is pinned in `packages/build-utils/src/__tests__/vite.test.ts`.

### Agent-debug macOS automation identity

On macOS, `dev:agent-debug` launches through a lightweight temporary
`Electron.app` shim inside its disposable profile. The shim symlinks the
installed Electron executable, Frameworks, and Resources, but owns an
`Info.plist` with display name `BrainStrike Agent Debug` and bundle identifier
`com.brainstrike.desktop.agent-debug`. It is not a packaged application, does
not copy Electron's framework payload, and is scoped to the isolated temporary
profile. Shim construction is fail-closed: an unexpected Electron bundle
layout or malformed plist aborts startup rather than falling back to the
ambiguous `com.github.Electron` identity. Agent-debug windows pin the native
and accessibility title `BrainStrike Agent Debug`.

The launcher re-enters the exact pnpm CLI recorded in `npm_execpath` through
`process.execPath`. On Windows this is required because Corepack exposes a
`pnpm.cmd` shim rather than an executable that `child_process.spawn` can invoke
directly without a shell. The recorded entrypoint must be an absolute
`pnpm.cjs`, `pnpm.js`, or `pnpm.mjs` path — Corepack-managed pnpm resolves to
the `.mjs` form under its cache (`.../corepack/v1/pnpm/<version>/bin/pnpm.mjs`)
on every platform, so all three are accepted; `pnpm.cmd` stays rejected because
re-entering a shim as a Node script is exactly what this contract prevents.
Missing pnpm launch context fails before the
disposable profile is created; child spawn errors are observed and flow through
the normal owned-tree/profile cleanup path. Do not replace this with the shared
shell-based spawn helper: the extra `cmd.exe` process would sit between the
launcher and the process tree whose ownership the Windows Job Object enforces.

The launcher owns its development subprocess tree. On POSIX, `pnpm dev` is the
leader of a detached process group; shutdown signals that exact group with
SIGTERM, waits for quiescence, and escalates to SIGKILL after a bounded grace
period. This remains effective when the direct `pnpm` child exits before a
late-writing Electron or PGlite grandchild. Although other Windows process-tree
helpers may use an ancestry walk while their direct child remains addressable,
agent-debug does not use that weaker path: its launcher first joins a private
Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then starts
`pnpm dev` console-bound so Ctrl-C can be handled gracefully. Every descendant
inherits the non-breakaway job, so membership remains authoritative after an
intermediate parent exits. Cleanup waits for the job to contain only the
launcher, then terminates only the remaining job members after a bounded grace
period. Missing or malformed native Job Object support aborts Windows startup;
there is no ancestry-walk fallback. Only after the owned tree is stopped may
the launcher remove its temporary profile. Process-tree or profile cleanup
failures are visible fatal errors with a non-zero exit, never warning-only
cleanup. The `Native Windows` required check builds and exercises the native
addon with a late-writing orphan plus an unrelated-process survival assertion.

#### Stale-profile sweep (abrupt-kill recovery)

In-process cleanup covers every exit the launcher can observe, but SIGKILL, a
panic, and loss of power run no handler at all, and nothing reclaims `$TMPDIR`
while the machine stays up — 121 profiles totalling 262 GB accumulated over a
single eleven-day uptime. Because the profile is also
`BRAINSTRIKE_DB_ROOT_PATH`, each abandoned profile retains a whole PGlite
cluster, so the leak is measured in gigabytes.

Each profile records an `agent-devtools-owner.json` marker
(`{ pgid, pid, platform, startedAtMs }`). `pid` and `platform` are written
immediately after `mkdtemp`; `pgid` is added right after `pnpm dev` is spawned,
because the group does not exist before then. On startup, after spawning its own
dev server, the launcher sweeps sibling `brainstrike-agent-devtools-*`
directories.

**A dead launcher pid is not proof the profile is idle.** On POSIX `pnpm dev` is
spawned detached, so SIGKILLing the launcher leaves the whole tree reparented and
still writing to this directory. Reclaiming on the pid alone would `rm -rf` a
live PGlite cluster — the historical failure, re-created from the other side —
and on macOS would also delete the running app's own `electron-dist` bundle.
Verified by experiment: after `kill -9` of the launcher, the detached tree stays
alive and keeps writing.

The sweep is opportunistic hygiene, **not** the ownership guarantee, and the two
must not be conflated:

- A sibling is reclaimed only when the launcher pid is dead **and** its recorded
  process group has no live members. Every uncertain liveness answer resolves to
  alive (`EPERM`, a recycled pid), so the sweep can only under-delete. An age
  threshold is deliberately **not** the deciding signal: a long-running
  agent-debug session is both old and live.
- A marker written before the current boot is reclaimable outright: no process
  from before the boot survives. Without this, pids re-issued from a low
  watermark after a reboot probe as alive against unrelated processes and the
  profile becomes permanently unreclaimable.
- On `win32` the launcher pid suffices — descendants inherit a non-breakaway Job
  Object with `KILL_ON_JOB_CLOSE`, so no tree outlives the launcher.
- A profile with a missing/malformed marker, or a POSIX marker with no recorded
  `pgid`, cannot be proven stale. It is reported as an explicit list of paths,
  **with no removal command**, and is **never** auto-deleted. Any glob in that
  report is paired with `ls -d` only: a `brainstrike-agent-devtools-*` glob also
  matches a concurrent session's profile.
- Skipped and failed profiles are both reported. Skipping is the safe answer,
  but a machine where the sweep never reclaims anything must not look identical
  to one with nothing to reclaim.
- The sweep runs after the dev server is spawned, so it overlaps startup instead
  of delaying it, and it never fails a launch. The run's own profile stays
  fail-loud through `removeUserDataDir`; do not make the sweep fatal to "match"
  it.

The marker sits at the profile root, which is safe only because the database
joins `<root>/profiles/<profile>` and never enumerates the root. Re-verify that
before adding anything else there.

Manual QA must cover both automation surfaces while another Electron app is
running:

1. Run `pnpm --filter @brainstrike/desktop dev:agent-debug` and connect CDT to
   the printed local CDP endpoint (default `http://127.0.0.1:9222`). Confirm the
   visible target is the expected BrainStrike renderer.
2. In Computer Use, verify `list_apps` reports
   `com.brainstrike.desktop.agent-debug` as `BrainStrike Agent Debug`, then call
   `get_app_state({ app: "com.brainstrike.desktop.agent-debug" })`.
3. Confirm the accessibility tree describes the same renderer URL/title seen
   through CDP. Do not stop or retarget unrelated Electron processes.
4. Stop the documented root command with Ctrl-C, wait for it to exit, and
   confirm the printed `brainstrike-agent-devtools-*` profile remains absent
   after a bounded post-exit observation. Keep unrelated Electron processes
   running throughout this check.
5. Verify abrupt-kill recovery in the correct order — the orphaned tree must be
   spared, not reclaimed, while it is still alive:
   a. Start the launcher, `kill -9` its pid, and confirm the printed profile
      survives and the orphaned Electron/PGlite tree is still running.
   b. Start a second session. It must report the profile as *still in use* and
      leave it on disk. Reclaiming it here would delete a live database.
   c. Kill the orphaned process group, then start a third session and confirm it
      now reports reclaiming that profile and the directory is gone. A
      concurrently running session's profile stays untouched throughout.

---

## REACT DOCTOR (LINT + DEAD CODE)

`.github/workflows/react-doctor.yml` runs **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.9.3`) on every PR and on push to `main`. It supersedes running standalone knip in
CI: React Doctor performs knip-style dead-code analysis (the bundled `deslop` engine) **and**
its React/JS lint rules (Security / Bugs / Performance / Accessibility / Maintainability).
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`.

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs. Version
  0.9.3 carries [upstream's rename-aware baseline comparison](https://github.com/millionco/react-doctor/pull/1376),
  so moving unchanged code does not reclassify its diagnostics as new. CAVEAT (BST-981,
  2026-08-06): that pairing failed on a ~200-file rename PR — byte-identical renamed files
  had their pre-existing diagnostics reclassified as new, both in CI and in a local
  `--scope changed` run. Precedent: prove pre-existence with a full scan of the base at the
  old paths, then suppress narrowly via `ignore.overrides` with a follow-up ticket to fix
  the findings and drop the override. BST-1182 completed that cleanup for the three
  assistant-ui ref mutations and removed the temporary override; the caveat remains for
  future large rename sets, not as an active exception.
  `scripts/__tests__/react-doctor-version-contract.test.mjs` keeps the local and Action pins equal
  and rejects downgrade below the 0.8.2 fix.
- **knip is retained, NOT replaced.** `deslop` is not knip: it reads knip's `entry`/`ignore`
  (only from strict-JSON `knip.json` or `package.json#knip`, never `knip.jsonc`) but ignores
  knip's `ignoreDependencies` and has no per-dependency allowlist. So `deslop/unused-dependency`
  + `deslop/unused-dev-dependency` are disabled in `doctor.config.ts`, and `pnpm knip`
  (driven by `knip.jsonc`, with the curated false-positive allowlist) stays the dependency auditor.
- **No broad `ignore.files` exclusions.** The old 0.5.5/0.7.1 implementation silently dropped
  roughly half the monorepo when that key was present. Upstream 0.9.3 fixes enumeration by
  listing all supported sources before filtering, but Brainstrike still needs no whole-file
  ignores: build artifacts are gitignored and test-file noise is handled natively. Prefer the
  narrow `ignore.overrides` / `rules` surfaces for a proved exception.
- **`Accessibility` + `Security` categories are OFF.** a11y is already enforced by the
  biome a11y rules (and react-doctor can't read `biome-ignore`, so it re-flagged every
  documented exception + custom ARIA widget — an audit of 28 findings found 1 genuine
  gap). Security produced 0 genuine issues across 6 real-source findings; secret detection
  stays covered by the lefthook `secrets-scan`. react-doctor's unique value here is its
  React-Compiler-correctness rules (`react-hooks-js/*`, `react-compiler-*`) + dead-code,
  which is where remediation effort is focused.
- **`react-compiler-no-manual-memoization` is OFF.** Manual `useMemo`/`useCallback`/
  `React.memo` is intentional here (guards non-React work, external-store identity,
  referential stability for consumers outside the compiled tree). The rule fired 1211× (54%
  of the original backlog) demanding removal — disabled per team decision.
  `react-hooks-js/preserve-manual-memoization` stays ON (it protects memo the compiler needs).
- **An unimplemented rule id is accepted SILENTLY — 0 findings means "gone" OR "clean".**
  `doctor.config.ts` emits no "unknown rule" error, so a config that believes it enabled
  (or disabled) a rule is indistinguishable from one that did not, and that rule's zero
  findings read as a passing gate. Proved on `react-doctor/only-export-components`
  (2026-08-09, pinned 0.9.3): the id appears in the bundle ONLY as a *value* in the
  oxlint→react-doctor alias tables (`react-refresh/only-export-components` and
  `react/only-export-components` both map to it) with no rule implementation behind it,
  and adding `rules: { 'react-doctor/only-export-components': 'warn' }` left counts
  byte-identical (149 → 149 on `packages/file-explorer-ui`). **Before citing a
  react-doctor rule id as a contract, prove it fires on a known violation** — a
  package-scoped scan returning 0 is not evidence.
  `scripts/__tests__/lint-rule-liveness-contract.test.mjs` mechanizes that proof — **for
  ESLint rules only.** It drives `new ESLint({ cwd: repoRoot })` against `eslint.config.js`,
  so it exercises **zero react-doctor rules** and confers no coverage on any
  `react-doctor/*`, `react-hooks-js/*`, or `deslop/*` id. Do not read a green
  `test:scripts` as evidence that a react-doctor id is live; that engine remains
  unmechanized, and it is the one with the silent-acceptance defect.
- **Two other cited react-doctor ids are also absent from the 0.9.3 bundle** (2026-08-09,
  #2372). `react-hooks-js/preserve-manual-memoization` — asserted above to "stay ON" — and
  `react-doctor/async-parallel`, the rule in `doctor.config.ts`'s lone `ignore.overrides`
  entry, each appear **0 times** across `node_modules/react-doctor/dist/`, while real ids
  appear literally (`only-export-components` 12, `react-compiler-no-manual-memoization`
  10). Neither has been *empirically* confirmed dead: a local `npx react-doctor packages/db`
  emits no findings summary at all, which is BST-1142 (react-doctor local runs returning
  zero analyzed files). **Nothing was changed on grep evidence alone** — the override stays
  until BST-1142 unblocks a real before/after. Note the manual-memoization protection does
  still exist, just not via the engine the bullet above names: eslint-plugin-react-hooks'
  own `react-hooks/preserve-manual-memoization` is live, reporting 2 warnings, and is now
  tracked in `eslint-warning-baseline.json`.
- **The Fast Refresh module-boundary contract is NOT react-doctor's — it is
  `react-refresh/only-export-components` in `eslint.config.js`** (BST-1220, #2372, plugin
  `eslint-plugin-react-refresh`), riding the same `--max-warnings` ratchet as the
  compiler diagnostics. It landed at 155 warnings across 77 files; burn it down and lower
  its baseline entry, exactly as for the compiler wave.
  **That ratchet is now PER RULE.** `eslint-warning-baseline.json` holds one budget per
  rule id and `scripts/verify-eslint-warning-baselines.mjs` enforces it as `lint:eslint`.
  A rule OVER its entry fails; a rule UNDER its entry also fails until the entry is
  lowered, so every burn-down is banked instead of leaving headroom behind; a rule with
  findings and no entry fails; error-severity findings never get a budget. This replaced a
  single `--max-warnings=N` scalar, which could not tell the two warning families apart —
  burning Fast Refresh warnings silently granted the same headroom to compiler
  diagnostics. The scalar had already failed that way: #2372 found 186 actual warnings
  under an unchanged 194 ceiling. Re-baseline with
  `pnpm run lint:eslint --write-baseline`, and read the diff — an unexplained drop is a
  rule going dark, not a win. Biome's `useComponentExportOnlyModules`
  was evaluated and rejected for this job despite already being installed and already
  blocking: measured against this repo it also flags unexported components (63 sites —
  not a defect, since `@vitejs/plugin-react`'s `validateRefreshBoundaryAndEnqueueUpdate`
  walks `moduleExports` only, so a private component never breaks the boundary) and
  misreads `export default <Component>` aliases (29 false positives, e.g.
  `logging-settings.tsx`, whose only exports are one component named and defaulted).
  The eslint plugin matches the Vite runtime semantics; do not swap in Biome's rule
  without re-measuring both.

Local: `pnpm run react-doctor` (full scan, telemetry off via config) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

**The script is named `react-doctor`, not `doctor`, and the `run` is not optional.**
`doctor` is a pnpm **builtin** subcommand, so `pnpm doctor` <!-- shadowed-shorthand-example --> runs pnpm's own
environment doctor and never reaches any package script — while printing
`All checks passed with 1 warning(s)` and exiting 0, which reads exactly like a
clean react-doctor run. Because react-doctor error-severity findings are a
required PR check, that false green can be followed by a red CI. The script was
renamed in BST-852 so the collision cannot be typed by accident, and
`scripts/__tests__/pnpm-shadowed-builtin-contract.test.mjs` fails if any package
reintroduces a shadowed script name or any doc reinstates the bare shorthand.
The shadow set is empirical, not read from `pnpm help -a` — that listing omits
`doctor` (hidden yet shadowing) and lists `clean` (visible yet harmless).

Two react-doctor CLI constraints worth knowing before you script around it:

- It takes a **directory only**. A file path fails with `not a directory`, so
  per-file checks are not possible.
- It takes **exactly one** positional argument (`too many arguments. Expected 1
  argument but got 3`), so covering several changed paths means several
  invocations — do not pass a changed-file list.

---
