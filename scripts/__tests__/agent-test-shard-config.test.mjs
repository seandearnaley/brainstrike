import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vitest/node';
import { resolveAgentTestShard } from '../../packages/agent/vitest.config.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Turbo passes and hashes the Agent shard identity only for Agent tasks', () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, 'packages/agent/turbo.json'), 'utf8'));
  const expected = ['$TURBO_EXTENDS$', 'AGENT_TEST_SHARD', 'AGENT_TEST_SHARD_REQUIRED'];
  assert.deepEqual(config.tasks.test.env, expected);
  assert.deepEqual(config.tasks['test:integration'].env, expected);
});

test('ordinary Agent test invocations remain unsharded', () => {
  assert.equal(resolveAgentTestShard({}), undefined);
});

test('the native Agent task accepts the complete configured shard set', () => {
  for (const shard of ['1/2', '2/2']) {
    assert.equal(resolveAgentTestShard({ AGENT_TEST_SHARD: shard }), shard);
  }
});

test('both Agent phases apply the shard at Vitest runner scope', async () => {
  const previousShard = process.env['AGENT_TEST_SHARD'];
  process.env['AGENT_TEST_SHARD'] = '1/2';
  try {
    for (const config of ['vitest.config.mts', 'vitest.integration.config.mts']) {
      const { test: vitestConfig } = await resolveConfig({
        config: path.join(repoRoot, 'packages/agent', config),
      });
      assert.deepEqual(
        vitestConfig.shard,
        { count: 2, index: 1 },
        `${config} must resolve the Agent shard at runner scope`
      );
    }
  } finally {
    if (previousShard === undefined) {
      Reflect.deleteProperty(process.env, 'AGENT_TEST_SHARD');
    } else {
      process.env['AGENT_TEST_SHARD'] = previousShard;
    }
  }
});

test('money test: a required shard never degrades to an unsharded run', () => {
  assert.throws(
    () => resolveAgentTestShard({ AGENT_TEST_SHARD_REQUIRED: 'true' }),
    /AGENT_TEST_SHARD is required/
  );
  assert.throws(
    () =>
      resolveAgentTestShard({
        AGENT_TEST_SHARD: 'one-of-two',
        AGENT_TEST_SHARD_REQUIRED: 'true',
      }),
    /must use Vitest's i\/N form/
  );
  assert.throws(
    () =>
      resolveAgentTestShard({
        AGENT_TEST_SHARD: '3/2',
        AGENT_TEST_SHARD_REQUIRED: 'true',
      }),
    /index must not exceed its count/
  );
});
