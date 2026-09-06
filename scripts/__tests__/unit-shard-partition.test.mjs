import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseUnitShardMatrix, validateUnitShardPartition } from '../unit-shard-partition.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8');

test('the real unit-shard matrix is a valid partition', () => {
  const matrix = parseUnitShardMatrix(workflow);
  assert.deepEqual(matrix.map((s) => s.shard).sort(), [
    'db-1',
    'db-2',
    'desktop-1',
    'desktop-2',
    'desktop-3',
    'heavy',
    'rest',
  ]);
  assert.deepEqual([...new Set(matrix.map((s) => s.partition))].sort(), [
    'db',
    'desktop',
    'heavy',
    'rest',
  ]);
  assert.deepEqual(
    matrix.filter((s) => s.partition === 'db').map((s) => s.vitestShard),
    [
      { count: 2, index: 1 },
      { count: 2, index: 2 },
    ]
  );
  assert.deepEqual(
    matrix.filter((s) => s.partition === 'desktop').map((s) => s.vitestShard),
    [
      { count: 3, index: 1 },
      { count: 3, index: 2 },
      { count: 3, index: 3 },
    ]
  );
  assert.match(workflow, /DB_TEST_SHARD:.*matrix\.partition == 'db'/u);
  assert.equal(
    [...workflow.matchAll(/DESKTOP_TEST_SHARD:.*matrix\.partition == 'desktop'/gu)].length,
    4
  );
  assert.equal(
    [...workflow.matchAll(/DESKTOP_TEST_SHARD_REQUIRED:.*matrix\.partition == 'desktop'/gu)].length,
    4
  );
  assert.match(workflow, /pnpm turbo run test \$\{\{ matrix\.pr_filters \}\}/u);
  assert.equal(
    [...workflow.matchAll(/TURBO_SCM_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/gu)]
      .length,
    2
  );
  assert.equal([...workflow.matchAll(/TURBO_SCM_HEAD: \$\{\{ github\.sha \}\}/gu)].length, 2);
  assert.equal(
    [...workflow.matchAll(/matrix\.pr_filters \}\} --affected --concurrency=/gu)].length,
    2
  );
  assert.doesNotMatch(workflow, /matrix\.test_args|-- --shard=/u);
  const failures = validateUnitShardPartition(matrix);
  assert.deepEqual(
    failures,
    [],
    `unit-shard partition invariant violated:\n${failures.join('\n')}`
  );
});

test('rest negations equal the union of db+heavy positives (real workflow)', () => {
  const matrix = parseUnitShardMatrix(workflow);
  const rest = matrix.find((s) => s.shard === 'rest');
  const union = [...new Map(matrix.map((s) => [s.partition, s])).values()]
    .filter((s) => s.partition !== 'rest')
    .flatMap((s) => s.pr.positives)
    .sort();
  assert.deepEqual(rest.pr.negations, union);
});

// --- validator unit tests over synthetic drift cases ---

const shard = (name, positives, negations = [], options = {}) => ({
  partition: options.partition ?? name,
  pr: { negations: [...negations].sort(), positives: [...positives].sort() },
  push: { negations: [...negations].sort(), positives: [...positives].sort() },
  shard: name,
  vitestShard: options.vitestShard ?? null,
});

test('accepts a well-formed partition', () => {
  const matrix = [
    shard('db', ['db']),
    shard('heavy', ['desktop', 'ui']),
    shard('rest', [], ['db', 'desktop', 'ui']),
  ];
  assert.deepEqual(validateUnitShardPartition(matrix), []);
});

test('flags a package negated out of rest but owned by no shard (silent coverage loss)', () => {
  const matrix = [
    shard('db', ['db']),
    shard('heavy', ['desktop']),
    // `ui` is excluded from rest but never given a positive shard → UNTESTED.
    shard('rest', [], ['db', 'desktop', 'ui']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((f) => f.includes('UNTESTED') && f.includes('ui')),
    `expected an UNTESTED failure mentioning ui, got:\n${failures.join('\n')}`
  );
});

test('flags a positive package missing its rest negation (double-tested)', () => {
  const matrix = [
    shard('db', ['db']),
    shard('heavy', ['desktop', 'ui']),
    // `ui` is a positive but not negated from rest → runs in both heavy and rest.
    shard('rest', [], ['db', 'desktop']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((f) => f.includes('double-tested') && f.includes('ui')),
    `expected a double-tested failure mentioning ui, got:\n${failures.join('\n')}`
  );
});

test('flags a package owned positively by two shards', () => {
  const matrix = [
    shard('db', ['db', 'ui']),
    shard('heavy', ['desktop', 'ui']),
    shard('rest', [], ['db', 'desktop', 'ui']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((f) => f.includes('both') && f.includes('ui')),
    `expected a dual-ownership failure mentioning ui, got:\n${failures.join('\n')}`
  );
});

test('flags pr/push filter drift within a shard', () => {
  const matrix = [
    { ...shard('db', ['db']), push: { negations: [], positives: [] } },
    shard('heavy', ['desktop', 'ui']),
    shard('rest', [], ['db', 'desktop', 'ui']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((f) => f.includes('pr positives') && f.includes('push positives')),
    `expected a pr/push drift failure, got:\n${failures.join('\n')}`
  );
});

test('flags a missing native Vitest shard index', () => {
  const matrix = [
    shard('db-1', ['db'], [], {
      partition: 'db',
      vitestShard: { count: 2, index: 1 },
    }),
    shard('heavy', ['desktop']),
    shard('rest', [], ['db', 'desktop']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((failure) => failure.includes('exactly 1/2..2/2') && failure.includes('[1]')),
    `expected a missing native shard failure, got:\n${failures.join('\n')}`
  );
});

test('flags duplicate native Vitest shard indices', () => {
  const matrix = [
    shard('db-1', ['db'], [], {
      partition: 'db',
      vitestShard: { count: 2, index: 1 },
    }),
    shard('db-duplicate', ['db'], [], {
      partition: 'db',
      vitestShard: { count: 2, index: 1 },
    }),
    shard('heavy', ['desktop']),
    shard('rest', [], ['db', 'desktop']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((failure) => failure.includes('exactly 1/2..2/2') && failure.includes('[1,1]')),
    `expected a duplicate native shard failure, got:\n${failures.join('\n')}`
  );
});

test('flags native Vitest shard-count drift', () => {
  const matrix = [
    shard('db-1', ['db'], [], {
      partition: 'db',
      vitestShard: { count: 2, index: 1 },
    }),
    shard('db-2', ['db'], [], {
      partition: 'db',
      vitestShard: { count: 3, index: 2 },
    }),
    shard('heavy', ['desktop']),
    shard('rest', [], ['db', 'desktop']),
  ];
  const failures = validateUnitShardPartition(matrix);
  assert.ok(
    failures.some((failure) => failure.includes('inconsistent native shard counts [2,3]')),
    `expected native shard-count drift, got:\n${failures.join('\n')}`
  );
});

test('money test: malformed native shard environment value fails parsing loudly', () => {
  const mutated = workflow.replace('vitest_shard: 1/2', 'vitest_shard: shard-one');
  assert.notEqual(mutated, workflow, 'the control mutation must change the real workflow');
  assert.throws(() => parseUnitShardMatrix(mutated), /malformed vitest_shard "shard-one"/);
});
