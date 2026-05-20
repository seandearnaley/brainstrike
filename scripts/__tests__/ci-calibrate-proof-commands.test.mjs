import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildCalibrationPlan,
  parseCalibrationArgs,
  runCalibration,
  runCli,
} from '../ci-calibrate-proof-commands.mjs';

test('parseCalibrationArgs requires explicit command names', () => {
  assert.throws(() => parseCalibrationArgs([]), /at least one --command is required/);
});

test('parseCalibrationArgs accepts a pnpm argument separator', () => {
  assert.deepEqual(parseCalibrationArgs(['--', '--command', 'diff-check']), {
    allowFull: false,
    commandNames: ['diff-check'],
    dryRun: false,
    output: undefined,
  });
});

test('parseCalibrationArgs rejects full local suite unless explicitly allowed', () => {
  assert.throws(
    () => parseCalibrationArgs(['--command', 'full-local-suite']),
    /full-local-suite calibration requires --allow-full/
  );
  assert.deepEqual(parseCalibrationArgs(['--command', 'full-local-suite', '--allow-full']), {
    allowFull: true,
    commandNames: ['full-local-suite'],
    dryRun: false,
    output: undefined,
  });
});

test('buildCalibrationPlan exposes owners, budgets, and commands', () => {
  assert.deepEqual(buildCalibrationPlan(['diff-check', 'ci-script-tests']), [
    {
      budgetMs: 30_000,
      command: 'git diff --check',
      name: 'diff-check',
      owner: 'tooling',
      requiredFor: ['all'],
    },
    {
      budgetMs: 120_000,
      command:
        'node --test scripts/__tests__/ci-risk-rules.test.mjs scripts/__tests__/ci-select.test.mjs scripts/__tests__/ci-timing-summary.test.mjs scripts/__tests__/ci-proof-timing-summary.test.mjs scripts/__tests__/ci-proof.test.mjs scripts/__tests__/turbo-run-diagnostics.test.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/__tests__/check-ci-risk-fixtures.test.mjs scripts/__tests__/run-changed-unit-tests.test.mjs scripts/__tests__/ci-calibrate-proof-commands.test.mjs scripts/__tests__/ci-calibration-summary.test.mjs && pnpm run ci:risk-fixtures',
      name: 'ci-script-tests',
      owner: 'tooling',
      requiredFor: ['config-tooling', 'full-release-high-risk'],
    },
  ]);
});

test('runCalibration records command timing and stops after failure', async () => {
  const calls = [];
  const result = await runCalibration(
    {
      commandNames: ['diff-check', 'docs-static'],
      dryRun: false,
    },
    async (command) => {
      calls.push(command);
      return calls.length === 1 ? 1 : 0;
    }
  );

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.dryRun, false);
  assert.equal(result.commandResults.length, 1);
  assert.equal(result.commandResults[0].name, 'diff-check');
  assert.equal(result.commandResults[0].exitCode, 1);
});

test('runCli writes machine-readable calibration output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-ci-calibration-'));
  const output = path.join(dir, 'calibration.json');
  const originalConsoleLog = console.log;
  console.log = () => {};
  try {
    const exitCode = await runCli(
      ['--command', 'diff-check', '--output', output],
      async () => 0
    );

    assert.equal(exitCode, 0);
    const parsed = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(parsed.commandResults[0].name, 'diff-check');
    assert.equal(parsed.commandResults[0].owner, 'tooling');
    assert.equal(parsed.commandResults[0].budgetStatus, 'ok');
  } finally {
    console.log = originalConsoleLog;
    await rm(dir, { force: true, recursive: true });
  }
});
