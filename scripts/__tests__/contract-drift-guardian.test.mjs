import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertContractDriftPromotionReady,
  CONTRACT_COMMANDS,
  evaluateContractDriftCalibration,
  runContractDriftGuardian,
} from '../agent-routines/contract-drift/index.mjs';

const SHA = 'a'.repeat(40);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = (outcome = 'passed') => ({
  durationMs: 1,
  exitCode: outcome === 'failed' ? 1 : outcome === 'passed' ? 0 : null,
  outcome,
  signal: outcome === 'signalled' ? 'SIGTERM' : null,
  stderrTail: '',
  stdoutTail: '',
});

function runnerFor(outcomes) {
  const calls = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return result(outcomes[calls.length - 1] ?? 'passed');
    },
  };
}

test('runs the three existing contract boundaries once in exact order', async () => {
  const runner = runnerFor([]);
  const report = await runContractDriftGuardian({ headSha: SHA, runner: runner.run });
  assert.deepEqual(
    runner.calls.map(({ command }) => command),
    CONTRACT_COMMANDS.map(({ command }) => command)
  );
  assert.equal(report.executions.length, 3);
  assert.equal(report.status, 'clean');
  assert.deepEqual(
    report.executions.map(({ classification }) => classification),
    ['stable-clean', 'stable-clean', 'stable-clean']
  );
});

test('ordinary failure is contract drift without retries', async () => {
  for (let failingIndex = 0; failingIndex < 3; failingIndex += 1) {
    const outcomes = ['passed', 'passed', 'passed'];
    outcomes[failingIndex] = 'failed';
    const runner = runnerFor(outcomes);
    const report = await runContractDriftGuardian({ headSha: SHA, runner: runner.run });
    assert.equal(report.status, 'findings');
    assert.equal(report.findings[0].classification, 'contract-drift');
    assert.equal(runner.calls.length, 3);
  }
});

test('timeout and signal fail closed as incomplete; spawn errors are harness errors', async () => {
  for (const [outcome, status] of [
    ['timed-out', 'incomplete'],
    ['signalled', 'incomplete'],
    ['spawn-error', 'harness-error'],
  ]) {
    const report = await runContractDriftGuardian({
      headSha: SHA,
      runner: runnerFor([outcome, 'passed', 'passed']).run,
    });
    assert.equal(report.status, status);
  }
});

test('the 35-minute total deadline fails closed without starting work beyond it', async () => {
  let now = 0;
  let calls = 0;
  const report = await runContractDriftGuardian({
    headSha: SHA,
    now: () => now,
    runner: async () => {
      calls += 1;
      now += 36 * 60 * 1000;
      return result('passed');
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.executions.length, 3);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(
    report.executions.slice(1).map(({ classification }) => classification),
    ['incomplete', 'incomplete']
  );
});

test('anti-vacuity rejects missing or reordered executions', () => {
  const complete = CONTRACT_COMMANDS.map(({ command, id }) => ({
    classification: 'stable-clean',
    command,
    id,
    ...result(),
  }));
  assert.throws(
    () => evaluateContractDriftCalibration({ executions: complete.slice(0, 2), findings: [] }, []),
    /exactly three/u
  );
  assert.throws(
    () => evaluateContractDriftCalibration({ executions: complete.toReversed(), findings: [] }, []),
    /exact command order/u
  );
});

test('calibration consumes complete external labels and fails closed when one is missing', () => {
  const report = {
    executions: CONTRACT_COMMANDS.map(({ command, id }) => ({
      classification: id === 'test-scripts' ? 'contract-drift' : 'stable-clean',
      command,
      id,
      ...result(id === 'test-scripts' ? 'failed' : 'passed'),
    })),
    findings: [{ classification: 'contract-drift', fingerprint: 'contract:test-scripts' }],
  };
  const summary = evaluateContractDriftCalibration(report, [
    { fingerprint: 'contract:test-scripts', label: 'correct-actionable' },
  ]);
  assert.equal(summary.precision, 1);
  assert.equal(summary.reportCount, 1);
  assert.throws(
    () =>
      assertContractDriftPromotionReady(report, [
        { fingerprint: 'contract:test-scripts', label: 'correct-actionable' },
      ]),
    /not promotion-ready/u
  );
  assert.throws(() => evaluateContractDriftCalibration(report, []), /missing external label/u);
});

test('externally labelled historical and live fixtures meet calibrated thresholds', () => {
  const fixtures = JSON.parse(
    readFileSync(
      path.join(root, 'scripts/__tests__/fixtures/agent-routines/contract-drift-calibration.json')
    )
  );
  assert.deepEqual(
    fixtures.map(({ source }) => source),
    ['historical', 'live']
  );
  for (const fixture of fixtures) {
    const summary = evaluateContractDriftCalibration(fixture.report, fixture.labels);
    assert.deepEqual(
      {
        noiseRate: summary.noiseRate,
        precision: summary.precision,
        unsafe: summary.unsafeFindings,
      },
      { noiseRate: 0, precision: 1, unsafe: 0 }
    );
  }
});
