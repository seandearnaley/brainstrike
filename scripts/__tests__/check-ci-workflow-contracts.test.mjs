import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  extractJob,
  validateDesktopE2EContracts,
  validateWorkflowContracts,
} from '../check-ci-workflow-contracts.mjs';

const workflowSource = await readFile('.github/workflows/test.yml', 'utf8');

test('extractJob returns a single workflow job block', () => {
  const e2e = extractJob(workflowSource, 'e2e');

  assert.ok(e2e);
  assert.match(e2e, /^  e2e:$/m);
  assert.match(e2e, /name: E2E Tests/);
  assert.doesNotMatch(e2e, /^  e2e-stateful:/m);
});

test('extractJob treats job names as literal text', () => {
  const source = ['jobs:', '  e2e.test:', '    name: Literal job', '  e2e-test:', '    name: Other job'].join('\n');
  const job = extractJob(source, 'e2e.test');

  assert.ok(job);
  assert.match(job, /^  e2e\.test:$/m);
  assert.doesNotMatch(job, /name: Other job/);
});

test('extractJob stops before dotted job names', () => {
  const source = ['jobs:', '  e2e:', '    name: Functional job', '  e2e.test:', '    name: Dotted job'].join('\n');
  const job = extractJob(source, 'e2e');

  assert.ok(job);
  assert.match(job, /name: Functional job/);
  assert.doesNotMatch(job, /name: Dotted job/);
});

test('current workflow satisfies CI cost and E2E routing contracts', () => {
  assert.deepEqual(validateWorkflowContracts(workflowSource), []);
});

test('workflow contract fails when blob reports upload on success', () => {
  const source = workflowSource.replace(
    '- name: Upload blob report\n        if: failure()',
    '- name: Upload blob report\n        if: always()'
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Blob report uploads must be failure-only/
  );
});

test('workflow contract fails when stateful E2E waits on determine-matrix', () => {
  const stateful = extractJob(workflowSource, 'e2e-stateful');
  assert.ok(stateful);
  const source = workflowSource.replace(
    stateful,
    stateful.replace('needs: [checks]\n    runs-on', 'needs: [checks, determine-matrix]\n    runs-on')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Stateful E2E must not wait on determine-matrix/
  );
});

test('workflow contract fails when the aggregate PR gate drops functional E2E', () => {
  const prGate = extractJob(workflowSource, 'required-pr-gate');
  assert.ok(prGate);

  const source = workflowSource.replace(prGate, prGate.replace('\n      - e2e\n', '\n'));

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Required PR Gate must depend on e2e/
  );
});

test('workflow contract fails when PR desktop E2E is smoke-only', () => {
  const desktopPr = extractJob(workflowSource, 'desktop-e2e-pr');
  assert.ok(desktopPr);

  const source = workflowSource.replace(
    desktopPr,
    desktopPr
      .replace('name: Desktop E2E Regression', 'name: Desktop E2E Smoke')
      .replace('--project=regression', '--project=smoke')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /PR desktop E2E must run the regression Playwright project/
  );
});

test('workflow contract fails when desktop embedding retries are reintroduced', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(' --retries=0 --max-failures=1', '')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop embedding E2E must disable Playwright retries/);
  assert.match(failures, /desktop embedding E2E must fail fast on the first failure/);
});

test('workflow contract fails when desktop embedding global timeout is removed', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace(' --global-timeout=720000', '')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /desktop embedding E2E must cap Playwright runtime at 12 minutes/
  );
});

test('workflow contract fails when broad desktop embedding core lane is reintroduced', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr.replace('@desktop-embedding-lifecycle', '@desktop-embedding-core')
  );

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /must not reintroduce the broad @desktop-embedding-core lane/
  );
});

test('workflow contract fails when desktop embedding timeout is widened', () => {
  const desktopEmbeddingPr = extractJob(workflowSource, 'desktop-e2e-embedding-pr');
  assert.ok(desktopEmbeddingPr);

  const source = workflowSource.replace(
    desktopEmbeddingPr,
    desktopEmbeddingPr
      .replace('timeout-minutes: 15', 'timeout-minutes: 40')
      .replace('timeout-minutes: 12', 'timeout-minutes: 35')
  );

  const failures = validateWorkflowContracts(source).join('\n');
  assert.match(failures, /desktop embedding job timeout must stay at 15 minutes/);
  assert.match(failures, /desktop embedding test step timeout must stay at 12 minutes/);
});

test('workflow contract fails when desktop PR and main shard totals diverge', () => {
  const source = workflowSource
    .replace('desktop-shards=["1","2","3","4"]', 'desktop-shards=["1","2"]')
    .replace('desktop-shard-total=["4"]', 'desktop-shard-total=["2"]');

  assert.match(
    validateWorkflowContracts(source).join('\n'),
    /Desktop regression matrix must stay at four shards/
  );
});

test('desktop E2E contract fails when Playwright is forced to one worker', () => {
  const failures = validateDesktopE2EContracts({
    playwrightConfigSource: 'workers: 1\nfullyParallel: config.fullyParallel',
    playwrightEnvironmentSource: 'return 0;',
  });

  assert.match(failures.join('\n'), /must not force workers to one/);
});

test('desktop E2E contract fails when Playwright has a 15 minute global timeout', () => {
  const failures = validateDesktopE2EContracts({
    playwrightConfigSource: 'workers: config.workers\nfullyParallel: config.fullyParallel',
    playwrightEnvironmentSource: 'return 15 * 60 * 1000;',
  });

  assert.match(failures.join('\n'), /globalTimeout disabled/);
  assert.match(failures.join('\n'), /15 minute global timeout/);
});
