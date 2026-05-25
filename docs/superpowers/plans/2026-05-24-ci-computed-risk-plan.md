# CI-Computed Risk Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Brainstrike's proof-manifest and human-label PR routing with a CI-computed affected/risk plan that chooses the smallest trustworthy gate for each pull request.

**Architecture:** A cheap `plan` job computes changed files, affected risk lanes, required jobs, and E2E matrices from Git history and the existing lane taxonomy. All cloud jobs read `needs.plan.outputs.*`; humans and agents do not add `ci:*` labels, do not commit `.ci/proof/latest.json`, and do not run a local proof ceremony before every PR. `Required PR Gate` remains the stable branch-protection check and fails only when a selected required job fails or is missing.

**Tech Stack:** GitHub Actions, Turborepo affected filters, pnpm workspaces, Node.js script tests, Playwright lane tags, Vitest, existing Brainstrike `scripts/ci-risk-rules.mjs` taxonomy.

---

## Research Baseline

The replacement follows current standard monorepo CI practice rather than the bespoke proof system:

- Nx `affected` uses Git history plus the project graph to select only projects affected by a PR: <https://nx.dev/docs/features/ci-features/affected>
- Nx's CI guidance pairs affected selection with remote caching and distributed execution to reduce wasted work: <https://nx.dev/docs/concepts/ci-concepts/reduce-waste>
- Turborepo has native `--affected`; its docs warn that shallow checkout can make all packages appear changed, so CI must fetch enough history: <https://turborepo.dev/docs/reference/run>
- Turborepo CI docs explicitly position `--affected` for GitHub Actions pull requests: <https://turborepo.dev/docs/crafting-your-repository/constructing-ci>
- GitHub Actions supports job outputs and dynamic matrices via `fromJSON`: <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations>
- GitHub Actions supports `concurrency.cancel-in-progress` for superseded PR runs: <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- GitHub warns that skipped required workflows can remain pending, so Brainstrike should keep one always-present required gate instead of relying on workflow-level `paths-ignore`: <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore>

## Current State Verified From The Repo

I inspected these live files before writing this plan:

- `.github/workflows/test.yml`
- `scripts/ci-risk-rules.mjs`
- `scripts/ci-select.mjs`
- `scripts/ci-proof.mjs`
- `scripts/ci-required-pr-gate.mjs`
- `scripts/ci-doctor.mjs`
- `scripts/ci-selector-guard.mjs`
- `scripts/check-ci-workflow-contracts.mjs`
- `package.json`
- `AGENTS.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

The current brittle pieces are real and must be removed or rewritten:

- `pr-sentinel` reads live PR labels and runs `pnpm ci:verify-proof`.
- PR jobs are selected by `contains(join(github.event.pull_request.labels.*.name, ','), 'ci:...')`.
- `.ci/proof/latest.json` is a committed state artifact and invalidates after source commits.
- `AGENTS.md` and `.github/PULL_REQUEST_TEMPLATE.md` instruct agents to run `ci:prove`, commit proof, and add labels.
- `scripts/ci-required-pr-gate.mjs` maps required jobs from selected labels and expanded lanes.
- `scripts/ci-proof.mjs`, `scripts/ci-doctor.mjs`, proof timing scripts, and proof tests maintain the ceremony.

There is also current dirty work in the checkout:

- `.github/actions/setup-monorepo/action.yml`
- `scripts/__tests__/check-ci-workflow-contracts.test.mjs`
- `scripts/check-ci-workflow-contracts.mjs`
- `turbo.jsonc`

Execution must preserve or intentionally commit that work before editing the proof replacement. Do not overwrite it.

## Target Design

### New PR Flow

1. PR opens or updates.
2. `plan` job checks out with `fetch-depth: 0`.
3. `plan` runs `node scripts/ci-plan.mjs --base origin/${GITHUB_BASE_REF} --head HEAD --event pull_request --github-output "$GITHUB_OUTPUT"`.
4. `plan` emits:
   - `plan-json`
   - `required-jobs-json`
   - `run-docs-static`
   - one boolean output per optional job
   - web and desktop matrix JSON for selected lane groups
5. Docs-static, static, unit, coverage, browser, web E2E, and desktop E2E jobs run only when the plan output selects them.
6. `required-pr-gate` reads the selected required jobs from the plan and verifies only those jobs.
7. No PR labels are required for CI correctness.
8. No `.ci/proof/latest.json` commit exists.
9. Superseded runs cancel through the existing workflow-level `concurrency` group.

### New Local Developer Flow

For small changes:

```bash
pnpm ci:select --base origin/main --head HEAD
```

Expected behavior:

- Prints the CI-computed plan and the exact local commands a developer may run.
- Does not require proof artifact creation.
- Does not require PR labels.
- Does not mutate the repo.

For normal PRs:

```bash
git push
```

Expected behavior:

- GitHub computes the same plan.
- Required PR Gate waits for the selected jobs only.
- Docs-only PRs run only cheap plan/static documentation validation.
- Code PRs run affected static/unit work and selected E2E lanes.

For release confidence:

```bash
gh workflow run test.yml -f release_proof=full-release -f reason="release candidate"
```

Expected behavior:

- Runs full release proof intentionally.
- Not part of the default PR loop.

## Files And Responsibilities

### Create

- `scripts/ci-plan.mjs`
  - CI-owned planner.
  - Uses `collectGitSelection` and lane taxonomy from `scripts/ci-select.mjs` / `scripts/ci-risk-rules.mjs`.
  - Emits stable JSON plus GitHub outputs.

- `scripts/__tests__/ci-plan.test.mjs`
  - Positive and negative tests for docs-only, code, web, desktop, DB, embedding, full-risk, and workflow changes.
  - Tests GitHub output rendering.

### Modify

- `.github/workflows/test.yml`
  - Replace `pr-sentinel` with `plan`.
  - Replace every label-based PR job condition with `needs.plan.outputs.<job> == 'true'`.
  - Keep scheduled/manual release matrix explicit.
  - Keep one stable `Required PR Gate` status.

- `scripts/ci-select.mjs`
  - Keep as local read-only CLI over the same planner.
  - Stop emitting `labels` as a required action.
  - Print required jobs, selected lanes, and local suggested commands.

- `scripts/ci-risk-rules.mjs`
  - Keep the lane taxonomy.
  - Rename label-facing concepts to lane-facing concepts where practical.
  - Remove `ci:full` label expansion as a PR instruction; retain full-risk lane internally.

- `scripts/ci-required-pr-gate.mjs`
  - Replace label/expanded-lane gate inputs with plan-selected required jobs.
  - Treat skipped unselected jobs as success.
  - Fail selected jobs that are missing, skipped, failed, cancelled, or timed out.

- `scripts/check-ci-workflow-contracts.mjs`
  - Reject `ci:verify-proof`, `.ci/proof/latest.json`, live PR label reads, and label-based PR job routing.
  - Require `plan` job outputs and plan-based job conditions.
  - Require scheduled/manual full release proof to stay explicit.

- `scripts/__tests__/check-ci-workflow-contracts.test.mjs`
  - Replace proof-contract expectations with plan-contract expectations.
  - Add regression tests proving labels and proof manifest cannot re-enter the workflow.

- `scripts/__tests__/ci-risk-rules.test.mjs`
  - Preserve risk lane behavior tests.
  - Update assertions to say lanes/jobs rather than labels.

- `scripts/__tests__/ci-select.test.mjs`
  - Update expected JSON shape.
  - Prove the CLI is read-only and deterministic.

- `scripts/__tests__/ci-required-pr-gate.test.mjs`
  - Test selected-job success.
  - Test unselected skipped jobs are accepted.
  - Test selected skipped/missing jobs fail.

- `package.json`
  - Remove `ci:prove` and `ci:verify-proof`.
  - Replace `ci:doctor` with `ci:plan` or keep `ci:doctor` only if it becomes a read-only alias that prints the plan.
  - Rename proof timing/calibration scripts to lane timing/calibration names or remove them if unused.

- `AGENTS.md`
  - Replace the PR CI Proof Flow section.
  - Tell agents to run `pnpm ci:select` only for visibility.
  - Tell agents not to add `ci:*` labels, not to commit proof manifests, and not to run full release proof unless explicitly requested.

- `.github/PULL_REQUEST_TEMPLATE.md`
  - Remove the proof checklist.
  - Add a short validation section:
    - local tests run
    - `pnpm ci:select` reviewed for unexpectedly broad selection
    - no manual CI labels required

### Delete

- `.ci/proof/latest.json`
- `scripts/ci-proof.mjs`
- `scripts/__tests__/ci-proof.test.mjs`
- `scripts/ci-proof-timing-summary.mjs`
- `scripts/__tests__/ci-proof-timing-summary.test.mjs`

### Review For Removal Or Rename

- `scripts/ci-doctor.mjs`
- `scripts/__tests__/ci-doctor.test.mjs`
- `scripts/ci-calibrate-proof-commands.mjs`
- `scripts/__tests__/ci-calibrate-proof-commands.test.mjs`
- `scripts/ci-risk-audit.mjs`
- `scripts/__tests__/ci-risk-audit.test.mjs`
- `docs/architecture-reset/ci-proof-system-onboarding-2026-05-23.html`

These files may stay only if they are renamed to plan/lane terminology and no longer require a proof manifest.

## Plan JSON Contract

`scripts/ci-plan.mjs` must emit this shape:

```json
{
  "planVersion": 1,
  "eventName": "pull_request",
  "base": "origin/main",
  "head": "HEAD",
  "baseSha": "40-char-sha",
  "headSha": "40-char-sha",
  "mergeBase": "40-char-sha",
  "changedFiles": ["packages/ui/src/example.tsx"],
  "risk": {
    "category": "shared-foundation",
    "level": "medium",
    "domains": ["shared-foundation"],
    "reasons": ["packages/ui/** changed"]
  },
  "lanes": ["unit", "browser"],
  "requiredJobs": ["plan", "checks", "unit_affected", "browser-tests"],
  "jobs": {
    "docs_static": false,
    "checks": true,
    "unit_affected": true,
    "unit_coverage": false,
    "browser_tests": true,
    "prepare_web": false,
    "web_e2e_pr": false,
    "prepare_desktop": false,
    "desktop_e2e_pr": false,
    "merge_reports": false
  },
  "webE2eMatrix": {
    "include": []
  },
  "desktopE2eMatrix": {
    "include": []
  },
  "localCommands": [
    {
      "name": "unit-affected",
      "command": "pnpm turbo run test --filter=\"...[origin/main]\" --concurrency=4 --summarize --log-order=grouped --cache-dir=.turbo",
      "owner": "shared-foundation"
    }
  ]
}
```

GitHub outputs must include compact single-line JSON:

```text
plan-json=<compact JSON>
required-jobs-json=["plan","checks","unit_affected","browser-tests"]
run-docs-static=false
run-checks=true
run-unit-affected=true
run-unit-coverage=false
run-browser-tests=true
run-prepare-web=false
run-web-e2e-pr=false
run-prepare-desktop=false
run-desktop-e2e-pr=false
run-merge-reports=false
web-e2e-matrix={"include":[]}
desktop-e2e-matrix={"include":[]}
```

## Implementation Tasks

### Task 0: Preserve Current Dirty Work

**Files:**
- Inspect: `.github/actions/setup-monorepo/action.yml`
- Inspect: `scripts/__tests__/check-ci-workflow-contracts.test.mjs`
- Inspect: `scripts/check-ci-workflow-contracts.mjs`
- Inspect: `turbo.jsonc`

- [ ] **Step 1: Record current dirty files**

Run:

```bash
git status --short
git diff -- .github/actions/setup-monorepo/action.yml scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/check-ci-workflow-contracts.mjs turbo.jsonc > /tmp/brainstrike-pre-proof-replacement-dirty.diff
```

Expected: status shows only the known dirty files plus this plan if it is not committed.

- [ ] **Step 2: Commit or park existing dirty work before implementation**

If the dirty changes are still required, commit them:

```bash
git add .github/actions/setup-monorepo/action.yml scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/check-ci-workflow-contracts.mjs turbo.jsonc
git commit -m "fix(ci): scope turbo cache inputs"
```

Expected: cache-input work is preserved as its own commit.

- [ ] **Step 3: Keep the plan separate**

Run:

```bash
git add docs/superpowers/plans/2026-05-24-ci-computed-risk-plan.md
git commit -m "docs(ci): plan CI-computed risk routing"
```

Expected: the plan is reviewable independently from implementation.

### Task 1: Add CI Plan Tests First

**Files:**
- Create: `scripts/__tests__/ci-plan.test.mjs`
- Modify: `scripts/__tests__/ci-select.test.mjs`
- Modify: `scripts/__tests__/ci-required-pr-gate.test.mjs`

- [ ] **Step 1: Write failing tests for plan classification**

Create `scripts/__tests__/ci-plan.test.mjs` with cases for representative diffs:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCiPlan, renderGithubOutputs } from '../ci-plan.mjs';

const baseInput = {
  eventName: 'pull_request',
  base: 'origin/main',
  head: 'HEAD',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  mergeBase: 'c'.repeat(40),
};

function planFor(files) {
  return buildCiPlan({ ...baseInput, files });
}

describe('buildCiPlan', () => {
  it('keeps docs-only changes out of code and E2E jobs', () => {
    const plan = planFor(['docs/architecture-reset/example.md']);
    assert.equal(plan.risk.category, 'docs-only');
    assert.deepEqual(plan.requiredJobs, ['plan', 'docs-static']);
    assert.equal(plan.jobs.checks, false);
    assert.equal(plan.jobs.unit_affected, false);
    assert.equal(plan.jobs.web_e2e_pr, false);
    assert.equal(plan.jobs.desktop_e2e_pr, false);
  });

  it('selects affected unit work for isolated source changes without E2E', () => {
    const plan = planFor(['packages/utils/src/logger.ts']);
    assert.equal(plan.jobs.checks, true);
    assert.equal(plan.jobs.unit_affected, true);
    assert.equal(plan.jobs.web_e2e_pr, false);
    assert.equal(plan.jobs.desktop_e2e_pr, false);
    assert.ok(plan.requiredJobs.includes('unit_affected'));
  });

  it('selects web file explorer persistence without unrelated web lanes', () => {
    const plan = planFor(['packages/file-explorer-ui/src/tree/public.ts']);
    assert.equal(plan.jobs.prepare_web, true);
    assert.deepEqual(plan.webE2eMatrix.include.map((entry) => entry.lane), [
      'web-file-explorer-persistence',
    ]);
    assert.equal(plan.jobs.desktop_e2e_pr, false);
  });

  it('selects desktop IPC reset without desktop full regression', () => {
    const plan = planFor(['apps/desktop/src/desktop-factory-reset.ts']);
    assert.equal(plan.jobs.prepare_desktop, true);
    assert.deepEqual(plan.desktopE2eMatrix.include.map((entry) => entry.lane), [
      'desktop-ipc-reset',
    ]);
    assert.equal(plan.jobs.desktop_full_regression, false);
  });

  it('selects full release risk for workflow routing changes', () => {
    const plan = planFor(['.github/workflows/test.yml']);
    assert.equal(plan.risk.category, 'full-release-high-risk');
    assert.equal(plan.jobs.unit_coverage, true);
    assert.equal(plan.jobs.web_e2e_pr, true);
    assert.equal(plan.jobs.desktop_e2e_pr, true);
  });

  it('renders GitHub outputs without labels or proof fields', () => {
    const output = renderGithubOutputs(planFor(['packages/utils/src/logger.ts']));
    assert.match(output, /^plan-json=/m);
    assert.match(output, /^required-jobs-json=/m);
    assert.doesNotMatch(output, /ci:prove/);
    assert.doesNotMatch(output, /ci:verify-proof/);
    assert.doesNotMatch(output, /\.ci\/proof\/latest\.json/);
  });
});
```

- [ ] **Step 2: Run tests to confirm the new module is missing**

Run:

```bash
node --test scripts/__tests__/ci-plan.test.mjs
```

Expected: fails with `Cannot find module '../ci-plan.mjs'`.

### Task 2: Implement The CI Plan Module

**Files:**
- Create: `scripts/ci-plan.mjs`
- Modify: `scripts/ci-select.mjs`

- [ ] **Step 1: Create `scripts/ci-plan.mjs`**

Implement exported functions:

```js
export function buildCiPlan(input) {}
export function renderGithubOutputs(plan) {}
export function renderPlanJson(plan) {}
export function parsePlanArgs(args = process.argv.slice(2)) {}
export async function collectCiPlan(options, runner) {}
```

Rules:

- `buildCiPlan` accepts the same Git selection data as `buildSelection`.
- It reuses `selectRiskProfileForFiles`, `expandRiskLanes`, and `selectProofCommandsForFiles`.
- It converts risk lanes to required jobs directly.
- It never emits PR labels.
- It never reads or writes `.ci/proof/latest.json`.
- It emits booleans for every optional job used by `.github/workflows/test.yml`.
- It supports `--files` for fixture and contract tests without reading Git. The value is a comma-separated list of normalized repository paths.

- [ ] **Step 2: Add deterministic job mapping**

The module must define a single map:

```js
export const JOBS_BY_LANE = new Map([
  ['docs-static', ['docs-static']],
  ['unit', ['unit_affected']],
  ['coverage-db', ['unit_coverage']],
  ['coverage-full', ['unit_coverage']],
  ['browser', ['browser-tests']],
  ['web-smoke', ['prepare-web', 'web-e2e-pr']],
  ['web-file-explorer-persistence', ['prepare-web', 'web-e2e-pr']],
  ['web-import-indexing', ['prepare-web', 'web-e2e-pr']],
  ['web-assistant-state', ['prepare-web', 'web-e2e-pr']],
  ['web-settings-state', ['prepare-web', 'web-e2e-pr']],
  ['web-db-startup', ['prepare-web', 'web-e2e-pr']],
  ['web-destructive-reset', ['prepare-web', 'web-e2e-pr']],
  ['web-full-regression', ['prepare-web', 'web-e2e-pr']],
  ['desktop-smoke', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-ipc-reset', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-runtime-hosts', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-db-storage', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-full-regression', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-embedding-diagnostics', ['prepare-desktop', 'desktop-e2e-pr']],
]);
```

The exact lane names must match existing `E2E_LANES_BY_RISK_LABEL` behavior after removing the label prefix.

- [ ] **Step 3: Update `ci:select` to call the planner**

`scripts/ci-select.mjs` should stay as the local CLI, but it should print the same plan the CI job will use:

```bash
pnpm ci:select --base origin/main --head HEAD
```

Expected output:

- changed files
- risk category
- selected cloud jobs
- selected E2E lanes
- suggested local commands
- no instruction to add labels
- no instruction to commit proof

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test scripts/__tests__/ci-plan.test.mjs scripts/__tests__/ci-select.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/ci-plan.mjs scripts/ci-select.mjs scripts/__tests__/ci-plan.test.mjs scripts/__tests__/ci-select.test.mjs
git commit -m "feat(ci): compute PR risk plan in CI"
```

### Task 3: Replace PR Sentinel With Plan Job

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `scripts/check-ci-workflow-contracts.mjs`
- Modify: `scripts/__tests__/check-ci-workflow-contracts.test.mjs`

- [ ] **Step 1: Replace `pr-sentinel` job**

Delete the `pr-sentinel` job and add:

```yaml
  plan:
    name: CI Plan
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      plan-json: ${{ steps.plan.outputs.plan-json }}
      required-jobs-json: ${{ steps.plan.outputs.required-jobs-json }}
      run-docs-static: ${{ steps.plan.outputs.run-docs-static }}
      run-checks: ${{ steps.plan.outputs.run-checks }}
      run-unit-affected: ${{ steps.plan.outputs.run-unit-affected }}
      run-unit-coverage: ${{ steps.plan.outputs.run-unit-coverage }}
      run-browser-tests: ${{ steps.plan.outputs.run-browser-tests }}
      run-prepare-web: ${{ steps.plan.outputs.run-prepare-web }}
      run-web-e2e-pr: ${{ steps.plan.outputs.run-web-e2e-pr }}
      run-prepare-desktop: ${{ steps.plan.outputs.run-prepare-desktop }}
      run-desktop-e2e-pr: ${{ steps.plan.outputs.run-desktop-e2e-pr }}
      run-merge-reports: ${{ steps.plan.outputs.run-merge-reports }}
      web-e2e-matrix: ${{ steps.plan.outputs.web-e2e-matrix }}
      desktop-e2e-matrix: ${{ steps.plan.outputs.desktop-e2e-matrix }}
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup monorepo
        uses: ./.github/actions/setup-monorepo
        with:
          skip-electron: 'true'

      - name: Compute CI plan
        id: plan
        run: |
          set -euo pipefail
          node scripts/ci-plan.mjs --base "origin/${GITHUB_BASE_REF}" --head HEAD --event pull_request --github-output "$GITHUB_OUTPUT"
          pnpm lint:ci-workflow-contracts
          pnpm test:scripts
```

- [ ] **Step 2: Add docs-static PR job**

Add a cheap job for docs-only pull requests:

```yaml
  docs-static:
    name: Docs Static
    if: github.event_name == 'pull_request' && needs.plan.outputs.run-docs-static == 'true'
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Check docs diff formatting
        run: git diff --check "origin/${GITHUB_BASE_REF}"...HEAD -- docs apps/docs README.md AGENTS.md CLAUDE.md
```

- [ ] **Step 3: Remove live PR label reads**

Delete this behavior from the workflow:

```yaml
- name: Read live pull request labels
```

Delete every use of:

```yaml
github.event.pull_request.labels.*.name
```

Expected: PR routing no longer depends on label timing or human label state.

- [ ] **Step 4: Add workflow contract failures for old behavior**

In `scripts/check-ci-workflow-contracts.mjs`, add checks that fail when the workflow contains:

```text
pnpm ci:verify-proof
.ci/proof/latest.json
gh pr view "$PR_NUMBER" --json labels
github.event.pull_request.labels.*.name
```

- [ ] **Step 5: Run contract tests**

Run:

```bash
node --test scripts/__tests__/check-ci-workflow-contracts.test.mjs
pnpm run lint:ci-workflow-contracts
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add .github/workflows/test.yml scripts/check-ci-workflow-contracts.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs
git commit -m "fix(ci): route PR jobs from computed plan"
```

### Task 4: Convert PR E2E To Plan-Owned Matrix Jobs

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `scripts/check-ci-workflow-contracts.mjs`
- Modify: `scripts/__tests__/check-ci-workflow-contracts.test.mjs`

- [ ] **Step 1: Add `needs: plan` to non-E2E PR-routed jobs**

For non-E2E PR-routed jobs, add `plan` to `needs` and replace label conditions:

```yaml
if: github.event_name == 'pull_request' && needs.plan.outputs.run-unit-affected == 'true'
```

Apply the same pattern for:

- `checks`
- `docs-static`
- `unit_affected`
- `unit_coverage`
- `browser-tests`
- `prepare-web`
- `prepare-desktop`
- `merge-reports`

- [ ] **Step 2: Replace PR web E2E jobs with one matrix job**

Delete PR routing from these jobs:

- `e2e`
- `e2e-stateful`
- `e2e-destructive`
- `web-e2e-smoke-pr`
- `web-e2e-file-explorer-persistence-pr`
- `web-e2e-import-indexing-pr`
- `web-e2e-assistant-state-pr`
- `web-e2e-settings-state-pr`
- `web-e2e-db-startup-pr`
- `web-e2e-destructive-reset-pr`

Add one PR matrix job:

```yaml
  web-e2e-pr:
    name: Web E2E (${{ matrix.lane }})
    if: github.event_name == 'pull_request' && needs.plan.outputs.run-web-e2e-pr == 'true'
    needs: [plan, checks, prepare-web]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.web-e2e-matrix) }}
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Setup monorepo
        uses: ./.github/actions/setup-monorepo
      - name: Download web dist
        uses: actions/download-artifact@v8
        with:
          name: web-dist
          path: apps/web/dist/
      - name: Setup Playwright runtime
        uses: ./.github/actions/setup-playwright-runtime
      - name: Run selected web lane
        run: ${{ matrix.command }}
```

- [ ] **Step 3: Replace PR desktop E2E jobs with one matrix job**

Delete PR routing from these jobs:

- `desktop-e2e-pr`
- `desktop-e2e-smoke-pr`
- `desktop-e2e-ipc-reset-pr`
- `desktop-e2e-runtime-hosts-pr`
- `desktop-e2e-db-storage-pr`
- `desktop-e2e-embedding-pr`

Add one PR matrix job:

```yaml
  desktop-e2e-pr:
    name: Desktop E2E (${{ matrix.lane }})
    if: github.event_name == 'pull_request' && needs.plan.outputs.run-desktop-e2e-pr == 'true'
    needs: [plan, checks, prepare-desktop]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.desktop-e2e-matrix) }}
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Setup monorepo
        uses: ./.github/actions/setup-monorepo
        with:
          skip-electron: 'false'
      - name: Setup Playwright runtime
        uses: ./.github/actions/setup-playwright-runtime
      - name: Setup desktop E2E
        uses: ./.github/actions/setup-desktop-e2e
      - name: Run selected desktop lane
        working-directory: apps/desktop
        run: |
          export DISPLAY=":${{ matrix.display }}"
          LOCK_FILE="/tmp/.X${{ matrix.display }}-lock"
          [ -f "$LOCK_FILE" ] && rm -f "$LOCK_FILE"
          Xvfb "${DISPLAY}" -screen 0 1280x960x24 -ac +extension GLX &
          XVFB_PID=$!
          sleep 3
          if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            echo "ERROR: Xvfb process died unexpectedly"
            exit 1
          fi
          unset NO_COLOR
          ${{ matrix.command }}
          TEST_EXIT_CODE=$?
          kill "$XVFB_PID" 2>/dev/null || true
          exit "$TEST_EXIT_CODE"
```

- [ ] **Step 4: Preserve push and release policy**

Keep existing non-PR policy:

- `push` to `main` runs cheap health only.
- `schedule` runs release proof.
- `workflow_dispatch` runs release proof only when `release_proof=full-release`.
- `workflow_dispatch` defaults to `release_proof=skip`.
- `desktop-backgrounding` remains explicit.

- [ ] **Step 5: Use plan matrices for E2E**

For web E2E:

```yaml
strategy:
  fail-fast: false
  matrix: ${{ fromJSON(needs.plan.outputs.web-e2e-matrix) }}
```

Each matrix entry must include:

```json
{
  "lane": "web-file-explorer-persistence",
  "command": "pnpm --filter @brainstrike/web run test:e2e:lane:file-explorer-persistence",
  "timeoutMinutes": 12
}
```

For desktop E2E:

```yaml
strategy:
  fail-fast: false
  matrix: ${{ fromJSON(needs.plan.outputs.desktop-e2e-matrix) }}
```

Each matrix entry must include:

```json
{
  "lane": "desktop-ipc-reset",
  "command": "pnpm run test:e2e:lane:ipc-reset",
  "display": "108",
  "timeoutMinutes": 8
}
```

- [ ] **Step 6: Keep full release matrix outside PR plan**

Scheduled/manual release jobs can keep their existing explicit matrices:

- web functional shards
- web stateful groups
- web destructive group
- desktop regression shards
- desktop embedding groups

They must not be selected for normal PRs unless the plan marks full-release risk.

- [ ] **Step 7: Run workflow contract tests**

Run:

```bash
node --test scripts/__tests__/check-ci-workflow-contracts.test.mjs
pnpm run lint:ci-workflow-contracts
```

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add .github/workflows/test.yml scripts/check-ci-workflow-contracts.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs
git commit -m "fix(ci): replace label conditions with plan outputs"
```

### Task 5: Rewrite Required PR Gate

**Files:**
- Modify: `scripts/ci-required-pr-gate.mjs`
- Modify: `scripts/__tests__/ci-required-pr-gate.test.mjs`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Change gate inputs**

`required-pr-gate` should pass:

```yaml
needs:
  - plan
  - docs-static
  - checks
  - unit_affected
  - unit_coverage
  - browser-tests
  - prepare-web
  - prepare-desktop
  - web-e2e-pr
  - desktop-e2e-pr
  - merge-reports
env:
  REQUIRED_NEEDS: ${{ toJSON(needs) }}
  REQUIRED_PLAN: ${{ needs.plan.outputs.plan-json }}
  REQUIRED_JOBS: ${{ needs.plan.outputs.required-jobs-json }}
```

It must not pass labels or expanded lanes.

- [ ] **Step 2: Update gate validation**

`verifyRequiredPrGate` must:

- require `plan` success
- require every job in `requiredJobs` to be `success`
- reject selected jobs that are `skipped`, `failure`, `cancelled`, `timed_out`, or missing
- ignore skipped jobs that are not in `requiredJobs`
- print selected required jobs on success

- [ ] **Step 3: Test the gate**

Add tests:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyRequiredPrGate } from '../ci-required-pr-gate.mjs';

describe('verifyRequiredPrGate plan mode', () => {
  it('passes when all selected jobs succeed and unselected jobs skip', () => {
    const failures = verifyRequiredPrGate({
      requiredJobs: ['plan', 'checks', 'unit_affected'],
      needs: {
        plan: { result: 'success' },
        checks: { result: 'success' },
        unit_affected: { result: 'success' },
        web_e2e_pr: { result: 'skipped' },
      },
    });
    assert.deepEqual(failures, []);
  });

  it('fails when a selected job is skipped', () => {
    const failures = verifyRequiredPrGate({
      requiredJobs: ['plan', 'checks', 'unit_affected'],
      needs: {
        plan: { result: 'success' },
        checks: { result: 'success' },
        unit_affected: { result: 'skipped' },
      },
    });
    assert.deepEqual(failures, ['unit_affected: skipped']);
  });
});
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test scripts/__tests__/ci-required-pr-gate.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/ci-required-pr-gate.mjs scripts/__tests__/ci-required-pr-gate.test.mjs .github/workflows/test.yml
git commit -m "fix(ci): validate PR gate from computed plan"
```

### Task 6: Delete Proof Manifest Machinery

**Files:**
- Delete: `.ci/proof/latest.json`
- Delete: `scripts/ci-proof.mjs`
- Delete: `scripts/__tests__/ci-proof.test.mjs`
- Delete: `scripts/ci-proof-timing-summary.mjs`
- Delete: `scripts/__tests__/ci-proof-timing-summary.test.mjs`
- Modify: `package.json`
- Modify: `scripts/__tests__` references

- [ ] **Step 1: Remove scripts from `package.json`**

Delete:

```json
"ci:prove": "node scripts/ci-proof.mjs prove",
"ci:verify-proof": "node scripts/ci-proof.mjs verify-proof",
"ci:proof-timing-summary": "node scripts/ci-proof-timing-summary.mjs"
```

Add:

```json
"ci:plan": "node scripts/ci-plan.mjs"
```

Keep:

```json
"ci:select": "node scripts/ci-select.mjs"
```

- [ ] **Step 2: Remove proof files**

Run:

```bash
git rm .ci/proof/latest.json scripts/ci-proof.mjs scripts/__tests__/ci-proof.test.mjs scripts/ci-proof-timing-summary.mjs scripts/__tests__/ci-proof-timing-summary.test.mjs
```

Expected: proof artifact and proof verifier no longer exist.

- [ ] **Step 3: Update script-test bundle references**

Search:

```bash
rg -n "ci-proof|proof-timing|ci:prove|ci:verify-proof|\\.ci/proof/latest\\.json|proof manifest|proof-only" package.json scripts .github AGENTS.md docs .ci
```

Expected after edits:

- No required workflow or PR docs reference proof.
- Historical docs may mention prior proof only if clearly marked obsolete.

- [ ] **Step 4: Run script tests**

Run:

```bash
pnpm test:scripts
```

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json scripts .github .ci
git commit -m "refactor(ci): remove proof manifest gating"
```

### Task 7: Update Agent And PR Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `docs/architecture-reset/ci-computed-risk-plan-2026-05-24.md`

- [ ] **Step 1: Replace AGENTS PR section**

Replace `## PR CI PROOF FLOW` with:

```markdown
## PR CI FLOW

Pull requests are gated by a CI-computed risk plan. Agents do not add `ci:*`
labels and do not commit `.ci/proof/latest.json`.

Before opening or updating a PR:
1. Commit source, config, workflow, test, and doc changes normally.
2. Run `pnpm ci:select --base origin/main --head HEAD` to inspect the plan.
3. If the plan looks broader than the diff justifies, fix the selector before pushing.
4. Push the branch.
5. Let the GitHub `CI Plan` job select required jobs.
6. Monitor `Required PR Gate`; debug the first failing selected job.

Rules:
- Do not run `pnpm ci:prove`; it no longer exists.
- Do not run `pnpm ci:verify-proof`; it no longer exists.
- Do not add `ci:*` labels for routing.
- Do not run full release proof unless explicitly requested.
- Do not rerun broad E2E to diagnose a narrow selected-job failure.
- Superseded GitHub runs should cancel through workflow concurrency.
```

- [ ] **Step 2: Replace PR template checklist**

Replace the CI proof checklist with:

```markdown
## CI

- [ ] Reviewed `pnpm ci:select --base origin/main --head HEAD`
- [ ] Confirmed the selected plan matches the changed files
- [ ] Did not add manual `ci:*` routing labels
- [ ] Did not commit `.ci/proof/latest.json`
```

- [ ] **Step 3: Add short architecture note**

Create `docs/architecture-reset/ci-computed-risk-plan-2026-05-24.md` with:

- why proof manifest was removed
- how CI computes the plan
- how normal PRs behave
- how release proof is triggered
- examples for docs-only, small package source, web UI, desktop reset, and full-risk workflow changes

- [ ] **Step 4: Run doc checks**

Run:

```bash
git diff --check -- AGENTS.md .github/PULL_REQUEST_TEMPLATE.md docs/architecture-reset/ci-computed-risk-plan-2026-05-24.md
```

Expected: no whitespace errors.

- [ ] **Step 5: Commit**

Run:

```bash
git add AGENTS.md .github/PULL_REQUEST_TEMPLATE.md docs/architecture-reset/ci-computed-risk-plan-2026-05-24.md
git commit -m "docs(ci): document CI-computed PR flow"
```

### Task 8: Verify Selector And Workflow Contracts

**Files:**
- Test only

- [ ] **Step 1: Run cheap script and contract tests**

Run:

```bash
node --test scripts/__tests__/ci-plan.test.mjs scripts/__tests__/ci-select.test.mjs scripts/__tests__/ci-risk-rules.test.mjs scripts/__tests__/ci-required-pr-gate.test.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/__tests__/ci-selector-guard.test.mjs
pnpm run lint:ci-workflow-contracts
```

Expected: pass.

- [ ] **Step 2: Run full script-test suite**

Run:

```bash
pnpm test:scripts
```

Expected: pass.

- [ ] **Step 3: Verify no proof or label-routing references remain in active flow**

Run:

```bash
rg -n "ci:prove|ci:verify-proof|\\.ci/proof/latest\\.json|gh pr view \"\\$PR_NUMBER\" --json labels|github.event.pull_request.labels.*.name|proof-only|proof manifest" .github scripts AGENTS.md .github/PULL_REQUEST_TEMPLATE.md package.json
```

Expected: no output.

- [ ] **Step 4: Verify docs-only plan**

Run:

```bash
node scripts/ci-plan.mjs --base origin/main --head HEAD --event pull_request --files docs/example.md
```

Expected:

- risk category `docs-only`
- required jobs `plan` and `docs-static`
- no unit, coverage, browser, web E2E, desktop E2E, or embedding jobs

- [ ] **Step 5: Verify representative fixture tests**

Run:

```bash
pnpm run ci:risk-fixtures
```

Expected: pass with fixture expectations updated to plan jobs rather than PR labels.

### Task 9: Open One Validation PR And Observe Real Behavior

**Files:**
- No code changes after local verification unless GitHub reveals a real defect.

- [ ] **Step 1: Push only after local script verification passes**

Run:

```bash
git push -u origin HEAD
```

Expected: one GitHub Actions run starts and any older run for the same branch is cancelled by workflow concurrency.

- [ ] **Step 2: Create PR**

Run:

```bash
gh pr create --draft --title "ci: replace proof manifest with computed risk plan" --body-file /tmp/brainstrike-ci-plan-pr-body.md
```

Expected: draft PR opens.

- [ ] **Step 3: Monitor latest head only**

Run:

```bash
HEAD_SHA="$(git rev-parse HEAD)"
while true; do
  gh pr checks --json name,state,conclusion,link --jq '.[] | [.name,.state,.conclusion,.link] | @tsv'
  sleep 30
done
```

Stop the loop when all required checks finish or the first selected required job fails.

- [ ] **Step 4: Confirm PR behavior**

Required evidence:

- `CI Plan` ran.
- `PR Sentinel` did not exist.
- No failed run happened because of missing labels.
- No failed run happened because of stale proof.
- `Required PR Gate` depended on plan-selected jobs.
- Unselected expensive jobs were skipped without blocking.
- Superseded branch runs were cancelled.

- [ ] **Step 5: Fix first real failure only**

If a selected job fails:

1. Download the failing job log.
2. Identify the exact root cause.
3. Fix the code or plan.
4. Run focused local tests for that failure.
5. Commit.
6. Push once.

Do not rerun full release proof for a narrow PR failure.

## Acceptance Criteria

- No active PR workflow path reads PR labels for CI routing.
- No active PR workflow path invokes `ci:prove` or `ci:verify-proof`.
- `.ci/proof/latest.json` is removed from the repository.
- `Required PR Gate` remains the single stable branch-protection status.
- CI computes required jobs from changed files.
- Docs-only PRs do not run unit, coverage, web E2E, desktop E2E, or embedding jobs.
- Code PRs run affected static/unit work and only selected E2E lanes.
- Full release proof remains available through scheduled/manual runs.
- `pnpm ci:select --base origin/main --head HEAD` is read-only and matches the CI plan.
- Workflow contracts fail if label routing or proof manifest references return.
- Script tests cover plan generation, gate validation, selector determinism, and workflow contracts.
- The PR template and `AGENTS.md` no longer tell agents to add labels or commit proof.

## Self-Review Checklist

- Spec coverage: This plan removes proof manifest gating, removes human label routing, keeps risk lanes, keeps one required PR gate, preserves release proof, and updates docs.
- Current-code grounding: The plan names the inspected live files and replacement points.
- Cost control: The plan adds no local full-suite requirement and no cloud rerun requirement before the implementation PR.
- No hidden routing: Required jobs come from `plan-json`; unselected jobs are ignored by the gate.
- Migration safety: Current dirty files are preserved before implementation begins.
- Verification: Every code task has focused script/workflow tests before push.
