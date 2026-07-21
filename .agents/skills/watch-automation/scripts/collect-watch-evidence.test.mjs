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
  fingerprint,
  parseArgs,
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

test('parseArgs validates watermark keys, empty watermark, and preflight ports', () => {
  const parsed = parseArgs(['--repo', '/x', '--watermark', '124@2,123@1', '--preflight-port', '8080']);
  assert.deepEqual(parsed.watermark, ['123@1', '124@2']);
  assert.equal(parsed.watermarkSupplied, true);
  assert.deepEqual(parsed.preflightPorts, [8080]);

  const explicitlyEmpty = parseArgs(['--repo', '/x', '--watermark', 'none']);
  assert.deepEqual(explicitlyEmpty.watermark, []);
  assert.equal(explicitlyEmpty.watermarkSupplied, true);
  assert.equal(parseArgs(['--repo', '/x', '--watermark', '']).watermarkSupplied, true);
  assert.equal(parseArgs(['--repo', '/x']).watermarkSupplied, false);

  assert.throws(() => parseArgs(['--repo', '/x', '--watermark', '123']), /<runId>@<attempt>/);
  assert.throws(() => parseArgs(['--repo', '/x', '--preflight-port', '8080abc']), /integer/);
  assert.throws(() => parseArgs(['--repo', '/x', '--preflight-port', ' 8080']), /integer/);
});

test('deriveWatchedWorkflows lists every scheduled workflow with inclusion markers', () => {
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
    assert.deepEqual(deriveWatchedWorkflows(repo), {
      scheduled: [
        {
          exclusionReason: 'name lacks an E2E or nightly token',
          included: false,
          name: 'Actions Storage Cleanup',
          path: '.github/workflows/cleanup.yml',
        },
        {
          exclusionReason: null,
          included: true,
          name: 'Nightly Coverage',
          path: '.github/workflows/coverage.yaml',
        },
        {
          exclusionReason: null,
          included: true,
          name: 'Web E2E',
          path: '.github/workflows/web.yml',
        },
      ],
      watched: [
        { name: 'Nightly Coverage', path: '.github/workflows/coverage.yaml' },
        { name: 'Web E2E', path: '.github/workflows/web.yml' },
      ],
    });
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }

  const uncovered = mkdtempSync(path.join(tmpdir(), 'watch-workflows-'));
  const uncoveredRoot = path.join(uncovered, '.github', 'workflows');
  mkdirSync(uncoveredRoot, { recursive: true });
  writeFileSync(
    path.join(uncoveredRoot, 'cleanup.yml'),
    "name: Actions Storage Cleanup\non:\n  schedule:\n    - cron: '0 2 * * *'\n"
  );
  try {
    assert.throws(() => deriveWatchedWorkflows(uncovered), /Derived no scheduled/);
  } finally {
    rmSync(uncovered, { force: true, recursive: true });
  }
});

test('compareWatermark checkpoints completed runs only, attempt-aware', () => {
  const runs = [
    { attempt: 1, id: '1', status: 'completed' },
    { attempt: 1, id: '2', status: 'in_progress' },
  ];
  assert.deepEqual(compareWatermark({ previousKeys: ['1@1'], runs, supplied: true }), {
    checkpointWatermark: ['1@1'],
    currentRunKeys: ['1@1', '2@1'],
    expiredRunKeys: [],
    newRunKeys: ['2@1'],
    noopEligible: false,
    pendingRuns: [{ attempt: 1, id: '2', status: 'in_progress' }],
    previousRunKeys: ['1@1'],
    supplied: true,
    unchanged: false,
  });
});

test('compareWatermark never NOOPs while a watched run is pending', () => {
  const runs = [
    { attempt: 1, id: '1', status: 'completed' },
    { attempt: 1, id: '2', status: 'in_progress' },
  ];
  const result = compareWatermark({ previousKeys: ['1@1', '2@1'], runs, supplied: true });
  assert.equal(result.unchanged, true);
  assert.equal(result.noopEligible, false);
  assert.deepEqual(result.pendingRuns, [{ attempt: 1, id: '2', status: 'in_progress' }]);
  assert.deepEqual(result.checkpointWatermark, ['1@1']);
});

test('compareWatermark surfaces reruns as new attempt-aware keys', () => {
  const result = compareWatermark({
    previousKeys: ['1@1'],
    runs: [{ attempt: 2, id: '1', status: 'completed' }],
    supplied: true,
  });
  assert.deepEqual(result.newRunKeys, ['1@2']);
  assert.deepEqual(result.expiredRunKeys, ['1@1']);
  assert.deepEqual(result.checkpointWatermark, ['1@2']);
  assert.equal(result.noopEligible, false);
});

test('compareWatermark NOOPs only on an unchanged fully-completed set', () => {
  const runs = [{ attempt: 1, id: '1', status: 'completed' }];
  assert.equal(compareWatermark({ previousKeys: ['1@1'], runs, supplied: true }).noopEligible, true);
  assert.equal(
    compareWatermark({ previousKeys: [], runs, supplied: false }).noopEligible,
    false
  );
  assert.equal(compareWatermark({ previousKeys: [], runs: [], supplied: true }).noopEligible, true);
  assert.equal(compareWatermark({ previousKeys: [], runs: [], supplied: false }).noopEligible, false);
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
    'Web Full Regression\tSet up job\t2026-07-20T23:59:58Z\tImage: ubuntu-24.04',
    'Web Full Regression\tSet up job\t2026-07-20T23:59:58Z\tVersion: 20260720.1.0',
    'Web Full Regression\tSet up job\t2026-07-20T23:59:59Z\tOperating System',
    'Web Full Regression\tSet up job\t2026-07-20T23:59:59Z\tUbuntu',
    'Web Full Regression\tSet up job\t2026-07-20T23:59:59Z\t24.04.2',
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
    'watch:web-e2e:tests-explorer-spec-ts-explorer-select-all:locator-click-timeout-pointer-interception'
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
    operatingSystem: 'Ubuntu',
    version: '20260720.1.0',
  });
  assert.deepEqual(evidence.unattributedCandidates, []);
  assert.deepEqual(evidence.unparsedFailures, []);
});

test('extractLogEvidence yields one fingerprint for padded list-reporter headers', () => {
  const jobs = [
    { conclusion: 'failure', name: 'Web', steps: [{ conclusion: 'failure', name: 'Run' }] },
  ];
  const line = (message) => `Web\tRun\t2026-07-21T00:00:00Z\t${message}`;
  const logText = [
    line('1) [chromium] › e2e/x.test.ts:42:3 › Explorer › select all (retry #1) ─────────'),
    line('Error: Test timeout of 30000ms exceeded.'),
    line('1) [chromium] › e2e/x.test.ts:42:3 › Explorer › select all ─────────'),
    line('Error: Test timeout of 30000ms exceeded.'),
  ].join('\n');

  const evidence = extractLogEvidence({ attempt: 1, jobs, logText, workflowName: 'Web E2E' });
  assert.deepEqual(
    [...new Set(evidence.failureCandidates.map((candidate) => candidate.fingerprintCandidate))],
    ['watch:web-e2e:e2e-x-test-ts-explorer-select-all:test-timeout']
  );
  assert.equal(evidence.failureCandidates.length, 1);
  assert.equal(evidence.failureCandidates[0].testTitle, 'e2e/x.test.ts › Explorer › select all');
  assert.deepEqual(
    evidence.retrySignals.map((signal) => signal.testTitle),
    ['e2e/x.test.ts › Explorer › select all']
  );
});

test('extractLogEvidence never lets unattributed lines cover a failed job', () => {
  const jobs = [
    {
      conclusion: 'failure',
      name: 'Desktop E2E',
      steps: [{ conclusion: 'failure', name: 'Run desktop e2e' }],
    },
  ];
  const logText = [
    '1) [chromium] › e2e/app.test.ts:7:1 › App › boots',
    'Error: Test timeout of 30000ms exceeded.',
  ].join('\n');

  const evidence = extractLogEvidence({ attempt: 1, jobs, logText, workflowName: 'Desktop E2E' });
  assert.deepEqual(evidence.failureCandidates, []);
  assert.equal(evidence.unparsedFailures.length, 1);
  assert.equal(evidence.unparsedFailures[0].job, 'Desktop E2E');
  assert.equal(evidence.unattributedCandidates.length, 1);
  assert.equal(evidence.unattributedCandidates[0].job, null);
  assert.equal(
    evidence.unattributedCandidates[0].fingerprintCandidate,
    'watch:desktop-e2e:e2e-app-test-ts-app-boots:test-timeout'
  );
});

test('fingerprint slugs the full title path and stays bounded', () => {
  const explorer = fingerprint('Web E2E', 'Explorer › renders', 'assertion');
  const settings = fingerprint('Web E2E', 'Settings › renders', 'assertion');
  assert.notEqual(explorer, settings);
  assert.equal(explorer, 'watch:web-e2e:explorer-renders:assertion');

  const long = fingerprint('Web E2E', `${'segment '.repeat(30)}› leaf`, 'assertion');
  const slugPart = long.split(':')[2];
  assert.ok(slugPart.length <= 80);
  assert.ok(slugPart.length > 0);
  assert.ok(!slugPart.endsWith('-'));
});

test('error classes and lsof listeners are normalized', () => {
  assert.equal(errorClassFromMessage('Test timeout of 30000ms exceeded.'), 'test-timeout');
  assert.equal(errorClassFromMessage('TypeError: value is undefined'), 'type-error');
  assert.deepEqual(parseLsofOutput('p123\ncnode\nn127.0.0.1:8080\n', 8080), [
    { command: 'node', name: '127.0.0.1:8080', pid: '123', port: 8080 },
  ]);
});
