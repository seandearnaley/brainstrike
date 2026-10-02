import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditMinutes } from '../audit-ci-minutes.mjs';

const job = (overrides = {}) => ({
  completed_at: '2026-09-01T00:02:01Z',
  conclusion: 'success',
  id: 1,
  labels: ['ubicloud-standard-4'],
  name: 'Unit (rest)',
  runner_name: 'runner-1',
  started_at: '2026-09-01T00:00:00Z',
  status: 'completed',
  steps: [
    {
      completed_at: '2026-09-01T00:01:01Z',
      conclusion: 'success',
      name: 'Setup workspace',
      started_at: '2026-09-01T00:00:01Z',
    },
    {
      completed_at: '2026-09-01T00:02:01Z',
      conclusion: 'success',
      name: 'Run PR affected unit tests',
      started_at: '2026-09-01T00:01:01Z',
    },
    {
      completed_at: '2026-09-01T00:02:01Z',
      conclusion: 'skipped',
      name: 'Run push unit tests',
      started_at: '2026-09-01T00:00:00Z',
    },
  ],
  ...overrides,
});
const row = (jobs, overrides = {}) => ({
  attempt: 1,
  event: 'pull_request',
  jobs,
  run_id: 10,
  workflow: 'Test',
  ...overrides,
});
const window = { end: '2026-10-01T00:00:00Z', start: '2026-09-01T00:00:00Z' };

test('accounts parallel jobs per runner, excludes skipped steps, and separates elapsed time from rounding', () => {
  const report = auditMinutes([row([job(), job({ id: 2 })])], window);
  assert.equal(report.total.jobs, 2);
  assert.equal(report.total.seconds, 242);
  assert.equal(report.total.roundedJobMinutes, 6);
  assert.equal(report.total.roundingSeconds, 118);
  assert.equal(report.total.stepSeconds, 240);
  assert.equal(report.total.outsideStepsSeconds, 2);
  assert.equal(
    report.steps.some((step) => step.name.includes('push')),
    false
  );
  assert.equal(report.steps.find((step) => step.name === 'Setup workspace').seconds, 120);
});

test('accounts each rerun once and refuses a duplicated allocated job', () => {
  const report = auditMinutes([row([job()]), row([job({ id: 3 })], { attempt: 2 })], window);
  assert.equal(report.reruns.roundedJobMinutes, 3);
  assert.throws(
    () => auditMinutes([row([job()]), row([job()], { attempt: 2 })], window),
    /Duplicate job 1/
  );
});

test('excludes unallocated cancellation, hosted runners, and completion outside the UTC month', () => {
  const report = auditMinutes(
    [
      row([
        job({ conclusion: 'cancelled', id: 1, runner_name: null }),
        job({ id: 2, labels: ['ubuntu-latest'] }),
        job({
          completed_at: '2026-09-01T00:00:30Z',
          id: 3,
          started_at: '2026-08-31T23:59:30Z',
          steps: [],
        }),
        job({ completed_at: '2026-10-01T00:00:00Z', id: 4, steps: [] }),
      ]),
    ],
    window
  );
  assert.equal(report.total.jobs, 1);
  assert.equal(report.total.roundedJobMinutes, 1);
  assert.equal(report.unallocatedJobs, 1);
});

test('does not double count overlapping step metadata or call unexplained time a hang', () => {
  const report = auditMinutes(
    [
      row([
        job({
          steps: [
            {
              completed_at: '2026-09-01T00:01:00Z',
              conclusion: 'success',
              name: 'First',
              started_at: '2026-09-01T00:00:00Z',
            },
            {
              completed_at: '2026-09-01T00:01:30Z',
              conclusion: 'success',
              name: 'Second',
              started_at: '2026-09-01T00:00:30Z',
            },
          ],
        }),
      ]),
    ],
    window
  );
  assert.equal(report.total.stepSeconds, 90);
  assert.equal(report.total.overlappingStepSeconds, 30);
  assert.equal(report.total.outsideStepsSeconds, 31);
  assert.equal('hangSeconds' in report.total, false);
});

test('fails on missing completion, inverted job/step intervals, and invalid windows', () => {
  assert.throws(() => auditMinutes([row([job({ completed_at: null })])], window), /completion/);
  assert.throws(
    () => auditMinutes([row([job({ completed_at: '2026-08-31T23:00:00Z' })])], window),
    /interval/
  );
  assert.throws(
    () =>
      auditMinutes(
        [
          row([
            job({
              steps: [
                {
                  completed_at: '2026-09-01T00:00:00Z',
                  conclusion: 'success',
                  name: 'Bad',
                  started_at: '2026-09-01T00:01:00Z',
                },
              ],
            }),
          ]),
        ],
        window
      ),
    /interval/
  );
  assert.throws(() => auditMinutes([], { end: window.start, start: window.end }), /window/);
});

test('reports incomplete canceled step metadata without inventing elapsed time', () => {
  const report = auditMinutes(
    [
      row([
        job({
          conclusion: 'cancelled',
          steps: [
            {
              completed_at: null,
              conclusion: 'cancelled',
              name: 'Interrupted test',
              started_at: '2026-09-01T00:01:00Z',
            },
          ],
        }),
      ]),
    ],
    window
  );
  assert.equal(report.total.seconds, 121);
  assert.equal(report.total.stepSeconds, 0);
  assert.equal(report.total.outsideStepsSeconds, 121);
  assert.deepEqual(report.incompleteSteps, [
    {
      completedAt: null,
      conclusion: 'cancelled',
      jobId: 1,
      name: 'Interrupted test',
      startedAt: '2026-09-01T00:01:00Z',
    },
  ]);
});

test('refuses a partial attempt ledger when a run inventory is supplied', () => {
  const options = { ...window, runs: [{ conclusion: 'success', id: 10, run_attempt: 2 }] };
  assert.throws(() => auditMinutes([row([job()])], options), /Missing attempt 10\/2/);
  const report = auditMinutes([row([job()]), row([job({ id: 2 })], { attempt: 2 })], options);
  assert.equal(report.attemptCoverageVerified, true);
  assert.throws(
    () =>
      auditMinutes([row([job()]), row([])], {
        ...window,
        runs: [{ conclusion: 'success', id: 10, run_attempt: 1 }],
      }),
    /Duplicate attempt/
  );
});

test('the offline CLI emits a checked report and rejects missing snapshots', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-ci-audit-'));
  try {
    const snapshots = path.join(root, 'jobs.json');
    const inventory = path.join(root, 'runs.json');
    writeFileSync(snapshots, JSON.stringify([row([job()])]));
    writeFileSync(inventory, JSON.stringify([{ conclusion: 'success', id: 10, run_attempt: 1 }]));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../audit-ci-minutes.mjs', import.meta.url)),
          snapshots,
          window.start,
          window.end,
          inventory,
        ],
        { encoding: 'utf8' }
      );
    const complete = run();
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).total.roundedJobMinutes, 3);
    writeFileSync(inventory, JSON.stringify([{ conclusion: 'success', id: 10, run_attempt: 2 }]));
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing attempt 10\/2/);
    assert.equal(missing.stdout, '');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
