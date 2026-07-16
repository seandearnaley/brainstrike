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

### Static and Unit run on arm64 (Series C R9b)

`static` and `unit` in `test.yml` run on `ubuntu-24.04-arm`, not
`ubuntu-latest` (x64). arm64 runners became available for private repos on
2026-01-29 and cost 37% less per minute than x64. Probe P1 measured this
specific: `pnpm install --frozen-lockfile` (the native-deps/node-gyp set,
the main risk), lint, script tests, secret scan, and the 6 `cache: false`
`test:integration` suites (real PGlite, embeddings — the heaviest,
native-dependent work in the workflow) all genuinely ran and passed on
arm64. Wall-clock was AT PARITY with x64 (~3.0m either arch) — arm64 is
**not** faster here, only cheaper per minute; do not claim a speedup.
`build`, `native-windows`, `native-electron`, `web-e2e`, and `desktop-e2e`
stay on x64: P1 did not test them, and they are inherently
Electron/Playwright/Windows-bound work.

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

### Coverage is a separate workflow (`.github/workflows/coverage.yml`)

Coverage used to be a job inside `test.yml` running on every `synchronize` —
11-14 min of re-instrumentation on EVERY push. Series C R7 demoted it to once
per PR lifecycle: it runs on non-draft `opened`, `ready_for_review`, non-draft
`reopened`, or an explicit `coverage` label add. It does NOT run on
`synchronize`. `nightly-coverage.yml` remains the authoritative threshold gate;
per-PR coverage is advisory Codecov patch signal only.

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

### @vitest/runner teardown patch (pnpm patch)

`patches/@vitest__runner@4.1.9.patch` (wired via `patchedDependencies` in
`pnpm-workspace.yaml`) fixes a vitest-internal flake: the runner throttles
task-update RPCs with a 100ms `setTimeout` that is never cancelled at the end
of a run. Under loaded CI runners that stray timer can fire after worker-state
teardown and crash with "Vitest failed to access its internal state" as an
unhandled error — every test passes but the run exits 1 (CI run 29183123865,
file-explorer Unit job). The patch adds a `cancel()` to the throttle and calls
it from `finishSendTasksUpdate` (newly exported). Regression guard:
`packages/test-utils/__tests__/vitest-runner-throttle-teardown.test.ts` — it
fails loudly if a vitest bump drops the patch. When bumping vitest, re-apply
the patch (or verify upstream fixed the throttle) before deleting it.

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
intercept tsc). The apps needed NO build edges: the B4 clean-state proof run
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


