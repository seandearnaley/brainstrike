import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
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
    inputDirs: ['docs'],
    inputPaths: [],
    jsonOutput: undefined,
    minSamples: 2,
    output: undefined,
  });
  assert.deepEqual(parseCalibrationSummaryArgs(['--', '--input', 'one.json']), {
    inputDirs: [],
    inputPaths: ['one.json'],
    jsonOutput: undefined,
    minSamples: 5,
    output: undefined,
  });
});

test('parseCalibrationSummary groups calibration samples by current command budget', () => {
  const summary = parseCalibrationSummary(
    [
      calibration('one.json', [
        {
          budgetMs: 180_000,
          durationMs: 260_000,
          exitCode: 0,
          name: 'db-tests',
        },
      ]),
      calibration('two.json', [
        {
          budgetMs: 300_000,
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
    recordedBudgetMs: 300_000,
    recordedBudgetStale: false,
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
