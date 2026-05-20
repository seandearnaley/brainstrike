import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildRiskAudit,
  parseRiskAuditArgs,
  renderMarkdownRiskAudit,
  runCli,
} from '../ci-risk-audit.mjs';

function selection(commandNames) {
  return {
    riskProfile: {
      category: 'web-ui-file-explorer',
      domains: ['workspace-experience'],
      riskLevel: 'medium',
    },
    budget: {
      target: 'normal-pr-risk',
      targetMs: 900_000,
      totalMs: 570_000,
      status: 'within-target',
    },
    commands: commandNames.map((name) => ({
      name,
      owner: name === 'web-smoke-tests' ? 'applications' : 'workspace-experience',
      budgetMs: name === 'web-smoke-tests' ? 300_000 : 240_000,
      command: `run ${name}`,
    })),
  };
}

function calibration(commands) {
  return {
    status: 'calibrating',
    commands,
  };
}

test('parseRiskAuditArgs requires explicit selection and calibration paths', () => {
  assert.throws(() => parseRiskAuditArgs([]), /--selection is required/);
  assert.throws(
    () => parseRiskAuditArgs(['--selection', 'selection.json']),
    /--calibration is required/
  );
  assert.throws(
    () =>
      parseRiskAuditArgs([
        '--selection',
        'selection.json',
        '--calibration',
        'summary.json',
        '--bad',
        'value',
      ]),
    /unknown flag --bad/
  );
  assert.deepEqual(
    parseRiskAuditArgs([
      '--selection',
      'selection.json',
      '--calibration',
      'summary.json',
      '--output',
      'audit.md',
      '--json-output',
      'audit.json',
      '--strict',
    ]),
    {
      calibration: 'summary.json',
      jsonOutput: 'audit.json',
      output: 'audit.md',
      selection: 'selection.json',
      strict: true,
    }
  );
});

test('buildRiskAudit maps selected commands to calibration evidence', () => {
  const audit = buildRiskAudit(
    selection(['file-explorer-tests', 'web-smoke-tests']),
    calibration([
      {
        currentBudgetMs: 240_000,
        name: 'file-explorer-tests',
        owner: 'workspace-experience',
        p50Ms: 20_000,
        p95Ms: 25_000,
        sampleCount: 5,
        status: 'within-target',
      },
      {
        currentBudgetMs: 300_000,
        name: 'web-smoke-tests',
        owner: 'applications',
        p50Ms: 33_000,
        p95Ms: 33_000,
        sampleCount: 1,
        status: 'calibrating',
      },
    ])
  );

  assert.equal(audit.status, 'calibrating');
  assert.deepEqual(
    audit.commands.map((command) => ({
      name: command.name,
      owner: command.owner,
      calibrationStatus: command.calibrationStatus,
      evidence: command.evidence,
    })),
    [
      {
        calibrationStatus: 'within-target',
        evidence: 'measured',
        name: 'file-explorer-tests',
        owner: 'workspace-experience',
      },
      {
        calibrationStatus: 'calibrating',
        evidence: 'calibrating',
        name: 'web-smoke-tests',
        owner: 'applications',
      },
    ]
  );
});

test('buildRiskAudit reports missing evidence and keeps failure ownership', () => {
  const audit = buildRiskAudit(
    selection(['file-explorer-tests', 'web-smoke-tests']),
    calibration([
      {
        currentBudgetMs: 240_000,
        failureCount: 1,
        name: 'file-explorer-tests',
        owner: 'workspace-experience',
        p50Ms: 20_000,
        p95Ms: 25_000,
        sampleCount: 2,
        status: 'failing',
      },
    ])
  );

  assert.equal(audit.status, 'failing');
  assert.deepEqual(
    audit.commands.map((command) => ({
      name: command.name,
      owner: command.owner,
      calibrationStatus: command.calibrationStatus,
      evidence: command.evidence,
    })),
    [
      {
        calibrationStatus: 'failing',
        evidence: 'failing',
        name: 'file-explorer-tests',
        owner: 'workspace-experience',
      },
      {
        calibrationStatus: 'missing',
        evidence: 'missing-calibration',
        name: 'web-smoke-tests',
        owner: 'applications',
      },
    ]
  );
});

test('buildRiskAudit preserves stale calibration command evidence', () => {
  const audit = buildRiskAudit(
    selection(['file-explorer-tests', 'web-smoke-tests']),
    calibration([
      {
        currentBudgetMs: 300_000,
        name: 'file-explorer-tests',
        owner: 'applications',
        p50Ms: 33_000,
        p95Ms: 33_000,
        sampleCount: 1,
        status: 'stale-command',
      },
    ])
  );

  assert.equal(audit.status, 'stale-command');
  assert.equal(audit.commands[0].evidence, 'stale-command');
  assert.equal(audit.commands[1].evidence, 'missing-calibration');
});

test('renderMarkdownRiskAudit includes selected lane ownership and missing samples', () => {
  const audit = buildRiskAudit(selection(['web-smoke-tests']), calibration([]));
  const markdown = renderMarkdownRiskAudit(audit);

  assert.match(markdown, /Risk Audit/);
  assert.match(markdown, /web-ui-file-explorer/);
  assert.match(markdown, /web-smoke-tests/);
  assert.match(markdown, /applications/);
  assert.match(markdown, /missing-calibration/);
  assert.doesNotMatch(markdown, /nullms/);
});

test('runCli writes markdown and JSON and fails strict mode on calibrating evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-ci-risk-audit-'));
  const selectionPath = path.join(dir, 'selection.json');
  const calibrationPath = path.join(dir, 'calibration.json');
  const markdownOutput = path.join(dir, 'audit.md');
  const jsonOutput = path.join(dir, 'audit.json');
  const originalConsoleLog = console.log;
  console.log = () => {};
  await writeFile(selectionPath, `${JSON.stringify(selection(['web-smoke-tests']))}\n`);
  await writeFile(
    calibrationPath,
    `${JSON.stringify(
      calibration([
        {
          currentBudgetMs: 300_000,
          name: 'web-smoke-tests',
          owner: 'applications',
          p50Ms: 33_000,
          p95Ms: 33_000,
          sampleCount: 1,
          status: 'calibrating',
        },
      ])
    )}\n`
  );

  try {
    assert.equal(
      await runCli([
        '--selection',
        selectionPath,
        '--calibration',
        calibrationPath,
        '--output',
        markdownOutput,
        '--json-output',
        jsonOutput,
      ]),
      0
    );
    assert.match(await readFile(markdownOutput, 'utf8'), /web-smoke-tests/);
    assert.equal(JSON.parse(await readFile(jsonOutput, 'utf8')).status, 'calibrating');
    assert.equal(
      await runCli([
        '--selection',
        selectionPath,
        '--calibration',
        calibrationPath,
        '--strict',
      ]),
      1
    );
  } finally {
    console.log = originalConsoleLog;
    await rm(dir, { force: true, recursive: true });
  }
});
