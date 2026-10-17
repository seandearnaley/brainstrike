import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');

test('test.yml runs on its nightly schedule and dispatch, never per PR or per push', () => {
  // BST-2066: per-PR hosted CI is off, so admission now only ever sees
  // schedule and workflow_dispatch events, which it admits immediately.
  const triggers = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.match(triggers, /^ {2}schedule:$/m);
  assert.match(triggers, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(triggers, /pull_request|^ {2}push:|ready_for_review/m);
});

const REQUIRED_JOBS = new Map([
  ['static', 'Static'],
  ['unit', 'Unit'],
  ['build', 'Build'],
  ['web-e2e', 'Web E2E'],
  ['desktop-e2e', 'Desktop E2E'],
]);

// The parallel lanes behind the required Desktop E2E fan-in (BST-1762).
const DESKTOP_SMOKE_LANE_JOB_IDS = ['desktop-e2e-smoke', 'desktop-e2e-delegated'];

const ADMITTED_JOBS = [
  ...REQUIRED_JOBS.keys(),
  ...DESKTOP_SMOKE_LANE_JOB_IDS,
  'native-windows',
  'native-electron',
  // Non-required like the native jobs, but expensive (three Chromium
  // suites) — it must keep its quiet-head gate (BST-994 review).
  'browser-tests',
];

function jobBlock(jobId) {
  const startPattern = new RegExp(`^  ${jobId}:\\s*$`, 'm');
  const start = workflow.search(startPattern);
  assert.notEqual(start, -1, `Expected test.yml to define the "${jobId}" job.`);

  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
}

test('required check names remain stable and always come from the admitted full graph', () => {
  for (const [jobId, checkName] of REQUIRED_JOBS) {
    const job = jobBlock(jobId);
    assert.match(job, new RegExp(`^    name: ${checkName}$`, 'm'), jobId);
    assert.match(job, /^ {4}needs: .*admission/m, jobId);
    assert.match(job, /always\(\)/, `${jobId} must surface an admission failure.`);
    assert.match(
      job,
      /needs\.admission\.outputs\.admitted == 'true'/,
      `${jobId} must not start until the quiet-head gate admits this exact PR head.`
    );
    assert.match(
      job,
      /if: needs\.admission\.result != 'success'[\s\S]*?exit 1/,
      `${jobId} must fail, rather than skip, when admission itself fails.`
    );
  }

  assert.match(jobBlock('web-e2e'), /^ {4}needs: \[admission, build\]$/m);
  assert.match(
    jobBlock('desktop-e2e'),
    /^ {4}needs: \[admission, build, desktop-e2e-smoke, desktop-e2e-delegated\]$/m
  );
  for (const laneJobId of DESKTOP_SMOKE_LANE_JOB_IDS) {
    assert.match(jobBlock(laneJobId), /^ {4}needs: \[admission, build\]$/m, laneJobId);
  }
});

test('every expensive test job is held behind the same admission decision', () => {
  for (const jobId of ADMITTED_JOBS) {
    const job = jobBlock(jobId);
    assert.match(job, /^ {4}needs: .*admission/m, jobId);
    assert.match(job, /needs\.admission\.outputs\.admitted == 'true'/, jobId);
  }
});

test('Static bounds type-check concurrency to the arm64 runner memory budget', () => {
  assert.match(
    jobBlock('static'),
    /^ {6}- name: Type check\n {8}env:\n {10}TURBO_CONCURRENCY: 4\n {8}run: pnpm run type-check$/m
  );
});

test('quiet-head admission is cheap, PR-only, exact-head, and fail-closed', () => {
  const admission = jobBlock('admission');

  assert.match(workflow, /^ {2}pull-requests: read$/m);
  assert.match(admission, /^ {4}runs-on: ubuntu-slim$/m);
  assert.match(admission, /^ {4}timeout-minutes: 5$/m);
  assert.match(admission, /^ {6}admitted: \$\{\{ steps\.admission\.outputs\.result \}\}$/m);

  assert.match(admission, /if: github\.event_name == 'pull_request'/);
  assert.match(admission, /run: sleep 120/);
  assert.match(admission, /uses: actions\/github-script@v9/);
  assert.match(admission, /result-encoding: string/);
  assert.match(admission, /context\.eventName !== 'pull_request'/);
  assert.match(admission, /return 'true'/);

  assert.match(admission, /github\.rest\.pulls\.get/);
  assert.match(admission, /pull\.head\.sha/);
  assert.match(admission, /currentHead !== runHead/);
  assert.match(admission, /return 'false'/);
  assert.match(admission, /core\.setFailed/);
});

test('PR concurrency still cancels the older run during the quiet window', () => {
  assert.match(
    workflow,
    /^ {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m
  );
});
