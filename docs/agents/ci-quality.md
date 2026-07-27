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
`Web E2E`, `Desktop E2E`) plus both native jobs. Web and desktop E2E retain
their `build` dependency. Push and `workflow_dispatch` events are admitted
immediately, so their behavior is unchanged apart from the dependency edge.

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

### Primary Linux x64 jobs run on Ubicloud (BST-765)

`unit-shard`, `build`, `native-electron`, `web-e2e`, and `desktop-e2e` in
`test.yml` run on `ubicloud-standard-4`. That runner preserves the
4-vCPU/16-GB class used for the x64 work while moving the measured, dominant
Linux x64 lanes to the connected Ubicloud runner fleet. The boundary is
deliberate:

- quiet-head admission remains on GitHub `ubuntu-slim`
- Static and the Unit fan-in remain on GitHub ARM
- all three Unit shards use one fixed Ubicloud runner class
- Native Windows remains on GitHub Windows
- coverage, scheduled, review, and auxiliary workflows are unchanged

The Unit matrix moved as a whole after GitHub's ARM pool terminated the
`rest` shard without a failing test assertion on five consecutive attempts
across two exact PR heads (runs 30158896583 and 30175303301 on 2026-07-25).
Do not route individual shards to different providers: keeping one fixed
runner contract avoids a provider-selection layer while preserving the exact
partition, integration concurrency, and required `Unit` fan-in.

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

Nightly package coverage uses six static GitHub Actions matrix shards plus a
separate DB job. Five package shards isolate the measured heavyweight lanes;
the sixth is a negative-filter remainder, so a new package with a
`test:coverage` task is covered automatically instead of requiring registry
maintenance. Each job uploads its raw JSON in a tar archive. The final
`coverage` job fails closed unless all seven archives are present, restores
them into one workspace, and is the only job that runs
`coverage:prepare-workspace`, `coverage:enforce`, the merged report, and
Codecov. Do not replace this with a generated planner or raise the original
shared timeout: the split preserves one authoritative threshold decision while
giving slow packages independent failure and timeout domains.

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
`@brainstrike/utils#test` needs its own `build` (logger-dist-singleton test
imports utils' `dist` by file URL); `@brainstrike/db#test`/`#test:coverage`
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
rather than turbo) finds no addon. This matches `@brainstrike/utils`, whose
dist-singleton tests fail the same way without a prior build, and the `check.mjs`
gate is safe because it runs `build` before `test:fast` sequentially. A preflight
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

### Root clean orchestration

The root `pnpm clean` command stays on the shared Turbo command wrapper so it
retains the same grouped logs and run summary as the other root graph commands.
The root `clean` task is uncached, declares no outputs, and has no dependency
edges. Every workspace package with a `build` script must declare `clean`;
TypeScript and app packages remove local `dist`/`.tsbuildinfo`, while native
addon packages remove their local node-gyp `build` directory. The command,
complete build-package coverage, and resolved task graph are guarded by
`scripts/__tests__/package-scripts-canonical-form-contract.test.mjs`.

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
`@brainstrike/build-utils`. Measured and REJECTED — do not relitigate: only 9 of
18 configs are simple, and they genuinely diverge on `sourcemap`, `format`,
`target` and `splitting` (tsup defaults `splitting` to TRUE for ESM, so
build-utils/embeddings/text-splitter really do split). A factory would also have
added 8 build-graph edges (none of those packages depend on build-utils) or hit
the config-load hash-gap class `verify-config-load-hash-coverage.mjs` guards —
unifying the 4 fields that must stay different while doing nothing about the 2
that must stay the same.

The invariant is CONDITIONAL, and the class is DERIVED from each package's
`build` script rather than hand-listed (a list would be a second copy of a fact
already in the script, free to disagree with it). **TypeScript-owned** (17
packages, 14 with a config file) runs `tsc -b`/`tsc --build` then tsup, and is
governed. **tsup-owned** — exactly `chunking-worker`, `file-tree-worker`,
`test-utils`, `token-cache` — runs tsup ALONE (`type-check` is a separate
`tsc --noEmit`), so tsup is the only possible declaration emitter and `dts: true`
is REQUIRED there. A flat "every config sets clean/dts false" rule would have
been false for those 4 on the day it was written. The exemption carries the
INVERSE obligation (a tsup-owned package that enables no declaration emit FAILS),
so it cannot be used as a parking spot to silence a violation; a test pins the
exempt set to those four names so growing it is a deliberate decision.

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
   a config would have been a silent no-op. Config-LESS packages (`queue`,
   `types`, `worker-runtime`) are exempt from this — they have nothing to drift
   and are covered by the CLI check instead.
3. **Every declaration-emit spelling is modelled**, verified against the
   installed tsup 8.5.1 rather than from memory: config keys `dts` AND
   `experimentalDts`, plus four CLI flags — `--dts`, `--dts-only`,
   `--dts-resolve`, `--experimental-dts`. tsup normalises
   `if (flags.dts || flags.dtsResolve || flags.dtsOnly)`, so `--dts-only` and
   `--dts-resolve` each enable emit ON THEIR OWN; they are not modifiers of
   `--dts`. `experimentalDts` may be omitted but never enabled.

Discovery floors (`MIN_TSUP_CONFIGS`, `MIN_TYPESCRIPT_OWNED_PACKAGES`) refuse to
run rather than report a vacuous green — the second catches a collapsed
classification, where discovery looks healthy but the governed class has emptied
out. Config parsing is line-shaped with comments blanked (preserving line
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
runtime behavior and both app ceilings are pinned by the utils accurate-runtime
tests and app Vite-config tests.

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
development launch, including `dev:agent-debug`. The helper must always ask
Turbo to build the exact `build-utils` + `agent` + `ui` dependency graph.
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
pinned `0.7.1`) on every PR and on push to `main`. It supersedes running standalone knip in
CI: React Doctor performs knip-style dead-code analysis (the bundled `deslop` engine) **and**
~250 React/JS lint rules (Security / Bugs / Performance / Accessibility / Maintainability).
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`.

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs.
- **knip is retained, NOT replaced.** `deslop` is not knip: it reads knip's `entry`/`ignore`
  (only from strict-JSON `knip.json` or `package.json#knip`, never `knip.jsonc`) but ignores
  knip's `ignoreDependencies` and has no per-dependency allowlist. So `deslop/unused-dependency`
  + `deslop/unused-dev-dependency` are disabled in `doctor.config.ts`, and `pnpm knip`
  (driven by `knip.jsonc`, with the curated false-positive allowlist) stays the dependency auditor.
- **Never set `ignore.files`** (verified against 0.5.5, re-verified against 0.7.1). A non-empty `ignore.files` flips
  the lint pass to an explicit include-list and silently drops ~half the monorepo's real
  source from linting (e.g. packages/hooks 34 → 0). Build artifacts are gitignored (never
  listed) and test-file noise is handled natively (`test-noise`-tagged rules auto-suppress
  in non-production files). Suppress findings via `ignore.overrides` / `rules`, not files.
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

Local: `pnpm doctor` (full scan, telemetry off via config) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

---
