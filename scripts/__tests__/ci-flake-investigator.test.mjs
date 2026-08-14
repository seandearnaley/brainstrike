import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchCurrentMainFailureMetadata } from '../agent-routines/ci-flake/github-actions.mjs';
import {
  classifyAttemptVector,
  loadUnitPartition,
  runCiFlakeInvestigator,
  selectQualifyingUnitFailure,
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

function run(overrides = {}) {
  return {
    conclusion: 'failure',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    id: 42,
    name: 'Test',
    run_attempt: 1,
    status: 'completed',
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    conclusion: 'failure',
    id: 91,
    name: 'Unit (db-1)',
    status: 'completed',
    steps: [
      { conclusion: 'success', name: 'Checkout', status: 'completed' },
      { conclusion: 'failure', name: 'Push and manual unit tests', status: 'completed' },
    ],
    ...overrides,
  };
}

test('classifies exactly three attempts without treating infrastructure as a flake', () => {
  const cases = [
    [['passed', 'passed', 'passed'], 'stable-pass'],
    [['failed', 'failed', 'failed'], 'stable-fail'],
    [['passed', 'failed', 'passed'], 'flake-suspect'],
    [['passed', 'signalled', 'passed'], 'infrastructure'],
    [['passed', 'timed-out', 'passed'], 'infrastructure'],
    [['passed', 'termination-failed', 'passed'], 'infrastructure'],
    [['passed', 'spawn-error', 'passed'], 'infrastructure'],
  ];
  for (const [outcomes, expected] of cases) {
    assert.equal(classifyAttemptVector(outcomes.map(execution)), expected);
  }
  assert.equal(classifyAttemptVector([execution('passed')]), 'harness-error');
});

test('reuses all four live Unit matrix rows and their exact push filters', () => {
  const rows = ['db-1', 'db-2', 'heavy', 'rest'].map((shard) => loadUnitPartition(workflow, shard));
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

test('selects one completed current-main Unit test phase from Actions metadata', () => {
  assert.deepEqual(selectQualifyingUnitFailure({ baseSha: SHA, jobs: [job()], runs: [run()] }), {
    jobId: 91,
    phase: 'test',
    runId: 42,
    runUrl: undefined,
    shard: 'db-1',
  });
  assert.equal(
    selectQualifyingUnitFailure({
      baseSha: SHA,
      jobs: [
        job({
          name: 'Unit (heavy)',
          steps: [
            {
              conclusion: 'failure',
              name: 'Push and manual integration tests',
              status: 'completed',
            },
          ],
        }),
      ],
      runs: [run()],
    }).phase,
    'test:integration'
  );
});

test('rejects stale, cancelled, ambiguous, and infrastructure-only metadata', () => {
  for (const input of [
    { jobs: [job()], runs: [run({ head_sha: 'c'.repeat(40) })] },
    { jobs: [job()], runs: [run({ conclusion: 'cancelled' })] },
    {
      jobs: [job({ steps: [{ conclusion: 'failure', name: 'Setup workspace' }] })],
      runs: [run()],
    },
    { jobs: [job(), job({ id: 92, name: 'Unit (rest)' })], runs: [run()] },
  ]) {
    assert.equal(selectQualifyingUnitFailure({ baseSha: SHA, ...input }), null);
  }
});

test('queries only read-only Actions metadata with a request timeout', async () => {
  const calls = [];
  const metadata = await fetchCurrentMainFailureMetadata({
    baseSha: SHA,
    fetchImpl: async (url, init) => {
      calls.push({ init, url });
      if (url.includes('/runs?')) {
        return new Response(JSON.stringify({ workflow_runs: [run()] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobs: [job()] }), { status: 200 });
    },
    repository: 'owner/repo',
    requestTimeoutMs: 4321,
    token: 'token',
  });
  assert.equal(metadata.runs.length, 1);
  assert.equal(metadata.jobs.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init.method === 'GET'));
  assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
  assert.match(calls[0].url, /actions\/workflows\/test\.yml\/runs\?/u);
  assert.match(calls[1].url, /actions\/runs\/42\/jobs/u);
});

test('does no test work when metadata has no qualifying failure', async () => {
  let calls = 0;
  const report = await runCiFlakeInvestigator({
    baseSha: SHA,
    candidate: null,
    runner: async () => {
      calls += 1;
      return execution('passed');
    },
    workflowText: workflow,
  });
  assert.equal(calls, 0);
  assert.equal(report.status, 'clean');
  assert.equal(report.summary.executions, 0);
});

test('reruns only the selected Unit shard and phase three times with read-only cache', async () => {
  const calls = [];
  const report = await runCiFlakeInvestigator({
    baseSha: SHA,
    candidate: { jobId: 91, phase: 'test:integration', runId: 42, shard: 'db-1' },
    runner: async (request) => {
      calls.push(request);
      return execution('passed');
    },
    workflowText: workflow,
  });
  assert.equal(calls.length, 3);
  assert.equal(report.selected.phase, 'test:integration');
  assert.ok(calls.every(({ command }) => command[3] === 'test:integration'));
  assert.ok(calls.every(({ command }) => command.includes('--cache=local:r')));
  assert.ok(calls.every(({ command }) => !command.includes('--force')));
  assert.ok(calls.every(({ env }) => env.DB_TEST_SHARD === '1/2'));
});

test('infrastructure during a selected rerun blocks instead of reporting a flake', async () => {
  let attempt = 0;
  const outcomes = ['passed', 'signalled', 'passed'];
  const report = await runCiFlakeInvestigator({
    baseSha: SHA,
    candidate: { jobId: 91, phase: 'test', runId: 42, shard: 'rest' },
    runner: async () => execution(outcomes[attempt++]),
    workflowText: workflow,
  });
  assert.equal(report.classification, 'infrastructure');
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.findings, []);
});
