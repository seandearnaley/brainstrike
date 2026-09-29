import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vitest/node';
import { resolveDbTestShard } from '../../packages/db/vitest.config.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function assertResolvedShard(config, expected) {
  assert.deepEqual(
    config.shard,
    expected,
    'the DB shard must resolve as a runner option; Vitest ignores shard inside an inline project'
  );
}

test('ordinary DB test invocations remain unsharded', () => {
  assert.equal(resolveDbTestShard({}), undefined);
});

test('the native DB task accepts the complete configured shard set', () => {
  for (const shard of ['1/2', '2/2']) {
    assert.equal(resolveDbTestShard({ DB_TEST_SHARD: shard }), shard);
  }
});

test('the DB config applies the shard at Vitest runner scope', async () => {
  const previousShard = process.env['DB_TEST_SHARD'];
  process.env['DB_TEST_SHARD'] = '1/2';
  try {
    const { test: vitestConfig } = await resolveConfig({
      config: path.join(repoRoot, 'packages/db/vitest.config.mts'),
    });
    assertResolvedShard(vitestConfig, { count: 2, index: 1 });

    assert.throws(
      () => assertResolvedShard({ ...vitestConfig, shard: undefined }, { count: 2, index: 1 }),
      /must resolve as a runner option/,
      'CONTROL: moving shard back into an inline project must turn the guard red'
    );
  } finally {
    if (previousShard === undefined) {
      Reflect.deleteProperty(process.env, 'DB_TEST_SHARD');
    } else {
      process.env['DB_TEST_SHARD'] = previousShard;
    }
  }
});

test('money test: a required shard never degrades to an unsharded run', () => {
  assert.throws(
    () => resolveDbTestShard({ DB_TEST_SHARD_REQUIRED: 'true' }),
    /DB_TEST_SHARD is required/
  );
  assert.throws(
    () =>
      resolveDbTestShard({
        DB_TEST_SHARD: 'first-of-two',
        DB_TEST_SHARD_REQUIRED: 'true',
      }),
    /must use Vitest's i\/N form/
  );
  assert.throws(
    () =>
      resolveDbTestShard({
        DB_TEST_SHARD: '3/2',
        DB_TEST_SHARD_REQUIRED: 'true',
      }),
    /index must not exceed its count/
  );
});
