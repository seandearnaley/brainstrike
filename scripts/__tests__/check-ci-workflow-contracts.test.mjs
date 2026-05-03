import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  extractJob,
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
