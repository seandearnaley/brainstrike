import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createVitest, resolveConfig } from 'vitest/node';
import { electronPassEnvironment } from '../../apps/desktop/scripts/run-integration.mjs';
import {
  ELECTRON_RUNTIME_TESTS,
  resolveDesktopTestShard,
} from '../../apps/desktop/vitest.config.mts';
import { createDesktopUnitConfig } from '../../apps/desktop/vitest.unit.config.mts';
import { parseUnitShardMatrix } from '../unit-shard-partition.mjs';

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

test('an unsharded desktop lane (local runs, coverage) runs the whole Electron pass', () => {
  const environment = electronPassEnvironment({}, 'electron');
  assert.ok(environment, 'an unsharded lane must run the Electron pass');
  assert.equal(resolveDesktopTestShard(environment), undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
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

/** The native shard `config` resolves when its pass runs with `environment`'s shard variables. */
async function resolvePassShard(config, environment) {
  const variables = ['DESKTOP_TEST_SHARD', 'DESKTOP_TEST_SHARD_REQUIRED'];
  const previous = variables.map((variable) => process.env[variable]);
  for (const variable of variables) {
    if (environment[variable] === undefined) {
      Reflect.deleteProperty(process.env, variable);
    } else {
      process.env[variable] = environment[variable];
    }
  }
  try {
    return (await resolveConfig({ config })).test.shard;
  } finally {
    for (const [position, variable] of variables.entries()) {
      if (previous[position] === undefined) {
        Reflect.deleteProperty(process.env, variable);
      } else {
        process.env[variable] = previous[position];
      }
    }
  }
}

// BST-2134: the Electron pass inherited the lane's DESKTOP_TEST_SHARD, so all
// three desktop shards failed on Vitest's "Resolved 2 test files for
// --shard=i/3" and its two files ran in none. This walks every pass a desktop
// native shard runs, with the environment that pass actually gets.
test('every desktop pass runs each file in exactly one native shard, and a sharded pass never has fewer files than shards', async () => {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const root = path.resolve('apps/desktop');
  const shards = parseUnitShardMatrix(readFileSync('.github/workflows/test.yml', 'utf8'))
    .filter((row) => row.partition === 'desktop')
    .map(({ vitestShard }) => `${vitestShard.index}/${vitestShard.count}`);
  assert.ok(shards.length > 1, 'the workflow must shard the desktop partition');
  const listed = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, 'list', '--filesOnly', '--json', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    )
      .map((file) => file.file)
      .sort();
  const passes = [
    // The package `test` script.
    {
      config: 'vitest.unit.config.mts',
      environment: (lane) => lane,
      files: listed(['--config', 'vitest.unit.config.mts', '--exclude', '**/*.integration.test.*']),
      name: 'unit',
    },
    // scripts/run-integration.mjs's Node pass runs in the lane's environment.
    {
      config: 'vitest.integration.config.mts',
      environment: (lane) => lane,
      files: listed(['--config', 'vitest.integration.config.mts']),
      name: 'Node integration',
    },
    // Its Electron pass selects ELECTRON_RUNTIME_TESTS (the config's include
    // under Electron; Node runs exclude them, so `list` cannot see them here).
    {
      config: 'vitest.integration.config.mts',
      environment: (lane) => electronPassEnvironment(lane, 'electron'),
      files: ELECTRON_RUNTIME_TESTS.map((file) => path.join(root, file)).sort(),
      name: 'Electron integration',
    },
  ];
  const everyRun = [];
  for (const pass of passes) {
    assert.ok(pass.files.length > 0, `the ${pass.name} pass must select test files`);
    const { test: vitestConfig } = await resolveConfig({ config: path.join(root, pass.config) });
    const combined = [];
    for (const lane of shards) {
      const environment = pass.environment({
        DESKTOP_TEST_SHARD: lane,
        DESKTOP_TEST_SHARD_REQUIRED: 'true',
      });
      if (environment === undefined) {
        continue;
      }
      const shard = await resolvePassShard(path.join(root, pass.config), environment);
      if (shard === undefined) {
        combined.push(...pass.files);
        continue;
      }
      // Vitest refuses this before running anything (executeTests in its pool).
      assert.ok(
        pass.files.length >= shard.count,
        `the ${pass.name} pass resolves ${pass.files.length} test files for --shard=${shard.index}/${shard.count}`
      );
      // list --filesOnly omits sharding. Use the runner's configured sequencer
      // (no copied hash/slicing implementation) on the files the CLI found.
      const sequencer = new vitestConfig.sequence.sequencer({ config: { ...vitestConfig, shard } });
      const selected = await sequencer.shard(pass.files.map((moduleId) => ({ moduleId })));
      assert.ok(selected.length > 0, `the ${pass.name} pass runs nothing in shard ${lane}`);
      combined.push(...selected.map((spec) => spec.moduleId));
    }
    assert.equal(new Set(combined).size, combined.length, `${pass.name} shards must never overlap`);
    assert.deepEqual(combined.sort(), pass.files, `${pass.name} sharding must never orphan a file`);
    everyRun.push(...combined);
  }
  assert.ok(everyRun.length > 120, 'the real desktop inventory must not be empty or truncated');
  assert.equal(new Set(everyRun).size, everyRun.length, 'no file may run in two desktop passes');
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
