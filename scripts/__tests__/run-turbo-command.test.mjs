import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as turboCommand from '../run-turbo-command.mjs';

const require = createRequire(import.meta.url);

function makeFakeHome() {
  return mkdtempSync(join(tmpdir(), 'run-turbo-command-home-'));
}

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

  it('does not skip when TURBO_HASH is set but --skip-under-turbo is absent', () => {
    const logs = [];
    const spawnCalls = [];

    // Without the opt-in flag the wrapper must run turbo even under an outer
    // turbo task (predev under `turbo run dev` has no ^build edge and NEEDS the
    // nested build).
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

  it('only prebuild scripts use --skip-under-turbo', () => {
    // predev under `turbo run dev` has NO ^build edge, so its nested build is
    // load-bearing on a fresh clone — it must never skip.
    const offenders = packageScriptEntries()
      .filter(
        ({ command, scriptName }) =>
          command.includes('--skip-under-turbo') && scriptName !== 'prebuild'
      )
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

  it('predev guards and filters mirror the prebuild filter list', () => {
    // predev's `[ -f .../dist/... ]` fast path and its fallback nested build
    // must cover the same packages prebuild builds, or a standalone `dev` run
    // starts vite against missing dist artifacts.
    const byPackage = new Map();
    for (const entry of wrapperScripts) {
      const bucket = byPackage.get(entry.packageJsonPath) ?? {};
      bucket[entry.scriptName] = entry.command;
      byPackage.set(entry.packageJsonPath, bucket);
    }

    for (const [packageJsonPath, scriptsByName] of byPackage) {
      if (!(scriptsByName.prebuild && scriptsByName.predev)) {
        continue;
      }

      const prebuildFilters = parseFilterList(scriptsByName.prebuild).sort();
      const predevFilters = parseFilterList(scriptsByName.predev).sort();
      assert.deepEqual(
        predevFilters,
        prebuildFilters,
        `${packageJsonPath}: predev's nested build filters must match prebuild's`
      );

      const guardedPackages = [
        ...scriptsByName.predev.matchAll(/-f \.\.\/\.\.\/packages\/([^/]+)\//gu),
      ]
        .map(
          ([, dir]) => JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8')).name
        )
        .sort();
      assert.deepEqual(
        guardedPackages,
        prebuildFilters,
        `${packageJsonPath}: predev's dist existence guards must cover exactly the prebuild filter list`
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

const sweepIgnoredDirectories = new Set(['.claude', '.git', '.turbo', 'dist', 'node_modules']);

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
