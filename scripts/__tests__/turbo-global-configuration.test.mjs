import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSpawnInvocation } from '../spawn-command.mjs';

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

/** Every task the planned graph runs before `taskId`, direct or transitive. */
function scheduledBefore(graph, taskId) {
  const byId = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const task = byId.get(taskId);
  assert.ok(task, `${taskId} must exist in the actual Turbo graph`);
  const scheduled = new Set();
  const pending = [...task.dependencies];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!scheduled.has(id)) {
      scheduled.add(id);
      pending.push(...(byId.get(id)?.dependencies ?? []));
    }
  }
  return scheduled;
}

function assertScheduledBefore(graph, taskId, dependencies, reason) {
  const scheduled = scheduledBefore(graph, taskId);
  for (const dependency of dependencies) {
    assert.ok(scheduled.has(dependency), `${taskId} must build ${dependency} first: ${reason}`);
  }
}

test('agent emitted-export lanes build their own package and retain source hashing', () => {
  const graph = turboDryRunFor([
    'test:integration',
    'test:coverage',
    '--filter=@brainstrike/agent',
  ]);
  for (const taskId of [
    '@brainstrike/agent#test:integration',
    '@brainstrike/agent#test:coverage',
  ]) {
    const task = graph.tasks.find((entry) => entry.taskId === taskId);
    assert.ok(task, `${taskId} must exist in the actual Turbo graph`);
    for (const dependency of ['@brainstrike/agent#build', '@brainstrike/agent#topo']) {
      assert.ok(
        task.dependencies.includes(dependency),
        `${taskId} must depend on ${dependency} for its emitted exports and source hash`
      );
    }
  }
  const unit = turboDryRunFor(['test', '--filter=@brainstrike/agent']).tasks.find(
    (entry) => entry.taskId === '@brainstrike/agent#test'
  );
  assert.ok(unit, 'the source-only agent unit task must exist');
  assert.ok(unit.dependencies.includes('@brainstrike/agent#topo'));
  assert.ok(!unit.dependencies.includes('@brainstrike/agent#build'));
});

test('native desktop restart lanes schedule every public fixture dependency build before execution', () => {
  const graph = turboDryRunFor([
    'test:integration',
    'test:coverage',
    '--filter=@brainstrike/desktop',
  ]);
  for (const taskId of [
    '@brainstrike/desktop#test:integration',
    '@brainstrike/desktop#test:coverage',
  ]) {
    assertScheduledBefore(
      graph,
      taskId,
      [
        '@brainstrike/agent#build',
        '@brainstrike/assistant-data#build',
        '@brainstrike/assistant-service#build',
      ],
      "the native fixture's public exports"
    );
    // BST-2089: Electron launches dist/main.js with dist/renderer, the CLI
    // proofs spawn host-capabilities' emitted bin, and the MCP proofs start
    // the built lab. None of them reads source through Vitest's aliases.
    assertScheduledBefore(
      graph,
      taskId,
      [
        '@brainstrike/desktop#build',
        '@brainstrike/host-capabilities#build',
        '@brainstrike/mcp-test-lab#build',
      ],
      'the real-app, CLI and MCP proofs run built artifacts'
    );
    const task = graph.tasks.find((entry) => entry.taskId === taskId);
    assert.ok(
      task.dependencies.includes('@brainstrike/desktop#topo'),
      `${taskId} must retain the inherited source dependency cascade`
    );
  }
});

/** Packages with a Vitest config importing @brainstrike/build-utils, whose exports are dist only. */
async function packagesLoadingBuildUtilsInVitestConfig() {
  const found = new Set();
  for await (const config of glob('{apps,packages}/*/vitest*.config.{ts,mts}', { cwd: repoRoot })) {
    if (
      /from '@brainstrike\/build-utils'/u.test(readFileSync(path.join(repoRoot, config), 'utf8'))
    ) {
      found.add(path.dirname(config));
    }
  }
  return [...found].sort();
}

test('every test task that loads a build-utils Vitest config builds build-utils first', async () => {
  // BST-2079: Vite bundles the config and resolves the workspace import through
  // `exports`, so a clean checkout cannot even load these configs without dist.
  const packageDirs = await packagesLoadingBuildUtilsInVitestConfig();
  assert.ok(
    packageDirs.length >= 4,
    `expected the build-utils config readers, found ${packageDirs}`
  );
  const lanes = ['test', 'test:integration', 'test:coverage', 'test:browser'];
  const taskIds = [];
  const filters = [];
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
    filters.push(`--filter=${manifest.name}`);
    for (const lane of lanes.filter((name) => manifest.scripts?.[name])) {
      taskIds.push(`${manifest.name}#${lane}`);
    }
  }
  const graph = turboDryRunFor([...lanes, ...filters]);
  for (const taskId of taskIds) {
    assertScheduledBefore(
      graph,
      taskId,
      ['@brainstrike/build-utils#build'],
      'its config imports it'
    );
  }
  // The script tests load those same configs (pnpm test:scripts runs this root task).
  const scripts = turboDryRunFor(['test:scripts:run']);
  assertScheduledBefore(
    scripts,
    '//#test:scripts:run',
    ['@brainstrike/build-utils#build'],
    'the script tests load the build-utils Vitest configs'
  );
});

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

function readRootPackageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
}

function devScriptConcurrency(packageJson = readRootPackageJson()) {
  const devScript = packageJson.scripts?.dev;
  assert.equal(typeof devScript, 'string', 'root package.json must declare a dev script');
  const configured = /--concurrency=(\d+)/.exec(devScript);
  assert.ok(
    configured,
    `the root dev script must carry its own --concurrency (turbo.jsonc's global value is the build/test calibration, not a dev floor); got: ${devScript}`
  );
  return Number(configured[1]);
}

test('native global-input discovery preserves dotfile and files-only matching', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'turbo-global-input-glob-'));
  try {
    for (const directory of ['visible', '.hidden', 'visible/directory.json']) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const file of [
      'visible/config.json',
      'visible/.secret.json',
      '.hidden/config.json',
      '.hidden/.secret.json',
    ]) {
      writeFileSync(path.join(root, file), '{}');
    }

    assert.deepEqual(await matchingGlobalFiles('*/*.json', { cwd: root }), [
      '.hidden/.secret.json',
      '.hidden/config.json',
      'visible/.secret.json',
      'visible/config.json',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('native guard globs prune ignored directories and document POSIX output', () => {
  const guardPaths = [
    'scripts/assistant-run-id-producer-guard.mjs',
    'scripts/browser-events-literal-guard.mjs',
    'scripts/forbid-no-memo.mjs',
    'scripts/verify-mastra-schema-init-order.mjs',
  ];

  for (const guardPath of guardPaths) {
    const source = readFileSync(path.join(repoRoot, guardPath), 'utf8');
    const descendantOnlyPatterns = [...source.matchAll(/'([^']+)\/\*\*'/g)].map(
      (match) => match[1]
    );
    for (const directoryPattern of descendantOnlyPatterns) {
      assert.ok(
        source.includes(`'${directoryPattern}',`),
        `${guardPath} must exclude ${directoryPattern} itself so Node glob prunes the directory`
      );
    }
  }

  const noMemoSource = readFileSync(path.join(repoRoot, 'scripts/forbid-no-memo.mjs'), 'utf8');
  assert.match(
    noMemoSource,
    /Windows: Node glob returns platform-separated paths by default/,
    'the POSIX normalization must retain its Windows rationale'
  );
});

/**
 * `turbo run dev` refuses to start when concurrency is <= the number of
 * persistent tasks in the selection — every `dev` task holds its slot forever,
 * so the graph would deadlock. A `--dry` run does NOT enforce this, so the only
 * cheap guard is comparing the planned graph against the configured cap.
 *
 * The cap must also exceed the workspace's PACKAGE count, not merely today's
 * persistent-task count: turbo can never plan more `dev` tasks than there are
 * packages, so a cap above that can never bind, and the one-at-a-time bump
 * treadmill (28 → 29 → 30 → 31 → 32, then a dead `pnpm dev` at 40/40) cannot
 * come back. This goes red while `pnpm dev` still works — that is the point.
 */
function assertDevConcurrencyCannotBind(devConcurrency, plan) {
  const persistentTasks = persistentTaskCount(plan);
  const packageCount = plan.packages.length;
  assert.ok(
    persistentTasks >= 30,
    `Turbo planned only ${persistentTasks} persistent dev task(s) (expected >= 30) — the dev sweep collapsed.`
  );
  assert.ok(
    devConcurrency > persistentTasks,
    `The root dev script's --concurrency (${devConcurrency}) must exceed the ${persistentTasks} persistent dev tasks turbo plans, or \`pnpm dev\` fails to start ("You have ${persistentTasks} persistent tasks but \`turbo\` is configured for concurrency of ${devConcurrency}").`
  );
  assert.ok(
    devConcurrency > packageCount,
    `The root dev script's --concurrency (${devConcurrency}) must exceed the ${packageCount} workspace packages turbo plans over, so the cap can never bind — turbo cannot plan more dev tasks than there are packages. Raise it well clear of the package count rather than tracking the persistent-task count one bump at a time.`
  );
}

function includeDotMatches(pattern) {
  return pattern
    .split('/')
    .map((segment) =>
      segment.startsWith('.') || !/[*?[]/.test(segment) ? segment : `{${segment},.${segment}}`
    )
    .join('/');
}

async function matchingGlobalFiles(pattern, { cwd = repoRoot } = {}) {
  const entries = await Array.fromAsync(
    glob(includeDotMatches(pattern), { cwd, withFileTypes: true })
  );
  return [
    ...new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(cwd, path.join(entry.parentPath, entry.name)))
    ),
  ].sort();
}

async function configuredGlobalFiles(config = readTurboConfig()) {
  assert.ok(
    Array.isArray(config.global?.inputs),
    'turbo.jsonc must expose the configured cross-package cache inputs at global.inputs'
  );

  const filesByPattern = await Promise.all(
    config.global.inputs.map(async (pattern) => {
      // The former glob package used dot:true + nodir:true. Native glob has no
      // dot option, so make wildcard segments explicitly match dot-prefixed
      // names and filter Dirents to preserve the files-only contract.
      const matches = await matchingGlobalFiles(pattern);
      assert.ok(
        matches.length > 0,
        `turbo.jsonc global.inputs entry "${pattern}" matches no file — an invisible cache input is not a contract.`
      );
      return matches;
    })
  );
  const files = [...new Set(filesByPattern.flat())];
  assert.ok(
    // Formatting policy is task-local; the remaining eight files are global.
    files.length >= 8,
    `Only ${files.length} file(s) matched turbo.jsonc global.inputs (expected >= 8) — the cache-input sweep collapsed.`
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
  const packageJson = readRootPackageJson();
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
  // The $schema host encodes the same version a second time; without this,
  // editors silently validate turbo.jsonc against the previous release.
  assert.equal(
    readTurboConfig().$schema,
    `https://v${pinnedTurboVersion.replaceAll('.', '-')}.turborepo.dev/schema.json`,
    `turbo.jsonc $schema must track the pinned Turbo version ${pinnedTurboVersion}`
  );
  assertEveryTaskReceivesGlobalFiles(plan, expectedFiles);
});

test('the dev script caps concurrency above anything turbo can plan for it', () => {
  assertDevConcurrencyCannotBind(devScriptConcurrency(), devDryRun());
});

// The guard above is pure arithmetic over a planned graph; it assumes turbo
// enforces `concurrency > persistent tasks` at all. Neither `--dry` nor
// `--graph` exercises that check, and the real `dev` graph cannot be run here
// (it launches every watcher), so prove the RULE on a two-package fixture at
// the pinned binary. If a future turbo drops or changes the rule, this goes red
// instead of the arithmetic quietly guarding nothing.
/**
 * The lockfile's first document: pnpm's own locked resolution. With it, an
 * offline install in a fixture never has to resolve pnpm from a package mirror.
 */
function packageManagerLockDocument() {
  const [leading, document] = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8').split(
    /^---\n/mu
  );
  assert.equal(leading, '', 'pnpm-lock.yaml must open with its package-manager document');
  assert.match(document, /packageManagerDependencies:/u, 'the first document must lock pnpm');
  return `---\n${document}`;
}

test('MONEY TEST: turbo rejects concurrency equal to the persistent-task count', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'turbo-persistent-floor-'));
  try {
    // The fixture runs pnpm offline, so it pins and locks the repo's own pnpm.
    // A hosted runner caches no other pnpm and no mirror entry for this one:
    // an unlocked pin failed there to resolve pnpm (Test run 39059869809).
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'persistent-floor-fixture',
        packageManager: readRootPackageJson().packageManager,
        private: true,
      })
    );
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), packageManagerLockDocument());
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(
      path.join(dir, 'turbo.json'),
      JSON.stringify({ tasks: { dev: { cache: false, persistent: true } } })
    );
    for (const name of ['alpha', 'beta']) {
      mkdirSync(path.join(dir, 'packages', name), { recursive: true });
      writeFileSync(
        path.join(dir, 'packages', name, 'package.json'),
        JSON.stringify({
          name,
          private: true,
          scripts: { dev: 'node --version' },
          version: '0.0.0',
        })
      );
    }

    // Give the fixture the same installed dependency state required by pnpm run.
    for (const flags of [
      ['--lockfile-only', '--offline'],
      ['--frozen-lockfile', '--offline'],
    ]) {
      const invocation = createSpawnInvocation('pnpm', ['install', ...flags]);
      execFileSync(invocation.command, invocation.args, {
        cwd: dir,
        encoding: 'utf8',
        shell: invocation.shell,
      });
    }

    const runDev = (concurrency) =>
      spawnSync(
        process.execPath,
        [
          require.resolve('turbo/bin/turbo'),
          'run',
          'dev',
          '--skip-infer',
          `--concurrency=${concurrency}`,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, NO_UPDATE_NOTIFIER: '1', TURBO_TELEMETRY_DISABLED: '1' },
        }
      );

    const atFloor = runDev(2);
    assert.equal(atFloor.error, undefined, `could not spawn turbo: ${atFloor.error?.message}`);
    assert.notEqual(
      atFloor.status,
      0,
      `turbo must refuse 2 persistent tasks at concurrency 2; got ${atFloor.status}\n${atFloor.stdout}\n${atFloor.stderr}`
    );
    assert.match(
      `${atFloor.stdout}\n${atFloor.stderr}`,
      /persistent tasks/,
      'control failed: the rejection must name the persistent-task floor'
    );

    const aboveFloor = runDev(3);
    assert.equal(
      aboveFloor.status,
      0,
      `turbo must accept 2 persistent tasks at concurrency 3; got ${aboveFloor.status}\n${aboveFloor.stdout}\n${aboveFloor.stderr}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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

  const devPlan = devDryRun();
  const plannedPersistentTasks = persistentTaskCount(devPlan);
  assert.throws(
    () => assertDevConcurrencyCannotBind(plannedPersistentTasks, devPlan),
    /must exceed the \d+ persistent dev tasks/,
    'control failed: a dev cap equal to the persistent dev-task count must make the guard red'
  );
  // The gap between the two floors: a cap that clears today's persistent tasks
  // but not the package count is exactly the treadmill this guard retires.
  assert.throws(
    () => assertDevConcurrencyCannotBind(devPlan.packages.length, devPlan),
    /must exceed the \d+ workspace packages/,
    'control failed: a dev cap that merely clears today’s task count must make the guard red'
  );
  assert.throws(
    () => assertDevConcurrencyCannotBind(devScriptConcurrency(), { ...devPlan, tasks: [] }),
    /persistent dev task\(s\).*dev sweep collapsed/,
    'control failed: a collapsed dev sweep must make the guard red instead of passing vacuously'
  );
  assert.throws(
    () =>
      devScriptConcurrency({ scripts: { dev: 'node scripts/run-turbo-command.mjs -- run dev' } }),
    /must carry its own --concurrency/,
    'control failed: a dev script without its own cap must make the guard red'
  );
});
