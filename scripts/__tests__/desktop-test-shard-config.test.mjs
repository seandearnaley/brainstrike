import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createVitest, resolveConfig } from 'vitest/node';
import { resolveDesktopTestShard } from '../../apps/desktop/vitest.config.mts';
import { createDesktopUnitConfig } from '../../apps/desktop/vitest.unit.config.mts';

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

/** Files a desktop config selects, as `vitest list --filesOnly` resolves them, by project. */
async function selectDesktopFiles(options, viteConfig) {
  const vitest = await createVitest('test', { ...options, watch: false }, viteConfig);
  try {
    const specifications = await vitest.getRelevantTestSpecifications();
    return {
      files: specifications.map((specification) => specification.moduleId).sort(),
      projects: [...new Set(specifications.map((specification) => specification.project.name))]
        .filter(Boolean)
        .sort(),
    };
  } finally {
    await vitest.close();
  }
}

test('the desktop unit lane selects no integration file on any platform, CI or shard branch', async () => {
  const lane = (config) => selectDesktopFiles({ config: path.resolve('apps/desktop', config) });
  const full = await lane('vitest.config.mts');
  const integration = await lane('vitest.integration.config.mts');
  const isIntegration = (file) => file.includes('.integration.test.');
  assert.ok(integration.files.length > 60, 'the integration inventory must not be empty');
  assert.deepEqual(integration.files.filter(isIntegration), integration.files);
  // Coverage runs the base config: it keeps every integration file.
  const unitFiles = full.files.filter((file) => !isIntegration(file));
  assert.deepEqual(full.files.filter(isIntegration), integration.files);

  // Without the package script's CLI `--exclude`, which Vitest does not pass to
  // projects: the config alone must keep integration files out of every branch.
  for (const [branch, options, projects] of [
    [
      'Linux parallel',
      { cores: 16, environment: {}, platform: 'linux' },
      ['desktop', 'main-import'],
    ],
    [
      'macOS parallel',
      { cores: 16, environment: {}, platform: 'darwin' },
      ['desktop', 'main-import'],
    ],
    ['Linux CI', { environment: { CI: 'true' }, platform: 'linux' }, []],
    ['Linux shard', { environment: { DESKTOP_TEST_SHARD: '2/3' }, platform: 'linux' }, []],
    ['Windows', { environment: {}, platform: 'win32' }, ['desktop', 'main-boot']],
    ['Windows CI', { environment: { CI: 'true' }, platform: 'win32' }, ['desktop', 'main-boot']],
    [
      'Windows shard',
      { environment: { DESKTOP_TEST_SHARD: '2/3' }, platform: 'win32' },
      ['desktop', 'main-boot'],
    ],
  ]) {
    const selected = await selectDesktopFiles({ config: false }, createDesktopUnitConfig(options));
    assert.deepEqual(selected.projects, projects, `${branch} must build its own projects`);
    assert.deepEqual(
      selected.files.filter(isIntegration),
      [],
      `${branch} selected integration files`
    );
    assert.deepEqual(selected.files, unitFiles, `${branch} must select every unit file once`);
  }
});
