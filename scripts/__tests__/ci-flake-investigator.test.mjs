import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertCiFlakePromotionReady,
  classifyAttemptVector,
  evaluateCiFlakeCalibration,
  loadUnitPartition,
  runCiFlakeInvestigator,
} from '../agent-routines/ci-flake/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
const SHA = 'b'.repeat(40);
const execution = (outcome) => ({
  durationMs: 1,
  exitCode: outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : null,
  outcome,
  signal: outcome === 'signalled' ? 'SIGKILL' : null,
  stderrTail: '',
  stdoutTail: '',
});

test('classifies exactly three attempts without parsing logs', () => {
  const cases = [
    [['passed', 'passed', 'passed'], 'stable-pass'],
    [['failed', 'failed', 'failed'], 'stable-fail'],
    [['passed', 'failed', 'passed'], 'flake-suspect'],
    [['passed', 'signalled', 'passed'], 'process-instability'],
    [['passed', 'timed-out', 'passed'], 'incomplete'],
    [['passed', 'spawn-error', 'passed'], 'harness-error'],
  ];
  for (const [outcomes, expected] of cases) {
    assert.equal(classifyAttemptVector(outcomes.map(execution)), expected);
  }
  assert.equal(classifyAttemptVector([execution('passed')]), 'harness-error');
});

test('reuses all four live Unit matrix rows and their push filters', () => {
  const rows = ['db-1', 'db-2', 'heavy', 'rest'].map((shard) => loadUnitPartition(workflow, shard));
  assert.deepEqual(
    rows.map(({ shard }) => shard),
    ['db-1', 'db-2', 'heavy', 'rest']
  );
  assert.deepEqual(
    rows.map(({ dbTestShard }) => dbTestShard),
    ['1/2', '2/2', '', '']
  );
  assert.deepEqual(rows[2].filterArgs, [
    '--filter=@brainstrike/desktop',
    '--filter=@brainstrike/ui',
    '--filter=@brainstrike/file-explorer-ui',
    '--filter=@brainstrike/app-shell',
  ]);
});

test('runs three forced uncached attempts for each existing phase with CI environment', async () => {
  const calls = [];
  const report = await runCiFlakeInvestigator({
    headSha: SHA,
    partition: loadUnitPartition(workflow, 'db-1'),
    runner: async (request) => {
      calls.push(request);
      return execution('passed');
    },
  });
  assert.equal(calls.length, 6);
  assert.deepEqual(
    report.phases.map(({ classification }) => classification),
    ['stable-pass', 'stable-pass']
  );
  assert.deepEqual(
    calls.map(({ command }) => command[3]),
    ['test', 'test', 'test', 'test:integration', 'test:integration', 'test:integration']
  );
  for (const call of calls) {
    assert.ok(call.command.includes('--force'));
    assert.equal(call.env.COVERAGE, 'false');
    assert.equal(call.env.TEST_TIMEOUT_MULTIPLIER, '2');
    assert.equal(call.env.TURBO_TEST_MODE, 'unit');
    assert.equal(call.env.DB_TEST_SHARD, '1/2');
  }
  assert.ok(calls.slice(0, 3).every(({ command }) => command.includes('--concurrency=4')));
  assert.ok(calls.slice(3).every(({ command }) => command.includes('--concurrency=2')));
});

test('classification precedence and status remain fail closed', async () => {
  for (const [outcomes, classification, status] of [
    [['failed', 'failed', 'failed'], 'stable-fail', 'findings'],
    [['passed', 'failed', 'passed'], 'flake-suspect', 'findings'],
    [['passed', 'signalled', 'passed'], 'process-instability', 'findings'],
    [['passed', 'timed-out', 'passed'], 'incomplete', 'incomplete'],
    [['passed', 'spawn-error', 'passed'], 'harness-error', 'harness-error'],
  ]) {
    let index = 0;
    const report = await runCiFlakeInvestigator({
      headSha: SHA,
      partition: loadUnitPartition(workflow, 'rest'),
      runner: async () => execution(outcomes[index++ % 3]),
    });
    assert.equal(report.phases[0].classification, classification);
    assert.equal(report.status, status);
  }
});

test('total deadline stops new work and reports incomplete attempts', async () => {
  let now = 0;
  let calls = 0;
  const report = await runCiFlakeInvestigator({
    headSha: SHA,
    now: () => now,
    partition: loadUnitPartition(workflow, 'rest'),
    runner: async () => {
      calls += 1;
      now += 2_000_000;
      return execution('passed');
    },
    totalTimeoutMs: 1_000_000,
  });
  assert.equal(calls, 1);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.phases[0].classification, 'harness-error');
});

test('calibration requires an external label for every finding', () => {
  const report = {
    findings: [{ classification: 'flake-suspect', fingerprint: 'flake:rest:test' }],
    phases: [
      { attempts: [{}, {}, {}], phase: 'test' },
      { attempts: [{}, {}, {}], phase: 'test:integration' },
    ],
  };
  const labels = [{ fingerprint: 'flake:rest:test', label: 'correct-actionable' }];
  const summary = evaluateCiFlakeCalibration(report, labels);
  assert.equal(summary.precision, 1);
  assert.equal(summary.reportCount, 1);
  assert.throws(() => assertCiFlakePromotionReady(report, labels), /not promotion-ready/u);
  assert.throws(() => evaluateCiFlakeCalibration(report, []), /missing external label/u);
});

test('historical/live calibration and independent holdout fixtures stay precise', () => {
  const fixtureRoot = path.join(root, 'scripts/__tests__/fixtures/agent-routines');
  const calibration = JSON.parse(readFileSync(path.join(fixtureRoot, 'ci-flake-calibration.json')));
  assert.deepEqual(
    calibration.map(({ source }) => source),
    ['historical', 'live']
  );
  for (const fixture of calibration) {
    const summary = evaluateCiFlakeCalibration(fixture.report, fixture.labels);
    assert.deepEqual(
      {
        noiseRate: summary.noiseRate,
        precision: summary.precision,
        unsafe: summary.unsafeFindings,
      },
      { noiseRate: 0, precision: 1, unsafe: 0 }
    );
  }
  const holdout = JSON.parse(readFileSync(path.join(fixtureRoot, 'ci-flake-holdout.json')));
  for (const fixture of holdout) {
    assert.equal(classifyAttemptVector(fixture.outcomes.map(execution)), fixture.expected);
  }
});
