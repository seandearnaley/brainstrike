import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');

const REQUIRED_JOBS = new Map([
  ['static', 'Static'],
  ['unit', 'Unit'],
  ['build', 'Build'],
  ['web-e2e', 'Web E2E'],
  ['desktop-e2e', 'Desktop E2E'],
]);

const ADMITTED_JOBS = [...REQUIRED_JOBS.keys(), 'native-windows', 'native-electron'];

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
    assert.match(
      job,
      /needs\.admission\.outputs\.admitted == 'true'/,
      `${jobId} must not start until the quiet-head gate admits this exact PR head.`
    );
  }

  assert.match(jobBlock('web-e2e'), /^ {4}needs: \[admission, build\]$/m);
  assert.match(jobBlock('desktop-e2e'), /^ {4}needs: \[admission, build\]$/m);
});

test('every expensive test job is held behind the same admission decision', () => {
  for (const jobId of ADMITTED_JOBS) {
    const job = jobBlock(jobId);
    assert.match(job, /^ {4}needs: .*admission/m, jobId);
    assert.match(job, /needs\.admission\.outputs\.admitted == 'true'/, jobId);
  }
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
