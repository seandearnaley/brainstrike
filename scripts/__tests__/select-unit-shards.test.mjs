import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

test('direct node execution resolves the installed CLI without a Turbo binary on PATH', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'unit-selector-cli-'));
  t.after(() => rmSync(scratch, { force: true, recursive: true }));
  const output = join(scratch, 'github-output');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const row = { pr_filters: '--filter="@brainstrike/assistant-contract"', shard: 'contract' };
  const cleanPath = (process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .filter(
      (entry) => !['turbo', 'turbo.cmd', 'turbo.exe'].some((name) => existsSync(join(entry, name)))
    )
    .join(delimiter);
  const result = spawnSync(process.execPath, [resolve('scripts/select-unit-shards.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAINSTRIKE_TURBO_CACHE_DIR: join(scratch, 'cache'),
      GITHUB_OUTPUT: output,
      PATH: cleanPath,
      TURBO_CACHE_DIR: undefined,
      TURBO_HASH: undefined,
      TURBO_SCM_BASE: head,
      TURBO_SCM_HEAD: head,
      TURBO_TEAM: undefined,
      TURBO_TELEMETRY_DISABLED: '1',
      TURBO_TOKEN: undefined,
      UNIT_MATRIX: JSON.stringify({ include: [row] }),
      UNIT_SELECTION: 'affected',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = readFileSync(output, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const selected = JSON.parse(lines[0].slice('matrix='.length));
  assert.ok(Array.isArray(selected.include));
  assert.deepEqual(selected.include, selected.include.length === 0 ? [] : [row]);
  assert.equal(lines[1], `count=${selected.include.length}`);
});

test('integration-only work keeps every native shard and drops the empty partition', () => {
  const calls = [];
  const selected = selectUnitShards(matrix, 'affected', (filters) => {
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
    selectUnitShards(matrix, 'affected', () => placeholders),
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

test('affected selection without an exact base and head fails closed', () => {
  for (const [base, head] of [
    ['', 'HEAD'],
    ['HEAD', ''],
  ]) {
    const result = spawnSync(process.execPath, [resolve('scripts/select-unit-shards.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: join(tmpdir(), 'never-written'),
        TURBO_SCM_BASE: base,
        TURBO_SCM_HEAD: head,
        UNIT_MATRIX: JSON.stringify(matrix),
        UNIT_SELECTION: 'affected',
      },
    });
    assert.notEqual(result.status, 0, `base "${base}", head "${head}"`);
    assert.match(result.stderr, /Exact base and tested head are required/u);
  }
});

test('complete selection retains all rows and never invokes affected selection', () => {
  assert.equal(
    selectUnitShards(matrix, 'complete', () => assert.fail('unexpected preview')),
    matrix
  );
});

test('a global change admits the complete matrix', () => {
  assert.deepEqual(
    selectUnitShards(matrix, 'affected', () => integrationOnly),
    matrix
  );
});

test('failed commands and malformed summaries cannot masquerade as empty success', () => {
  assert.throws(
    () =>
      selectUnitShards(matrix, 'affected', () => {
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
    assert.throws(() => selectUnitShards(matrix, 'affected', () => summary), /Invalid/u);
  }
  // Validate the whole result even when an earlier node already has work.
  assert.throws(
    () => hasUnitTasks({ ...integrationOnly, tasks: [...integrationOnly.tasks, {}] }),
    /Invalid/u
  );
});

test('missing matrix, unknown selections and unsupported filters fail closed', () => {
  assert.throws(() => selectUnitShards({ include: [] }, 'affected'), /Missing/u);
  // An event name is not a selection: the workflow decides which runs are affected.
  for (const selection of ['unknown', 'pull_request', 'merge_group', 'push', undefined]) {
    assert.throws(() => selectUnitShards(matrix, selection), /Unsupported/u, String(selection));
  }
  assert.deepEqual(unitFilterArguments('--filter="@brainstrike/a" --filter="!@brainstrike/b"'), [
    '--filter=@brainstrike/a',
    '--filter=!@brainstrike/b',
  ]);
  for (const filter of ['', '--filter="*"', '--filter="@brainstrike/a";echo bad', '--force']) {
    assert.throws(() => unitFilterArguments(filter), /Missing|Unsupported/u);
  }
});
