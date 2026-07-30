import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as turboCommand from '../run-turbo-command.mjs';

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

    // env deliberately lacks HOME: if the skip did NOT short-circuit, cache-dir
    // resolution would fail and return 1 — so return 0 proves no turbo spawn.
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-turbo', '--', 'run', 'build'],
      'darwin',
      {
        env: { TURBO_HASH: '649b8853e23bc395' },
        log: (message) => logs.push(message),
        logError: (message) => errors.push(message),
      }
    );

    assert.equal(status, 0);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /TURBO_HASH/u);
    assert.match(logs[0], /--skip-under-turbo/u);
  });

  it('proceeds normally when --skip-under-turbo is passed outside a turbo task', () => {
    const logs = [];
    const errors = [];

    // TURBO_HASH is unset, so the wrapper must NOT skip. The env also lacks
    // HOME, so proceeding fails at cache-dir resolution (status 1) — proving
    // the normal path was taken without spawning turbo.
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--skip-under-turbo', '--', 'run', 'build'],
      'darwin',
      {
        env: {},
        log: (message) => logs.push(message),
        logError: (message) => errors.push(message),
      }
    );

    assert.equal(status, 1);
    assert.deepEqual(logs, []);
    assert.deepEqual(errors, [
      'HOME is required to resolve the default Turborepo cache directory.',
    ]);
  });

  it('does not skip when TURBO_HASH is set but --skip-under-turbo is absent', () => {
    const logs = [];
    const errors = [];

    // Without the opt-in flag the wrapper must run turbo even under an outer
    // turbo task (predev under `turbo run dev` has no ^build edge and NEEDS the
    // nested build). Missing HOME again proves which path was taken.
    const status = turboCommand.runTurboCommand(
      ['node', 'run-turbo-command.mjs', '--', 'run', 'build'],
      'darwin',
      {
        env: { TURBO_HASH: '649b8853e23bc395' },
        log: (message) => logs.push(message),
        logError: (message) => errors.push(message),
      }
    );

    assert.equal(status, 1);
    assert.deepEqual(logs, []);
    assert.deepEqual(errors, [
      'HOME is required to resolve the default Turborepo cache directory.',
    ]);
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
      for (const filter of parseFilterList(command)) {
        assert.ok(
          closure.has(filter),
          `${packageJsonPath} prebuild filters ${filter}, which is outside ${appManifest.name}'s workspace dependency closure — the outer turbo graph would never build it once prebuild skips under turbo`
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

function findPackageJsonFiles(root) {
  const packageJsonFiles = [];
  const ignored = new Set(['.git', '.turbo', 'dist', 'node_modules']);

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'package.json') {
        packageJsonFiles.push(join(dir, entry.name));
        continue;
      }

      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      if (statSync(child).isDirectory()) {
        visit(child);
      }
    }
  }

  visit(root);
  return packageJsonFiles;
}
