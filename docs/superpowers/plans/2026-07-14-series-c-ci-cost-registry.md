# Series C — CI cost + registry consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the remaining PR-pipeline waste (coverage-per-sync, Static's uncacheable floor, x64-only lanes) and collapse the four module-resolution registries to one, without touching the structural god-packages (Series D).

**Architecture:** Eight independent PRs (C1–C8) delivered as worktree-isolated lanes with adversarial review and merge-on-green, exactly like Series B. Two targeted probes gate the one risky PR (C3). Each PR is independently testable, independently revertible, and validated on the push path via `gh workflow run` where it touches CI.

**Tech Stack:** GitHub Actions (`.github/workflows/test.yml`), Turborepo 2.10, pnpm 11 workspaces + catalogs, Vitest 4, Biome, TypeScript 6 → 7 (native), the B3 `workspace-src-aliases` registry, the db lane manifest.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from `docs/superpowers/specs/2026-07-14-series-c-design.md`.

- **Operating model:** overseer dispatches each PR to a worktree-isolated implementation lane (opus or codex). Draft PR → adversarial review every round → merge ONLY when (a) every review comment is addressed or declined **with a reply** — a green `review` check is NOT the review — AND (b) all checks are green.
- **Push-path validation:** every workflow-touching PR (C1, C2, C3) MUST be validated with `gh workflow run test.yml --ref <branch>` before merge — PR checks exercise a different path than push (the #1066/#1207 lesson).
- **Cost claims from real timings only.** Prove before/after from actual `gh run view --json jobs` step durations. Never assert an estimate as measured.
- **Credential handling is USER-ONLY.** Never retrieve, mint, or enter `TURBO_TOKEN`/`CODECOV_TOKEN`/any secret, and never authenticate to Vercel or GitHub secrets. Verify-by-log is the only role here.
- **NO SILENT FALLBACKS.** Malformed config / unsupported routing / broken capability throws or surfaces visibly.
- **Separate-infra rule.** Any unrelated CI/infra flake found mid-lane goes in ITS OWN PR, never bundled into a Series C PR.
- **Stop for confirmation** before deleting files (C7 is pre-authorized by the design decision, but re-verify zero-consumers in-PR first), data migrations, irreversible terminal commands, or pushing to remote environments beyond the lane's own draft PR.
- **Node/pnpm floors:** `.nvmrc` is the single Node source; pnpm via `pnpm/action-setup@v6`. Do not pin versions inline.
- **Do-not-relitigate rulings** (from the spec's decisions log): R7 = ready_for_review + label; queue-telemetry-collector is deleted; TS7 = verify-then-adopt one PR; R6 source = the B3 registry (not vite-tsconfig-paths); declaration-only renderer builds are WON'T-DO.

## File Structure

Workflow-chain PRs (serialized — all edit `.github/workflows/test.yml`; each rebases on the prior):
- **C1** — `.github/workflows/test.yml` (coverage job `if:` + `pull_request` types).
- **C2** — `.github/actions/setup-workspace/action.yml` (new composite), `.github/workflows/test.yml` + `nightly-coverage.yml` + `web-e2e.yml` + `desktop-e2e.yml` + `performance.yml` (consume it), Turbo `.turbo` cache key re-key.
- **C3** — `.github/workflows/test.yml` (`runs-on` per job), `turbo.jsonc` (lint task `cache`/`inputs`), possibly `packages/config/biome/*` no change; new guard `scripts/verify-lint-cache-coverage.mjs` if the probe demands it.

Independent PRs (parallel — no shared files with each other):
- **C4** — root `package.json` (add TS7 native devDep + type-check binary wiring), `turbo.jsonc` (type-check task unchanged unless env needed), findings doc under `docs/`.
- **C5** — `apps/web/vitest.config.mts`, `apps/web/vite.config.ts`, `apps/desktop/vite.config.ts`, `packages/test-utils/workspace-src-aliases.mjs` (maybe a vite-shaped export), `scripts/verify-workspace-src-aliases.mjs` (extend to apps/*), new `scripts/verify-tsconfig-paths-match-registry.mjs`, root `tsconfig.json` (only if drift found).
- **C6** — `pnpm-workspace.yaml` (catalog), every `package.json` referencing catalogued deps, root `package.json` (drop `syncpack` + `deps:*` scripts), `pnpm-lock.yaml`, `renovate.json` (catalog support).
- **C7** — delete `packages/queue-telemetry-collector/`; edit `tsconfig.json` (lines 101–102, 240), `biome.json` (line 395), `architecture/domain-map.json` (line 105), `scripts/enforce-coverage.mjs` (line 79), `pnpm-lock.yaml`.
- **C8** — `packages/db/scripts/db-test-lane-manifest.mjs` (only if a gap is found), `AGENTS.md` + `docs/agents/*` (correct "register in BOTH" wording), possibly a new manifest guard test. **Reframed to verify-and-correct — see task.**

---

## Probe P1 — ARM runner viability (gates C3)

Run by the overseer from a throwaway probe branch; not a PR. Determines which lanes can move to `ubuntu-24.04-arm`.

- [ ] **Step 1: Create probe branch that flips Static + Unit to ARM**

On a fresh branch `probe/arm-runners`, edit `.github/workflows/test.yml`: change `static.runs-on` (line 34) and `unit.runs-on` (line 85) to `ubuntu-24.04-arm`. Leave `native-windows`, `native-electron`, `web-e2e`, `desktop-e2e` untouched (Electron/Playwright/node-pty are x64-verified paths).

- [ ] **Step 2: Dispatch and capture**

```bash
git push -u origin probe/arm-runners
gh workflow run test.yml --ref probe/arm-runners
sleep 20 && gh run list --workflow=test.yml --branch=probe/arm-runners --limit=1 --json databaseId -q '.[0].databaseId'
```

- [ ] **Step 3: Judge**

Poll until complete. Static + Unit must be GREEN on ARM. Inventory any native rebuild failures (node-pty, secure-fs-native, onnxruntime-node, `@tailwindcss/oxide`, `@swc/core`) — these appear in `allowBuilds` in `pnpm-workspace.yaml` and are prebuilt-binary packages that may lack arm64 artifacts. Record per-job wall-clock delta vs the latest x64 main run. **Decision output:** the exact set of lanes safe to move (Static and Unit only if both green; otherwise the subset that is).

- [ ] **Step 4: Tear down**

```bash
git push origin --delete probe/arm-runners
git branch -D probe/arm-runners
```

Expected: a written decision — "Static+Unit → arm, others stay x64" or a narrower set with the failing native package named.

---

## Probe P2 — Lint cacheability (gates C3's lint half)

Determines whether the `lint` task can become Turbo-cacheable without a config-load hash gap (the B4 gap class).

- [ ] **Step 1: Enumerate lint inputs**

`lint:ci` (package.json:79) chains eight sub-commands. The cacheable candidate is `biome check .` + `lint:eslint` (targets 4 fixed dirs: `apps/web/src packages/ui/src packages/file-explorer-ui/src packages/file-explorer-hooks/src`). The repo-global checks (`lint:no-no-memo`, `arch:domain-contract`, `arch:domain-boundaries`, secret scan, the e2e-contract linters) read files across the whole repo and stay UNCACHED.

- [ ] **Step 2: Confirm no hidden inputs**

Run the config-load-gap guard pattern from B4 mentally against Biome + eslint configs: list every file `biome check` and the eslint flat config transitively load (`biome.json`, `eslint.config.*`, any imported preset under `packages/config/`). Every one must be a hashed input of the cacheable lint task or the cache is unsound.

```bash
node -e "console.log(require('fs').readFileSync('biome.json','utf8').length)"  # sanity it exists
grep -rn "extends\|import" eslint.config.* 2>/dev/null | head
```

- [ ] **Step 3: Decision output**

Either "lint is cleanly cacheable — split `lint` into `lint:cacheable` (biome+eslint, per-package inputs) + `lint:global` (uncached)" OR "defer lint caching to Series D — hidden global input X". This gates whether C3 includes the lint-cache change or only the ARM move.

---

## Task C1: R7 — demote Coverage to once-per-PR-lifecycle

**Files:**
- Modify: `.github/workflows/test.yml:3-11` (pull_request types), `:232-234` (coverage job `if:`)

**Interfaces:**
- Produces: a `Coverage` job that runs on `ready_for_review`, on `opened` when not draft, and when a `coverage` label is added — NOT on every `synchronize`. Nightly `nightly-coverage.yml` threshold gate is unchanged (the enforcement backstop).

- [ ] **Step 1: Add `labeled` to the trigger types**

In `.github/workflows/test.yml`, extend the `pull_request.types` list (currently `opened, synchronize, reopened, ready_for_review`) to also include `labeled`. This is required so adding the `coverage` label fires the workflow at all. Adding `labeled` does not change Static/Unit/Build behavior because their `if:` conditions do not depend on it, but VERIFY that in step 4 (a `labeled` event must not double-run Unit).

- [ ] **Step 2: Gate the coverage job on lifecycle events**

Replace the coverage job `if: github.event_name == 'pull_request'` (line 234) with a condition that runs once per lifecycle:

```yaml
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.draft == false &&
      (github.event.action == 'ready_for_review' ||
       github.event.action == 'reopened' ||
       (github.event.action == 'opened') ||
       (github.event.action == 'labeled' && github.event.label.name == 'coverage'))
```

Rationale in a workflow comment: coverage is advisory (not in the ruleset); running it per-`synchronize` re-instrumented changed packages 11–14 min every push. This runs it when a PR becomes review-ready and on explicit `coverage`-label request; the nightly threshold gate stays authoritative.

- [ ] **Step 3: Guard against the draft double-fire**

Add a note/comment: `ready_for_review` fires with `draft == false`; the `opened` branch must also require non-draft (already covered by the top-level `draft == false`). Confirm no path runs coverage on a draft PR.

- [ ] **Step 4: Validate PR + push + label paths**

```bash
# From the lane branch, open a draft PR and confirm Coverage is SKIPPED on sync:
gh pr create --draft --title "C1: R7 coverage demotion" --body "..."
# push a trivial commit → Coverage must not run
# flip ready → Coverage runs once
gh pr ready <n>
# add label → Coverage runs again
gh pr edit <n> --add-label coverage
gh run list --workflow=test.yml --branch=<branch> --json displayTitle,name,conclusion
```

Expected: Coverage appears exactly on ready-flip and on label-add, and is absent on plain synchronize pushes. Unit runs once per event (no double-run from `labeled`).

- [ ] **Step 5: Prove the saving**

Count Coverage executions across the PR's own lifecycle (should be ≈1–2, not N). Record in the PR body vs a recent comparable PR's sync count.

- [ ] **Step 6: Review + merge gate**

Adversarial review must confirm: the `labeled` type doesn't leak extra Unit/Static runs; a reopened non-draft PR still gets coverage; nightly gate untouched. Merge only on all-green + every comment answered.

---

## Task C2: R9a — composite setup action + cache re-key

**Files:**
- Create: `.github/actions/setup-workspace/action.yml`
- Modify: `.github/workflows/test.yml` (8 setup blocks → composite), `nightly-coverage.yml`, `web-e2e.yml`, `desktop-e2e.yml`, `performance.yml` (Playwright pin single-source), `.turbo` cache key

**Interfaces:**
- Produces: a composite action `./.github/actions/setup-workspace` inputs `{ turbo-cache: 'true'|'false' }` doing checkout→pnpm→node(+pnpm cache)→install, optionally the `.turbo` restore. Callers replace their first 4–5 steps with one `uses:`.

- [ ] **Step 1: Write the composite action**

```yaml
# .github/actions/setup-workspace/action.yml
name: Setup workspace
description: Checkout, pnpm, Node (with pnpm cache), and install deps.
inputs:
  fetch-depth:
    description: git checkout depth
    default: '1'
  turbo-cache:
    description: restore/save the local .turbo cache layer
    default: 'false'
runs:
  using: composite
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: ${{ inputs.fetch-depth }}
    - uses: pnpm/action-setup@v6
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: 'pnpm'
    - if: ${{ inputs.turbo-cache == 'true' }}
      uses: actions/cache@v5
      with:
        path: .turbo
        # Re-key on lockfile + turbo.jsonc (performance.yml pattern) instead of
        # per-job-per-sha, which pinned storage at the 10 GB ceiling. With remote
        # cache live this layer is an outage hedge, not the primary cache.
        key: ${{ runner.os }}-turbo-${{ hashFiles('pnpm-lock.yaml', 'turbo.jsonc') }}
        restore-keys: |
          ${{ runner.os }}-turbo-
    - run: pnpm install --frozen-lockfile
      shell: bash
```

- [ ] **Step 2: Replace the setup blocks in test.yml**

For `static`, `unit`, `build` (they use turbo cache): replace Checkout+pnpm+Node+Cache+Install with `- uses: ./.github/actions/setup-workspace` `with: { turbo-cache: 'true', fetch-depth: '0' for unit }`. For `native-windows`, `native-electron`: `turbo-cache: 'false'`. For `web-e2e` (inside the Playwright container, custom `--filter` install) and `desktop-e2e` (electron cache + custom provisioning): leave their bespoke install as-is OR parameterize carefully — **do not** fold the container/electron special-casing into the composite (that's the trap; keep those two bespoke).

- [ ] **Step 3: Single-source the Playwright image pin**

The tag `mcr.microsoft.com/playwright:v1.61.1-noble` appears in `test.yml`, `web-e2e.yml`, `performance.yml`. Introduce one source of truth. Preferred: a top-of-file `env: PLAYWRIGHT_IMAGE:` won't work in `container.image` for reusable contexts — instead add a comment-linked check script `scripts/verify-playwright-pin-sync.mjs` that asserts all three match `@playwright/test`'s version, run in the Static job. (Keeping three literals + one guard is safer than a fragile interpolation.)

- [ ] **Step 4: Type-check the composite locally**

```bash
pnpm dlx action-validator .github/actions/setup-workspace/action.yml 2>/dev/null || echo "validate manually"
gh workflow run test.yml --ref <branch>
```

- [ ] **Step 5: Validate all five workflows still green**

Dispatch `test.yml`, and confirm `nightly-coverage.yml`, `web-e2e.yml`, `desktop-e2e.yml`, `performance.yml` still parse (`gh workflow run <wf> --ref <branch>` for each that supports dispatch; for the rest, confirm the YAML lints). Every job that previously passed must still pass. Prove the `.turbo` cache still restores (look for "Cache restored" in logs).

- [ ] **Step 6: Optional — Turbo 2.10 local-cache eviction**

If `cacheMaxAge`/`cacheMaxSize` in `turbo.jsonc` can replace the LRU-prune half of `scripts/run-turbo-command.mjs` in <20 lines, do it here; else file a Series D chip and leave the script. Do not expand scope.

- [ ] **Step 7: Review + merge gate**

Reviewer confirms: web-e2e/desktop-e2e bespoke installs untouched; cache key change doesn't orphan the remote cache (remote cache keys off content hashes, unaffected); no job lost its `fetch-depth: 0`.

---

## Task C3: R9b — ARM runners + (conditionally) cacheable lint

**Gated on P1 and P2.** Do not start until both probes report.

**Files:**
- Modify: `.github/workflows/test.yml` (`runs-on` for the P1-approved lanes), `turbo.jsonc` (lint task split, only if P2 = cacheable), root `package.json` (lint script split, only if P2 = cacheable)

**Interfaces:**
- Consumes: P1's approved-lane set, P2's cacheable/deferred verdict.
- Produces: cheaper lanes on `ubuntu-24.04-arm`; if P2 green, a `lint:cacheable` Turbo task + retained uncached `lint:global`.

- [ ] **Step 1: Move approved lanes to ARM**

For each lane P1 cleared, change `runs-on: ubuntu-latest` → `runs-on: ubuntu-24.04-arm`. Add a comment naming the 2026-01-29 arm64-in-private-repos availability and the 37% cost delta. Leave every native/Electron/Playwright lane on x64.

- [ ] **Step 2: (If P2 = cacheable) split the lint task**

Split `lint:ci` so the deterministic, file-local part (`biome check .` + `lint:eslint` on its 4 fixed dirs) becomes a Turbo task with declared `inputs` (those dirs + `biome.json` + eslint config), and the repo-global linters stay a separate uncached step. Add `scripts/verify-lint-cache-coverage.mjs` asserting every file the cacheable lint reads is a hashed input (the B4 gap-guard pattern). If P2 deferred, SKIP this step and note it in the PR.

- [ ] **Step 3: Validate push path on ARM**

```bash
gh workflow run test.yml --ref <branch>
```

Confirm every moved lane is green on ARM and (if split) lint cache-hits on a no-op re-run.

- [ ] **Step 4: Prove the delta**

Record per-lane wall-clock and note the cost basis (ARM is 37% cheaper per-minute; lint cache converts a fixed floor into a hit). Real timings only.

- [ ] **Step 5: Review + merge gate**

Reviewer confirms no native lane silently moved to ARM; lint split (if present) has no hash gap; the guard fails when an input is removed (demonstrate by temporarily deleting an input in a scratch commit).

---

## Task C4: R12a — TypeScript 7 verify-then-adopt

**Files:**
- Modify: root `package.json` (add TS7 native compiler devDep + wire the type-check binary), `turbo.jsonc` (type-check task env only if needed)
- Create: `docs/series-c-ts7-parity-findings.md`

**Interfaces:**
- Consumes: current `type-check` = `turbo run type-check` → per-package `tsc --noEmit` (TypeScript 6.0.3 today).
- Produces: EITHER the type-check lanes switched to the TS7 native `tsc` (with `typescript@6.x` retained as the resolved LIBRARY for API consumers — `scripts/*` using `ts.createSourceFile` and packages doing `ts.createProgram` at runtime like `packages/db` migration-runner-types) OR a findings report if parity fails.

- [ ] **Step 1: Establish the decoupling fact**

TS 7.0 (GA 2026-07-08) ships the native compiler as a SEPARATE package with NO programmatic API until 7.1. The repo's `typescript@^6.0.3` must stay the resolved version for every `import ... from 'typescript'` (verified consumers: `scripts/verify-workspace-src-aliases.mjs`, `scripts/architecture-domain-boundaries.mjs`, `scripts/model-catalog-migration-contract.mjs`, `scripts/check-e2e-readiness-contracts.mjs`, `scripts/e2e-playwright-title-tags.mjs`, plus package runtime uses). Only the CI/dev **type-check binary** (`tsc --noEmit`) moves to TS7. Discover the exact TS7 native package name at implementation time (fast-moving GA); pin it exactly.

- [ ] **Step 2: Add the TS7 compiler as a devDep and a parity script**

Add the TS7 native compiler to root `devDependencies`. Write `scripts/ts7-parity-check.mjs` that runs the full type-check under BOTH compilers and diffs the diagnostic sets (normalize file:line:code tuples; TS7 claims structurally identical semantics). Real code:

```js
// scripts/ts7-parity-check.mjs — run TS6 and TS7 type-check, diff diagnostics.
import { spawnSync } from 'node:child_process';
function run(bin) {
  const r = spawnSync(bin, ['--noEmit', '--pretty', 'false'], { encoding: 'utf8', shell: process.platform === 'win32' });
  // collect "path(line,col): error TSxxxx" lines, sorted, deduped
  return new Set((r.stdout + r.stderr).split('\n').filter((l) => /error TS\d+/.test(l)).sort());
}
// ...invoke per tsconfig project; assert set equality; print the symmetric difference on mismatch.
```

(The lane fills the per-project invocation loop from `tsconfig.json` `references`.)

- [ ] **Step 3: Run parity across every type-check lane**

```bash
node scripts/ts7-parity-check.mjs
```

Expected on success: empty symmetric difference for every project. On ANY difference: STOP — the PR becomes a findings report (`docs/series-c-ts7-parity-findings.md`) listing each divergence, and the compiler switch is NOT made.

- [ ] **Step 4: (On parity) switch the type-check invocation**

Point the `type-check` task's `tsc` at the TS7 binary (per-package `type-check` scripts or a shared `scripts/run-turbo-command.mjs` tweak). Keep `typescript@6.x` resolved. Confirm `turbo run type-check` still green and faster.

- [ ] **Step 5: Validate + measure**

```bash
gh workflow run test.yml --ref <branch>   # Static job's Type check step
```

Record Static's type-check step duration before/after (the ~5.5-min prize; TS7 claims 8–12×). Confirm API-consumer scripts (`pnpm test:scripts`, `pnpm run arch:domain-boundaries`) still pass on `typescript@6`.

- [ ] **Step 6: Review + merge gate**

Reviewer confirms: no API consumer accidentally resolves to TS7; parity script is retained as a guard (re-runnable on future TS bumps); if parity failed, the PR is a report, not a switch.

---

## Task C5: R6 — one module-resolution registry

**Files:**
- Modify: `apps/web/vitest.config.mts` (hand map → registry spread), `apps/web/vite.config.ts`, `apps/desktop/vite.config.ts`, `packages/test-utils/workspace-src-aliases.mjs` (add a vite-shaped consumer if needed), `scripts/verify-workspace-src-aliases.mjs` (extend to apps/*)
- Create: `scripts/verify-tsconfig-paths-match-registry.mjs`

**Interfaces:**
- Consumes: the B3 `workspaceSrcAliases(root)` registry (array of `{find: RegExp|string, replacement}`, first-match, existence-validated, exports-derived). Desktop vitest already spreads it.
- Produces: web vitest config spreading the same registry (deliberate overrides/dist-pins BEFORE the spread); both apps' Vite configs deriving aliases from the registry with explicit dist-alias exceptions; a guard asserting root `tsconfig.json` `paths` ⊇ the registry's package roots.

- [ ] **Step 1: Convert web vitest to the registry (array form)**

`apps/web/vitest.config.mts` currently has a large **object-form** `resolve.alias` (order-sensitive, subpaths-before-roots). Convert to array form: deliberate entries (mocks, the `createAgentBrowserSafeAliasMap` helper, any dist pin) FIRST, then `...workspaceSrcAliases(resolve(import.meta.dirname, '../..'))`. Preserve every deliberate exception — diff the resolved alias set before/after to prove no specifier changed target except the intended source-resolution ones.

- [ ] **Step 2: Add the parity assertion for web**

Run the web unit suite with the no-dist gold proof (delete all `packages/*/dist`, run `pnpm --filter @brainstrike/web test`). It must pass entirely from source. Any failure = a missing registry entry or a real dist dependency to pin explicitly.

- [ ] **Step 3: Derive both Vite configs from the registry**

`apps/web/vite.config.ts` and `apps/desktop/vite.config.ts` hand-maintain 43 + 48 aliases. Add a registry consumer that emits Vite's alias shape (Vite wants `{ find, replacement }[]` too). Keep the deliberate DIST alias for `@brainstrike/file-explorer` in web (its worker build resolves to dist ON PURPOSE — this exception must be expressed explicitly, BEFORE the registry spread, with a comment). Verify `pnpm --filter @brainstrike/web build` and `apps/desktop` build unchanged (byte-compare the alias-resolved graph or just confirm a green build + smoke).

- [ ] **Step 4: Extend the execution guard to apps/**

`scripts/verify-workspace-src-aliases.mjs` today validates package vitest configs. Extend its checked-config discovery to include `apps/web/vitest.config.mts` and `apps/desktop/vitest.config.mts` so an app alias that drifts from source-resolution fails the Static-job guard.

- [ ] **Step 5: Guard tsconfig paths against the registry**

```js
// scripts/verify-tsconfig-paths-match-registry.mjs
// Assert every @brainstrike/* package-root key in tsconfig.json `paths` resolves
// to the same src target the registry emits. tsconfig paths stay hand-written
// (TS needs them) but are VERIFIED against the single source, not re-synced by hand.
```

Add it to `pnpm test:scripts` (Static job). It must FAIL if a package is added to the registry but not tsconfig paths (demonstrate).

- [ ] **Step 6: Full validation**

```bash
pnpm test:scripts                       # new guard + extended guard green
pnpm --filter @brainstrike/web test     # no-dist proof
pnpm build                              # both apps build
gh workflow run test.yml --ref <branch>
```

- [ ] **Step 7: Review + merge gate**

Reviewer confirms: the file-explorer→dist exception is preserved and commented; no specifier silently changed target; the extended guard catches an intentionally-broken app alias; tsconfig-paths guard catches a registry/tsconfig divergence.

---

## Task C6: R8 — pnpm catalogs, retire syncpack

**Files:**
- Modify: `pnpm-workspace.yaml` (add `catalog:` + `catalogMode: strict` + `cleanupUnusedCatalogs`), every `package.json` with a catalogued dep (version → `catalog:`), root `package.json` (drop `syncpack` devDep + `deps:fix/lint/update/update:check` scripts), `pnpm-lock.yaml`, `renovate.json`

**Interfaces:**
- Produces: a single-source `catalog:` for shared dependency versions, enforced strict; syncpack removed.

- [ ] **Step 1: Baseline the current version map**

```bash
pnpm deps:lint   # syncpack's current view — capture the mismatch/consistency report before removing it
```

Record which deps are shared across ≥2 packages (catalog candidates). Start conservative: catalog the highest-fan-out shared deps (react, react-dom, typescript, vitest, the @brainstrike-external libs), not every leaf.

- [ ] **Step 2: Author the catalog**

In `pnpm-workspace.yaml` add a `catalog:` block with the chosen deps at their current single versions, plus `catalogMode: strict` and `cleanupUnusedCatalogs: true`. Do NOT touch `trustPolicy` (memory: pnpm trustPolicy no-downgrade is verified-broken — leave it). Preserve the existing `overrides`, `allowBuilds`, `minimumReleaseAgeExclude`, `patchedDependencies` blocks verbatim.

- [ ] **Step 3: Repoint package.json entries to `catalog:`**

For each catalogued dep, change the version in every consuming `package.json` to `"catalog:"`. Then:

```bash
pnpm install   # regenerates the lockfile with catalog resolution — EXPECT a large lockfile diff
```

Note in the PR: this is a one-time full cache bust (lockfile is a global input). The Turbo lockfile analysis is catalog-aware (2.7+), so a future catalog bump only cache-misses affected packages.

- [ ] **Step 4: Remove syncpack**

Delete the `syncpack` devDep and the four `deps:*` scripts from root `package.json`. Grep the repo + CI for any `syncpack`/`deps:lint` invocation and remove/replace (catalog strict mode is the new enforcement).

```bash
grep -rn "syncpack\|deps:lint\|deps:fix\|deps:update" .github package.json scripts 2>/dev/null
```

- [ ] **Step 5: Renovate catalog support**

Update `renovate.json` so Renovate manages catalog entries (first-class catalog support). Confirm the config still parses.

- [ ] **Step 6: Validate strict enforcement**

```bash
pnpm install --frozen-lockfile   # must succeed
# deliberately set one package's catalogued dep to a different literal → pnpm install must ERROR under catalogMode: strict
pnpm build && pnpm test:scripts
gh workflow run test.yml --ref <branch>
```

Prove strict mode rejects drift (the syncpack replacement actually works).

- [ ] **Step 7: Review + merge gate**

Reviewer confirms: `overrides`/`allowBuilds`/`minimumReleaseAgeExclude`/`patchedDependencies` intact; no dep silently version-bumped during the migration (versions must be identical, only the indirection changes); strict mode demonstrably rejects a mismatch; no orphan syncpack reference remains.

---

## Task C7: delete the queue-telemetry-collector orphan

**Files:**
- Delete: `packages/queue-telemetry-collector/` (3 src files + package.json + README + dist)
- Modify: `tsconfig.json` (lines 101–102 paths entry, line 240 references entry), `biome.json` (line 395), `architecture/domain-map.json` (line 105), `scripts/enforce-coverage.mjs` (line 79), `pnpm-lock.yaml`

**Interfaces:** none — pure removal.

- [ ] **Step 1: Re-verify zero consumers in-PR**

```bash
grep -rn "from ['\"]@brainstrike/queue-telemetry-collector\|require(['\"]@brainstrike/queue-telemetry-collector" --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.mjs" . | grep -v node_modules
grep -rln "queue-telemetry-collector" --include="package.json" . | grep -v node_modules | grep -v "packages/queue-telemetry-collector/package.json"
```

Both MUST return empty (confirmed 2026-07-14: zero code imports, zero package.json deps). If either is non-empty, STOP and report — the orphan assumption is wrong.

- [ ] **Step 2: Remove the package and its config references**

```bash
git rm -r packages/queue-telemetry-collector
```

Then delete: `tsconfig.json` paths key (101–102) + references entry (240); `biome.json` line-395 test-glob; `architecture/domain-map.json` line-105 entry; `scripts/enforce-coverage.mjs` line-79 entry.

- [ ] **Step 3: Reinstall + validate the whole toolchain**

```bash
pnpm install                     # drops it from the lockfile
pnpm run type-check              # tsconfig references still resolves
pnpm run arch:domain-boundaries  # domain-map still valid
node scripts/enforce-coverage.mjs 2>/dev/null || true   # no dangling ref
pnpm test:scripts
pnpm build
```

Every command green. The `arch:domain-boundaries` check is the key one — it parses `domain-map.json` and would fail on a dangling package reference.

- [ ] **Step 4: Review + merge gate**

Reviewer independently re-runs the two grep verifications. Merge only when they confirm zero consumers and the full build/type-check/arch checks are green.

---

## Task C8: verify coverage-lane derivation + correct the docs

**REFRAMED.** The audit found the derivation is ALREADY implemented: `packages/db/scripts/test-lanes.mjs` and `coverage-lanes.mjs` BOTH import from a single `packages/db/scripts/db-test-lane-manifest.mjs`; `buildDbCoverageLaneMap` derives coverage lanes from `dbUnitLaneDefinitions` via `coverageDefaultsByUnitLane`. So the review's §7 "derive coverage-lanes from test-lanes" is done. This task VERIFIES completeness and corrects the stale "register in BOTH registries" wording rather than building a new derivation.

**Files:**
- Modify: `AGENTS.md` + any `docs/agents/*.md` and `MEMORY.md` line stating "register in BOTH lane registries"; possibly `packages/db/scripts/db-test-lane-manifest.mjs` (only if a real residual gap is found)
- Create (maybe): `packages/db/__tests__/db-test-lane-manifest.test.ts` (a guard test if none exists)

**Interfaces:**
- Consumes: the shared manifest (single source), the two `check-lanes` scripts run in the Static job.

- [ ] **Step 1: Confirm the single-source claim end to end**

```bash
grep -n "import" packages/db/scripts/test-lanes.mjs packages/db/scripts/coverage-lanes.mjs   # both import db-test-lane-manifest.mjs
pnpm --filter @brainstrike/db test:db:check-lanes
pnpm --filter @brainstrike/db test:coverage:db:check-lanes
```

Both check-lanes pass. Confirm a NEW test file added to `dbUnitLaneDefinitions` automatically flows to a coverage lane via `coverageDefaultsByUnitLane` (add a temp fixture regex + temp test file, run both checks, confirm no "register in coverage too" step was needed, then revert).

- [ ] **Step 2: Identify the residual footgun (if any)**

The remaining manual surface: `coverageDefaultsByUnitLane` needs an entry per unit lane, and `coverageOverridesByLane` is hand-listed. Check whether adding a unit lane without a coverage default fails LOUDLY (it does — `buildDbCoverageLaneMap` pushes a failure). If a gap exists (a code path where drift passes both checks), fix it in the manifest with a test. If none, record "derivation complete — no code change."

- [ ] **Step 3: Correct the docs**

Update `AGENTS.md` (and `docs/agents/database.md` / `MEMORY.md` if they repeat it): the instruction is now "add the test's regex to `dbUnitLaneDefinitions` in `db-test-lane-manifest.mjs` — coverage lane assignment is derived automatically; add a `coverageOverridesByLane` entry ONLY to override the default." Remove the "register in BOTH registries" framing that implies two independent edits.

- [ ] **Step 4: (If no guard test exists) add one**

Add `packages/db/__tests__/db-test-lane-manifest.test.ts` asserting: (a) every unit lane has a `coverageDefaultsByUnitLane` entry; (b) `buildDbCoverageLaneMap` assigns every collected test to exactly one coverage lane; (c) an unassigned test triggers a failure. Register it in the manifest (dogfood the single-source flow).

- [ ] **Step 5: Validate + merge gate**

```bash
pnpm --filter @brainstrike/db test:db:check-lanes && pnpm --filter @brainstrike/db test:coverage:db:check-lanes
pnpm --filter @brainstrike/db test -t "lane manifest"
```

Reviewer confirms the docs match the code and (if added) the guard actually fails on an unassigned test.

---

## Sequencing & dependency graph

```
Probes:   P1 (ARM) ─┐
          P2 (lint) ─┴─► C3

Workflow chain (serial, rebasing):  C1 ─► C2 ─► C3
Independent (parallel, any order):  C4   C5   C6   C7   C8
```

- C1→C2→C3 serialize because they all edit `test.yml`; land C1, rebase C2, etc. (the Series B `gh pr update-branch` discipline — reruns reuse the old merge SHA).
- C4, C5, C6, C7, C8 touch disjoint files and can run as parallel lanes. C6 (lockfile) and C7 (lockfile) both touch `pnpm-lock.yaml` — land one, rebase the other to avoid a lockfile conflict.
- Recommended dispatch order to front-load safety: **C7 (trivial, high-confidence) and C8 (mostly verification) first**, then C1, then the parallel batch C4/C5/C6, then C2→C3 behind the probes.

## Success criteria (measured, per spec)

- Coverage executions per PR lifecycle ≈ 1 (from N syncs) — C1.
- Setup duplication gone; `.turbo` cache re-keyed off content — C2.
- Runner-cost delta recorded for ARM-moved lanes; lint floor converted to cache hits (if P2 green) — C3.
- Static type-check step 8–12× faster on parity, or a findings report — C4.
- One module-resolution source; guards green across packages + apps + root tsconfig; zero hand-synced vitest alias blocks — C5.
- syncpack absent; strict catalog rejecting drift — C6.
- Orphan gone, all arch/type/build checks green — C7.
- Single-source lane manifest confirmed; docs corrected — C8.

## Explicitly deferred (Series D)

R5 assistant-server extraction (+ panel-prop pipeline), R10 god-package splits, R12b Turbo 3.0 deprecation audit (unless C2 lands `cacheMaxAge` trivially), R12c turbo boundaries advisory, merge queue (tripwire: red-main recurrence), shared platform-composition seam, declaration-only renderer builds (WON'T-DO).

## Standing notes

- A foreign user stash (git-panel work) sits untouched at `stash@{0}` — do not drop.
- origin/main is ahead of the local main snapshot by unrelated commits (#1656, #1657); fast-forward before cutting lane branches.
