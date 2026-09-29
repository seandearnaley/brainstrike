import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as turboCommand from '../run-turbo-command.mjs';
import {
  findModuleFiles,
  findPackageJsonFiles,
  packageScriptEntries,
  parseFilterList,
  workspaceDependencyClosure,
  workspaceManifestsByName,
} from './run-turbo-command-test-support.mjs';

const require = createRequire(import.meta.url);

function makeFakeHome() {
  return mkdtempSync(join(tmpdir(), 'run-turbo-command-home-'));
}

describe('run turbo command helper', () => {
  it('the package.json sweep skips transient .stryker-tmp fixtures', (t) => {
    // stryker-vitest-5-compatibility.test.mjs creates and deletes
    // .stryker-tmp/stryker-vitest-5-*/package.json while the sweeps in this
    // file walk the repo under default node --test concurrency. Listing the
    // fixture and then stat/reading it after removal is ENOENT; the sweep
    // must never descend into that scratch directory at all.
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'sweep-ignores-stryker-'));
    t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
    const workspacePackage = join(fixtureRoot, 'packages', 'real');
    const strykerFixture = join(fixtureRoot, '.stryker-tmp', 'stryker-vitest-5-abc');
    mkdirSync(workspacePackage, { recursive: true });
    mkdirSync(strykerFixture, { recursive: true });
    writeFileSync(join(workspacePackage, 'package.json'), '{"name":"@brainstrike/real"}');
    writeFileSync(join(strykerFixture, 'package.json'), '{"type":"module"}');

    assert.deepEqual(findPackageJsonFiles(fixtureRoot), [join(workspacePackage, 'package.json')]);
  });

  it('isolates and bounds default caches using Turbo effective cwd', (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'turbo-cache-scope-'));
    t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
    const laneA = join(fixtureRoot, 'lane-a');
    const laneB = join(fixtureRoot, 'lane-b');
    const longLane = join(fixtureRoot, 'w'.repeat(255));
    const laneAPackage = join(laneA, 'packages/output');
    for (const worktreeRoot of [laneA, laneB, longLane]) {
      mkdirSync(join(worktreeRoot, '.git'), { recursive: true });
    }
    mkdirSync(laneAPackage, { recursive: true });
    const options = { env: { HOME: '/Users/tester' }, platform: 'darwin' };
    const cacheFor = (cwd) => turboCommand.resolveTurboCacheDir({ ...options, cwd });
    const laneACache = cacheFor(laneA);
    const laneBCache = cacheFor(laneB);
    assert.equal(laneACache, cacheFor(laneAPackage));
    assert.notEqual(laneACache, laneBCache);
    assert.equal(resolve(laneACache, '..'), resolve(laneBCache, '..'));
    assert.ok(Buffer.byteLength(basename(cacheFor(longLane)), 'utf8') <= 255);
    assert.deepEqual(
      turboCommand.buildTurboArgs(['--cwd', laneA, 'run', 'build'], {
        ...options,
        cwd: fixtureRoot,
      }),
      ['--cwd', laneA, 'run', 'build', `--cache-dir=${laneACache}`]
    );
  });

  it('does not override an explicit turbo cache directory', () => {
    assert.equal(typeof turboCommand.buildTurboArgs, 'function');

    const args = turboCommand.buildTurboArgs(['run', 'build', '--cache-dir=.turbo'], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    });

    assert.deepEqual(args, ['run', 'build', '--cache-dir=.turbo']);
  });

  it('restores correct bytes when default-cache worktrees build concurrently', async (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'turbo-worktree-concurrency-'));
    const home = makeFakeHome();
    t.after(() => {
      rmSync(fixtureRoot, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    });
    const laneA = join(fixtureRoot, 'lane-a');
    const laneB = join(fixtureRoot, 'lane-b');
    const packageDir = join(laneA, 'packages/output');
    const wrapperPath = resolve(process.cwd(), 'scripts/run-turbo-command.mjs');
    const packageManager = `npm@${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`;

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(laneA, '.gitignore'), '**/.turbo/\nnode_modules/\n');
    writeFileSync(
      join(laneA, 'package.json'),
      `${JSON.stringify({ name: 'cache-concurrency-fixture', packageManager, private: true, workspaces: ['packages/*'] }, null, 2)}\n`
    );
    writeFileSync(
      join(laneA, 'package-lock.json'),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          name: 'cache-concurrency-fixture',
          packages: {
            '': { name: 'cache-concurrency-fixture', workspaces: ['packages/*'] },
            'packages/output': { name: 'fixture-output' },
          },
          requires: true,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      join(laneA, 'turbo.json'),
      `${JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } } }, null, 2)}\n`
    );
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({ name: 'fixture-output', private: true, scripts: { build: 'node build.mjs' } }, null, 2)}\n`
    );
    writeFileSync(join(packageDir, '.gitignore'), 'dist/\n');
    writeFileSync(
      join(packageDir, 'build.mjs'),
      [
        "import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';",
        "const lane = readFileSync(new URL('input.txt', import.meta.url), 'utf8').trim();",
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);',
        "mkdirSync(new URL('dist', import.meta.url), { recursive: true });",
        "const output = new URL('dist/index.d.ts', import.meta.url);",
        `writeFileSync(output, \`export const lane = "\${lane}";\\n\`);`,
        'const fixedTime = new Date(1_700_000_000_000);',
        'utimesSync(output, fixedTime, fixedTime);',
        '',
      ].join('\n')
    );
    writeFileSync(join(packageDir, 'input.txt'), 'AAAA\n');

    execFileSync('git', ['init', '--initial-branch=lane-a'], { cwd: laneA });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: laneA });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: laneA });
    execFileSync('git', ['add', '.'], { cwd: laneA });
    execFileSync('git', ['commit', '-m', 'lane A'], { cwd: laneA });
    execFileSync('git', ['worktree', 'add', '-b', 'lane-b', laneB], { cwd: laneA });
    writeFileSync(join(laneB, 'packages/output/input.txt'), 'BBBB\n');
    execFileSync('git', ['add', 'packages/output/input.txt'], { cwd: laneB });
    execFileSync('git', ['commit', '-m', 'lane B'], { cwd: laneB });

    const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
    const env = {
      ...process.env,
      HOME: home,
      NO_UPDATE_NOTIFIER: '1',
      PATH: `${resolve(process.cwd(), 'node_modules/.bin')}${delimiter}${inheritedPath}`,
      TURBO_TELEMETRY_DISABLED: '1',
    };
    // This regression owns the default local-cache boundary. Remote credentials
    // would let one fixture lane satisfy the other through an unrelated backend.
    env.BRAINSTRIKE_TURBO_CACHE_DIR = undefined;
    env.TURBO_CACHE_DIR = undefined;
    env.TURBO_HASH = undefined;
    env.TURBO_TEAM = undefined;
    env.TURBO_TOKEN = undefined;
    env.USERPROFILE = undefined;
    env.XDG_CACHE_HOME = undefined;

    const runBuild = (cwd) =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [wrapperPath, '--', 'run', 'build'], {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        child.once('error', rejectRun);
        child.once('close', (status) => resolveRun({ output, status }));
      });

    const primeResults = await Promise.all([runBuild(laneA), runBuild(laneB)]);
    assert.deepEqual(
      primeResults.map(({ status }) => status),
      [0, 0],
      primeResults.map(({ output }) => output).join('\n--- concurrent lane ---\n')
    );

    // The fixed mtime models two lanes finishing within one filesystem timestamp
    // interval; removing it makes the metadata collision nondeterministic.
    // Select lane B's hash in lane A while retaining lane A's stale
    // same-size/same-mtime output. With the old shared cache, Turbo 2.10's
    // metadata-only restore manifest reported a cache hit and retained AAAA.
    // The worktree-scoped cache must miss instead and produce the correct bytes.
    writeFileSync(join(laneA, 'packages/output/input.txt'), 'BBBB\n');
    const dryTask = (cwd) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [require.resolve('turbo/bin/turbo'), 'run', 'build', '--dry=json'],
          { cwd, encoding: 'utf8', env }
        )
      ).tasks[0];
    const laneATask = dryTask(laneA);
    const laneBTask = dryTask(laneB);
    assert.equal(
      laneATask.hash,
      laneBTask.hash,
      JSON.stringify({ laneA: laneATask, laneB: laneBTask }, null, 2)
    );
    const restoreResult = await runBuild(laneA);
    assert.equal(restoreResult.status, 0, restoreResult.output);
    assert.equal(
      readFileSync(join(laneA, 'packages/output/dist/index.d.ts'), 'utf8'),
      'export const lane = "BBBB";\n',
      `lane A retained stale bytes from its previous hash:\n${restoreResult.output}`
    );

    rmSync(join(laneA, 'packages/output/dist'), { force: true, recursive: true });
    const sameWorktreeHit = await runBuild(laneA);
    assert.equal(sameWorktreeHit.status, 0, sameWorktreeHit.output);
    assert.match(sameWorktreeHit.output, /cache hit/u, sameWorktreeHit.output);
    assert.equal(
      readFileSync(join(laneA, 'packages/output/dist/index.d.ts'), 'utf8'),
      'export const lane = "BBBB";\n'
    );
  });

  it('routes workspace turbo scripts through the bounded wrapper', () => {
    const directTurboScripts = findPackageJsonFiles(process.cwd()).flatMap((packageJsonPath) => {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return Object.entries(packageJson.scripts ?? {})
        .filter(([, command]) =>
          /\b(?:pnpm\s+)?turbo\s+(?:run\s+)?(?:build|test|type-check|dev|clean)\b/u.test(command)
        )
        .map(([name]) => `${packageJsonPath}:${name}`);
    });

    assert.deepEqual(directTurboScripts, []);
  });

  it('serializes root build-producing graphs on Windows', () => {
    const rootManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

    for (const scriptName of ['build', 'type-check']) {
      assert.match(
        rootManifest.scripts[scriptName],
        /^node scripts\/run-turbo-command\.mjs --windows-concurrency=1 -- run\b/u,
        `${scriptName} can schedule both native addon builds, which must not link concurrently on Windows`
      );
    }
  });

  it('applies requested Windows concurrency only on Windows', () => {
    const run = (platform) => {
      let spawnedCommand;
      const status = turboCommand.runTurboCommand(
        [
          'node',
          'run-turbo-command.mjs',
          '--windows-concurrency=1',
          '--',
          'run',
          'build',
          '--concurrency=8',
        ],
        platform,
        {
          env: { HOME: makeFakeHome() },
          logError: () => {},
          spawnSyncImpl: (command, args) => {
            spawnedCommand = [command, ...args].join(' ');
            return { status: 0 };
          },
        }
      );
      assert.equal(status, 0);
      return spawnedCommand;
    };

    assert.ok(run('win32').includes('--concurrency=1'));
    assert.ok(run('darwin').includes('--concurrency=8'));
  });

  it('routes automation-script turbo spawns through the bounded wrapper', () => {
    // The package.json sweep above cannot see turbo spawns buried inside .mjs
    // helpers (e.g. spawnSync('pnpm', ['turbo', ...])), which resolve the
    // repo-local .turbo cache instead of the wrapper's shared cache dir. Only
    // run-turbo-command.mjs may name the turbo binary.
    //
    // One bounded exception: scripts/turbo-boundaries.mjs. `turbo boundaries`
    // is an analysis subcommand, not a task run — it schedules nothing, reads
    // and writes no cache, and takes no --cache-dir (the flag run-turbo-command
    // exists to inject), so the shared-cache rationale does not reach it. The
    // exemption is held to that: it may name the binary, never to run a task.
    const wrapperPath = resolve(process.cwd(), 'scripts/run-turbo-command.mjs');
    const boundariesGatePath = resolve(process.cwd(), 'scripts/turbo-boundaries.mjs');
    const directTurboSpawns = findModuleFiles(process.cwd()).filter(
      (modulePath) =>
        modulePath !== wrapperPath &&
        modulePath !== boundariesGatePath &&
        /['"`]turbo['"`]/u.test(readFileSync(modulePath, 'utf8'))
    );

    assert.deepEqual(directTurboSpawns, []);

    assert.ok(existsSync(boundariesGatePath), 'the exempted gate script must still exist');
    // Scoped to the spawn's ARGUMENT LIST, not the file text: that header
    // backticks identifiers constantly to explain turbo behaviour, and a line
    // like "`clean` removes them" would otherwise fail this guard with a
    // message claiming the script runs a cached task. Asserting the match
    // exists first keeps the narrowing from going vacuous if the spawn moves.
    const gateSource = readFileSync(boundariesGatePath, 'utf8');
    const spawnArgs = gateSource.match(/spawnSync\(\s*process\.execPath,\s*\[([^\]]*)\]/u);
    assert.ok(
      spawnArgs,
      'expected scripts/turbo-boundaries.mjs to spawn turbo via process.execPath with a literal argument list'
    );
    assert.doesNotMatch(
      spawnArgs[1],
      /['"`](?:run|build|test|type-check|dev|clean)['"`]/u,
      'scripts/turbo-boundaries.mjs may spawn `turbo boundaries` only — a cache-bearing task run must go through run-turbo-command.mjs'
    );
  });

  it('plans oldest cache entries for pruning until the cache is under the byte cap', () => {
    assert.equal(typeof turboCommand.planTurboCachePrune, 'function');

    const deletions = turboCommand.planTurboCachePrune(
      [
        { mtimeMs: 100, path: '/cache/a.tar.zst', size: 60 },
        { mtimeMs: 50, path: '/cache/b.tar.zst', size: 40 },
        { mtimeMs: 75, path: '/cache/c.tar.zst', size: 30 },
      ],
      80
    );

    assert.deepEqual(deletions, ['/cache/b.tar.zst', '/cache/c.tar.zst']);
  });

  it('resolves relative cache directories from the repository root', () => {
    assert.equal(typeof turboCommand.getCacheDirFromArgs, 'function');

    assert.equal(
      turboCommand.getCacheDirFromArgs(['run', 'build', '--cache-dir=.turbo'], '/repo'),
      resolve('/repo/.turbo')
    );
    assert.equal(
      turboCommand.getCacheDirFromArgs(['run', 'build', '--cache-dir', '.turbo'], '/repo'),
      resolve('/repo/.turbo')
    );
  });

  it('skips cache entries that disappear during pruning walks', () => {
    assert.equal(typeof turboCommand.collectCacheFiles, 'function');
    const gone = Object.assign(new Error('entry disappeared'), { code: 'ENOENT' });
    const fakeFileSystem = {
      existsSync: () => true,
      lstatSync: () => {
        throw gone;
      },
      readdirSync: () => [{ name: 'gone.tar.zst' }],
    };

    assert.deepEqual(turboCommand.collectCacheFiles('/cache', { fs: fakeFileSystem }), []);
  });

  it('skips the nested turbo invocation when --skip-under-turbo runs inside an outer turbo task', () => {
    const logs = [];
    const errors = [];
    const spawnCalls = [];

    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-turbo', '--', 'run', 'build'],
      'darwin',
      {
        env: { HOME: makeFakeHome(), TURBO_HASH: '649b8853e23bc395' },
        log: (message) => logs.push(message),
        logError: (message) => errors.push(message),
        spawnSyncImpl: (command, args) => {
          spawnCalls.push({ args, command });
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /TURBO_HASH/u);
    assert.match(logs[0], /--skip-under-turbo/u);
  });

  it('proceeds normally when --skip-under-turbo is passed outside a turbo task', () => {
    const logs = [];
    const spawnCalls = [];

    // TURBO_HASH is unset, so the wrapper must NOT skip: turbo is spawned
    // exactly once with the original run arguments.
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-turbo', '--', 'run', 'build'],
      'darwin',
      {
        env: { HOME: makeFakeHome() },
        log: (message) => logs.push(message),
        logError: () => {},
        spawnSyncImpl: (command, args) => {
          spawnCalls.push({ args, command });
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(logs, []);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args.slice(0, 2), ['run', 'build']);
  });

  it('skips prepared dev dependency builds only with the explicit root marker', () => {
    const logs = [];
    const spawnCalls = [];
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-prepared-dev', '--', 'run', 'build'],
      'darwin',
      {
        env: {
          BRAINSTRIKE_DEV_DEPS_PREPARED: '1',
          HOME: makeFakeHome(),
          TURBO_HASH: '649b8853e23bc395',
        },
        log: (message) => logs.push(message),
        logError: () => {},
        spawnSyncImpl: (...args) => {
          spawnCalls.push(args);
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(spawnCalls, []);
    assert.match(logs[0], /BRAINSTRIKE_DEV_DEPS_PREPARED/u);
  });

  it('fails loudly when direct turbo dev bypasses root dependency preparation', () => {
    const errors = [];
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-prepared-dev', '--', 'run', 'build'],
      'darwin',
      {
        env: { HOME: makeFakeHome(), TURBO_HASH: '649b8853e23bc395' },
        log: () => {},
        logError: (message) => errors.push(message),
        spawnSyncImpl: () => {
          throw new Error('must not start a racy nested build');
        },
      }
    );

    assert.equal(status, 1);
    assert.match(errors[0], /pnpm dev/u);
  });

  it('marks the spawned root dev graph after synchronous preparation', () => {
    const spawnCalls = [];
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--mark-dev-deps-prepared', '--', 'run', 'dev'],
      'darwin',
      {
        env: { HOME: makeFakeHome() },
        log: () => {},
        logError: () => {},
        spawnSyncImpl: (_command, _args, options) => {
          spawnCalls.push(options.env);
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.equal(spawnCalls[0].BRAINSTRIKE_DEV_DEPS_PREPARED, '1');
  });

  it('does not skip when TURBO_HASH is set but --skip-under-turbo is absent', () => {
    const logs = [];
    const spawnCalls = [];

    // Without either opt-in flag the wrapper must run turbo even under an outer
    // task. Prepared dev hooks use their distinct fail-closed option; this path
    // remains available to other nested commands that genuinely need to run.
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--', 'run', 'build'],
      'darwin',
      {
        env: { HOME: makeFakeHome(), TURBO_HASH: '649b8853e23bc395' },
        log: (message) => logs.push(message),
        logError: () => {},
        spawnSyncImpl: (command, args) => {
          spawnCalls.push({ args, command });
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(logs, []);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args.slice(0, 2), ['run', 'build']);
  });

  it('treats cache pruning errors as non-fatal housekeeping warnings', () => {
    assert.equal(typeof turboCommand.pruneTurboCache, 'function');
    const warnings = [];

    assert.doesNotThrow(() => {
      turboCommand.pruneTurboCache(
        '/cache',
        { BRAINSTRIKE_TURBO_CACHE_MAX_BYTES: 'not-a-number' },
        { warn: (message) => warnings.push(message) }
      );
    });

    assert.deepEqual(warnings, [
      'Skipped Turborepo cache pruning: BRAINSTRIKE_TURBO_CACHE_MAX_BYTES must be a positive integer byte count.',
    ]);
  });
});

describe('nested turbo run lock', () => {
  // Sharing one cache dir makes concurrent nested runs CONSISTENT, not
  // SERIALIZED: turbo has no cross-process execution lock, so on a cold cache
  // the web and desktop predev builds can both miss the same task hash and
  // both execute it (rimraf dist under a live reader). The wrapper therefore
  // takes an exclusive lock for nested invocations. Root invocations must
  // never take it — the root `pnpm dev` would hold the lock while its own
  // nested predev children wait on it forever.
  it('holds the cache-dir lock while spawning a nested invocation and releases it after', () => {
    const home = makeFakeHome();
    const lockDir = join(
      turboCommand.resolveTurboCacheDir({ env: { HOME: home }, platform: 'darwin' }),
      'nested-turbo-run.lock'
    );
    const lockSeenDuringSpawn = [];

    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--', 'run', 'desktop-dev-dependencies'],
      'darwin',
      {
        env: { HOME: home, TURBO_HASH: '649b8853e23bc395' },
        log: () => {},
        logError: () => {},
        spawnSyncImpl: () => {
          lockSeenDuringSpawn.push(existsSync(lockDir));
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(lockSeenDuringSpawn, [true]);
    assert.equal(existsSync(lockDir), false);
  });

  it('releases the lock even when the nested invocation fails', () => {
    const home = makeFakeHome();
    const lockDir = join(
      turboCommand.resolveTurboCacheDir({ env: { HOME: home }, platform: 'darwin' }),
      'nested-turbo-run.lock'
    );

    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--', 'run', 'desktop-dev-dependencies'],
      'darwin',
      {
        env: { HOME: home, TURBO_HASH: '649b8853e23bc395' },
        log: () => {},
        logError: () => {},
        spawnSyncImpl: () => ({ status: 3 }),
      }
    );

    assert.equal(status, 3);
    assert.equal(existsSync(lockDir), false);
  });

  it('does not take the lock for root invocations', () => {
    const home = makeFakeHome();
    const lockDir = join(
      turboCommand.resolveTurboCacheDir({ env: { HOME: home }, platform: 'darwin' }),
      'nested-turbo-run.lock'
    );
    const lockSeenDuringSpawn = [];

    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--', 'run', 'build'],
      'darwin',
      {
        env: { HOME: home },
        log: () => {},
        logError: () => {},
        spawnSyncImpl: () => {
          lockSeenDuringSpawn.push(existsSync(lockDir));
          return { status: 0 };
        },
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(lockSeenDuringSpawn, [false]);
  });

  it('waits for a live holder and acquires once the holder releases', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nested-run-lock-'));
    const lockDir = join(cacheDir, 'nested-turbo-run.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    const sleeps = [];

    const release = turboCommand.acquireNestedTurboRunLock(cacheDir, {
      log: () => {},
      sleep: (ms) => {
        sleeps.push(ms);
        rmSync(lockDir, { force: true, recursive: true });
      },
    });

    assert.equal(sleeps.length, 1);
    assert.equal(existsSync(lockDir), true);
    release();
    assert.equal(existsSync(lockDir), false);
  });

  it('steals a lock left behind by a dead holder without sleeping', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nested-run-lock-'));
    const lockDir = join(cacheDir, 'nested-turbo-run.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '99999');
    const logs = [];

    const release = turboCommand.acquireNestedTurboRunLock(cacheDir, {
      isProcessAlive: () => false,
      log: (message) => logs.push(message),
      sleep: () => {
        throw new Error('must not sleep when the holder is dead');
      },
    });

    assert.equal(existsSync(join(lockDir, 'pid')), true);
    assert.equal(readFileSync(join(lockDir, 'pid'), 'utf8'), String(process.pid));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /stale/u);
    release();
  });

  it('fails loudly instead of waiting forever on a wedged holder', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nested-run-lock-'));
    const lockDir = join(cacheDir, 'nested-turbo-run.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));

    assert.throws(
      () =>
        turboCommand.acquireNestedTurboRunLock(cacheDir, {
          log: () => {},
          pollMs: 100,
          sleep: () => {},
          timeoutMs: 300,
        }),
      /Timed out/u
    );
  });

  it('reports live processes as alive and reaped processes as dead', () => {
    assert.equal(turboCommand.isProcessAlive(process.pid), true);

    const reaped = spawnSync(process.execPath, ['-e', '']);
    assert.equal(reaped.status, 0);
    assert.equal(turboCommand.isProcessAlive(reaped.pid), false);
  });
});

describe('nested prebuild turbo contract', () => {
  // Context: app `build` scripts have a `prebuild` that re-enters turbo via
  // run-turbo-command.mjs so DIRECT `pnpm --filter <app> build` invocations get
  // their workspace deps built. When the app builds UNDER an outer turbo run,
  // that nested invocation is redundant (the `build` task's `dependsOn:
  // ["^build"]` already built every dep) and races the outer run: the nested
  // turbo uses the GLOBAL cache while the outer run may use the repo-local one,
  // so the same task hash can be a hit outside and a miss inside — and the
  // nested execution's `rimraf dist` deletes freshly-written outputs while
  // sibling tasks (e.g. web's vite config-load) are importing them. Hence:
  // prebuild passes --skip-under-turbo, and these tests pin the conditions
  // that make the skip sound.
  const wrapperScripts = packageScriptEntries().filter(({ command }) =>
    command.includes('run-turbo-command.mjs')
  );

  it('every prebuild that re-enters turbo opts into --skip-under-turbo', () => {
    const prebuilds = wrapperScripts.filter(({ scriptName }) => scriptName === 'prebuild');
    assert.ok(prebuilds.length > 0, 'expected at least one prebuild using run-turbo-command.mjs');

    for (const { command, packageJsonPath } of prebuilds) {
      assert.ok(
        command.includes('--skip-under-turbo'),
        `${packageJsonPath} prebuild must pass --skip-under-turbo (nested turbo races the outer graph)`
      );
    }
  });

  it('every predev that re-enters turbo opts into --skip-under-prepared-dev', () => {
    const predevs = wrapperScripts.filter(({ scriptName }) => scriptName === 'predev');
    assert.ok(predevs.length > 0, 'expected at least one predev using run-turbo-command.mjs');

    for (const { command, packageJsonPath } of predevs) {
      assert.ok(
        command.includes('--skip-under-prepared-dev'),
        `${packageJsonPath} predev must pass --skip-under-prepared-dev (nested turbo races the outer watcher graph)`
      );
    }
  });

  it('restricts --skip-under-turbo to sound lifecycle boundaries', () => {
    // Only prebuilds may use the ^build-backed flag. Prepared dev hooks use a
    // separate explicit-marker flag so TURBO_HASH alone cannot authorize them.
    const offenders = packageScriptEntries()
      .filter(
        ({ command, scriptName }) =>
          command.includes('--skip-under-turbo') && scriptName !== 'prebuild'
      )
      .map(({ packageJsonPath, scriptName }) => `${packageJsonPath}:${scriptName}`);

    assert.deepEqual(offenders, []);
  });

  it('restricts prepared-dev marker flags to their lifecycle owners', () => {
    const preparedSkipOffenders = packageScriptEntries()
      .filter(
        ({ command, scriptName }) =>
          command.includes('--skip-under-prepared-dev') && scriptName !== 'predev'
      )
      .map(({ packageJsonPath, scriptName }) => `${packageJsonPath}:${scriptName}`);
    assert.deepEqual(preparedSkipOffenders, []);

    const markerOwners = packageScriptEntries()
      .filter(({ command }) => command.includes('--mark-dev-deps-prepared'))
      .map(({ packageJsonPath, scriptName }) => ({ packageJsonPath, scriptName }));
    assert.deepEqual(markerOwners, [
      { packageJsonPath: resolve(process.cwd(), 'package.json'), scriptName: 'dev' },
    ]);

    assert.match(
      readFileSync(resolve(process.cwd(), 'scripts/ensure-desktop-dev-deps.mjs'), 'utf8'),
      /'--skip-under-prepared-dev'/u,
      'desktop predev preparation must use the explicit prepared-graph skip flag'
    );

    const wrapperPath = resolve(process.cwd(), 'scripts/run-turbo-command.mjs');
    const desktopHelperPath = resolve(process.cwd(), 'scripts/ensure-desktop-dev-deps.mjs');
    const automationModules = findModuleFiles(process.cwd()).filter(
      (modulePath) => modulePath !== wrapperPath
    );
    assert.deepEqual(
      automationModules.filter((modulePath) =>
        readFileSync(modulePath, 'utf8').includes('--mark-dev-deps-prepared')
      ),
      [],
      'automation helpers must not mint the root preparation marker'
    );
    assert.deepEqual(
      automationModules
        .filter((modulePath) =>
          readFileSync(modulePath, 'utf8').includes('--skip-under-prepared-dev')
        )
        .sort(),
      [desktopHelperPath],
      'only the desktop predev helper may use the prepared-graph skip flag outside package scripts'
    );
  });

  it('prebuild filter lists stay within the outer ^build graph (workspace dep closure)', () => {
    // The skip is only sound because the outer `build` task's ^build already
    // builds every filtered package. A filter outside the app's transitive
    // workspace dependency closure would be built ONLY by the nested run — and
    // silently never built once the nested run skips under turbo.
    const manifests = workspaceManifestsByName();

    for (const { command, packageJsonPath } of wrapperScripts.filter(
      ({ scriptName }) => scriptName === 'prebuild'
    )) {
      const appManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const closure = workspaceDependencyClosure(appManifest, manifests);
      const filters = parseFilterList(command);
      // Non-vacuity guard: parseFilterList only matches the `--filter=<pkg>`
      // form. A prebuild written in the space-separated form would parse to []
      // and slip past this test unchecked.
      assert.ok(
        filters.length > 0,
        `${packageJsonPath} prebuild: no --filter=<pkg> parsed — use the '=' form so this contract stays enforced`
      );
      for (const filter of filters) {
        assert.ok(
          closure.has(filter),
          `${packageJsonPath} prebuild filters ${filter}, which is outside ${appManifest.name}'s workspace dependency closure — the outer turbo graph would never build it once prebuild skips under turbo`
        );
      }
    }
  });

  it("turbo's resolved build graph covers every skip-flagged prebuild filter", () => {
    // The other half of the skip's soundness, pinned at the RESOLVED level:
    // the outer `<app>#build` task graph must actually schedule a build for
    // every package the (now-skipped) nested prebuild would have built. Asking
    // turbo itself via --dry=json covers everything the package.json closure
    // test cannot: root turbo.jsonc `build.dependsOn` losing "^build", an
    // app-level turbo.json override dropping the edge, or any future extends
    // semantics change. If any of those happen, the filtered package vanishes
    // from the dry-run task list and this fails loudly.
    for (const { command, packageJsonPath } of wrapperScripts.filter(
      ({ scriptName }) => scriptName === 'prebuild'
    )) {
      if (!command.includes('--skip-under-turbo')) {
        continue;
      }
      const appName = JSON.parse(readFileSync(packageJsonPath, 'utf8')).name;
      const dryRun = JSON.parse(
        execFileSync(
          process.execPath,
          // Node 24 rejects Windows batch shims passed to execFileSync, so
          // execute Turbo's package-resolved JavaScript entrypoint through
          // Node itself (same pattern as the canonical-form contract test).
          [require.resolve('turbo/bin/turbo'), 'run', 'build', `--filter=${appName}`, '--dry=json'],
          {
            cwd: process.cwd(),
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
      const scheduledBuilds = new Set(
        dryRun.tasks
          .filter((task) => task.task === 'build' && task.command !== '<NONEXISTENT>')
          .map((task) => task.package)
      );
      for (const filter of parseFilterList(command)) {
        assert.ok(
          scheduledBuilds.has(filter),
          `${appName}'s resolved build graph no longer schedules ${filter}#build — the --skip-under-turbo prebuild would leave it unbuilt (check turbo.jsonc build.dependsOn / app turbo.json overrides)`
        );
      }
    }
  });

  it('builds all app dev dependencies before the outer watcher graph starts', () => {
    const rootManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const desktopManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps/desktop/package.json'), 'utf8')
    );
    const webManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps/web/package.json'), 'utf8')
    );
    const rootPredev = rootManifest.scripts.predev;
    const webPrebuild = webManifest.scripts.prebuild;
    const webPredev = webManifest.scripts.predev;

    assert.match(
      rootManifest.scripts.dev,
      /^node scripts\/run-turbo-command\.mjs --mark-dev-deps-prepared -- run dev\b/u
    );
    assert.equal(
      rootPredev,
      'node scripts/ensure-desktop-dev-deps.mjs',
      'root predev must complete the full desktop dependency graph before turbo launches persistent watchers'
    );
    assert.equal(desktopManifest.scripts.predev, 'node ../../scripts/ensure-desktop-dev-deps.mjs');
    assert.match(
      webPredev,
      /^node \.\.\/\.\.\/scripts\/run-turbo-command\.mjs --skip-under-prepared-dev -- run build(?: --filter=@brainstrike\/[\w-]+)+$/u,
      'standalone web dev must build dependencies, while the root turbo graph must skip its nested build'
    );
    const devDryRun = JSON.parse(
      execFileSync(
        process.execPath,
        [
          require.resolve('turbo/bin/turbo'),
          'run',
          'dev',
          '--filter=@brainstrike/web',
          '--filter=@brainstrike/desktop',
          '--dry=json',
        ],
        {
          cwd: process.cwd(),
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
    for (const appName of ['@brainstrike/web', '@brainstrike/desktop']) {
      const appDevTask = devDryRun.tasks.find(
        (task) => task.task === 'dev' && task.package === appName
      );
      assert.ok(appDevTask, `expected ${appName}#dev in the resolved dev graph`);
      assert.ok(
        (appDevTask.environmentVariables.specified.passThroughEnv ?? []).includes(
          'BRAINSTRIKE_DEV_DEPS_PREPARED'
        ),
        `${appName}#dev must pass the root preparation marker through Turbo strict-env mode`
      );
    }

    const preparedGraph = JSON.parse(
      execFileSync(
        process.execPath,
        [
          require.resolve('turbo/bin/turbo'),
          'run',
          'desktop-dev-dependencies',
          '--filter=@brainstrike/desktop',
          '--dry=json',
        ],
        {
          cwd: process.cwd(),
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
    const preparedBuilds = new Set(
      preparedGraph.tasks
        .filter((task) => task.task === 'build' && task.command !== '<NONEXISTENT>')
        .map((task) => task.package)
    );
    const webPredevFilters = parseFilterList(webPredev);
    const webPrebuildFilters = parseFilterList(webPrebuild);
    assert.ok(webPredevFilters.length > 0, 'web predev must declare at least one --filter=<pkg>');
    assert.ok(
      webPrebuildFilters.length > 0,
      'web prebuild must declare at least one --filter=<pkg>'
    );
    const webPreparationFilters = new Set([...webPredevFilters, ...webPrebuildFilters]);
    for (const filter of webPreparationFilters) {
      assert.ok(
        preparedBuilds.has(filter),
        `root dev preparation must include ${filter} before web and desktop watchers start`
      );
    }
  });
});
