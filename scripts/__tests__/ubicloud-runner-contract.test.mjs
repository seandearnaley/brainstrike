import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
const coverageWorkflow = readFileSync('.github/workflows/coverage.yml', 'utf8');
const shortAutomationWorkflows = new Map([
  ['React Doctor', readFileSync('.github/workflows/react-doctor.yml', 'utf8')],
  ['Claude Auto Review', readFileSync('.github/workflows/claude-code-review.yml', 'utf8')],
  ['Claude Code', readFileSync('.github/workflows/claude.yml', 'utf8')],
]);

const UBICLOUD_JOBS = [
  'unit-shard',
  'build',
  'native-electron',
  'browser-tests',
  'web-e2e',
  'desktop-e2e',
];
const GITHUB_JOBS = new Map([
  ['admission', 'ubuntu-slim'],
  ['static', 'ubuntu-24.04-arm'],
  ['unit', 'ubuntu-slim'],
  ['native-windows', 'windows-latest'],
]);

function jobBlock(jobId) {
  const startPattern = new RegExp(`^  ${jobId}:\\s*$`, 'm');
  const start = workflow.search(startPattern);
  assert.notEqual(start, -1, `Expected test.yml to define the "${jobId}" job.`);

  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
}

test('the measured Linux x64 jobs run on Ubicloud standard-4', () => {
  for (const jobId of UBICLOUD_JOBS) {
    assert.match(
      jobBlock(jobId),
      /^ {4}runs-on: ubicloud-standard-4$/m,
      `${jobId} must preserve the 4-vCPU/16-GB runner class on Ubicloud.`
    );
  }
});

test('PR coverage uses the cost-optimized 2-vCPU Ubicloud runner', () => {
  assert.match(coverageWorkflow, /^ {4}runs-on: ubicloud-standard-2$/m);
});

test('short x64 automation uses the cost-optimized 2-vCPU Ubicloud runner', () => {
  for (const [name, source] of shortAutomationWorkflows) {
    assert.match(source, /^ {4}runs-on: ubicloud-standard-2$/m, name);
  }
});

test('admission, Unit fan-in, ARM Static, and Windows use their cheapest compatible GitHub runners', () => {
  for (const [jobId, runner] of GITHUB_JOBS) {
    assert.match(jobBlock(jobId), new RegExp(`^ {4}runs-on: ${runner}$`, 'm'), jobId);
  }
});

test('Native Windows stays always-on without custom diff-routing machinery', () => {
  assert.doesNotMatch(workflow, /^ {2}native-windows-impact:\s*$/m);
  assert.doesNotMatch(workflow, /native-windows-impact\.mjs/);

  const windows = jobBlock('native-windows');
  assert.match(windows, /^ {4}if: needs\.admission\.outputs\.admitted == 'true'$/m);
  assert.match(windows, /^ {4}needs: \[admission\]$/m);
  assert.doesNotMatch(windows, /^ {4}if: always\(\)/m);
});

test('the Test workflow uses Ubicloud only for the six measured jobs', () => {
  const ubicloudAssignments = [...workflow.matchAll(/^ {4}runs-on: (ubicloud-[a-z0-9-]+)$/gm)].map(
    (match) => match[1]
  );

  assert.deepEqual(
    ubicloudAssignments,
    UBICLOUD_JOBS.map(() => 'ubicloud-standard-4')
  );
});
