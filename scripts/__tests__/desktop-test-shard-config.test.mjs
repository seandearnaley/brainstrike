import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { resolveConfig } from 'vitest/node';
import { resolveDesktopTestShard } from '../../apps/desktop/vitest.config.mts';

test('desktop native shards reject missing or malformed required configuration', () => {
  assert.equal(resolveDesktopTestShard({}), undefined);
  for (const value of ['', '0/3', '4/3', 'one/three', '1/0', '1/3junk']) {
    assert.throws(
      () =>
        resolveDesktopTestShard({
          DESKTOP_TEST_SHARD: value,
          DESKTOP_TEST_SHARD_REQUIRED: 'true',
        }),
      /DESKTOP_TEST_SHARD/
    );
  }
  for (const value of ['1/3', '2/3', '3/3']) {
    assert.equal(resolveDesktopTestShard({ DESKTOP_TEST_SHARD: value }), value);
  }
});

test('both desktop lanes resolve native sharding without changing file serialization', async () => {
  const previous = process.env.DESKTOP_TEST_SHARD;
  process.env.DESKTOP_TEST_SHARD = '2/3';
  try {
    for (const config of ['vitest.unit.config.mts', 'vitest.integration.config.mts']) {
      const { test: vitestConfig } = await resolveConfig({
        config: path.resolve('apps/desktop', config),
        fileParallelism: false,
        maxWorkers: 1,
        pool: 'forks',
      });
      assert.deepEqual(vitestConfig.shard, { count: 3, index: 2 });
      assert.equal(vitestConfig.maxWorkers, 1);
      assert.equal(vitestConfig.fileParallelism, false);
    }
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'DESKTOP_TEST_SHARD');
    } else {
      process.env.DESKTOP_TEST_SHARD = previous;
    }
  }
});

test('Turbo passes and hashes the desktop shard for both tasks', () => {
  const source = readFileSync('apps/desktop/turbo.json', 'utf8');
  const parsed = ts.parseConfigFileTextToJson('apps/desktop/turbo.json', source);
  assert.equal(parsed.error, undefined);
  for (const task of ['test', 'test:integration']) {
    const env = parsed.config.tasks[task]?.env;
    assert.ok(env, `${task} must define env`);
    for (const variable of [
      '$TURBO_EXTENDS$',
      'DESKTOP_TEST_SHARD',
      'DESKTOP_TEST_SHARD_REQUIRED',
    ]) {
      assert.ok(env.includes(variable), `${task} must preserve ${variable}`);
    }
  }
});

test('native desktop shards discover every real unit and integration file exactly once', async () => {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const root = path.resolve('apps/desktop');
  for (const lane of [
    { args: ['--exclude', '**/*.integration.test.*'], config: 'vitest.unit.config.mts' },
    { args: [], config: 'vitest.integration.config.mts' },
  ]) {
    const files = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'list', '--filesOnly', '--json', '--config', lane.config, ...lane.args],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    );
    const { test: vitestConfig } = await resolveConfig({
      config: path.join(root, lane.config),
      root,
    });
    const full = files.map((file) => file.file).sort();
    assert.ok(full.length > 60, 'the real desktop inventory must not be empty or truncated');
    const specs = full.map((moduleId) => ({ moduleId }));
    const combined = [];
    // list --filesOnly deliberately omits sharding. Use the runner's actual
    // configured sequencer (no copied hash/slicing implementation), with the
    // module identities discovered by the real CLI and resolved runner config.
    for (const index of [1, 2, 3]) {
      const sequencer = new vitestConfig.sequence.sequencer({
        config: { ...vitestConfig, shard: { count: 3, index } },
      });
      const shard = await sequencer.shard([...specs]);
      assert.ok(shard.length > 0 && shard.length < full.length);
      combined.push(...shard.map((spec) => spec.moduleId));
    }
    assert.equal(new Set(combined).size, combined.length, 'shards must never overlap');
    assert.deepEqual(combined.sort(), full, 'sharding must never orphan a test file');
  }
});
