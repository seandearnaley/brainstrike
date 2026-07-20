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
  // Sanity: the three expected shards are present.
  assert.deepEqual(matrix.map((s) => s.shard).sort(), ['db', 'heavy', 'rest']);
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
  const union = matrix
    .filter((s) => s.shard !== 'rest')
    .flatMap((s) => s.pr.positives)
    .sort();
  assert.deepEqual(rest.pr.negations, union);
});

// --- validator unit tests over synthetic drift cases ---

const shard = (name, positives, negations = []) => ({
  pr: { negations: [...negations].sort(), positives: [...positives].sort() },
  push: { negations: [...negations].sort(), positives: [...positives].sort() },
  shard: name,
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
