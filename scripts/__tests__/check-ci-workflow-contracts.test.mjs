import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  extractJob,
  validateTurboContracts,
  validateDesktopE2EContracts,
  validateClaudeReviewWorkflowContracts,
  validateSetupDesktopE2EContracts,
  validateSetupMonorepoContracts,
  validateWorkflowContracts,
} from '../check-ci-workflow-contracts.mjs';

const workflowSource = await readFile('.github/workflows/test.yml', 'utf8');
const claudeReviewWorkflowSource = await readFile(
  '.github/workflows/claude-code-review.yml',
  'utf8'
);
const setupMonorepoSource = await readFile('.github/actions/setup-monorepo/action.yml', 'utf8');
const setupDesktopE2ESource = await readFile('.github/actions/setup-desktop-e2e/action.yml', 'utf8');
const turboConfigSource = await readFile('turbo.jsonc', 'utf8');

test('extractJob returns a single workflow job block', () => {
  const e2e = extractJob(workflowSource, 'e2e');

  assert.ok(e2e);
  assert.match(e2e, /^  e2e:$/m);
  assert.match(e2e, /name: E2E Tests/);
  assert.doesNotMatch(e2e, /^  e2e-stateful:/m);
});

test('extractJob treats job names as literal text', () => {
  const source = ['jobs:', '  e2e.test:', '    name: Literal job', '  e2e-test:', '    name: Other job'].join('\n');
  const job = extractJob(source, 'e2e.test');

  assert.ok(job);
  assert.match(job, /^  e2e\.test:$/m);
  assert.doesNotMatch(job, /name: Other job/);
});

test('extractJob stops before dotted job names', () => {
  const source = ['jobs:', '  e2e:', '    name: Functional job', '  e2e.test:', '    name: Dotted job'].join('\n');
  const job = extractJob(source, 'e2e');

  assert.ok(job);
  assert.match(job, /name: Functional job/);
  assert.doesNotMatch(job, /name: Dotted job/);
});

test('current workflow satisfies CI cost and E2E routing contracts', () => {
  assert.deepEqual(validateWorkflowContracts(workflowSource), []);
});

test('workflow contract fails when test workflow permissions are widened', () => {
  const source = workflowSource.replace('  contents: read', '  contents: write');

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must keep contents: read permission/);
  assert.match(failures, /must not widen permissions with contents: write/);
});

test('workflow contract fails when test workflow inherits all secrets', () => {
  const checks = extractJob(workflowSource, 'checks');
  assert.ok(checks);
  const source = workflowSource.replace(checks, checks.replace('    runs-on:', '    secrets: inherit\n    runs-on:'));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must not inherit all secrets/
  );
});

test('Claude auto-review workflow keeps large PR review budget fail-closed', () => {
  assert.deepEqual(validateClaudeReviewWorkflowContracts(claudeReviewWorkflowSource), []);
});

test('Claude auto-review workflow contract fails when large PR budget regresses', () => {
  const source = claudeReviewWorkflowSource
    .replace('    timeout-minutes: 60', '    timeout-minutes: 30')
    .replace('--max-turns 80', '--max-turns 30');

  const failures = validateClaudeReviewWorkflowContracts(source).join('\n');
  assert.match(failures, /timeout must allow large PR reviews/);
  assert.match(failures, /max-turns must allow large PR reviews/);
});

test('Claude auto-review workflow contract fails when review errors are hidden', () => {
  const source = claudeReviewWorkflowSource.replace(
    '- uses: anthropics/claude-code-action@v1',
    '- uses: anthropics/claude-code-action@v1\n        continue-on-error: true'
  );

  assert.match(
    validateClaudeReviewWorkflowContracts(source).join('\n'),
    /must not continue-on-error/
  );
});

test('Claude auto-review workflow contract fails when self-change guard is removed', () => {
  const source = claudeReviewWorkflowSource
    .replace(/      - name: Detect Claude workflow self-change[\s\S]*?\n\n      - uses:/, '      - uses:')
    .replace(/\n        if: \${{ steps\.claude-workflow-change\.outputs\.changed != 'true' }}/, '');

  const failures = validateClaudeReviewWorkflowContracts(source).join('\n');
  assert.match(failures, /must detect self-edits before invoking Claude/);
  assert.match(failures, /must skip Claude when this workflow changes/);
});

test('workflow contract fails when unit coverage phases are collapsed', () => {
  const unitCoverage = extractJob(workflowSource, 'unit_coverage');
  assert.ok(unitCoverage);

  const source = workflowSource.replace(
    unitCoverage,
    unitCoverage
      .replace('- name: Run affected package unit coverage', '- name: Run combined coverage')
      .replace('- name: Run DB runtime coverage', '- name: Run combined DB coverage')
      .replace('- name: Run DB serial coverage lanes', '- name: Run combined DB coverage lanes')
      .replace('- name: Prepare unit coverage workspace', '- name: Prepare coverage')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must keep affected package coverage in a separate timed step/);
  assert.match(failures, /must keep DB runtime coverage in a separate timed step/);
  assert.match(failures, /must keep serial DB coverage lanes in a separate timed step/);
  assert.match(failures, /must prepare merged workspace coverage in a separate output step/);
});

test('workflow contract fails when split unit coverage job timeout is too low', () => {
  const unitCoverage = extractJob(workflowSource, 'unit_coverage');
  assert.ok(unitCoverage);

  const source = workflowSource.replace(
    unitCoverage,
    unitCoverage.replace('    timeout-minutes: 90', '    timeout-minutes: 45')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must cover split coverage step budgets plus overhead/
  );
});

test('workflow contract fails when affected unit timeout cannot cover cold cache runs', () => {
  const unitAffected = extractJob(workflowSource, 'unit_affected');
  assert.ok(unitAffected);

  const source = workflowSource.replace(
    unitAffected,
    unitAffected
      .replace('    timeout-minutes: 25', '    timeout-minutes: 15')
      .replace('        timeout-minutes: 20', '        timeout-minutes: 10')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Affected unit job timeout must cover setup plus the test step/);
  assert.match(failures, /Affected unit test step timeout must cover cold cache runs/);
});

test('workflow contract fails when isolated changed unit tests expand to Turbo affected tests only', () => {
  const unitAffected = extractJob(workflowSource, 'unit_affected');
  assert.ok(unitAffected);

  const source = workflowSource.replace(
    unitAffected,
    unitAffected
      .replace(/      - name: Detect selected unit proof mode[\s\S]*?\n\n      - name: Run affected unit tests/, '      - name: Run affected unit tests')
      .replace(
        '            node scripts/run-changed-unit-tests.mjs --base "origin/${GITHUB_BASE_REF}" --head HEAD',
        '            pnpm turbo run test --filter="...[origin/${GITHUB_BASE_REF}]" --concurrency=4 --summarize --log-order=grouped --cache-dir=.turbo'
      )
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must detect changed-unit-test proof mode/);
  assert.match(failures, /must use the tested unit proof mode detector/);
  assert.match(failures, /must run changed unit test files directly/);
});

test('workflow contract fails when split unit coverage step timeouts are widened', () => {
  const unitCoverage = extractJob(workflowSource, 'unit_coverage');
  assert.ok(unitCoverage);

  const source = workflowSource.replace(
    unitCoverage,
    unitCoverage
      .replace(
        '      - name: Run affected package unit coverage\n        # Keep the affected package slice separate from the serial DB lanes so\n        # a cold cache cannot spend the entire step timeout before DB coverage.\n        timeout-minutes: 30',
        '      - name: Run affected package unit coverage\n        # Keep the affected package slice separate from the serial DB lanes so\n        # a cold cache cannot spend the entire step timeout before DB coverage.\n        timeout-minutes: 60'
      )
      .replace(
        '      - name: Run DB runtime coverage\n        # DB runtime coverage cold-starts PGlite and must stay isolated from the\n        # broader DB lanes to avoid runner resource contention. These coverage\n        # phases remain fail-fast intentionally; diagnostics below still run.\n        timeout-minutes: 10',
        '      - name: Run DB runtime coverage\n        # DB runtime coverage cold-starts PGlite and must stay isolated from the\n        # broader DB lanes to avoid runner resource contention. These coverage\n        # phases remain fail-fast intentionally; diagnostics below still run.\n        timeout-minutes: 20'
      )
      .replace(
        '      - name: Run DB serial coverage lanes\n        # DB coverage lanes are PGlite-heavy. On GitHub runners, running\n        # several lanes at once saturates the runner and turns valid 10s unit\n        # timeouts into contention failures, so keep DB lanes serial.\n        timeout-minutes: 30',
        '      - name: Run DB serial coverage lanes\n        # DB coverage lanes are PGlite-heavy. On GitHub runners, running\n        # several lanes at once saturates the runner and turns valid 10s unit\n        # timeouts into contention failures, so keep DB lanes serial.\n        timeout-minutes: 60'
      )
      .replace(
        '      - name: Prepare unit coverage workspace\n        id: unit-tests\n        timeout-minutes: 5',
        '      - name: Prepare unit coverage workspace\n        id: unit-tests\n        timeout-minutes: 10'
      )
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /package and DB serial steps must stay at 30 minutes or less/);
  assert.match(failures, /DB runtime coverage must keep a tight isolated timeout/);
  assert.match(failures, /Coverage workspace preparation must keep a tight timeout/);
});

test('workflow contract fails when unit coverage diagnostics depend on coverage outputs', () => {
  const unitCoverage = extractJob(workflowSource, 'unit_coverage');
  assert.ok(unitCoverage);

  const source = workflowSource.replace(
    unitCoverage,
    unitCoverage.replaceAll(
      'if: ${{ !cancelled() }}',
      "if: ${{ !cancelled() && steps.unit-tests.outcome != 'skipped' }}"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /timing diagnostics must still run when an earlier coverage phase fails/
  );
});

test('setup monorepo action satisfies cache contracts', () => {
  assert.deepEqual(validateSetupMonorepoContracts(setupMonorepoSource), []);
});

test('setup desktop E2E action satisfies preprovisioned dependency setup contracts', () => {
  assert.deepEqual(validateSetupDesktopE2EContracts(setupDesktopE2ESource), []);
});

test('Turborepo task config satisfies browser test environment contracts', () => {
  assert.deepEqual(validateTurboContracts(turboConfigSource), []);
});

test('Turborepo browser test contract fails when Playwright browser path is not passed through', () => {
  const source = turboConfigSource.replace('"PLAYWRIGHT_BROWSERS_PATH"', '"PLAYWRIGHT_CACHE"');

  assert.match(
    validateTurboContracts(source).join('\n'),
    /must pass PLAYWRIGHT_BROWSERS_PATH through/
  );
});

test('setup desktop E2E contract fails when apt is added to the shard setup', () => {
  const source = `${setupDesktopE2ESource}
    - name: Install system dependencies
      shell: bash
      run: sudo apt-get update`;

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must not run apt-get/
  );
});

test('setup desktop E2E contract fails when Playwright dependency install is unbounded', () => {
  const source = `${setupDesktopE2ESource}
    - name: Install Playwright system dependencies
      shell: bash
      run: pnpm exec playwright install-deps`;

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must not run Playwright install-deps/
  );
});

test('setup desktop E2E contract fails when Xvfb image verification is removed', () => {
  const source = setupDesktopE2ESource.replace('command -v Xvfb >/dev/null', 'echo skipped');

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must verify Xvfb/
  );
});

test('setup desktop E2E contract fails when Electron is resolved outside the desktop package', () => {
  const source = setupDesktopE2ESource.replace('cd apps/desktop', 'echo skipped');

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must resolve Electron from the desktop package/
  );
});

test('setup desktop E2E contract fails when Electron ldd verification is removed', () => {
  const source = setupDesktopE2ESource.replace('ldd "${ELECTRON_BINARY}"', 'echo skipped');

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must inspect Electron shared-library dependencies/
  );
});

test('workflow contract fails when Turbo commands stop using the shared cache directory', () => {
  const source = workflowSource.replace(' --cache-dir=.turbo', '');

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Turbo commands in the Test workflow must use the shared \.turbo cache directory/
  );
});

test('workflow contract fails when Turbo command summaries are dropped', () => {
  const source = workflowSource.replace(' --summarize', '');

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Turbo commands in the Test workflow must emit run summaries/
  );
});

test('workflow contract fails when Turbo run commands disappear', () => {
  const source = workflowSource.replaceAll('pnpm turbo run', 'pnpm turbo');

  assert.match(validateWorkflowContracts(source).join('\n'), /No Turbo run commands were found/);
});

test('workflow contract accepts Turbo run commands without the pnpm prefix', () => {
  const source = workflowSource.replaceAll('pnpm turbo run', 'turbo run');

  assert.deepEqual(validateWorkflowContracts(source), []);
});

test('workflow contract fails when required browser Vitest installs Playwright deps live', () => {
  const browserTests = extractJob(workflowSource, 'browser-tests');
  assert.ok(browserTests);

  const source = workflowSource.replace(
    browserTests,
    browserTests.replace(
      'pnpm exec playwright --version',
      'pnpm exec playwright install-deps chromium'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Browser Vitest Playwright job must not run install-deps during required CI/
  );
});

test('workflow contract fails when required web E2E leaves the Playwright image', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(
    e2e,
    e2e.replace('image: mcr.microsoft.com/playwright:v1.59.1-noble', 'image: ubuntu:24.04')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Functional E2E Playwright job must run in the preprovisioned Playwright Noble image/
  );
});

test('workflow contract fails when preprovisioned Playwright runtime verification is removed', () => {
  const destructive = extractJob(workflowSource, 'e2e-destructive');
  assert.ok(destructive);

  const source = workflowSource.replace(
    destructive,
    destructive.replace('chromium.launch', 'console.log')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Destructive E2E Playwright job must prove Chromium launches/
  );
});

test('setup monorepo contract fails when Turborepo cache path is removed', () => {
  const source = setupMonorepoSource.replace('path: .turbo', 'path: .turbo-disabled');

  assert.match(
    validateSetupMonorepoContracts(source).join('\n'),
    /must cache the shared \.turbo directory/
  );
});

test('setup monorepo contract fails when Turborepo config stops invalidating cache keys', () => {
  const source = setupMonorepoSource.replace(", 'turbo.jsonc'", '');

  assert.match(
    validateSetupMonorepoContracts(source).join('\n'),
    /cache key must include lockfile, turbo config, and tsconfig inputs/
  );
});

test('setup monorepo contract fails when cache hit reporting is removed', () => {
  const source = setupMonorepoSource.replace('TURBO_CACHE_HIT: ${{ steps.turbo-cache.outputs.cache-hit }}', '');

  assert.match(
    validateSetupMonorepoContracts(source).join('\n'),
    /cache summary must report Turborepo cache hit status/
  );
});

test('workflow contract fails when blob reports upload on success', () => {
  const source = workflowSource.replace(
    '- name: Upload blob report\n        if: failure()',
    '- name: Upload blob report\n        if: always()'
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Blob report uploads must be failure-only/
  );
});

test('workflow contract fails when report merge assumes artifact subdirectories', () => {
  const mergeReports = extractJob(workflowSource, 'merge-reports');
  assert.ok(mergeReports);

  const source = workflowSource.replace(
    mergeReports,
    mergeReports.replace(
      'find all-blob-reports -maxdepth 3 -print | sort',
      'ls -la all-blob-reports/*/'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must not assume download-artifact creates per-artifact subdirectories/
  );
});

test('workflow contract fails when report merge stops extracting root tar bundles', () => {
  const mergeReports = extractJob(workflowSource, 'merge-reports');
  assert.ok(mergeReports);

  const source = workflowSource.replace(
    mergeReports,
    mergeReports.replace(
      'find all-blob-reports -type f -name "*.tar" -print0',
      'find all-blob-reports/*/ -type f -name "*.tar" -print0'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must extract tar bundles found anywhere/
  );
});

test('workflow contract fails when report merge treats raw artifacts as mergeable reports', () => {
  const mergeReports = extractJob(workflowSource, 'merge-reports');
  assert.ok(mergeReports);

  const source = workflowSource.replace(
    mergeReports,
    mergeReports.replaceAll(
      'find all-blob-reports -type f -path "*/blob-report/*"',
      'ls -A all-blob-reports'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must only run when extracted blob report files exist/
  );
});

test('workflow contract fails when stateful E2E waits on determine-matrix', () => {
  const stateful = extractJob(workflowSource, 'e2e-stateful');
  assert.ok(stateful);
  const source = workflowSource.replace(
    stateful,
    stateful.replace('needs: [checks]\n    runs-on', 'needs: [checks, determine-matrix]\n    runs-on')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Stateful E2E must not wait on determine-matrix/
  );
});

test('workflow contract requires PR Sentinel to verify local proof', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);
  const source = workflowSource
    .replace(/  pr-sentinel:[\s\S]*?\n  checks:/, '  checks:')
    .replace(prGate, prGate.replace('\n      - pr-sentinel\n', '\n'));

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Missing pr-sentinel job/);
  assert.match(failures, /Required PR Gate must depend on pr-sentinel/);
});

test('workflow contract requires PR Sentinel to verify the pull request head', () => {
  const source = workflowSource
    .replace(
      'PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
      'PR_HEAD_SHA: ${{ github.sha }}'
    )
    .replace('--head "$PR_HEAD_SHA"', '--head "$GITHUB_SHA"');

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /pull request head SHA/);
  assert.match(failures, /must not verify proof against GITHUB_SHA/);
});

test('workflow contract requires selected risk labels to gate matching cloud jobs', () => {
  const browserTests = extractJob(workflowSource, 'browser-tests');
  assert.ok(browserTests);

  const source = workflowSource.replace(
    browserTests,
    browserTests.replace(
      "contains(join(github.event.pull_request.labels.*.name, ','), 'ci:browser')",
      "contains(join(github.event.pull_request.labels.*.name, ','), 'ci:web-e2e')"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Browser Vitest must run on PRs labeled ci:browser/
  );
});

test('workflow contract keeps full matrix available outside pull requests', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(e2e, e2e.replace("github.event_name == 'schedule' ||\n  ", ''));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Functional E2E must remain available for schedule full-matrix runs/
  );
});

test('workflow contract fails when PR heavy jobs run without risk labels', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(
    e2e,
    e2e.replace(/contains\(join\(github\.event\.pull_request\.labels\.\*\.name, ','\), 'ci:full'\) \|\|\n\s+contains\(join\(github\.event\.pull_request\.labels\.\*\.name, ','\), 'ci:web-e2e'\)/, "github.event_name == 'pull_request'")
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Functional E2E must run on PRs labeled ci:full/);
  assert.match(failures, /Functional E2E must run on PRs labeled ci:web-e2e/);
});

test('workflow contract fails when the aggregate PR gate requires skipped jobs', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(prGate, prGate.replace('\n      - e2e\n', '\n'));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must depend on e2e/
  );
});

test('workflow contract fails when the PR gate accepts skipped selected lanes', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(
    prGate,
    prGate.replace(
      "              if (needs[jobName]?.result !== 'success') {",
      "              if (needs[jobName]?.result === 'failure') {"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must fail when a selected risk lane is skipped, failed, or cancelled/
  );
});

test('workflow contract fails when the PR gate allows skipped static checks', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(
    prGate,
    prGate.replace(
      "const alwaysRequiredJobs = ['pr-sentinel', 'checks'];",
      "const alwaysRequiredJobs = ['pr-sentinel'];"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must define always-required PR jobs/
  );
});

test('workflow contract fails when the PR gate rejects unselected skipped lanes', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(
    prGate,
    prGate.replace(
      "job.result === 'failure' || job.result === 'cancelled' || job.result === 'timed_out'",
      "job.result !== 'success'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must not require unselected skipped jobs to succeed/
  );
});

test('workflow contract fails when the PR gate label job map drifts', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(
    prGate,
    prGate.replace(
      "['ci:web-e2e', ['prepare-web', 'e2e', 'e2e-stateful', 'e2e-destructive']]",
      "['ci:web-e2e', ['prepare-web', 'e2e']]"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must map ci:web-e2e to prepare-web, e2e, e2e-stateful, e2e-destructive/
  );
});

test('workflow contract fails when a narrow desktop lane job drops its label gate', () => {
  const ipcReset = extractJob(workflowSource, 'desktop-e2e-ipc-reset-pr');
  assert.ok(ipcReset);

  const source = workflowSource.replace(
    ipcReset,
    ipcReset.replace(
      "contains(join(github.event.pull_request.labels.*.name, ','), 'ci:desktop-ipc-reset')",
      "contains(join(github.event.pull_request.labels.*.name, ','), 'ci:desktop')"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /PR desktop IPC reset must run on PRs labeled ci:desktop-ipc-reset/
  );
});

test('workflow contract fails when the PR gate forgets a narrow desktop lane', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(
    prGate,
    prGate.replace(
      "['ci:desktop-ipc-reset', ['prepare-desktop', 'desktop-e2e-ipc-reset-pr']],",
      ''
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must map ci:desktop-ipc-reset to prepare-desktop, desktop-e2e-ipc-reset-pr/
  );
});

test('workflow contract fails when PR desktop E2E is smoke-only', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr
      .replace('name: Desktop E2E Regression', 'name: Desktop E2E Smoke')
      .replace('--project=regression', '--project=smoke')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /PR desktop E2E must run the regression Playwright project/
  );
});

test('workflow contract fails when desktop regression runs multiple workers per shard', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopPr);
  assert.ok(desktopMain);

  const source = workflowSource
    .replace(desktopPr, desktopPr.replace('--workers=1', '--workers=2'))
    .replace(desktopMain, desktopMain.replace('--workers=1', '--workers=2'));

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /PR desktop E2E must keep one worker per shard/);
  assert.match(failures, /Main desktop E2E must keep one worker per shard/);
});

test('workflow contract fails when desktop regression retries are reintroduced', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace(' --retries=0 --max-failures=1', '')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop regression E2E must disable Playwright retries/);
  assert.match(failures, /desktop regression E2E must fail fast on the first failure/);
});

test('workflow contract fails when desktop regression jobs leave the Playwright image', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace('image: mcr.microsoft.com/playwright:v1.59.1-noble', 'image: ubuntu:24.04')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop regression job must run in the preprovisioned Playwright Noble image/
  );
});

test('workflow contract fails when desktop regression jobs reintroduce apt or sudo', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace('echo "Starting Playwright regression tests..."', 'sudo apt-get update')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop regression job must not run apt-get/);
  assert.match(failures, /desktop regression job must not require sudo/);
});

test('workflow contract fails when desktop regression global timeout is removed', () => {
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopMain);

  const source = workflowSource.replace(
    desktopMain,
    desktopMain.replace(' --global-timeout=720000', '')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop regression E2E must cap Playwright runtime at 12 minutes/
  );
});

test('workflow contract fails when desktop regression global timeout is widened', () => {
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopMain);

  const source = workflowSource.replace(
    desktopMain,
    desktopMain.replace(' --global-timeout=720000', ' --global-timeout=900000')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop regression E2E must cap Playwright runtime at 12 minutes/
  );
});

test('workflow contract does not accept desktop regression timeout lines outside the job header', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr
      .replace('    timeout-minutes: 20\n', '')
      .replace('    steps:\n', '    steps:\n    timeout-minutes: 15\n')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop regression job timeout must stay at 20 minutes/
  );
});

test('workflow contract allows stricter desktop regression global timeout', () => {
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopMain);

  const source = workflowSource.replace(
    desktopMain,
    desktopMain.replace(' --global-timeout=720000', ' --global-timeout=600000')
  );

  assert.doesNotMatch(
    validateWorkflowContracts(source).join('\n'),
    /desktop regression E2E must cap Playwright runtime at 12 minutes/
  );
});

test('workflow contract fails when desktop embedding retries are reintroduced', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(' --retries=0 --max-failures=1', '')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop embedding E2E must disable Playwright retries/);
  assert.match(failures, /desktop embedding E2E must fail fast on the first failure/);
});

test('workflow contract fails when desktop embedding jobs leave the Playwright image', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(
      'image: mcr.microsoft.com/playwright:v1.59.1-noble',
      'image: ubuntu:24.04'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop embedding job must run in the preprovisioned Playwright Noble image/
  );
});

test('workflow contract fails when desktop embedding jobs reintroduce apt or sudo', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(
      'echo "Starting Xvfb on display ${DISPLAY} for embedding group ${{ matrix.group }}"',
      'sudo apt-get update'
    )
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop embedding job must not run apt-get/);
  assert.match(failures, /desktop embedding job must not require sudo/);
});

test('workflow contract fails when desktop embedding global timeout is removed', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(' --global-timeout=720000', '')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop embedding E2E must cap Playwright runtime at 12 minutes/
  );
});

test('workflow contract fails when broad desktop embedding core lane is reintroduced', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace('@desktop-embedding-lifecycle', '@desktop-embedding-core')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must not reintroduce the broad @desktop-embedding-core lane/
  );
});

test('workflow contract fails when diagnostic desktop embedding crash lanes are required', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(
      '          - group: mixed\n            display: 106\n            grep: "@desktop-embedding-mixed"',
      '          - group: mixed\n            display: 106\n            grep: "@desktop-embedding-mixed"\n          - group: crash-a\n            display: 107\n            grep: "@desktop-embedding-crash-a"'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must keep diagnostic @desktop-embedding-crash-a out of required lanes/
  );
});

test('workflow contract fails when mixed embedding spec coverage drops crash-a file', () => {
  const source = workflowSource.replaceAll(
    ' e2e/embedding-worker-renderer.crash-a.desktop.test.ts',
    ''
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop embedding E2E must include split spec e2e\/embedding-worker-renderer\.crash-a\.desktop\.test\.ts/
  );
});

test('workflow contract fails when desktop embedding timeout is widened', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr
      .replace('timeout-minutes: 15', 'timeout-minutes: 40')
      .replace('timeout-minutes: 12', 'timeout-minutes: 35')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop embedding job timeout must stay at 15 minutes/);
  assert.match(failures, /desktop embedding test step timeout must stay at 12 minutes/);
});

test('workflow contract fails when desktop PR and main shard totals diverge', () => {
  const source = workflowSource
    .replace('desktop-shards=["1","2","3","4"]', 'desktop-shards=["1","2"]')
    .replace('desktop-shard-total=["4"]', 'desktop-shard-total=["2"]');

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop regression matrix must stay at four shards/
  );
});

test('desktop E2E contract fails when Playwright is forced to one worker', () => {
  const failures = validateDesktopE2EContracts({
    playwrightConfigSource: 'workers: 1\nfullyParallel: config.fullyParallel',
    playwrightEnvironmentSource: 'return 0;',
  });

  assert.match(failures.join('\n'), /must not force workers to one/);
});

test('desktop E2E contract fails when Playwright has a 15 minute global timeout', () => {
  const failures = validateDesktopE2EContracts({
    playwrightConfigSource: 'workers: config.workers\nfullyParallel: config.fullyParallel',
    playwrightEnvironmentSource: 'return 15 * 60 * 1000;',
  });

  assert.match(failures.join('\n'), /globalTimeout disabled/);
  assert.match(failures.join('\n'), /15 minute global timeout/);
});
