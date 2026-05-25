# CI E2E Readiness Debug Log - PR #955

Date: 2026-05-05

Repository: `/Users/seandearnaley/Documents/GitHub/brainstrike`

PR: <https://github.com/seandearnaley/brainstrike/pull/955>

Current branch: `codex/ci-observability-trust-cleanup`

Current head under investigation: `088b7e7d933cd81eab7de6694a9cabc7ed044301`

## Rules For This Debug Pass

- No silent fallback.
- No guessing.
- No timeout-only fix.
- No selector/assertion fix until setup readiness is proven healthy.
- Every failed attempt must record what it ruled out or exposed.
- If a test attempt fails and teaches nothing, stop and improve instrumentation before another attempt.

## Prior Failed Fix

Commit: `088b7e7d9 Stabilize web DB readiness E2E lane`

What it changed:

- Moved `tools-panel-persistence.test.ts` and `web-db-worker-startup.test.ts` into a serialized `database-startup` stateful lane.
- Added DB-readiness diagnostics to `waitForDatabaseReady`.
- Removed a dynamic runtime logger import from Playwright helper code.

What passed:

- Local web E2E for the two DB-startup specs passed.
- `pnpm test:scripts` passed.
- `pnpm --filter @brainstrike/web build` passed.
- Full local root gate passed: `pnpm lint && pnpm type-check && pnpm build && pnpm test`.
- CI `E2E Stateful Tests (database-startup)` passed on the pushed head.

What failed after push:

- CI Test run `25397511561` failed on exact head `088b7e7d933cd81eab7de6694a9cabc7ed044301`.
- Failing jobs:
  - `E2E Tests (Shard 1/5)`, job `74489260415`
  - `E2E Tests (Shard 4/5)`, job `74489260406`
- `Required PR Gate` failed only because those upstream jobs failed.

Learning:

- The previous fix was too narrow. It fixed one DB-startup lane but did not address other functional-shard setup paths that still block on DB readiness.

## Current Failure Evidence

### Shard 1

Command in CI:

```text
pnpm exec playwright test --project=functional --workers=2 --grep-invert "@destructive|@stateful" --shard=1/5
```

Observed failing setup paths:

- `assistant-local-availability.test.ts`
  - Failure occurs in `beforeEach`, through `openAssistantWorkspace`.
  - Error: DB did not become ready before app-ready wait completed.
  - Observed state: `missing`; E2E hooks: absent.
- `embedding-worker-telemetry.test.ts`
  - First attempt failed, retry passed.
  - Failure occurs through `HomePage.goto`.
  - Observed state: `loading`; status text `Storage: Connecting...`; E2E hooks: absent.

### Shard 4

Command in CI:

```text
pnpm exec playwright test --project=functional --workers=2 --grep-invert "@destructive|@stateful" --shard=4/5
```

Observed failing setup paths:

- `panel-state-preservation.test.ts`
  - Failure occurs in `beforeEach`, through `resetLayoutState`.
  - Observed state: `missing`; E2E hooks: absent.
- `settings-models-and-providers.test.ts`
  - Failure occurs in `beforeEach`, through `waitForAppLoad(page)`.
  - Observed state: `missing`; E2E hooks: absent.

## New Primary Hypothesis

The web E2E harness has an overloaded readiness contract. Generic app setup helpers default to DB readiness, so ordinary functional shards are running DB-dependent setup waits under `--workers=2`. Some specs truly need DB, some only need shell/layout/settings UI, and the current helper API does not force that distinction. The result is setup-time DB boot contention and ambiguous failures before the tested behavior runs.

This is broader than a single missing `@stateful` tag.

## Current Differential

1. Functional tests that do not need DB are accidentally waiting for DB.
2. DB-dependent tests are not fully tagged and isolated into serialized stateful lanes.
3. `waitForAppLoad` has a dangerous default: `waitForDatabase: true`.
4. `resetLayoutState` silently reintroduces DB waiting after callers already used `waitForDatabase: false`.
5. `openAssistantWorkspace` resets/reloads and then forces DB readiness for assistant tests.
6. `HomePage.goto()` defaults into DB readiness through `waitForAppLoad`.
7. `resetAppState` plus reload can interrupt browser DB initialization while the next readiness wait starts.
8. Parallel functional workers create browser DB/PGlite startup pressure that serialized lanes avoid.
9. The app lacks typed readiness phases such as shell-mounted, DB-loading, DB-ready, settings-ready.
10. A real PGlite/browser worker startup bug may exist, but the current harness obscures it.

## Attempt Log

| Time (ET) | Action | Result | Learning |
| --- | --- | --- | --- |
| 2026-05-05 15:25 | Pushed `088b7e7d9` after local gates. | CI `database-startup` passed, functional shards failed. | The specific old shard-5 failure was not the whole readiness problem. |
| 2026-05-05 15:50 | Paused then deleted `monitor-pr-955-checks`; checked queued/in-progress Actions runs. | Automation deleted; no queued or in-progress runs. | No background rerun should occur while this debug pass is active. |
| 2026-05-05 16:00 | Read failing specs and stateful matrix wiring. | Found `settings-models-and-providers.test.ts` is listed in the stateful matrix because one test title contains `@stateful`, but its untagged tests still run in the two-worker functional shard and its file-level `beforeEach` always calls `waitForAppLoad(page)` with DB readiness. | File-level setup can be DB-coupled even when only one test is explicitly stateful. Per-test tags do not protect untagged tests in the same file from shared DB-coupled setup. |
| 2026-05-05 16:01 | Read `panel-state-preservation.test.ts`. | Its setup explicitly waits for app shell with `waitForDatabase: false`, then calls `resetLayoutState(page)` without options. `resetLayoutState` reloads and defaults back to DB readiness. | A helper default is undoing a caller's explicit shell-only readiness intent. |
| 2026-05-05 16:02 | Read `assistant-local-availability.test.ts` and `openAssistantWorkspace`. | The test verifies assistant UI availability with mocked local model/provider state. `openAssistantWorkspace` always performs a final `waitForAppLoad(page)` after reset/reload, forcing DB readiness before the assistant assertion. | Assistant workspace setup is DB-coupled even when the tested behavior is mocked assistant availability, not database behavior. |
| 2026-05-05 16:03 | Read `embedding-worker-telemetry.test.ts`. | The test asserts status-bar indexing telemetry in the Database tab and uses `HomePage.goto()` with default DB readiness. | This one plausibly needs DB/indexing readiness and may belong in a serialized DB/stateful lane rather than the fast functional shard. |
| 2026-05-05 16:06 | Ran the four failing files locally with CI env, `--workers=2`, `--retries=0`, `--max-failures=1`. | All 7 tests passed in 15.9s. | The failure does not reproduce from just the named files. It likely depends on full shard composition, runner/container pressure, previous tests in the shard, or CI-specific browser/CPU conditions. Next local probe must use full shard commands, not isolated files. |
| 2026-05-05 16:09 | Ran local shard `1/5` with CI env, `--workers=2`, `--retries=0`, `--max-failures=1`, and `--grep-invert "@destructive|@stateful"`. | 32 passed, 2 skipped, no failure. | Shard 1 failure is not deterministic on this machine. The CI failure remains valid evidence because it happened on exact head, but local reproduction requires either shard 4, repeated runs, or stricter harness checks rather than a single local pass. |
| 2026-05-05 16:10 | User corrected the process: these always pass locally. | Stopped using local E2E reproduction as proof for this failure class. | For this harness issue, local E2E can be used only as smoke coverage after code changes. Root-cause proof must come from CI evidence plus static/contract tests that prevent DB-coupled setup from leaking into fast functional shards. |
| 2026-05-05 16:13 | Added a TDD red test for a new E2E readiness contract checker. | `node --test scripts/__tests__/check-e2e-readiness-contracts.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `scripts/check-e2e-readiness-contracts.mjs`. | The contract test is active before implementation. It will guard the rule that fast functional paths must not use default DB readiness outside isolated title ranges. |
| 2026-05-05 16:17 | Implemented `scripts/check-e2e-readiness-contracts.mjs` and ran it before spec fixes. | Unit tests passed; repo-level check failed on the real DB-coupled fast-shard paths: `embedding-worker-telemetry`, `layout`, `panel-state-preservation`, and `settings-models-and-providers`. | The checker produces concrete file/line evidence and caught the same class as the CI failures. |
| 2026-05-05 16:21 | Patched readiness routing: shell-only waits in panel/settings/layout, DB telemetry tagged `@stateful`, stateful matrix updated, `openAssistantWorkspace` made shell-only by default after reset/reload, and checker added to `pnpm lint`. | `node --test scripts/__tests__/check-e2e-readiness-contracts.test.mjs` and `node scripts/check-e2e-readiness-contracts.mjs` passed. | Fast functional web E2E no longer contains the known DB-readiness waits that caused the latest CI failure shape. DB telemetry now runs in the one-worker stateful lane. |
| 2026-05-05 16:22 | Ran `pnpm test:scripts`. | 89/89 script tests passed. | The new readiness contract is covered by the repo script test suite and will run in existing CI/static checks. |
| 2026-05-05 16:25 | Ran focused fast functional E2E smoke for changed shell-only files with CI env, two workers, retries disabled, and `--grep-invert "@destructive|@stateful"`. | 16/16 passed. | The changed shell-only fast-shard paths still exercise their assertions without DB readiness. This is smoke only, not proof of GitHub stability. |
| 2026-05-05 16:27 | Ran focused stateful DB lane smoke with CI env, one worker, retries disabled, and `--grep "@stateful"` for `tools-panel-persistence`, `web-db-worker-startup`, and `embedding-worker-telemetry`. | 3/3 passed. | The expanded `database-startup` lane runs all intended DB readiness specs after moving telemetry out of the fast shard. This is smoke only, not proof of GitHub stability. |
| 2026-05-05 16:34 | Ran full local root gate: `pnpm lint && pnpm type-check && pnpm build && pnpm test`. | Passed. | Local repo gate is clean with the readiness contract wired into lint. This still does not prove GitHub E2E stability; the next proof is the latest-head GitHub Test workflow. |

## Current Classification

| Spec | Failing setup path | Needs DB for assertion? | Current classification |
| --- | --- | --- | --- |
| `assistant-local-availability.test.ts` | `openAssistantWorkspace` final `waitForAppLoad(page)` | No current evidence that DB is needed; assistant/provider/model state is mocked. | Shell-only setup should not wait for DB. |
| `panel-state-preservation.test.ts` | `resetLayoutState(page)` defaulting to DB readiness | No; assertions cover file explorer panel layout/selection with mocked browser APIs. | Shell-only setup should preserve `waitForDatabase: false`. |
| `settings-models-and-providers.test.ts` untagged tests | File-level `beforeEach` and `HomePage.goto()` defaulting to DB readiness | No for registry error/cache-directory tests; yes for persisted toggle test. | Split readiness intent inside the file or make the whole file stateful; the mixed file setup is currently wrong. |
| `embedding-worker-telemetry.test.ts` | `HomePage.goto()` defaulting to DB readiness | Probably yes; assertions cover Database tab indexing status. | Candidate stateful/serialized DB lane, not a shell-only functional shard. |

## Answered Questions

- Shell-only paths fixed in this pass:
  - `assistant-local-availability.test.ts` through `openAssistantWorkspace`.
  - `panel-state-preservation.test.ts` through explicit shell-only `resetLayoutState`.
  - `settings-models-and-providers.test.ts` untagged registry/cache-directory tests.
  - `layout.test.ts` prompt navigation test.
- DB-required path moved to serialized stateful lane:
  - `embedding-worker-telemetry.test.ts`.
- Local reproduction status:
  - Local E2E did not reproduce the GitHub failure and is not used as proof.
  - Local E2E was only used as smoke after static/contract fixes.
- Current guardrail:
  - `scripts/check-e2e-readiness-contracts.mjs` now fails lint if fast functional web E2E paths use default DB readiness outside `@stateful` or `@destructive` title ranges.

## Remaining Risk

- The next meaningful proof is GitHub Actions on the pushed head.
- If GitHub fails again with DB readiness after this change, the next hypothesis must move from misrouted readiness waits to browser DB bootstrap/resource contention or reset ordering.

## Fresh CI Failure After Commit `84a55508`

Run: `25399472141`

Head: `84a555080637cca4e1e5443606256f3dcab1cad3`

Action taken after failure:

- Cancel request submitted for the still-running workflow to avoid wasting more CI time after required failure was already known.

### What Improved

- `E2E Stateful Tests (database-startup)` passed with the added `embedding-worker-telemetry.test.ts`.
- `E2E Tests (Shard 2/5)`, `E2E Tests (Shard 3/5)`, `E2E Tests (Shard 5/5)`, `E2E Destructive Tests`, `E2E Stateful Tests (settings-state)`, and browser Vitest passed before cancellation/failure observation.
- The original DB-readiness failure signature did not recur in the collected web shard 4 log.

### New Failure 1: Web Shard 4

Job: `E2E Tests (Shard 4/5)` / `74496001256`

Failure:

```text
settings-models-and-providers.test.ts:56
Models & Providers settings (web) › shows a registry load error and recovers on retry
expect(locator).toBeVisible() failed
Locator: getByTestId('model-registry-error')
Timeout: 15000ms
```

Interpretation:

- This is no longer a DB-readiness setup failure.
- The app reached the settings test assertion.
- The test override intended to force a model registry error did not produce the expected error UI in GitHub CI.

### New Failure 2: Desktop Shard 4

Job: `Desktop E2E Regression (4, 4)` / `74496297354`

Failure:

```text
settings-token-counting.desktop.test.ts:15
SyntaxError: The requested module './chunk-DBBA3NFL.mjs' does not provide an export named 'finalPath'
at fixtures/electron-fixture.ts:39
const { launchElectronApp } = await loadElectronHelpers();
```

Interpretation:

- This is an Electron/desktop E2E helper bundle or module resolution failure before app launch.
- It is unrelated to the web DB readiness routing fix.
- It may indicate a stale/generated chunk problem, ESM export shape problem, or desktop E2E bundling issue.

## Revised Hypotheses After `84a55508` Failure

1. The web settings registry-error test installs overrides after app boot, but the model registry may already have loaded successfully before the override takes effect.
2. `installSettingsTestOverrides` may not trigger a registry reload or may not update the exact runtime surface used by the settings page in production preview.
3. The settings page may cache the successful registry snapshot in memory/localStorage from the shell-only setup before the error override is installed.
4. The first `home.goto({ waitForDatabase: false })` in the registry-error test may remount/reload enough state to lose or race the pending settings override.
5. The model registry error path may need an explicit pre-boot override via `page.addInitScript`, not a post-boot install call.
6. The web settings failure could be cross-test contamination from earlier `local-runtime-settings` or navigation tests in shard 4, not from DB readiness.
7. The desktop `finalPath` error may come from Vite/Rolldown chunking changing an internal helper export while `electron-helpers.mts` is dynamically imported.
8. The desktop helper module may import a symbol that exists in TypeScript source but is tree-shaken or renamed in the transformed Playwright runtime bundle.
9. Desktop shard 4 may be loading a stale cached transformed module from `test-results`, Playwright cache, or a prior worker context.
10. The desktop failure may be caused by a circular export in desktop E2E helper code that only breaks under parallel shard startup and dynamic import timing.

## Evidence Update After Artifact Inspection

Time: 2026-05-05 16:27 EDT

Downloaded artifacts from run `25399472141`:

- `blob-report-4`
- `desktop-blob-report-4`

### Web Trace Correction

The web failure is not that the model registry error override failed entirely.

Trace evidence from retry 2:

- `before@call@54`: `settings-category-models` was visible with normal model registry UI and no `model-registry-error`.
- The expect waited 15 seconds for `settings-category-models >> model-registry-error`.
- `after@call@54`: `model-registry-error` existed and contained `Model registry unavailable for test`, but only after the assertion had already timed out.

Learning:

- The test is still DB-gated. `ModelSelectionPage` only calls `fetchRegistry` after `usePGliteDatabase()` returns a DB.
- The test was running in the fast functional shard with shell-only readiness, then expecting a DB-triggered registry path.
- This is the same readiness class in a more specific form: DB-backed model registry assertions were misrouted into a fast shard.

Revised web hypothesis:

- `settings-models-and-providers.test.ts` contains mixed shell-only and DB-backed assertions. The registry error-and-retry test must either be truly decoupled from DB in product/test hook code or run as `@stateful` with explicit DB readiness. The current test is not shell-only.

### Desktop Build Contract Evidence

The desktop failure imports `@brainstrike/file-system`, which pulls built `@brainstrike/utils` subpath output.

Facts:

- `packages/utils/package.json` exposes runtime subpaths such as `./path-utils` -> `./dist/path-utils.mjs`.
- Current `packages/utils/tsup.config.ts` has only `entry: ['src/index.ts']`.
- A clean tsup probe emitted only `index.js`, `index.js.map`, `index.mjs`, and `index.mjs.map`; it did not emit `path-utils.mjs`.
- Local `packages/utils/dist/path-utils.mjs` exists only because generated `dist` has stale files from prior builds.

Learning:

- The desktop `finalPath` failure is not an Electron app readiness issue. It is a build-output contract bug: package subpath exports are depending on stale generated files and split chunks.
- Local passes are expected when stale local `dist` happens to be internally consistent. CI can restore or rebuild a different stale/generated shape and break module imports before Electron launches.

Next tests before patch:

- Add an E2E readiness contract test that flags DB-backed model row assertions outside isolated `@stateful`/`@destructive` ranges.
- Add a utils build contract test that requires every runtime JS subpath export to be listed in the tsup entry map and disables split chunks for `@brainstrike/utils`.

### Red Tests

Time: 2026-05-05 16:27 EDT

Commands:

```text
node --test scripts/__tests__/check-e2e-readiness-contracts.test.mjs
pnpm --filter @brainstrike/utils exec vitest run src/__tests__/tsup-config-contract.test.ts
```

Results:

- Readiness contract test failed because the checker did not yet flag `[data-testid^="model-row-"]` assertions in fast-shard tests.
- Utils build contract failed because `entry` was an array and `splitting` was undefined.

Learning:

- The new tests fail for the intended reasons before implementation.

### Utils Build Contract Tightening

Time: 2026-05-05 16:32 EDT

Additional red test:

```text
pnpm --filter @brainstrike/utils exec vitest run src/__tests__/tsup-config-contract.test.ts
```

Expected failures:

- `./crypto` tsup entry used `src/crypto-utils.ts` while the public package subpath wrapper is `src/crypto.ts`.
- `packages/utils/package.json` still hardcoded a separate tsup entry list instead of using `tsup.config.ts`.

Fix applied:

- `packages/utils/tsup.config.ts` now uses the public wrapper entries when wrappers exist:
  - `src/crypto.ts`
  - `src/hmr-utils.ts`
  - `src/install-renderer-error-hooks.ts`
- `packages/utils/package.json` now runs `tsup` without duplicating the entry list.

Green test:

```text
pnpm --filter @brainstrike/utils exec vitest run src/__tests__/tsup-config-contract.test.ts
```

Result:

- 4/4 tests passed.

Learning:

- The correct build contract is not just "emit the missing file once." The package must have one authoritative list of public runtime entrypoints, and split chunks must stay disabled for this package because CI imports package subpaths directly during desktop E2E setup.

### Utils Build Output Verification

Time: 2026-05-05 16:33 EDT

Commands:

```text
pnpm --filter @brainstrike/utils build
test -f packages/utils/dist/path-utils.mjs
test -f packages/utils/dist/logger.mjs
find packages/utils/dist -maxdepth 1 -name 'chunk-*.mjs' -print
node --input-type=module -e "const mod = await import('./packages/utils/dist/path-utils.mjs'); if (typeof mod.finalPath !== 'function') throw new Error('finalPath export missing'); console.log('path-utils finalPath export passed');"
node --input-type=module -e "const mod = await import('./packages/utils/dist/logger.mjs'); if (typeof mod.createLogger !== 'function') throw new Error('createLogger export missing'); console.log('logger createLogger export passed');"
```

Results:

- `@brainstrike/utils` build succeeded using the centralized `tsup.config.ts` entry map.
- `path-utils.mjs` exists.
- `logger.mjs` exists.
- No `chunk-*.mjs` files were emitted.
- `path-utils.mjs` exports `finalPath`.
- `logger.mjs` exports `createLogger`.

Learning:

- The exact missing runtime export from the desktop CI failure is now verified from clean generated package output, not inferred from stale local `dist`.

### Targeted Web Settings Verification

Time: 2026-05-05 16:34 EDT

Command:

```text
CI=true GITHUB_ACTIONS=true NODE_ENV=production PORT=8080 BASE_URL=http://127.0.0.1:8080 pnpm --filter @brainstrike/web exec playwright test --project=functional --workers=1 --retries=0 --max-failures=1 --grep "shows a registry load error and recovers on retry" e2e/settings-models-and-providers.test.ts
```

Result:

- 1/1 passed.

Learning:

- The specific web failure path passes when the test is treated as DB-backed stateful work instead of shell-only fast-shard work. This still does not prove CI is fixed; it only verifies the local targeted behavior after the routing correction.

### Targeted Desktop Settings Verification

Time: 2026-05-05 16:34 EDT

Command:

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/settings-token-counting.desktop.test.ts
```

Result:

- 2/2 passed.
- No `chunk-*.mjs` / `finalPath` import error occurred.
- DB host started and initialized in both tests, then Electron exited with code 0.

Learning:

- The previously failing desktop spec now gets past the prelaunch helper import path and completes. This verifies the local targeted symptom after the package build contract fix; it does not prove the full GitHub matrix is stable.

### Script Contract Suite

Time: 2026-05-05 16:35 EDT

Command:

```text
pnpm test:scripts
```

Result:

- 90/90 passed.

Learning:

- The repo-level CI contract tests include the new web readiness guard and still pass together. This reduces the chance of reintroducing DB-backed settings assertions into fast web shards.

### Full Root Gate Attempt 1

Time: 2026-05-05 16:35 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Failed during `pnpm lint`.
- Biome flagged `type PackageJson` and `type TsupConfig` in `packages/utils/src/__tests__/tsup-config-contract.test.ts` because the repo style requires interfaces for object shapes.

Fix applied:

- Converted those two object-shape aliases to interfaces.

Learning:

- This was a code-style failure in the new regression test, not evidence against the CI readiness/build-output hypotheses. The full gate must be rerun from the beginning after this fix.

### Full Root Gate Attempt 2

Time: 2026-05-05 16:36 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- `pnpm lint` passed.
- Failed during `pnpm type-check`.
- `@brainstrike/utils` type-check rejected the new test's static import of `packages/utils/tsup.config.ts` because that file is outside `packages/utils/src` and not included by `tsconfig.test.json`.

Fix applied:

- Replaced the static `tsup.config.ts` import with a runtime dynamic import through `pathToFileURL`.

Learning:

- The contract test must exercise the package build config without expanding the TypeScript project boundary for package tests. Static imports across that boundary are invalid in this package.

### Utils Test Boundary Verification

Time: 2026-05-05 16:36 EDT

Commands:

```text
pnpm --filter @brainstrike/utils exec vitest run src/__tests__/tsup-config-contract.test.ts
pnpm --filter @brainstrike/utils type-check
```

Results:

- `tsup-config-contract.test.ts`: 4/4 passed.
- `@brainstrike/utils` type-check passed.

Learning:

- The runtime dynamic import preserves the build-contract assertion while keeping package test type-checking inside the package boundary.

### Full Root Gate Attempt 3

Time: 2026-05-05 16:43 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.
- `pnpm lint` passed.
- `pnpm type-check` passed.
- `pnpm build` passed.
- `pnpm test` passed.

Learning:

- The current code state satisfies the local required gate. This still does not prove the GitHub Actions matrix is fixed; the next proof point must be the latest PR head CI run after push.

## Current-Head CI Failure After Push `ffbb9312`

Time: 2026-05-05 17:11 EDT

Run:

```text
Test workflow run 25401287916
Head ffbb93122c18bd2cf5a3468adbd83db61356bea2
URL https://github.com/seandearnaley/brainstrike/actions/runs/25401287916
```

Action taken:

- A foreground one-off watcher was used, not a recurring automation.
- The first watcher shell had a bug (`zsh: read-only variable: status`) and exited immediately.
- The watcher was restarted with a non-reserved variable name.
- When a real failing job appeared, the run was cancelled immediately with `gh run cancel 25401287916 --repo seandearnaley/brainstrike`.
- No rerun was started.

Observed result:

- The run ended as `cancelled` because it was cancelled after the first real failure.
- Failing job before cancellation:
  - `E2E Stateful Tests (assistant-ui)`, job `74503369265`.
- Downstream failures:
  - `Merge Test Reports`, because the run was cancelled/failed.
  - `Required PR Gate`, because required upstream validation failed.

Evidence files:

```text
/tmp/brainstrike-pr955-run-25401287916/e2e-stateful-assistant-ui.log
/tmp/brainstrike-pr955-run-25401287916/artifacts/stateful-blob-report-assistant-ui.tar
/tmp/brainstrike-pr955-run-25401287916/artifacts/extracted/blob-report/report-functional-ba5b097.zip
/tmp/brainstrike-pr955-run-25401287916/assistant-ui-report
```

Failing CI command:

```text
pnpm exec playwright test --project=functional --workers=1 --grep "@stateful" e2e/assistant-ui-panel.test.ts
```

Failing assertion:

```text
apps/web/e2e/utils/assistant-workspace.ts:177
await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({ timeout: 15_000 });
```

Error:

```text
Locator: getByTestId('assistant-thread-tabs-workspace')
Expected: visible
Timeout: 15000ms
Error: element(s) not found
```

Failed tests:

- `send message and see assistant stream with tool progress` failed once, passed on retry.
- `keeps streamed tool details collapsed until explicitly expanded` failed all attempts.
- `keeps composer controls in the input shell and reveals collapsed history` failed all attempts.
- `keeps the assistant tab controller stable when tabs overflow` failed all attempts.

Important partial validation from the same GitHub head:

- `Checks (static)` passed.
- `Code Quality Checks` passed.
- `Build Web App` passed.
- `Build Desktop App` passed.
- `E2E Destructive Tests` passed.
- `E2E Tests (Shard 4/5)` passed, which means the previous web model registry readiness patch survived the GitHub shard that had failed before.
- `E2E Stateful Tests (settings-state)` passed.
- `E2E Stateful Tests (database-startup)` passed.
- `E2E Stateful Tests (import)` passed.
- Desktop embedding lifecycle and memory lanes passed before cancellation.

Key code evidence:

- `apps/web/e2e/utils/assistant-workspace.ts` calls `waitForAppLoad(page, { waitForDatabase: false })` before reset, then after reset/reload calls `waitForAppLoad(page, { waitForDatabase: options.waitForDatabase ?? false })`.
- The same helper then waits for `assistant-thread-tabs-workspace`.
- `packages/app-shell/src/assistant-thread-tabs-workspace.tsx` only renders `assistant-thread-tabs-workspace` when both a workspace resource id and a PGlite-backed assistant memory repository exist.
- If the repository is missing, the component renders the explicit state `Memory database unavailable` with the description `Assistant memory requires an initialized PGlite database.`
- The CI error contexts include this unavailable state, which means the test helper was asking for a DB-backed assistant UI after explicitly allowing shell-only readiness.

## Hypothesis Reset After `ffbb9312` Failure

Primary hypothesis now:

The assistant UI stateful helper has the same readiness-class bug as the previous web model registry failure, but on a different surface. `openAssistantWorkspace` treats database readiness as optional by default even though it always waits for the DB-backed assistant thread workspace. CI is slower and exposes the race; local usually outruns it.

Ten concrete possibilities before patching:

1. `openAssistantWorkspace` incorrectly defaults to shell-only readiness after reload even though `assistant-thread-tabs-workspace` requires a PGlite-backed repository.
2. `resetAppState` plus `page.reload()` clears or delays assistant memory initialization, and the helper does not wait for DB readiness after that reset boundary.
3. Generic status-bar DB readiness may not be enough because assistant memory repository readiness is owned by a separate React provider/subtree.
4. `mockBrowserApis` can select a workspace root before the assistant memory repository exists, causing `ensureResourceThreads` to see no repository and render the unavailable state first.
5. The local assistant model init script may seed preferences before reload, but reset/reload ordering may still create an assistant setup race under CI timing.
6. `AssistantThreadTabsWorkspace` may render `Memory database unavailable` as a state that does not reliably transition when `usePGliteDatabase()` later becomes non-null.
7. The production preview path in GitHub Actions initializes PGlite slower than the 15 second assistant workspace assertion, while local machines usually finish sooner.
8. File root selection and assistant thread initialization may be racing; route/resource state may become valid before memory-backed thread state is ready.
9. The accessible tablist seen in some snapshots may appear in a later/partial render than the wrapper `data-testid`, so the current assertion may lack useful state diagnostics.
10. The assistant-ui stateful lane may be missing a harness preflight for assistant memory readiness, so it validates the app shell while the actual DB-backed assistant subsystem is not usable.

Next action:

- Add a focused contract test for `openAssistantWorkspace` readiness behavior before changing implementation.
- Patch the helper so its default matches the DB-backed element it waits for.
- Re-run the targeted assistant UI stateful command, then the full root gate, then push and watch the next GitHub run without starting any recurring automation.

### Red Contract Test For Assistant Workspace Readiness

Time: 2026-05-05 17:13 EDT

Command:

```text
pnpm --filter @brainstrike/web exec vitest run e2e/utils/__tests__/assistant-workspace.vitest.ts
```

Result:

- Failed as intended before implementation.

Failure:

```text
expected 2nd "vi.fn()" call to have been called with ... { waitForDatabase: true }
Received ... { waitForDatabase: false }
```

Learning:

- The helper's current implementation does not match the assistant workspace contract. It proves the CI failure hypothesis at the utility level: after reset/reload, the assistant helper still uses shell-only app readiness even though it immediately waits for a DB-backed assistant thread workspace.

### Assistant Workspace Readiness Fix

Time: 2026-05-05 17:14 EDT

Change:

- Removed the optional shell-only readiness path from `openAssistantWorkspace`.
- The helper still uses shell-only readiness before reset so it can reach the app and clear state.
- After `resetAppState()` and reload, it now always calls `waitForAppLoad(page, { waitForDatabase: true })` before waiting for `assistant-thread-tabs-workspace`.

Reason:

- `assistant-thread-tabs-workspace` cannot render without the PGlite-backed assistant memory repository. Allowing shell-only readiness at that point was an invalid harness contract.

Targeted contract verification:

```text
pnpm --filter @brainstrike/web exec vitest run e2e/utils/__tests__/assistant-workspace.vitest.ts
```

Result:

- 1/1 passed.

Targeted E2E verification:

```text
CI=true GITHUB_ACTIONS=true NODE_ENV=production PORT=8080 BASE_URL=http://127.0.0.1:8080 pnpm --filter @brainstrike/web exec playwright test --project=functional --workers=1 --retries=0 --max-failures=1 --grep "@stateful" e2e/assistant-ui-panel.test.ts
```

Result:

- 4/4 passed.

Learning:

- The failed assistant-ui stateful command now passes locally under CI flags. This validates the local regression path, but it is not proof that GitHub Actions is fixed. The next required proof is the full root gate followed by a new PR head run in GitHub.

### Full Root Gate After Assistant Workspace Fix

Time: 2026-05-05 17:16 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.
- `pnpm lint` passed. Biome formatted the new assistant workspace contract test.
- `pnpm type-check` passed.
- `pnpm build` passed.
- `pnpm test` passed.

Learning:

- The patch is clean against the local required gate in one run. This still does not prove GitHub Actions; the next required evidence is a pushed PR-head Test workflow run.

### Final Pre-Commit Root Gate Rerun

Time: 2026-05-05 17:16 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.
- `pnpm lint` passed with no fixes applied.
- `pnpm type-check` passed.
- `pnpm build` passed.
- `pnpm test` passed.

Learning:

- The final code state is clean against the local root gate immediately before staging. This is still not treated as CI proof.

### Post-Log Lint Check

Time: 2026-05-05 17:17 EDT

Command:

```text
pnpm lint
```

Result:

- Passed.
- No fixes applied.

Learning:

- The final markdown update did not trigger lint or contract changes.

## Current-Head CI Failure After Push `3a501115`

Time: 2026-05-05 17:37 EDT

Run:

```text
Test workflow run 25402852545
Head 3a501115e42aeda05554dea7143dda673292ab1d
URL https://github.com/seandearnaley/brainstrike/actions/runs/25402852545
```

Action taken:

- The run was watched in the foreground.
- When the first real failing job appeared, the run was cancelled immediately with `gh run cancel 25402852545 --repo seandearnaley/brainstrike`.
- No rerun was started.

Failing job:

```text
E2E Tests (Shard 1/5)
Job 74507591732
URL https://github.com/seandearnaley/brainstrike/actions/runs/25402852545/job/74507591732
```

Evidence files:

```text
/tmp/brainstrike-pr955-run-25402852545/e2e-shard-1.log
/tmp/brainstrike-pr955-run-25402852545/artifacts/blob-report-1.tar
/tmp/brainstrike-pr955-run-25402852545/artifacts/extracted/blob-report/report-functional-5a51a54-1.zip
/tmp/brainstrike-pr955-run-25402852545/shard-1-report
```

Important successes before cancellation:

- `E2E Stateful Tests (assistant-ui)` passed on GitHub for this head.
- `E2E Tests (Shard 4/5)` passed.
- `Browser Tests (Vitest 4)` passed.
- `E2E Stateful Tests (settings-state)` passed.
- `E2E Stateful Tests (database-startup)` passed.
- `E2E Stateful Tests (import)` passed.
- Desktop regression shards 1/4, 3/4, and 4/4 passed.
- Desktop embedding lifecycle, backfill, memory, recovery, search, and mixed lanes passed.

Failing CI command:

```text
pnpm exec playwright test --project=functional --workers=2 --grep-invert "@destructive|@stateful" --shard=1/5
```

Failing test:

```text
apps/web/e2e/assistant-local-availability.test.ts
Assistant local availability (web) > enables the assistant when the built-in local model is available without hosted keys
```

Failure:

```text
Test timeout of 60000ms exceeded while running "beforeEach" hook.
Error: Database failed to initialize before the app became test-ready.
Last observed state was missing. E2E hooks present: no.
Last wait error: page.waitForFunction: Test timeout of 60000ms exceeded.
```

Page snapshot:

- The app shell was mounted.
- Status bar showed `Storage: Connecting...`.
- The workspace had no root selected yet.
- Assistant panel showed `Assistant unavailable` / `Could not determine assistant status` / `Failed to fetch`.

Key code evidence:

- `assistant-local-availability.test.ts` calls `openAssistantWorkspace(... enableLocalAssistantModel: true ...)`.
- `openAssistantWorkspace` now correctly waits for DB readiness because the assistant workspace is DB-backed.
- `assistant-local-availability.test.ts` is not tagged `@stateful`, so the fast shard still runs it with `--grep-invert "@destructive|@stateful"` and `--workers=2`.
- The workflow only runs `@stateful` files that are listed in the `e2e-stateful` matrix.
- The existing stateful matrix has an `assistant-ui` group, but it only lists `e2e/assistant-ui-panel.test.ts`.

## Hypothesis Reset After `3a501115` Failure

Primary hypothesis now:

The helper contract is correct, but the lane contract is incomplete. Any spec that calls `openAssistantWorkspace` is DB-backed and should not run in the fast sharded lane. The prior patch made that hidden contract visible by forcing DB readiness; `assistant-local-availability.test.ts` was still incorrectly classified as a fast shard test.

Ten concrete possibilities before patching:

1. `assistant-local-availability.test.ts` is misclassified; it uses the DB-backed assistant workspace helper but lacks `@stateful`.
2. Other assistant specs using `openAssistantWorkspace` are also misclassified and only avoided failure because they skipped when the hosted assistant API was unavailable.
3. The stateful matrix is incomplete; tagging a file without adding it to the matrix would silently remove it from fast shards without running it anywhere.
4. The readiness contract checker does not currently flag `openAssistantWorkspace` calls in fast shard specs, so this class can return.
5. The local availability test needs one-worker isolation because DB startup plus mocked local model setup is not safe in the two-worker fast shard.
6. The test may still need a longer test-level timeout once moved to the stateful lane, but increasing timeouts alone would hide the wrong-lane issue.
7. The assistant local availability setup may depend on DB readiness before root selection, while fast shard concurrency keeps the DB provider in `Connecting...` until the test timeout.
8. The generic status-bar DB readiness may be too coarse for assistant readiness, but the current failure occurred before root selection and before assistant memory could render, so lane classification is the first contract to fix.
9. The workflow may need the entire assistant helper family grouped into one `assistant-ui` stateful lane to keep helper usage explicit.
10. The current test skipped behavior for hosted assistant specs may mask DB readiness problems when API keys are present in another environment.

Next action:

- Mark all `openAssistantWorkspace`-based assistant E2E specs as `@stateful`.
- Add those specs to the `e2e-stateful` assistant-ui matrix group.
- Extend the readiness contract checker so `openAssistantWorkspace` cannot be used in fast shard specs.
- Run the targeted contract test and the targeted stateful assistant group locally before the full root gate.

## Patch Attempt: Route Assistant Workspace Specs To Stateful Lane

Time: 2026-05-05 17:41 EDT

Files changed:

- `apps/web/e2e/assistant-local-availability.test.ts`
- `apps/web/e2e/assistant-panel.test.ts`
- `apps/web/e2e/assistant-panel-interactions.test.ts`
- `.github/workflows/test.yml`
- `scripts/check-e2e-readiness-contracts.mjs`
- `scripts/__tests__/check-e2e-readiness-contracts.test.mjs`

Change:

- Tagged all currently known `openAssistantWorkspace` specs as `@stateful`.
- Added those specs to the existing `e2e-stateful` `assistant-ui` matrix group.
- Added a readiness contract check that flags `openAssistantWorkspace` in fast-shard specs.

Targeted contract validation:

```text
node --test scripts/__tests__/check-e2e-readiness-contracts.test.mjs
node scripts/check-e2e-readiness-contracts.mjs
pnpm test:scripts
```

Result:

- Passed.
- `check-e2e-readiness-contracts` now fails on DB-backed assistant workspace usage outside isolated stateful/destructive ranges.
- Full scripts suite passed 91/91.

Targeted E2E validation:

```text
CI=true GITHUB_ACTIONS=true NODE_ENV=production PORT=8080 BASE_URL=http://127.0.0.1:8080 pnpm --filter @brainstrike/web exec playwright test --project=functional --workers=1 --grep "@stateful" e2e/assistant-ui-panel.test.ts e2e/assistant-local-availability.test.ts e2e/assistant-panel.test.ts e2e/assistant-panel-interactions.test.ts
```

Result:

- Passed: 5 passed, 2 skipped.
- `assistant-local-availability.test.ts` passed in the stateful lane shape.
- `assistant-panel.test.ts` and `assistant-panel-interactions.test.ts` skipped because the hosted assistant API was unavailable in this local environment.

Learning:

- The prior failure class was reproducible as a lane contract bug in code: assistant workspace specs were DB-backed but not all isolated from the fast two-worker shard.
- Local E2E passing is only a targeted sanity check. The required proof is still the next GitHub Actions run on the pushed head.

Next action:

- Run the full root gate before staging.

## Full Root Gate Before Commit

Time: 2026-05-05 17:42 EDT

Command:

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.
- `pnpm lint` passed with no fixes applied.
- `pnpm type-check` passed.
- `pnpm build` passed.
- `pnpm test` passed.

Learning:

- The current patch is clean against the local required gate. This remains only local evidence; GitHub Actions is still the required proof because the observed failures are CI lane/runtime failures.

Next action:

- Stage the scoped files, commit, push, then watch the new PR-head Test workflow.

## Post-Log Lint Check

Time: 2026-05-05 17:43 EDT

Command:

```text
pnpm lint
```

Result:

- Passed.
- No fixes applied.

Learning:

- The markdown log update did not introduce formatting or contract drift.

## Current-Head PR Monitoring Failure: PR #956 Desktop Shard 2

Time: 2026-05-06 07:25 EDT

Context:

- PR #957 (`Fix report merge for root blob artifacts`) was merged to `main` at `883641ec1b17d117bb156758e169cf48a08b2bff`.
- All open PR branches were updated to current `main`; PR #904 and PR #902 needed manual conflict resolution in `.jules/palette.md`.
- Foreground monitoring stopped on the first updated-head failure:
  - PR: #956
  - Head: `2bbce629cba31e76934f4440c02e5a169277e475`
  - Run: `25430956454`
  - Job: `Desktop E2E Regression (2, 4)`, job `74598874851`

Failure evidence:

```text
Failed test:
apps/desktop/e2e/file-explorer-selection.desktop.test.ts:1743
Desktop file explorer selection › promotes explicit mixed file-and-folder parents to checked as files are selected one by one

TimeoutError: locator.click: Timeout 5000ms exceeded
Locator:
getByRole('treegrid', { name: 'File tree' }).getByRole('checkbox', { name: 'Select tsconfig.json' })

Call log:
- locator resolved to visible enabled checkbox
- attempting click action
- waiting for element to be visible, enabled and stable
- element is visible, enabled and stable
- scrolling into view if needed
- done scrolling
- performing click action
```

Related log evidence:

```text
[PerfTiming] Operation "recursive-selection:/mock/desktop-selection-root-e2e/e2e/page-objects" exceeded budget
[PerfTiming] Operation "recursive-selection-query" exceeded budget
[DesktopRootLayoutContent] Desktop visible renderer frame health degraded
Timed out waiting for graceful shutdown; forcing exit
Error occurred in handler for 'db:live-query:start': Error: DB host exited with code 0.
```

Current hypothesis:

- This is not the report-merge bug; report artifact bundling happened successfully.
- This is also not only the earlier "app never became ready" hypothesis. The specific failed checkbox was visible, enabled, and stable. The renderer appears to become intermittently unresponsive during or immediately after recursive file selection, so Playwright times out while dispatching a click.
- The test helper currently gives the click only 5 seconds even though the same log shows recursive-selection work exceeding budget and renderer frame-health degradation.

Ten concrete possibilities before patching:

1. The `clickFileTreeCheckboxAndWaitForSelection` helper has an unrealistically short 5 second click timeout for desktop CI under recursive-selection load.
2. The file-tree selection flow blocks the renderer main thread long enough that Playwright can resolve a checkbox but cannot complete input dispatch before its click timeout.
3. The helper clicks too soon after the previous selection; the DOM is stable enough for Playwright's actionability check but the app is still processing the prior recursive selection.
4. The test needs a selection-idle/app-responsive gate between sequential file-selection clicks, not just `data-state` and count assertions after each click.
5. Recursive selection recomputes too much synchronously when selecting mixed file-and-folder parents, especially with expanded folders and a low selection limit.
6. The `selection-count` assertion can pass before all derived tree checkbox state/materialization work is complete, allowing the next click to race background UI updates.
7. The desktop frame-health degradation log should be treated as a readiness failure for the next interaction; the harness currently observes it but does not wait for recovery before continuing.
8. DB live-query startup/shutdown noise from concurrently running desktop tests can worsen renderer responsiveness even when the failing assertion is a file-tree click.
9. The checkbox element itself may be re-rendered or replaced during the click dispatch window, making Playwright hang at "performing click action" even though it was actionably resolved.
10. The test may be too broad for a two-worker desktop shard; however limiting the whole shard to one worker would mask the root responsiveness/settle contract unless proven necessary.

Next action:

- Inspect the file selection test helper and shared E2E readiness utilities.
- Prefer a central interaction/readiness helper that waits for selection settling and renderer responsiveness before the next desktop click.
- Do not rerun the failed GitHub job until there is a code change and local targeted validation.

## Patch Attempt: File Explorer Selection Interaction Settle Contract

Time: 2026-05-06 07:31 EDT

Files changed:

- `apps/desktop/e2e/file-explorer-selection.desktop.test.ts`
- `ci-e2e-readiness-debug-log-2026-05-05.md`

Change:

- Added `waitForFileExplorerSelectionIdle()` backed by `window.__brainstrikeFileExplorerTestHooks__`.
- The helper waits for a stable file-explorer test snapshot, including selected-file count, materialized path count, and tree root count.
- Added a renderer responsiveness probe that waits for two `requestAnimationFrame` ticks after the stable snapshot.
- Updated `clickFileTreeCheckboxAndWaitForSelection()` to:
  - wait for the previous selected count to settle before clicking;
  - use a 15 second click timeout for desktop CI interaction dispatch;
  - wait for checkbox state, visible selection-count text, and hook-backed selection idle after the click.
- Updated local expand/settings clicks in this file from 5 seconds to 15 seconds because the same failure class is interaction dispatch under renderer load, not missing locators.

Targeted validation:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

Learning:

- The exact failed test was healthy locally after the interaction-settle change.
- The whole selection spec also passed locally in CI mode.
- This is still not GitHub proof. The next proof point must be a pushed PR run on Linux with the updated desktop shard.

Next action:

- Run the full root gate, commit, push, and open a focused PR.

## PR #958 Review Fix: Make The Settle Contract Explicit

Time: 2026-05-06 07:41 EDT

Context:

- PR #958 was opened from commit `d9f7d1a4354fecbffc2db4eb5b79ea634121b802`.
- Claude review found three issues:
  - missing hook registration would silently spin until timeout;
  - sequential waits could stack into a long per-click failure time;
  - settle thresholds were magic numbers.
- The old-head Test run `25432831767` was cancelled before pushing another commit because the next push will supersede that run.

Change:

- `readFileExplorerSnapshot()` now fails immediately with `Missing required file explorer E2E test hooks` if the hook is not registered.
- Timing values are now named constants.
- `clickFileTreeCheckboxAndWaitForSelection()` now uses one 45 second wall-clock interaction budget instead of letting every assertion stack its own independent timeout.
- The settle rationale is documented next to the stable-sample check.

Learning:

- The review surfaced a real contract issue: readiness helpers must fail explicitly when their diagnostic/test hook is unavailable.
- Bounding each checkbox interaction preserves the longer click dispatch budget needed for desktop CI while preventing broken tests from expanding into multi-minute timeout chains.

Next action:

- Re-run targeted E2E validation and the full root gate before pushing the review fix.

Validation after review fix:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The explicit hook failure, named timing constants, and per-click wall-clock budget did not break the desktop E2E type-check, the targeted regression, the whole file selection spec, or the full root gate.

Next action:

- Push the new PR #958 head and resolve the review threads only after the pushed commit contains the fixes.

## PR #958 Second Review Cleanup

Time: 2026-05-06 07:47 EDT

Context:

- PR #958 commit `d27b638ac93334dc672dc74d2a99b379a6b60453` got a second review pass.
- Two code comments were cheap and valid:
  - remaining interaction time could be a tiny positive number passed into a Playwright timeout;
  - the snapshot signature used `JSON.stringify()` where an explicit signature is clearer.
- One comment asked whether this debug log should be split later. That is not being changed in this PR because the current user instruction is to keep a Markdown log of every attempt and learning during this incident.
- The old-head Test run `25433173008` was cancelled before pushing another commit because it was superseded by this review cleanup.

Change:

- Added `MIN_PLAYWRIGHT_STEP_TIMEOUT_MS`.
- `getRemainingInteractionTimeout()` now fails before a step when less than 1 second remains, with the remaining time in the error.
- Replaced the JSON signature with an explicit `materializedPathCount:selectedFilePathCount:treeRootCount` signature.

Learning:

- The wall-clock budget needs a minimum useful step threshold; otherwise the next failure can look like a Playwright flake instead of a deliberately exhausted interaction budget.

Next action:

- Re-run targeted E2E validation and the full root gate before pushing the new head.

## PR #958 Sixth Failure Reconsideration

Time: 2026-05-06 08:33 EDT

Context:

- Latest PR #958 head `a9755ae8fc3505191867f987e726f5033bdefd27` failed on Test workflow run `25434653073`.
- Failing job was `Desktop E2E Regression (2, 4)`, job `74610759846`.
- I stopped the watcher and cancelled the still-running workflow after the latest-head failure instead of rerunning.
- The previous hypothesis that the selection helper needed a stronger post-click idle/readiness contract was incomplete. It changed the original failure shape but did not make the CI shard stable.

Evidence:

- The failing spec was `apps/desktop/e2e/file-explorer-selection.desktop.test.ts`, test `promotes explicit mixed file-and-folder parents to checked as files are selected one by one`.
- The failure was `Test timeout of 45000ms exceeded`, followed by `page.evaluate: Target page, context or browser has been closed` from `waitForRendererFrames()`.
- The report timing shows teardown closed the page at the test timeout while the helper was trying to settle after selecting `index.ts`. The target-closed message is therefore a teardown symptom, not proof that Electron crashed first.
- The desktop regression command was `--workers=2 --retries=0 --max-failures=1 --global-timeout=720000 --grep-invert "@desktop-embedding-" --shard=2/4`.
- The job log showed two DB host processes started at nearly the same time in the same shard, plus repeated `Desktop visible renderer frame health degraded` messages.
- Local targeted runs passed, but the local file-only command is not equivalent to CI shard composition because a single spec file ran with one worker even when invoked with `--workers=2`.

Ten possibilities considered before the next fix:

1. The spec-level `45_000` timeout is lower than the test's own five-step selection-helper budget.
2. `waitForRendererFrames()` is throttled under CI/Xvfb/worker contention and can take about 1.8 seconds for two frames instead of a normal foreground-frame duration.
3. `--workers=2` runs multiple Electron apps and DB host processes concurrently inside one shard container/display, causing renderer starvation.
4. Recursive file-tree selection still blocks the renderer; the new waits expose that cost instead of fixing the underlying work scheduling.
5. The file-explorer snapshot signature can look stable while React, layout, or the renderer event loop still has pending work.
6. The setup and expand clicks before the helper are not covered by the same idle/readiness helper and consume a large fraction of the test budget.
7. `--max-failures=1` and Playwright teardown make `Target page closed` misleading when a timeout is the primary failure.
8. Earlier tests in shard 2 can leave the runner/container under load even when each test cleans up its own Electron app.
9. DB maintenance or background indexing can wake during long desktop tests and compete with renderer work.
10. The CI worker composition differs from local isolated proof, so local passes are evidence that the spec is logically correct but not proof that the shard harness is stable.

Decision:

- Act first on the two proven contract mismatches:
  - Desktop regression CI must not run two Electron/DB-host apps concurrently inside one required shard.
  - The multi-step file-tree promotion spec must have a test timeout aligned with its bounded five-interaction helper contract.
- Change PR and main desktop regression jobs to `--workers=1`, then update the workflow contract checker and tests so future edits cannot silently restore `--workers=2`.
- Add a named `90_000` timeout only for the five-click promotion spec. This is not a blind timeout bump; it prevents Playwright teardown from killing the helper mid-diagnostic while preserving fail-fast per-interaction deadlines and the 12-minute shard global timeout.

Next action:

- Patch workflow, contract tests, and the specific spec timeout; then validate with the script contract tests, desktop E2E type check, targeted failing spec, local shard 2/4 with one worker, and the full root gate before pushing.

Validation after sixth failure fix:

```text
pnpm test:scripts
```

Result:

- Passed: 95/95 script tests.

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1/1.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 --grep-invert "@desktop-embedding-" --shard=2/4
```

Result:

- Passed: 23/23.

Learning:

- The local shard analogue now runs serially through the file-explorer section and the failed five-click promotion test without timing out.
- The local shard still emits background-token-indexer dispatch failures, but those did not prevent the serial desktop shard from completing. That keeps the current fix focused on runner contention and the invalid timeout contract, not the final assertion.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The worker-isolation workflow contract, contract tests, specific desktop timeout update, and debugging log all pass the repo root gate together.

Next action:

- Amend and push PR #958, then monitor the latest head and review surface.

## PR #958 Fifth Review Cleanup

Time: 2026-05-06 08:14 EDT

Context:

- PR #958 commit `11d66fc13ef195376129f8d659461457968bd5c2` got a fifth review pass while the latest-head Test run `25434268047` was still in progress.
- One comment was non-blocking but valid under the harness strictness rule: `clickFileTreeCheckboxAndWaitForSelection()` implicitly assumed `expectedSelectedCount >= 1`.
- The current call sites satisfy the assumption, but a future misuse would pass `expectedSelectedCount - 1` as `-1` to the pre-click idle wait and could spin until the interaction deadline.

Change:

- Added a fail-fast guard to `clickFileTreeCheckboxAndWaitForSelection()`:
  - reject `expectedSelectedCount < 1`;
  - include the received value in the error.

Validation:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

Learning:

- The helper contract should be enforced at the boundary, not left as a comment. The explicit guard keeps future test changes from converting a bad call into another long CI wait.

Next action:

- Run the full root gate on the final tree before pushing the new PR #958 head.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The explicit `expectedSelectedCount >= 1` guard does not break the full local gate.

Next action:

- Amend and push the new PR #958 head, cancel superseded old-head CI, reply to the review thread, and monitor the new head.

Validation after fourth review cleanup:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

Learning:

- Binding the RAF probe to the caller's remaining deadline did not break targeted desktop E2E coverage.

Next action:

- Run the full root gate on the final tree before pushing the new PR #958 head.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The fourth cleanup passed the full root gate as well as the targeted desktop E2E checks.

Next action:

- Push the new PR #958 head and resolve/reply to the fourth review threads only after the pushed commit contains the fixes.

Validation after third review cleanup:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

Learning:

- Removing the RAF fallback did not break the targeted desktop E2E coverage.

Next action:

- Run the full root gate on the final tree before pushing the new PR #958 head.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The third cleanup passed the full root gate as well as the targeted desktop E2E checks.

Next action:

- Push the new PR #958 head and resolve/reply to the third review threads only after the pushed commit contains the fixes.

## PR #958 Fourth Review Cleanup

Time: 2026-05-06 08:02 EDT

Context:

- PR #958 commit `33d420b08ff5ab558aded244d7ecf2666fea594b` got a fourth review pass.
- One comment was valid: `waitForRendererFrames()` used a fixed 5 second timeout even when the caller's remaining settle/interaction budget was lower.
- One comment was non-blocking praise for the wall-clock deadline/minimum-step guard.
- The old-head Test run `25433812487` was cancelled before pushing another commit because it was superseded by this cleanup.

Change:

- `waitForRendererFrames()` now accepts a timeout.
- `waitForFileExplorerSelectionIdle()` now caps the RAF wait to the lesser of:
  - `RENDERER_FRAME_SETTLE_TIMEOUT_MS`;
  - the remaining caller deadline.

Learning:

- Every sub-wait in the readiness helper must be budget-aware. A fixed nested timeout undermines the outer wall-clock contract even when the main interaction helper is bounded.

Next action:

- Re-run targeted E2E validation and the full root gate before pushing the new head.

Validation after second review cleanup:

```text
pnpm --filter @brainstrike/desktop type-check:e2e
```

Result:

- Passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts -g "promotes explicit mixed file-and-folder parents to checked as files are selected one by one"
```

Result:

- Passed: 1 passed.

```text
CI=true GITHUB_ACTIONS=true pnpm --filter @brainstrike/desktop exec playwright test --project=regression --workers=2 --retries=0 --max-failures=1 e2e/file-explorer-selection.desktop.test.ts
```

Result:

- Passed: 20 passed.

```text
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Result:

- Passed.

Learning:

- The minimum timeout guard and explicit snapshot signature did not break the targeted desktop E2E coverage or the full root gate.

Next action:

- Push the new PR #958 head and resolve/reply to the second review threads only after the pushed commit contains the fixes.

## PR #958 Third Review Cleanup

Time: 2026-05-06 07:54 EDT

Context:

- PR #958 commit `f434b49449d4bb84f7bee7b1729498a23e662359` got a third review pass.
- One comment was valid under the project rule of no fallbacks/no silent degradation: `waitForRendererFrames()` silently resolved if `requestAnimationFrame` was missing.
- Two comments were non-blocking: one acknowledged `page.waitForTimeout()` as appropriate for polling the app hook; one affirmed the previous-count settle pattern.
- The old-head Test run `25433448303` was cancelled before pushing another commit because it was superseded by this cleanup.

Change:

- `waitForRendererFrames()` now rejects with `Missing required renderer requestAnimationFrame` if RAF is unavailable.

Learning:

- Even test-only readiness helpers should not silently pass when a required renderer primitive is absent. That would turn a broken harness into a misleading pass.

Next action:

- Re-run targeted E2E validation and the full root gate before pushing the new head.
