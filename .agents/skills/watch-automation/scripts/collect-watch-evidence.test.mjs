import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertStableRunSnapshots,
  compareWatermark,
  deriveCharter,
  deriveWatchedWorkflows,
  errorClassFromMessage,
  extractLogEvidence,
  parseLsofOutput,
} from './collect-watch-evidence.mjs';

test('deriveCharter fails closed while deriving live Watch values', () => {
  const charter = `
NAME=Watch
ROLE=flake investigator
AUTONOMY=diagnose-only
CHARTER_VERSION=2
STATE_ISSUE="[automation-state] Watch"
WALL_CLOCK_BUDGET=45 minutes
NEVER fix, skip, quarantine, retry-mask, or edit tests
pull the last 24h of runs (derive the list from .github/workflows/)
fingerprint =
watch:<workflow>:<test-title-slug>:<error-class>
`;
  assert.deepEqual(deriveCharter(charter), {
    autonomy: 'diagnose-only',
    fingerprintShape: 'watch:<workflow>:<test-title-slug>:<error-class>',
    lookbackHours: 24,
    name: 'Watch',
    role: 'flake investigator',
    stateIssue: '[automation-state] Watch',
    version: '2',
    wallClockBudget: '45 minutes',
  });
  assert.throws(
    () => deriveCharter(charter.replace('NEVER fix', 'Avoid fixing')),
    /safety boundary is missing/
  );
});

test('deriveWatchedWorkflows selects scheduled E2E and nightly workflows only', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'watch-workflows-'));
  const workflowRoot = path.join(repo, '.github', 'workflows');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(
    path.join(workflowRoot, 'web.yml'),
    "name: Web E2E\non:\n  schedule:\n    - cron: '0 0 * * *'\n"
  );
  writeFileSync(
    path.join(workflowRoot, 'coverage.yaml'),
    "name: Nightly Coverage\non:\n  schedule:\n    - cron: '0 1 * * *'\n"
  );
  writeFileSync(
    path.join(workflowRoot, 'manual.yml'),
    'name: Local Desktop E2E\non:\n  workflow_dispatch:\n'
  );
  writeFileSync(
    path.join(workflowRoot, 'cleanup.yml'),
    "name: Actions Storage Cleanup\non:\n  schedule:\n    - cron: '0 2 * * *'\n"
  );

  try {
    assert.deepEqual(deriveWatchedWorkflows(repo), [
      { name: 'Nightly Coverage', path: '.github/workflows/coverage.yaml' },
      { name: 'Web E2E', path: '.github/workflows/web.yml' },
    ]);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test('compareWatermark distinguishes unchanged, new, and expired run IDs', () => {
  assert.deepEqual(compareWatermark(['2', '1'], ['1', '2']), {
    currentRunIds: ['1', '2'],
    expiredRunIds: [],
    newRunIds: [],
    noopEligible: true,
    previousRunIds: ['1', '2'],
    supplied: true,
    unchanged: true,
  });
  assert.deepEqual(compareWatermark(['1', '2'], ['2', '3']), {
    currentRunIds: ['2', '3'],
    expiredRunIds: ['1'],
    newRunIds: ['3'],
    noopEligible: false,
    previousRunIds: ['1', '2'],
    supplied: true,
    unchanged: false,
  });
});

test('run snapshots fail closed when GitHub state drifts during collection', () => {
  const base = {
    attempt: 1,
    conclusion: 'failure',
    id: '10',
    status: 'completed',
    updatedAt: '2026-07-21T00:00:00Z',
    workflow: { id: 20 },
  };
  assert.doesNotThrow(() => assertStableRunSnapshots([base], [{ ...base }]));
  assert.throws(
    () => assertStableRunSnapshots([base], [{ ...base, attempt: 2 }]),
    /snapshot changed during collection/
  );
});

test('extractLogEvidence emits bounded fingerprint candidates and retry signals', () => {
  const jobs = [
    {
      conclusion: 'failure',
      name: 'Web Full Regression',
      steps: [{ conclusion: 'failure', name: 'Run full regression' }],
    },
    {
      conclusion: 'failure',
      name: 'Coverage',
      steps: [{ conclusion: 'failure', name: 'Run package coverage' }],
    },
  ];
  const logText = [
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:00Z\tImage: ubuntu-24.04',
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:01Z\tVersion: 20260720.1.0',
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:02Z\t1) [chromium] › tests/explorer.spec.ts:42:3 › Explorer › Select all (retry #1)',
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:03Z\tError: locator.click: Test timeout of 30000ms exceeded.',
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:03Z\t<button> intercepts pointer events',
    'Web Full Regression\tRun full regression\t2026-07-21T00:00:03Z\t✓ 12 [chromium] › tests/other.spec.ts:9:2 › Other › recovers (retry #1) (1.2s)',
    'Coverage\tRun package coverage\t2026-07-21T00:00:04Z\tError: The operation was canceled.',
  ].join('\n');

  const evidence = extractLogEvidence({
    attempt: 1,
    jobs,
    logText,
    workflowName: 'Web E2E',
  });
  assert.equal(evidence.failureCandidates.length, 2);
  assert.equal(
    evidence.failureCandidates[0].fingerprintCandidate,
    'watch:web-e2e:select-all:locator-click-timeout-pointer-interception'
  );
  assert.equal(evidence.failureCandidates[0].syntheticPhaseTitle, false);
  assert.equal(evidence.failureCandidates[0].fingerprintReady, true);
  assert.equal(evidence.failureCandidates[1].errorClass, 'operation-cancelled');
  assert.equal(evidence.failureCandidates[1].fingerprintReady, false);
  assert.equal(evidence.failureCandidates[1].syntheticPhaseTitle, true);
  assert.deepEqual(
    evidence.retrySignals.map((signal) => ({
      outcome: signal.outcome,
      retry: signal.retry,
      testTitle: signal.testTitle,
    })),
    [
      {
        outcome: 'failed',
        retry: 1,
        testTitle: 'tests/explorer.spec.ts › Explorer › Select all',
      },
      {
        outcome: 'passed',
        retry: 1,
        testTitle: 'tests/other.spec.ts › Other › recovers',
      },
    ]
  );
  assert.deepEqual(evidence.imagesByJob['Web Full Regression'], {
    image: 'ubuntu-24.04',
    operatingSystem: null,
    version: '20260720.1.0',
  });
  assert.deepEqual(evidence.unparsedFailures, []);
});

test('error classes and lsof listeners are normalized', () => {
  assert.equal(errorClassFromMessage('Test timeout of 30000ms exceeded.'), 'test-timeout');
  assert.equal(errorClassFromMessage('TypeError: value is undefined'), 'type-error');
  assert.deepEqual(parseLsofOutput('p123\ncnode\nn127.0.0.1:8080\n', 8080), [
    { command: 'node', name: '127.0.0.1:8080', pid: '123', port: 8080 },
  ]);
});
