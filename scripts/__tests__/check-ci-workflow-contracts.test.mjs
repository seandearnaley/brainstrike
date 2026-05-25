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
  validateSetupPlaywrightRuntimeContracts,
  validateWorkflowContracts,
} from '../check-ci-workflow-contracts.mjs';

const workflowSource = await readFile('.github/workflows/test.yml', 'utf8');
const claudeReviewWorkflowSource = await readFile(
  '.github/workflows/claude-code-review.yml',
  'utf8'
);
const setupMonorepoSource = await readFile('.github/actions/setup-monorepo/action.yml', 'utf8');
const setupDesktopE2ESource = await readFile('.github/actions/setup-desktop-e2e/action.yml', 'utf8');
const setupPlaywrightRuntimeSource = await readFile(
  '.github/actions/setup-playwright-runtime/action.yml',
  'utf8'
);
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
      .replace(
        '          UNIT_MODE: ${{ needs.plan.outputs.unit-mode }}',
        '          UNIT_MODE: affected-packages'
      )
      .replace(
        '            node scripts/run-changed-unit-tests.mjs --base "origin/${GITHUB_BASE_REF}" --head HEAD',
        '            pnpm turbo run test --filter="...[origin/${GITHUB_BASE_REF}]" --concurrency=4 --summarize --log-order=grouped --cache-dir=.turbo'
      )
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must read changed-unit-test mode from CI Plan/);
  assert.match(failures, /must run changed unit test files directly/);
});

test('workflow contract fails when affected unit diagnostics can use stale Turbo summaries', () => {
  const unitAffected = extractJob(workflowSource, 'unit_affected');
  assert.ok(unitAffected);

  const source = workflowSource.replace(
    unitAffected,
    unitAffected.replace('          rm -rf .turbo/runs\n          mkdir -p .turbo/runs\n', '')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Affected unit job must clear stale Turbo summaries/
  );
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

test('setup desktop E2E action satisfies dependency setup contracts', () => {
  assert.deepEqual(validateSetupDesktopE2EContracts(setupDesktopE2ESource), []);
});

test('setup Playwright runtime action satisfies browser runtime contracts', () => {
  assert.deepEqual(validateSetupPlaywrightRuntimeContracts(setupPlaywrightRuntimeSource), []);
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

test('Turborepo global dependency contract rejects ignored tsconfig globs', () => {
  const source = turboConfigSource.replace(
    '"packages/*/tsconfig/*.json"',
    '"**/tsconfig*.json"'
  );

  assert.match(
    validateTurboContracts(source).join('\n'),
    /must not hash ignored worktree or generated tsconfig files/
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

test('setup desktop E2E contract fails when Xvfb verification is removed', () => {
  const source = setupDesktopE2ESource.replace('command -v Xvfb >/dev/null', 'echo skipped');

  assert.match(
    validateSetupDesktopE2EContracts(source).join('\n'),
    /must verify Xvfb/
  );
});

test('setup Playwright runtime contract fails when Chromium launch verification is removed', () => {
  const source = setupPlaywrightRuntimeSource.replace('chromium: [chromium, {}]', 'chromium: null');

  assert.match(
    validateSetupPlaywrightRuntimeContracts(source).join('\n'),
    /must prove Chromium launches/
  );
});

test('setup Playwright runtime contract fails when browser caching is removed', () => {
  const source = setupPlaywrightRuntimeSource.replace('actions/cache@v5', 'actions/checkout@v6');

  assert.match(
    validateSetupPlaywrightRuntimeContracts(source).join('\n'),
    /must cache browser binaries/
  );
});

test('setup Playwright runtime contract fails when browser path export is removed', () => {
  const source = setupPlaywrightRuntimeSource.replace(
    'echo "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" >> "$GITHUB_ENV"',
    'echo skipped'
  );

  assert.match(
    validateSetupPlaywrightRuntimeContracts(source).join('\n'),
    /must export the cached browser path/
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

test('workflow contract fails when required browser Vitest bypasses the shared Playwright runtime setup', () => {
  const browserTests = extractJob(workflowSource, 'browser-tests');
  assert.ok(browserTests);

  const source = workflowSource.replace(
    browserTests,
    browserTests.replace(
      'uses: ./.github/actions/setup-playwright-runtime',
      'run: pnpm exec playwright --version'
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Browser Vitest Playwright job must use the cached Playwright runtime setup action/
  );
});

test('workflow contract fails when required web E2E reintroduces the Playwright container', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(
    e2e,
    e2e.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    container:\n      image: mcr.microsoft.com/playwright:v1.59.1-noble')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Functional E2E Playwright job must not depend on the MCR Playwright container image/
  );
});

test('workflow contract fails when Playwright runtime setup is removed from destructive E2E', () => {
  const destructive = extractJob(workflowSource, 'e2e-destructive');
  assert.ok(destructive);

  const source = workflowSource.replace(
    destructive,
    destructive.replace('uses: ./.github/actions/setup-playwright-runtime', 'run: pnpm exec playwright --version')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Destructive E2E Playwright job must use the cached Playwright runtime setup action/
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
    /cache key must include scoped lockfile, turbo config, and first-party tsconfig inputs/
  );
});

test('setup monorepo contract fails when Turborepo cache hashes ignored tsconfig files', () => {
  const source = setupMonorepoSource.replace(
    "'packages/*/tsconfig/*.json'",
    "'**/tsconfig*.json'"
  );

  assert.match(
    validateSetupMonorepoContracts(source).join('\n'),
    /must not hash ignored worktree or generated tsconfig files/
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

test('workflow contract requires CI Plan to compute PR routing', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);
  const source = workflowSource
    .replace(/  plan:[\s\S]*?\n  docs-static:/, '  docs-static:')
    .replace(prGate, prGate.replace('\n      - plan\n', '\n'));

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Missing plan job/);
  assert.match(failures, /Required PR Gate must depend on plan/);
});

test('workflow contract requires CI Plan to use the pull request head and base', () => {
  const source = workflowSource
    .replace(
      "PR_HEAD_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
      'PR_HEAD_SHA: ${{ github.sha }}'
    )
    .replace('--head "$PR_HEAD_SHA" --base "origin/${GITHUB_BASE_REF}"', '--head "$GITHUB_SHA" --base origin/main');

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must compute PR risk from the pull request head/);
});

test('workflow contract requires selected CI Plan outputs to gate matching cloud jobs', () => {
  const browserTests = extractJob(workflowSource, 'browser-tests');
  assert.ok(browserTests);

  const source = workflowSource.replace(
    browserTests,
    browserTests.replace(
      "needs.plan.outputs.run-browser-tests == 'true'",
      "needs.plan.outputs.run-web-e2e-pr == 'true'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Browser Vitest must use CI Plan output run-browser-tests/
  );
});

test('workflow contract rejects label-triggered pull request reruns', () => {
  const source = workflowSource
    .replace('      - ready_for_review\n', '      - ready_for_review\n      - labeled\n      - unlabeled\n');

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must not rerun on labeled/);
  assert.match(failures, /must not rerun on unlabeled/);
});

test('workflow contract requires Required PR Gate to use planned required jobs', () => {
  const requiredPrGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(requiredPrGate);

  const source = workflowSource.replace(
    requiredPrGate,
    requiredPrGate
      .replace(
        '          REQUIRED_JOBS_JSON: ${{ needs.plan.outputs.required-jobs-json }}\n',
        ''
      )
      .replace('        run: node scripts/ci-required-pr-gate.mjs', "        run: echo 'Required PR gate passed.'")
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /must read required jobs from CI Plan outputs/);
  assert.match(failures, /must use the tested gate script/);
});

test('workflow contract requires Required PR Gate to checkout the repo', () => {
  const requiredPrGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(requiredPrGate);

  const source = workflowSource.replace(
    requiredPrGate,
    requiredPrGate.replace(
      '      - name: Checkout\n        uses: actions/checkout@v6\n\n',
      ''
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must checkout the repo/
  );
});

test('workflow contract fails when a planned job is missing from required gate needs', () => {
  const requiredPrGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(requiredPrGate);

  const source = workflowSource.replace(
    requiredPrGate,
    requiredPrGate.replace('\n      - web-e2e-pr', '')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must depend on web-e2e-pr/
  );
});

test('workflow contract keeps full release matrix available outside pull requests', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(e2e, e2e.replace("github.event_name == 'schedule' ||\n  ", ''));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Functional E2E must remain available for schedule release-matrix runs/
  );
});

test('workflow contract requires explicit manual release proof inputs', () => {
  const source = workflowSource
    .replace('release_proof:', 'release_proof_removed:')
    .replace('default: skip', 'default: full-release')
    .replace('          - full-release\n', '')
    .replace('          - desktop-backgrounding\n', '')
    .replace('release-proof-dispatch-policy:', 'release-proof-dispatch-policy-removed:');

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Manual workflow_dispatch must expose an explicit release_proof input/);
  assert.match(failures, /Manual workflow_dispatch release_proof input must default to skip/);
  assert.match(failures, /Manual workflow_dispatch release_proof input must offer full-release explicitly/);
  assert.match(failures, /Manual workflow_dispatch release_proof input must keep desktop backgrounding explicit/);
  assert.match(failures, /Manual workflow_dispatch must include a cheap release proof policy summary job/);
});

test('workflow contract fails when manual release proof inputs are interpolated into shell', () => {
  const policy = extractJob(workflowSource, 'release-proof-dispatch-policy');
  assert.ok(policy);

  const source = workflowSource.replace(
    policy,
    policy
      .replace('RELEASE_PROOF_MODE: ${{ inputs.release_proof }}\n', '')
      .replace('RELEASE_PROOF_REASON: ${{ inputs.reason }}\n', '')
      .replace("printf 'Selected mode: `%s`\\n\\n' \"$RELEASE_PROOF_MODE\"", 'echo \'Selected mode: `${{ inputs.release_proof }}`\'')
      .replace("printf '\\nReason: `%s`\\n' \"$RELEASE_PROOF_REASON\"", 'echo \'Reason: `${{ inputs.reason }}`\'')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Manual release proof policy must pass release_proof through env/);
  assert.match(failures, /Manual release proof policy must pass reason through env/);
  assert.match(failures, /Manual release proof policy must not interpolate release_proof directly into the run script/);
  assert.match(failures, /Manual release proof policy must not interpolate free-text reason directly into the run script/);
});

test('workflow contract fails when release matrix runs on unconfirmed manual dispatch', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  assert.ok(e2e);

  const source = workflowSource.replace(
    e2e,
    e2e.replace(
      "(github.event_name == 'workflow_dispatch' && inputs.release_proof == 'full-release')",
      "github.event_name == 'workflow_dispatch'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Functional E2E must require release_proof=full-release for manual release-matrix runs/
  );
});

test('workflow contract fails when static checks run on unconfirmed manual dispatch', () => {
  const checks = extractJob(workflowSource, 'checks');
  assert.ok(checks);

  const source = workflowSource.replace(
    checks,
    checks.replace(
      "(github.event_name == 'workflow_dispatch' && inputs.release_proof == 'full-release')",
      "github.event_name == 'workflow_dispatch'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Checks \(static\) must require release_proof=full-release/
  );
});

test('workflow contract fails when desktop backgrounding runs on every manual dispatch', () => {
  const backgrounding = extractJob(workflowSource, 'desktop-e2e-backgrounding');
  assert.ok(backgrounding);

  const source = workflowSource.replace(
    backgrounding,
    backgrounding.replace(
      "if: github.event_name == 'workflow_dispatch' && inputs.release_proof == 'desktop-backgrounding'",
      "if: github.event_name == 'workflow_dispatch'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop backgrounding diagnostic must require release_proof=desktop-backgrounding/
  );
});

test('workflow contract fails when release matrix runs on every main push', () => {
  const e2e = extractJob(workflowSource, 'e2e');
  const unitCoverage = extractJob(workflowSource, 'unit_coverage');
  const mergeReports = extractJob(workflowSource, 'merge-reports');
  assert.ok(e2e);
  assert.ok(unitCoverage);
  assert.ok(mergeReports);

  const source = workflowSource
    .replace(
      e2e,
      e2e.replace(
        "github.event_name == 'schedule' ||",
        "github.event_name == 'push' ||\n      github.event_name == 'schedule' ||"
      )
    )
    .replace(
      unitCoverage,
      unitCoverage.replace(
        "github.event_name == 'schedule' ||",
        "github.event_name == 'push' ||\n      github.event_name == 'schedule' ||"
      )
    )
    .replace(
      mergeReports,
      mergeReports.replace(
        "github.event_name == 'schedule' ||",
        "github.event_name == 'push' ||\n        github.event_name == 'schedule' ||"
      )
    );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Functional E2E must not run the release matrix on plain main pushes/);
  assert.match(failures, /Checks \(coverage-db\/full\) must not run the release matrix on plain main pushes/);
  assert.match(failures, /Merge Test Reports must not run the release matrix on plain main pushes/);
});

test('workflow contract fails when main smoke jobs do not run on push', () => {
  const webSmoke = extractJob(workflowSource, 'web-e2e-smoke-pr');
  const desktopSmoke = extractJob(workflowSource, 'desktop-e2e-smoke-pr');
  assert.ok(webSmoke);
  assert.ok(desktopSmoke);

  const source = workflowSource
    .replace(webSmoke, webSmoke.replace("if: github.event_name == 'push'", 'if: ${{ false }}'))
    .replace(desktopSmoke, desktopSmoke.replace("if: github.event_name == 'push'", 'if: ${{ false }}'));

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Web E2E Smoke must remain available for the main push smoke gate/);
  assert.match(failures, /Desktop E2E Smoke must remain available for the main push smoke gate/);
});

test('workflow contract fails when PR web E2E runs without CI Plan output', () => {
  const webPr = extractJob(workflowSource, 'web-e2e-pr');
  assert.ok(webPr);

  const source = workflowSource.replace(
    webPr,
    webPr.replace("needs.plan.outputs.run-web-e2e-pr == 'true'", "github.event_name == 'pull_request'")
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Web E2E PR must use CI Plan output run-web-e2e-pr/);
});

test('workflow contract fails when the aggregate PR gate misses planned jobs', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(prGate, prGate.replace('\n      - docs-static\n', '\n'));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must depend on docs-static/
  );
});

test('workflow contract fails when main gate requires release-only jobs', () => {
  const mainGate = extractJob(workflowSource, 'required-main-gate');
  assert.ok(mainGate);

  const source = workflowSource.replace(
    mainGate,
    mainGate.replace(
      '\n      - web-e2e-smoke-pr\n',
      '\n      - web-e2e-smoke-pr\n      - unit_coverage\n      - e2e\n      - merge-reports\n'
    )
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Required Main Gate must not depend on release-only job unit_coverage/);
  assert.match(failures, /Required Main Gate must not depend on release-only job e2e/);
  assert.match(failures, /Required Main Gate must not depend on release-only job merge-reports/);
});

test('workflow contract requires a full scheduled/manual release gate', () => {
  const releaseGate = extractJob(workflowSource, 'required-release-gate');
  assert.ok(releaseGate);

  const source = workflowSource.replace(releaseGate, releaseGate.replace('\n      - unit_coverage\n', '\n'));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required Release Gate must depend on unit_coverage/
  );
});

test('workflow contract fails when optional code quality runs on every main push', () => {
  const codeQuality = extractJob(workflowSource, 'code-quality');
  assert.ok(codeQuality);

  const source = workflowSource.replace(
    codeQuality,
    codeQuality.replace(
      "if: github.event_name == 'pull_request' || github.event_name == 'schedule'",
      "if: github.event_name != 'workflow_dispatch'"
    )
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Code Quality must not run on every main push/
  );
});

test('workflow contract fails when desktop PR lane drops its CI Plan gate', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace("needs.plan.outputs.run-desktop-e2e-pr == 'true'", "github.event_name == 'pull_request'")
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop E2E PR must use CI Plan output run-desktop-e2e-pr/
  );
});

test('workflow contract fails when PR desktop E2E stops using the planned matrix', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace('matrix: ${{ fromJSON(needs.plan.outputs.desktop-e2e-matrix) }}', 'matrix:\n        lane: [desktop-smoke]')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop E2E PR must use the CI Plan desktop matrix/
  );
});

test('workflow contract fails when desktop regression runs multiple workers per shard', () => {
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopMain);

  const source = workflowSource.replace(
    desktopMain,
    desktopMain.replace('--workers=1', '--workers=2')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Main desktop E2E must keep one worker per shard/);
});

test('workflow contract fails when desktop regression retries are reintroduced', () => {
  const desktopMain = extractJob(workflowSource, 'desktop-e2e-main');
  assert.ok(desktopMain);

  const source = workflowSource.replace(
    desktopMain,
    desktopMain.replace(' --retries=0 --max-failures=1', '')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop regression E2E must disable Playwright retries/);
  assert.match(failures, /desktop regression E2E must fail fast on the first failure/);
});

test('workflow contract fails when desktop regression jobs reintroduce the Playwright container', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    container:\n      image: mcr.microsoft.com/playwright:v1.59.1-noble')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop E2E PR must not depend on the MCR Playwright container image/
  );
});

test('workflow contract fails when desktop regression jobs reintroduce apt or sudo', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr.replace('echo "Starting selected desktop lane: ${{ matrix.lane }}"', 'sudo apt-get update')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /Desktop E2E PR must not run apt-get/);
  assert.match(failures, /Desktop E2E PR must not require sudo/);
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
    /Desktop E2E PR job timeout must stay at 20 minutes/
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
