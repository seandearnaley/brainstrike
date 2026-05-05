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
| 2026-05-05 16:21 | Patched readiness routing: shell-only waits in panel/settings/layout, DB telemetry tagged `@stateful`, stateful matrix updated, `openAssistantWorkspace` made shell-only by default after reset/reload, and checker added to `pnpm lint`. | `node --test scripts/__tests__/check-e2e-readiness-contracts.test.mjs`, `node scripts/check-e2e-readiness-contracts.mjs`, `node scripts/check-e2e-stateful-matrix.mjs`, and `node scripts/check-ci-workflow-contracts.mjs` all passed. | Fast functional web E2E no longer contains the known DB-readiness waits that caused the latest CI failure shape. DB telemetry now runs in the one-worker stateful lane. |
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
