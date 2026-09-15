import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { listPlaywrightTitleEntries } from '../e2e-playwright-title-tags.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_SPEC = 'apps/web/e2e/settings-tools-and-diagnostics.test.ts';
const DESKTOP_SPEC = 'apps/desktop/e2e/tools-settings.desktop.test.ts';
const WEB_SMOKE_COMMAND = [
  'unset NO_COLOR;',
  'pnpm exec playwright test',
  '--project=functional',
  '--grep "@web-smoke"',
  '--workers=2',
  '--max-failures=1',
  '--global-timeout=600000',
].join(' ');
// The global timeout is a failure ceiling, not a latency target (BST-1713).
// BST-1762 split desktop smoke into two lanes on separate runners: 47 passing
// cases took 722-871 s of the single lane's 900 s ceiling across 24 green Test
// runs (2026-09-12..15), and run 34988958978 timed out at 898 s. The delegated
// specs' per-case CI means summed to 466 s and every other spec's to 337 s; the
// first split run (Test 34997197693) took 440 s and 367 s. Both lanes keep the
// 900 s ceiling inside the unchanged 25-minute job boundary. Put a new spec in
// the lane whose measured headroom absorbs it and record the measurement in
// docs/agents/ci-quality.md. A smoke spec dropped from both lists is caught by
// scripts/e2e-lane-coverage.mjs; one listed in both fails the overlap test below.
const DESKTOP_SMOKE_SPECS = [
  'e2e/add-root-ui.smoke.desktop.test.ts',
  'e2e/agent-devtools.desktop.test.ts',
  'e2e/app-launch.test.ts',
  'e2e/assistant-panel.desktop.test.ts',
  'e2e/background-indexing-pause.desktop.test.ts',
  'e2e/file-system.test.ts',
  'e2e/forge-pr.desktop.test.ts',
  'e2e/git-panel.desktop.test.ts',
  'e2e/local-runtime-probe.desktop.test.ts',
  'e2e/secrets-settings.test.ts',
  'e2e/subagent-persona-availability.desktop.test.ts',
  'e2e/terminal-panel.desktop.test.ts',
  'e2e/threads-panel-folders.desktop.test.ts',
  'e2e/tools-settings.desktop.test.ts',
  'e2e/workspace-bar.desktop.test.ts',
  'e2e/worktree-map.desktop.test.ts',
  'e2e/worktree-mode.desktop.test.ts',
];
const DESKTOP_DELEGATED_SMOKE_SPECS = [
  'e2e/delegated-child-control.desktop.test.ts',
  'e2e/delegated-child-interactive.desktop.test.ts',
  'e2e/delegated-worker-write.desktop.test.ts',
  'e2e/delegated-workspace-reload.desktop.test.ts',
];

function desktopSmokeLaneCommand(specs) {
  return [
    'node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn --',
    'xvfb-maybe pnpm exec playwright test',
    ...specs,
    '--project=smoke',
    '--workers=1',
    '--retries=0',
    '--max-failures=1',
    '--global-timeout=900000',
    '--grep="@smoke"',
  ].join(' ');
}

const DESKTOP_SMOKE_COMMAND = desktopSmokeLaneCommand(DESKTOP_SMOKE_SPECS);
const DESKTOP_DELEGATED_SMOKE_COMMAND = desktopSmokeLaneCommand(DESKTOP_DELEGATED_SMOKE_SPECS);
const DESKTOP_SMOKE_LANE_JOBS = [
  { command: 'dbus-run-session -- pnpm run test:e2e:lane:smoke', job: 'desktop-e2e-smoke' },
  {
    command: 'dbus-run-session -- pnpm run test:e2e:lane:smoke-delegated',
    job: 'desktop-e2e-delegated',
  },
];
const DESKTOP_TOOLS_NIGHTLY_COMMAND = [
  'node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn --',
  'xvfb-maybe pnpm exec playwright test',
  'e2e/tools-settings.desktop.test.ts',
  '--project=smoke',
  '--workers=1',
  '--retries=0',
  '--max-failures=1',
  '--global-timeout=120000',
  '--grep="@smoke"',
].join(' ');
const DESKTOP_FULL_REGRESSION_COMMAND = [
  'node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn --',
  'xvfb-maybe pnpm exec playwright test',
  '--project=regression',
  '--workers=1',
  '--retries=0',
  '--max-failures=1',
  '--global-timeout=1800000',
  '--grep-invert="@desktop-embedding-|@packaged"',
  '&& pnpm run test:e2e:lane:tools-settings-nightly',
].join(' ');
const REQUIRED_PR_E2E_JOB_CONDITION = [
  'always() &&',
  '(',
  "needs.admission.result != 'success' ||",
  '(',
  "github.event_name != 'workflow_dispatch' &&",
  "needs.admission.outputs.admitted == 'true' &&",
  "needs.build.result == 'success'",
  ')',
  ')',
].join(' ');

function read(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function normalizeExpression(expression) {
  return String(expression).replace(/\s+/g, ' ').trim();
}

function stepRunsExactCommand(step, expectedCommand) {
  return typeof step.run === 'string' && normalizeExpression(step.run) === expectedCommand;
}

function assertExactLaneCommand(command, expectedCommand, label) {
  assert.equal(
    normalizeExpression(command),
    expectedCommand,
    `${label} must retain the complete executable command`
  );
}

function assertBlockingStep(step, label) {
  assert.equal(step.if, undefined, `${label} must be unconditional`);
  assert.ok(
    step['continue-on-error'] === undefined || step['continue-on-error'] === false,
    `${label} must fail its job when tests fail`
  );
}

function laneResultExpression(laneJobId) {
  return `\${{ needs.${laneJobId}.result }}`;
}

function overlappingSpecs(left, right) {
  return left.filter((spec) => right.includes(spec));
}

// The required `Desktop E2E` check is a fan-in over the parallel desktop smoke
// lanes: it skips exactly when they skip and fails unless every lane succeeded.
function assertDesktopE2eFanIn(job, laneJobIds) {
  assert.deepEqual(
    job.needs,
    ['admission', 'build', ...laneJobIds],
    'Desktop E2E must wait for admission, build, and every desktop smoke lane'
  );
  assert.equal(
    normalizeExpression(job.if),
    REQUIRED_PR_E2E_JOB_CONDITION,
    'Desktop E2E must skip exactly when its smoke lanes skip'
  );
  const checks = job.steps.filter((step) => step.name === 'Check lane results');
  assert.equal(checks.length, 1, 'Desktop E2E must check its lane results once');
  assertBlockingStep(checks[0], 'Desktop E2E lane check');
  assert.equal(
    normalizeExpression(checks[0].env?.LANE_RESULTS),
    laneJobIds.map(laneResultExpression).join(' '),
    'Desktop E2E must read the result of every smoke lane'
  );
  assert.equal(
    normalizeExpression(checks[0].run),
    `echo "Desktop smoke lane results: $LANE_RESULTS" if [ "$LANE_RESULTS" != "${laneJobIds.map(() => 'success').join(' ')}" ]; then echo "::error::Desktop smoke lanes did not all succeed: $LANE_RESULTS" exit 1 fi`,
    'Desktop E2E must fail unless every smoke lane succeeded'
  );
}

function untaggedTitles(source, fileName, tag) {
  const testEntries = listPlaywrightTitleEntries(source, fileName).filter(
    (entry) => entry.kind === 'test'
  );
  assert.deepEqual(
    testEntries.filter((entry) => entry.tagsUnresolved).map((entry) => entry.titlePath),
    [],
    `${fileName} must use statically resolvable Playwright tags`
  );

  return testEntries
    .filter((entry) => !entry.titlePath.includes(tag))
    .map((entry) => entry.titlePath);
}

test('MONEY TEST: options-form tags cover only their suite, not an untagged sibling', () => {
  const source = `
    test.describe('Tools', { tag: '@smoke' }, () => {
      test('filters', async () => {});
    });
    test('outside', async () => {});
  `;
  assert.deepEqual(untaggedTitles(source, 'tools.test.ts', '@smoke'), ['outside']);
});

test('MONEY TEST: the smoke matcher rejects disabled lanes and diagnostic suffixes', () => {
  const expectedCommand = 'pnpm run test:e2e:lane:smoke';
  assert.equal(stepRunsExactCommand({ run: expectedCommand }, expectedCommand), true);
  assert.equal(
    stepRunsExactCommand({ run: `${expectedCommand}-disabled` }, expectedCommand),
    false
  );
  assert.equal(
    stepRunsExactCommand({ run: `${expectedCommand} -- --list` }, expectedCommand),
    false
  );
});

test('MONEY TEST: package smoke lanes reject no-op wrappers and failure swallowing', () => {
  for (const mutation of [
    `echo ${WEB_SMOKE_COMMAND}`,
    `${WEB_SMOKE_COMMAND} || true`,
    `${WEB_SMOKE_COMMAND} --list`,
  ]) {
    assert.throws(
      () => assertExactLaneCommand(mutation, WEB_SMOKE_COMMAND, 'fixture'),
      /complete executable command/
    );
  }
});

test('MONEY TEST: guarded workflow steps cannot swallow test failures', () => {
  const actionsExpression = (body) => `$${body}`;
  for (const continueOnError of [
    true,
    actionsExpression('{{ true }}'),
    actionsExpression("{{ github.event_name == 'pull_request' }}"),
  ]) {
    assert.throws(
      () => assertBlockingStep({ 'continue-on-error': continueOnError }, 'fixture'),
      /must fail its job/
    );
  }
  assert.doesNotThrow(() => assertBlockingStep({ 'continue-on-error': false }, 'fixture'));
});

test('REAL REPO: every web AI Tools settings title is selected by Web E2E smoke', () => {
  const source = read(WEB_SPEC);
  assert.deepEqual(untaggedTitles(source, WEB_SPEC, '@web-smoke'), []);

  const webPackage = JSON.parse(read('apps/web/package.json'));
  const smokeCommand = webPackage.scripts['test:e2e:lane:smoke'];
  assertExactLaneCommand(smokeCommand, WEB_SMOKE_COMMAND, 'web smoke lane');
  assert.match(smokeCommand, /--grep ["']@web-smoke["']/);
});

test('REAL REPO: every desktop AI Tools settings title is selected by Desktop E2E smoke', () => {
  const source = read(DESKTOP_SPEC);
  assert.deepEqual(untaggedTitles(source, DESKTOP_SPEC, '@smoke'), []);

  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  const smokeCommand = desktopPackage.scripts['test:e2e:lane:smoke'];
  assertExactLaneCommand(smokeCommand, DESKTOP_SMOKE_COMMAND, 'desktop smoke lane');
  assert.match(smokeCommand, /e2e\/tools-settings\.desktop\.test\.ts/);
  assert.match(smokeCommand, /--grep=["']@smoke["']/);
});

test('REAL REPO: desktop smoke tags remain selected by nightly regression', () => {
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  assertExactLaneCommand(
    desktopPackage.scripts['test:e2e:lane:full-regression'],
    DESKTOP_FULL_REGRESSION_COMMAND,
    'desktop full-regression lane'
  );
  const nightlyCommand = desktopPackage.scripts['test:e2e:lane:tools-settings-nightly'];
  assertExactLaneCommand(
    nightlyCommand,
    DESKTOP_TOOLS_NIGHTLY_COMMAND,
    'desktop AI Tools nightly lane'
  );
  assert.match(nightlyCommand, /e2e\/tools-settings\.desktop\.test\.ts/);
  assert.match(nightlyCommand, /--project=smoke/);
  assert.match(nightlyCommand, /--grep=["']@smoke["']/);

  const nightlyWorkflow = parseYaml(read('.github/workflows/desktop-e2e.yml'));
  const fullRegressionJob = nightlyWorkflow.jobs['desktop-full-regression'];
  const matchingSteps = fullRegressionJob.steps.filter((step) =>
    stepRunsExactCommand(step, 'dbus-run-session -- pnpm run test:e2e:lane:full-regression')
  );
  assert.equal(
    matchingSteps.length,
    1,
    'nightly workflow must execute full desktop regression once'
  );
  assertBlockingStep(matchingSteps[0], 'nightly full-regression step');
  assert.equal(
    matchingSteps[0]['working-directory'],
    'apps/desktop',
    'nightly full-regression step must run from the desktop workspace'
  );
});

test('MONEY TEST: a spec listed in both desktop smoke lanes is reported', () => {
  assert.deepEqual(
    overlappingSpecs(['e2e/a.desktop.test.ts', 'e2e/b.desktop.test.ts'], ['e2e/b.desktop.test.ts']),
    ['e2e/b.desktop.test.ts']
  );
});

test('REAL REPO: each desktop smoke spec runs in exactly one smoke lane', () => {
  assert.deepEqual(overlappingSpecs(DESKTOP_SMOKE_SPECS, DESKTOP_DELEGATED_SMOKE_SPECS), []);

  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  assertExactLaneCommand(
    desktopPackage.scripts['test:e2e:lane:smoke-delegated'],
    DESKTOP_DELEGATED_SMOKE_COMMAND,
    'desktop delegated smoke lane'
  );
});

test('MONEY TEST: the Desktop E2E fan-in rejects a lane it does not wait for or read', () => {
  const laneJobIds = DESKTOP_SMOKE_LANE_JOBS.map(({ job }) => job);
  const fanIn = parseYaml(read('.github/workflows/test.yml')).jobs['desktop-e2e'];
  assert.doesNotThrow(() => assertDesktopE2eFanIn(fanIn, laneJobIds));

  const unwaited = structuredClone(fanIn);
  unwaited.needs = unwaited.needs.filter((need) => need !== 'desktop-e2e-delegated');
  assert.throws(() => assertDesktopE2eFanIn(unwaited, laneJobIds), /every desktop smoke lane/);

  const unread = structuredClone(fanIn);
  unread.steps.find((step) => step.name === 'Check lane results').env.LANE_RESULTS =
    laneResultExpression('desktop-e2e-smoke');
  assert.throws(() => assertDesktopE2eFanIn(unread, laneJobIds), /result of every smoke lane/);

  const unchecked = structuredClone(fanIn);
  unchecked.steps.find((step) => step.name === 'Check lane results').run =
    'echo "Desktop smoke lane results: $LANE_RESULTS"';
  assert.throws(() => assertDesktopE2eFanIn(unchecked, laneJobIds), /unless every smoke lane/);
});

test('REAL REPO: pull-request E2E jobs invoke every smoke lane script', () => {
  const workflow = parseYaml(read('.github/workflows/test.yml'));
  assert.ok(workflow.on?.pull_request, 'test.yml must run on pull requests');

  const assertRequiredSmokeStep = (jobId, expectedCommand, expectedWorkingDirectory) => {
    const job = workflow.jobs[jobId];
    assert.deepEqual(
      job.needs,
      ['admission', 'build'],
      `${jobId} must depend on admission and build`
    );
    assert.equal(
      normalizeExpression(job.if),
      REQUIRED_PR_E2E_JOB_CONDITION,
      `${jobId} must retain the PR-admitting job condition`
    );
    const matchingSteps = job.steps.filter((step) => stepRunsExactCommand(step, expectedCommand));
    assert.equal(matchingSteps.length, 1, `${jobId} must have one exact smoke invocation`);
    assertBlockingStep(matchingSteps[0], `${jobId} smoke step`);
    assert.equal(
      matchingSteps[0]['working-directory'],
      expectedWorkingDirectory,
      `${jobId} smoke step must run from the expected workspace directory`
    );
  };

  assertRequiredSmokeStep('web-e2e', 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke');
  for (const { command, job } of DESKTOP_SMOKE_LANE_JOBS) {
    assertRequiredSmokeStep(job, command, 'apps/desktop');
  }
  assertDesktopE2eFanIn(
    workflow.jobs['desktop-e2e'],
    DESKTOP_SMOKE_LANE_JOBS.map(({ job }) => job)
  );
});
