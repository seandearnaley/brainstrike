import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildCalibrationGapPlan,
  parseCalibrationSummary,
  parseCalibrationSummaryArgs,
  renderMarkdownCalibrationSummary,
  runCli,
} from '../ci-calibration-summary.mjs';

function calibration(sourcePath, commandResults) {
  return {
    document: {
      schemaVersion: 1,
      generatedAt: '2026-05-20T00:00:00.000Z',
      dryRun: false,
      commandResults,
    },
    sourcePath,
  };
}

test('parseCalibrationSummaryArgs requires explicit flag values', () => {
  assert.throws(() => parseCalibrationSummaryArgs(['--input']), /--input requires a value/);
  assert.throws(() => parseCalibrationSummaryArgs(['--bad']), /unknown flag --bad/);
  assert.deepEqual(parseCalibrationSummaryArgs(['--input-dir', 'docs', '--min-samples', '2']), {
    gapJsonOutput: undefined,
    gapOutput: undefined,
    inputDirs: ['docs'],
    inputPaths: [],
    jsonOutput: undefined,
    minSamples: 2,
    output: undefined,
    selection: undefined,
  });
  assert.deepEqual(parseCalibrationSummaryArgs(['--', '--input', 'one.json']), {
    gapJsonOutput: undefined,
    gapOutput: undefined,
    inputDirs: [],
    inputPaths: ['one.json'],
    jsonOutput: undefined,
    minSamples: 5,
    output: undefined,
    selection: undefined,
  });
});

test('parseCalibrationSummary groups calibration samples by current command budget', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 180_000,
          command: 'pnpm --filter @brainstrike/db test',
          durationMs: 260_000,
          exitCode: 0,
          name: 'db-tests',
        },
      ]),
      calibration('two.json', [
        {
          budgetMs: 300_000,
          command: 'pnpm --filter @brainstrike/db test',
          durationMs: 240_000,
          exitCode: 0,
          name: 'db-tests',
        },
      ]),
    ],
    { minSamples: 2 }
  );

  assert.equal(summary.status, 'within-target');
  assert.equal(summary.commands.length, 1);
  assert.deepEqual(summary.commands[0], {
    currentBudgetMs: 300_000,
    failureCount: 0,
    maxDurationMs: 260_000,
    name: 'db-tests',
    owner: 'data-platform',
    p50Ms: 240_000,
    p95Ms: 260_000,
    recordedCommandStale: false,
    recordedBudgetMs: 300_000,
    recordedBudgetStale: false,
    ignoredStaleCommandSampleCount: 0,
    staleCommandSampleCount: 0,
    requiredFor: ['db-migrations-storage'],
    sampleCount: 2,
    sources: ['one.json', 'two.json'],
    status: 'within-target',
  });
});

test('parseCalibrationSummary marks insufficient and failing samples explicitly', () => {
  const summary = parseCalibrationSummary([
    calibration('one.json', [
      {
        budgetMs: 30_000,
        command: 'git diff --check',
        durationMs: 10,
        exitCode: 1,
        name: 'diff-check',
      },
    ]),
  ]);

  assert.equal(summary.status, 'failing');
  assert.equal(summary.commands[0].status, 'failing');
  assert.equal(summary.commands[0].failureCount, 1);
});

test('renderMarkdownCalibrationSummary includes p95 and stale budget notes', () => {
  const summary = parseCalibrationSummary([
    calibration('one.json', [
      {
        budgetMs: 180_000,
        command: 'pnpm stale-db-test',
        durationMs: 269_544,
        exitCode: 0,
        name: 'db-tests',
      },
    ]),
  ]);
  const markdown = renderMarkdownCalibrationSummary(summary);

  assert.match(markdown, /Local Calibration Timing Summary/);
  assert.match(markdown, /db-tests/);
  assert.match(markdown, /4m 30s/);
  assert.match(markdown, /recorded budget 3m 0s/);
  assert.match(markdown, /stale command definition/);
});

test('parseCalibrationSummary marks stale command samples as stale evidence', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 120_000,
          command: 'node --test old-ci-script-tests.test.mjs',
          durationMs: 310,
          exitCode: 0,
          name: 'ci-script-tests',
        },
      ]),
    ],
    { minSamples: 1 }
  );

  assert.equal(summary.status, 'stale-command');
  assert.equal(summary.commands[0].status, 'stale-command');
  assert.equal(summary.commands[0].recordedCommandStale, true);
  assert.equal(summary.commands[0].staleCommandSampleCount, 1);
});

test('parseCalibrationSummary ignores stale command samples when current samples exist', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 120_000,
          command: 'node --test old-ci-script-tests.test.mjs',
          durationMs: 310,
          exitCode: 0,
          name: 'ci-script-tests',
        },
      ]),
      calibration('two.json', [
        {
          budgetMs: 120_000,
          command:
            'node --test scripts/__tests__/ci-risk-rules.test.mjs scripts/__tests__/ci-select.test.mjs scripts/__tests__/ci-timing-summary.test.mjs scripts/__tests__/ci-proof-timing-summary.test.mjs scripts/__tests__/ci-proof.test.mjs scripts/__tests__/turbo-run-diagnostics.test.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/__tests__/check-ci-risk-fixtures.test.mjs scripts/__tests__/run-changed-unit-tests.test.mjs scripts/__tests__/ci-calibrate-proof-commands.test.mjs scripts/__tests__/ci-calibration-summary.test.mjs scripts/__tests__/ci-risk-audit.test.mjs && pnpm run ci:risk-fixtures',
          durationMs: 320,
          exitCode: 0,
          name: 'ci-script-tests',
        },
      ]),
    ],
    { minSamples: 1 }
  );

  assert.equal(summary.status, 'within-target');
  assert.equal(summary.commands[0].sampleCount, 1);
  assert.equal(summary.commands[0].ignoredStaleCommandSampleCount, 1);
  assert.equal(summary.commands[0].recordedCommandStale, false);
  assert.equal(summary.commands[0].p95Ms, 320);
});

test('buildCalibrationGapPlan ranks missing samples by selected PR-risk relevance', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 30_000,
          command: 'git diff --check',
          durationMs: 12,
          exitCode: 0,
          name: 'diff-check',
        },
        {
          budgetMs: 300_000,
          command: 'pnpm --filter @brainstrike/web exec playwright test --project=functional --grep "@smoke" --workers=2',
          durationMs: 33_000,
          exitCode: 0,
          name: 'web-smoke-tests',
        },
      ]),
    ],
    { minSamples: 5 }
  );
  const selection = {
    commands: [
      { name: 'diff-check' },
      { name: 'web-smoke-tests' },
      { name: 'full-local-suite' },
    ],
  };
  const plan = buildCalibrationGapPlan(summary, selection);

  assert.deepEqual(
    plan.commands.map((command) => ({
      name: command.name,
      selected: command.selected,
      missingSamples: command.missingSamples,
      releaseOnly: command.releaseOnly,
    })),
    [
      {
        missingSamples: 5,
        name: 'full-local-suite',
        releaseOnly: true,
        selected: true,
      },
      {
        missingSamples: 4,
        name: 'web-smoke-tests',
        releaseOnly: false,
        selected: true,
      },
      {
        missingSamples: 4,
        name: 'diff-check',
        releaseOnly: false,
        selected: true,
      },
    ]
  );
  assert.equal(plan.selectedMissingSamples, 13);
  assert.equal(plan.normalRiskMissingSamples, 8);
  assert.equal(plan.releaseOnlyMissingSamples, 5);
  assert.equal(plan.status, 'needs-samples');
});

test('buildCalibrationGapPlan reports complete when selected commands have enough samples', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 30_000,
          command: 'git diff --check',
          durationMs: 12,
          exitCode: 0,
          name: 'diff-check',
        },
      ]),
      calibration('two.json', [
        {
          budgetMs: 30_000,
          command: 'git diff --check',
          durationMs: 13,
          exitCode: 0,
          name: 'diff-check',
        },
      ]),
    ],
    { minSamples: 2 }
  );

  assert.deepEqual(buildCalibrationGapPlan(summary, { commands: [{ name: 'diff-check' }] }), {
    minSamples: 2,
    normalRiskMissingSamples: 0,
    releaseOnlyMissingSamples: 0,
    selectedMissingSamples: 0,
    status: 'complete',
    commands: [
      {
        estimatedRemainingMs: 0,
        missingSamples: 0,
        name: 'diff-check',
        owner: 'tooling',
        releaseOnly: false,
        sampleCount: 2,
        selected: true,
        status: 'within-target',
      },
    ],
  });
});

test('runCli writes markdown and JSON from a calibration directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-ci-calibration-summary-'));
  const jsonOutput = path.join(dir, 'summary.json');
  const markdownOutput = path.join(dir, 'summary.md');
  await writeFile(
    path.join(dir, 'pipeline-calibration-test.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      commandResults: [
        {
          budgetMs: 30_000,
          command: 'git diff --check',
          durationMs: 10,
          exitCode: 0,
          name: 'diff-check',
        },
      ],
    })}\n`
  );
  await writeFile(path.join(dir, 'unrelated.json'), '{}\n');
  await writeFile(
    path.join(dir, 'pipeline-calibration-summary-2026-05-20.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedFrom: 'calibration-files' })}\n`
  );
  await writeFile(
    path.join(dir, 'pipeline-calibration-gap-plan-2026-05-20.json'),
    `${JSON.stringify({ status: 'needs-samples' })}\n`
  );
  try {
    const exitCode = await runCli([
      '--input-dir',
      dir,
      '--min-samples',
      '1',
      '--output',
      markdownOutput,
      '--json-output',
      jsonOutput,
    ]);

    assert.equal(exitCode, 0);
    assert.match(await readFile(markdownOutput, 'utf8'), /diff-check/);
    assert.equal(JSON.parse(await readFile(jsonOutput, 'utf8')).status, 'within-target');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli writes a calibration gap plan when a selection is provided', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-ci-calibration-gaps-'));
  const jsonOutput = path.join(dir, 'summary.json');
  const gapJsonOutput = path.join(dir, 'gaps.json');
  const gapMarkdownOutput = path.join(dir, 'gaps.md');
  const selectionPath = path.join(dir, 'selection.json');
  await writeFile(
    path.join(dir, 'pipeline-calibration-test.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      commandResults: [
        {
          budgetMs: 30_000,
          command: 'git diff --check',
          durationMs: 10,
          exitCode: 0,
          name: 'diff-check',
        },
      ],
    })}\n`
  );
  await writeFile(
    selectionPath,
    `${JSON.stringify({
      commands: [{ name: 'diff-check' }, { name: 'full-local-suite' }],
    })}\n`
  );
  const originalConsoleLog = console.log;
  console.log = () => {};
  try {
    const exitCode = await runCli([
      '--input-dir',
      dir,
      '--selection',
      selectionPath,
      '--json-output',
      jsonOutput,
      '--gap-output',
      gapMarkdownOutput,
      '--gap-json-output',
      gapJsonOutput,
    ]);

    assert.equal(exitCode, 0);
    assert.match(await readFile(gapMarkdownOutput, 'utf8'), /full-local-suite/);
    const gapPlan = JSON.parse(await readFile(gapJsonOutput, 'utf8'));
    assert.equal(gapPlan.status, 'needs-samples');
    assert.equal(gapPlan.releaseOnlyMissingSamples, 5);
  } finally {
    console.log = originalConsoleLog;
    await rm(dir, { force: true, recursive: true });
  }
});
