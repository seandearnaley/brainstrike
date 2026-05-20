import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  parseProofTimingSummary,
  renderMarkdownProofTimingSummary,
  runCli,
} from '../ci-proof-timing-summary.mjs';

function manifest(category, totalMs, commandDurations = [totalMs]) {
  return {
    schemaVersion: 1,
    testedHeadSha: '2222222222222222222222222222222222222222',
    selection: {
      budget: {
        target: category === 'docs-only' ? 'fast-local' : 'normal-pr-risk',
        targetMs: category === 'docs-only' ? 120_000 : 900_000,
        totalMs: category === 'docs-only' ? 60_000 : 570_000,
        status: 'within-target',
      },
      riskProfile: {
        category,
        cloudLabels: [],
        domains: [category],
        e2eLanes: [],
        proofCommands: ['diff-check'],
        riskLevel: 'low',
      },
    },
    commandResults: commandDurations.map((durationMs, index) => ({
      budgetMs: index === 0 ? 30_000 : 60_000,
      budgetStatus: durationMs > (index === 0 ? 30_000 : 60_000) ? 'over-budget' : 'ok',
      command: `command-${index}`,
      durationMs,
      exitCode: 0,
      name: index === 0 ? 'diff-check' : 'domain-tests',
      owner: index === 0 ? 'tooling' : category,
    })),
  };
}

test('parseProofTimingSummary groups manifests by risk category and computes p50/p95', () => {
  const summary = parseProofTimingSummary(
    [
      manifest('docs-only', 10_000),
      manifest('docs-only', 20_000),
      manifest('docs-only', 90_000),
      manifest('web-ui-file-explorer', 200_000, [20_000, 180_000]),
      manifest('web-ui-file-explorer', 600_000, [30_000, 570_000]),
    ],
    { minSamples: 2 }
  );

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.generatedFrom, 'proof-manifests');
  assert.deepEqual(
    summary.categories.map((category) => ({
      category: category.category,
      p50Ms: category.p50Ms,
      p95Ms: category.p95Ms,
      sampleCount: category.sampleCount,
      status: category.status,
      targetMs: category.targetMs,
    })),
    [
      {
        category: 'docs-only',
        p50Ms: 20_000,
        p95Ms: 90_000,
        sampleCount: 3,
        status: 'within-target',
        targetMs: 120_000,
      },
      {
        category: 'web-ui-file-explorer',
        p50Ms: 200_000,
        p95Ms: 600_000,
        sampleCount: 2,
        status: 'within-target',
        targetMs: 900_000,
      },
    ]
  );
  assert.deepEqual(summary.categories[1].commands[1], {
    budgetMs: 60_000,
    owner: 'web-ui-file-explorer',
    p50Ms: 180_000,
    p95Ms: 570_000,
    sampleCount: 2,
    status: 'over-target',
    command: 'domain-tests',
  });
});

test('parseProofTimingSummary marks categories with too few samples as calibrating', () => {
  const summary = parseProofTimingSummary([manifest('docs-only', 10_000)], {
    minSamples: 3,
  });

  assert.equal(summary.categories[0].status, 'calibrating');
});

test('renderMarkdownProofTimingSummary includes lane status and command owners', () => {
  const markdown = renderMarkdownProofTimingSummary(
    parseProofTimingSummary([manifest('docs-only', 10_000), manifest('docs-only', 20_000)], {
      minSamples: 2,
    })
  );

  assert.match(markdown, /## Local Proof Timing Summary/);
  assert.match(markdown, /docs-only/);
  assert.match(markdown, /diff-check/);
  assert.match(markdown, /tooling/);
});

test('runCli writes proof timing markdown and JSON from explicit inputs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-proof-timing-'));
  try {
    const first = path.join(dir, 'first.json');
    const second = path.join(dir, 'second.json');
    const output = path.join(dir, 'summary.md');
    const jsonOutput = path.join(dir, 'summary.json');
    await writeFile(first, JSON.stringify(manifest('docs-only', 10_000)));
    await writeFile(second, JSON.stringify(manifest('docs-only', 20_000)));

    const exitCode = await runCli([
      '--input',
      first,
      '--input',
      second,
      '--min-samples',
      '2',
      '--output',
      output,
      '--json-output',
      jsonOutput,
    ]);

    assert.equal(exitCode, 0);
    assert.match(await readFile(output, 'utf8'), /docs-only/);
    assert.equal(JSON.parse(await readFile(jsonOutput, 'utf8')).categories[0].p95Ms, 20_000);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli fails closed when no proof manifest inputs are provided', async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    const exitCode = await runCli([]);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /at least one --input or --input-dir is required/);
  } finally {
    console.error = originalConsoleError;
  }
});
