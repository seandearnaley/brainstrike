import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readTurboConfig() {
  const configPath = path.join(repoRoot, 'turbo.jsonc');
  const typescript = require('typescript');
  const parsed = typescript.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));

  assert.equal(
    parsed.error,
    undefined,
    `Could not parse turbo.jsonc: ${parsed.error?.messageText ?? 'unknown parse error'}`
  );
  return parsed.config;
}

function turboDryRunFor(tasks) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [require.resolve('turbo/bin/turbo'), 'run', ...tasks, '--dry=json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_UPDATE_NOTIFIER: '1',
          TURBO_TELEMETRY_DISABLED: '1',
        },
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  );
}

let memoizedTurboDryRun;

function turboDryRun() {
  memoizedTurboDryRun ??= turboDryRunFor(['build', 'type-check', 'lint', 'test']);
  return memoizedTurboDryRun;
}

let memoizedDevDryRun;

function devDryRun() {
  memoizedDevDryRun ??= turboDryRunFor(['dev']);
  return memoizedDevDryRun;
}

function persistentTaskCount(plan) {
  return plan.tasks.filter(
    (task) => task.resolvedTaskDefinition?.persistent === true && task.command !== '<NONEXISTENT>'
  ).length;
}

/**
 * `turbo run dev` refuses to start when the configured concurrency is <= the
 * number of persistent tasks in the selection — every `dev` task holds its slot
 * forever, so the graph would deadlock. A `--dry` run does NOT enforce this, so
 * the only cheap guard is comparing the planned count against the config.
 */
function assertConcurrencyClearsPersistentFloor(configuredConcurrency, persistentTasks) {
  assert.match(
    String(configuredConcurrency),
    /^[1-9]\d*$/,
    'turbo.jsonc global.concurrency must be a positive integer string'
  );
  assert.ok(
    persistentTasks >= 30,
    `Turbo planned only ${persistentTasks} persistent dev task(s) (expected >= 30) — the dev sweep collapsed.`
  );
  assert.ok(
    Number(configuredConcurrency) > persistentTasks,
    `turbo.jsonc global.concurrency (${configuredConcurrency}) must exceed the ${persistentTasks} persistent dev tasks turbo plans, or \`pnpm dev\` fails to start ("You have ${persistentTasks} persistent tasks but \`turbo\` is configured for concurrency of ${configuredConcurrency}"). Raise it with headroom for the next few workspaces.`
  );
}

async function configuredGlobalFiles(config = readTurboConfig()) {
  assert.ok(
    Array.isArray(config.global?.inputs),
    'turbo.jsonc must expose the configured cross-package cache inputs at global.inputs'
  );

  const filesByPattern = await Promise.all(
    config.global.inputs.map(async (pattern) => {
      const matches = await glob(pattern, {
        cwd: repoRoot,
        dot: true,
        nodir: true,
      });
      assert.ok(
        matches.length > 0,
        `turbo.jsonc global.inputs entry "${pattern}" matches no file — an invisible cache input is not a contract.`
      );
      return matches;
    })
  );
  const files = [...new Set(filesByPattern.flat())];
  assert.ok(
    files.length >= 10,
    `Only ${files.length} file(s) matched turbo.jsonc global.inputs (expected >= 10) — the cache-input sweep collapsed.`
  );
  return files.map((file) => path.resolve(repoRoot, file)).sort();
}

function assertEveryTaskReceivesGlobalFiles(plan, expectedFiles) {
  assert.ok(
    plan.packages.length >= 47,
    `Turbo planned only ${plan.packages.length} package(s) (expected >= 47) — the package sweep collapsed.`
  );
  assert.ok(
    plan.tasks.length >= 230,
    `Turbo planned only ${plan.tasks.length} task(s) (expected >= 230) — the task sweep collapsed.`
  );

  const executableTasks = plan.tasks.filter((task) => task.command !== '<NONEXISTENT>');
  assert.ok(
    executableTasks.length >= 160,
    `Turbo planned only ${executableTasks.length} executable task(s) (expected >= 160) — the executable-task sweep collapsed.`
  );

  for (const task of executableTasks) {
    const taskDirectory = path.resolve(repoRoot, task.directory);
    const taskInputs = new Set(
      Object.keys(task.inputs).map((input) => path.resolve(taskDirectory, input))
    );
    const missingFiles = expectedFiles.filter((file) => !taskInputs.has(file));

    assert.deepEqual(
      missingFiles,
      [],
      `${task.taskId} is missing configured global input(s): ${missingFiles
        .map((file) => path.relative(repoRoot, file))
        .join(', ')}`
    );
  }
}

test('Turbo 2.10 applies every 3.0-style global input to every executable task', async () => {
  const expectedFiles = await configuredGlobalFiles();
  const plan = turboDryRun();
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pinnedTurboVersion = packageJson.devDependencies?.turbo;

  assert.equal(
    typeof pinnedTurboVersion,
    'string',
    'root package.json must declare a pinned Turbo devDependency'
  );

  assert.equal(
    plan.turboVersion,
    pinnedTurboVersion,
    `Turbo binary ${plan.turboVersion} does not match the root package.json pin ${pinnedTurboVersion}`
  );
  assertEveryTaskReceivesGlobalFiles(plan, expectedFiles);
});

test('global.concurrency stays above the persistent dev tasks turbo plans', () => {
  const config = readTurboConfig();
  assertConcurrencyClearsPersistentFloor(
    config.global?.concurrency,
    persistentTaskCount(devDryRun())
  );
});

test('money controls: unmatched config, a missing task input, and an empty task sweep fail visibly', async () => {
  const unmatchedInputConfig = structuredClone(readTurboConfig());
  unmatchedInputConfig.global.inputs.push(
    'scripts/__tests__/control-only-missing-global-input.mjs'
  );
  await assert.rejects(
    () => configuredGlobalFiles(unmatchedInputConfig),
    /global\.inputs entry "scripts\/__tests__\/control-only-missing-global-input\.mjs" matches no file/,
    'control failed: a configured pattern that matches nothing must make the guard red'
  );

  const expectedFiles = await configuredGlobalFiles();
  const plan = turboDryRun();
  const missingInputPlan = structuredClone(plan);
  const firstTask = missingInputPlan.tasks.find((task) => task.command !== '<NONEXISTENT>');
  assert.ok(firstTask, 'control setup failed: Turbo planned no executable task to mutate');
  const firstExpectedFile = expectedFiles[0];
  const firstTaskDirectory = path.resolve(repoRoot, firstTask.directory);
  const inputToDelete = Object.keys(firstTask.inputs).find(
    (input) => path.resolve(firstTaskDirectory, input) === firstExpectedFile
  );

  assert.ok(
    inputToDelete,
    'control setup failed: the real plan did not contain the input to delete'
  );
  Reflect.deleteProperty(firstTask.inputs, inputToDelete);
  assert.throws(
    () => assertEveryTaskReceivesGlobalFiles(missingInputPlan, expectedFiles),
    (error) =>
      error instanceof Error &&
      error.message.includes(`${firstTask.taskId} is missing configured global input`),
    'control failed: removing one global input from one task must make the guard red'
  );

  const emptyTaskPlan = structuredClone(plan);
  emptyTaskPlan.tasks = [];
  assert.throws(
    () => assertEveryTaskReceivesGlobalFiles(emptyTaskPlan, expectedFiles),
    /Turbo planned only 0 task\(s\).*task sweep collapsed/,
    'control failed: an empty Turbo task selection must make the guard red'
  );

  const plannedPersistentTasks = persistentTaskCount(devDryRun());
  assert.throws(
    () =>
      assertConcurrencyClearsPersistentFloor(
        String(plannedPersistentTasks),
        plannedPersistentTasks
      ),
    /must exceed the \d+ persistent dev tasks/,
    'control failed: concurrency equal to the persistent dev-task count must make the guard red'
  );
  assert.throws(
    () => assertConcurrencyClearsPersistentFloor('48', 0),
    /persistent dev task\(s\).*dev sweep collapsed/,
    'control failed: a collapsed dev sweep must make the guard red instead of passing vacuously'
  );
});
