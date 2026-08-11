import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as turboCommand from '../run-turbo-command.mjs';

const require = createRequire(import.meta.url);

function makeFakeHome() {
  return mkdtempSync(join(tmpdir(), 'run-turbo-command-home-'));
}

// Declared before the describe blocks: suite bodies call the sweep walkers
// during module evaluation, so a later const would still be in its TDZ.
const sweepIgnoredDirectories = new Set(['.claude', '.git', '.turbo', 'dist', 'node_modules']);

describe('run turbo command helper', () => {
  it('uses an explicit cache directory outside the repo when no cache is configured', () => {
    assert.equal(typeof turboCommand.buildTurboArgs, 'function');

    const args = turboCommand.buildTurboArgs(['run', 'build'], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    });

    assert.deepEqual(args, [
      'run',
      'build',
      '--cache-dir=/Users/tester/Library/Caches/BrainStrike/turbo',
    ]);
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

  it('routes automation-script turbo spawns through the bounded wrapper', () => {
    // The package.json sweep above cannot see turbo spawns buried inside .mjs
    // helpers (e.g. spawnSync('pnpm', ['turbo', ...])), which resolve the
    // repo-local .turbo cache instead of the wrapper's shared cache dir. Only
    // run-turbo-command.mjs may name the turbo binary.
    const wrapperPath = resolve(process.cwd(), 'scripts/run-turbo-command.mjs');
    const directTurboSpawns = findModuleFiles(process.cwd()).filter(
      (modulePath) =>
        modulePath !== wrapperPath && /['"`]turbo['"`]/u.test(readFileSync(modulePath, 'utf8'))
    );

    assert.deepEqual(directTurboSpawns, []);
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
    const lockDir = join(home, 'Library/Caches/BrainStrike/turbo', 'nested-turbo-run.lock');
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
    const lockDir = join(home, 'Library/Caches/BrainStrike/turbo', 'nested-turbo-run.lock');

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
    const lockDir = join(home, 'Library/Caches/BrainStrike/turbo', 'nested-turbo-run.lock');
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

  it('restricts --skip-under-turbo to sound lifecycle boundaries', () => {
    // Prebuilds are covered by the outer ^build graph. Web predev is the one
    // deliberate exception: root predev completes the same build before the
    // outer dev watcher graph starts, while standalone package dev still runs
    // this predev because TURBO_HASH is absent.
    const offenders = packageScriptEntries()
      .filter(({ command, packageJsonPath, scriptName }) => {
        if (!command.includes('--skip-under-turbo') || scriptName === 'prebuild') {
          return false;
        }
        return !(scriptName === 'predev' && packageJsonPath.endsWith('/apps/web/package.json'));
      })
      .map(({ packageJsonPath, scriptName }) => `${packageJsonPath}:${scriptName}`);

    assert.deepEqual(offenders, []);
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
    assert.match(
      readFileSync(resolve(process.cwd(), 'turbo.jsonc'), 'utf8'),
      /"BRAINSTRIKE_DEV_DEPS_PREPARED"/u,
      'the root preparation marker must pass through Turbo strict-env mode to app predev tasks'
    );

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
    for (const filter of parseFilterList(webPrebuild)) {
      assert.ok(
        preparedBuilds.has(filter),
        `root dev preparation must include ${filter} before web and desktop watchers start`
      );
    }
  });
});

function packageScriptEntries() {
  return findPackageJsonFiles(process.cwd()).flatMap((packageJsonPath) => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return Object.entries(packageJson.scripts ?? {}).map(([scriptName, command]) => ({
      command,
      packageJsonPath,
      scriptName,
    }));
  });
}

function workspaceManifestsByName() {
  const manifests = new Map();
  for (const packageJsonPath of findPackageJsonFiles(process.cwd())) {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@brainstrike/')) {
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

function workspaceDependencyClosure(manifest, manifests) {
  const closure = new Set();
  const queue = [manifest];
  while (queue.length > 0) {
    const current = queue.pop();
    const declared = {
      ...current.dependencies,
      ...current.devDependencies,
      ...current.optionalDependencies,
    };
    for (const name of Object.keys(declared)) {
      if (manifests.has(name) && !closure.has(name)) {
        closure.add(name);
        queue.push(manifests.get(name));
      }
    }
  }
  return closure;
}

function parseFilterList(command) {
  return [...command.matchAll(/--filter=(@brainstrike\/[\w-]+)/gu)].map(([, name]) => name);
}

function findPackageJsonFiles(root) {
  return findRepoFiles(root, (entry) => entry.name === 'package.json');
}

function findModuleFiles(root) {
  return findRepoFiles(
    root,
    (entry, dir) => entry.name.endsWith('.mjs') && !dir.endsWith('__tests__')
  );
}

function findRepoFiles(root, matches) {
  const matchedFiles = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (matches(entry, dir)) {
          matchedFiles.push(join(dir, entry.name));
        }
        continue;
      }

      if (sweepIgnoredDirectories.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      if (statSync(child).isDirectory()) {
        visit(child);
      }
    }
  }

  visit(root);
  return matchedFiles;
}
