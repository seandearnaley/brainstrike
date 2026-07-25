import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');

const UBICLOUD_JOBS = ['unit-shard', 'build', 'native-electron', 'web-e2e', 'desktop-e2e'];
const GITHUB_JOBS = new Map([
  ['admission', 'ubuntu-slim'],
  ['static', 'ubuntu-24.04-arm'],
  ['unit', 'ubuntu-24.04-arm'],
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

test('admission, ARM, and Windows jobs remain on GitHub-hosted runners', () => {
  for (const [jobId, runner] of GITHUB_JOBS) {
    assert.match(jobBlock(jobId), new RegExp(`^ {4}runs-on: ${runner}$`, 'm'), jobId);
  }
});

test('Ubicloud is limited to the five measured jobs', () => {
  const ubicloudAssignments = [...workflow.matchAll(/^ {4}runs-on: (ubicloud-[a-z0-9-]+)$/gm)].map(
    (match) => match[1]
  );

  assert.deepEqual(
    ubicloudAssignments,
    UBICLOUD_JOBS.map(() => 'ubicloud-standard-4')
  );
});
