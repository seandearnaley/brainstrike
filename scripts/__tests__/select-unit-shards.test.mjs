import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasUnitTasks, selectUnitShards, unitFilterArguments } from '../select-unit-shards.mjs';

// Projected from Turbo 2.11.2 --dry=json output: an integration-only package
// still has a test node, but its command is the literal <NONEXISTENT>.
const integrationOnly = {
  tasks: [
    { command: '<NONEXISTENT>', package: '@brainstrike/a', task: 'test' },
    { command: 'echo integration', package: '@brainstrike/a', task: 'test:integration' },
  ],
  version: '1',
};
const empty = { tasks: [], version: '1' };
const matrix = {
  include: [
    { pr_filters: '--filter="@brainstrike/a"', shard: 'a-1', vitest_shard: '1/2' },
    { pr_filters: '--filter="@brainstrike/a"', shard: 'a-2', vitest_shard: '2/2' },
    { pr_filters: '--filter="!@brainstrike/a"', shard: 'rest', vitest_shard: '' },
  ],
};

test('integration-only work keeps every native shard and drops the empty partition', () => {
  const calls = [];
  const selected = selectUnitShards(matrix, 'pull_request', (filters) => {
    calls.push(filters);
    return filters[0] === '--filter=@brainstrike/a' ? integrationOnly : empty;
  });
  assert.deepEqual(selected.include, matrix.include.slice(0, 2));
  assert.deepEqual(calls, [['--filter=@brainstrike/a'], ['--filter=!@brainstrike/a']]);
});

test('a verified no-work PR produces zero rows, without admitting placeholder tasks', () => {
  const placeholders = structuredClone(integrationOnly);
  placeholders.tasks[1].command = '<NONEXISTENT>';
  assert.equal(hasUnitTasks(placeholders), false);
  assert.deepEqual(
    selectUnitShards(matrix, 'pull_request', () => placeholders),
    { include: [] }
  );
});

test('unit-only work and dependent test tasks admit a partition', () => {
  assert.equal(
    hasUnitTasks({
      tasks: [
        { command: '<NONEXISTENT>', package: '@brainstrike/a', task: 'topo' },
        { command: 'tsc -b', package: '@brainstrike/a', task: 'build' },
        { command: 'vitest run', package: '@brainstrike/dependency', task: 'test' },
      ],
      version: '1',
    }),
    true
  );
  assert.equal(
    hasUnitTasks({
      tasks: [{ command: 'tsc -b', package: '@brainstrike/a', task: 'build' }],
      version: '1',
    }),
    false
  );
});

test('push and manual execution retain all rows and never invoke affected selection', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(
      selectUnitShards(matrix, event, () => assert.fail('unexpected preview')),
      matrix
    );
  }
});

test('a global change admits the complete matrix', () => {
  assert.deepEqual(
    selectUnitShards(matrix, 'pull_request', () => integrationOnly),
    matrix
  );
});

test('failed commands and malformed summaries cannot masquerade as empty success', () => {
  assert.throws(
    () =>
      selectUnitShards(matrix, 'pull_request', () => {
        throw new Error('Turbo failed');
      }),
    /Turbo failed/u
  );
  for (const summary of [
    null,
    {},
    { tasks: [], version: '2' },
    { tasks: null, version: '1' },
    { tasks: [{}], version: '1' },
    { tasks: [{ command: '', package: '@brainstrike/a', task: 'test' }], version: '1' },
  ]) {
    assert.throws(() => selectUnitShards(matrix, 'pull_request', () => summary), /Invalid/u);
  }
  // Validate the whole result even when an earlier node already has work.
  assert.throws(
    () => hasUnitTasks({ ...integrationOnly, tasks: [...integrationOnly.tasks, {}] }),
    /Invalid/u
  );
});

test('missing matrix, unknown events and unsupported filters fail closed', () => {
  assert.throws(() => selectUnitShards({ include: [] }, 'pull_request'), /Missing/u);
  assert.throws(() => selectUnitShards(matrix, 'unknown'), /Unsupported/u);
  assert.deepEqual(unitFilterArguments('--filter="@brainstrike/a" --filter="!@brainstrike/b"'), [
    '--filter=@brainstrike/a',
    '--filter=!@brainstrike/b',
  ]);
  for (const filter of ['', '--filter="*"', '--filter="@brainstrike/a";echo bad', '--force']) {
    assert.throws(() => unitFilterArguments(filter), /Missing|Unsupported/u);
  }
});
