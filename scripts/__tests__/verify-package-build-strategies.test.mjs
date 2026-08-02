import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  discoverPackageBuildStrategies,
  EXPECTED_BUNDLED_PACKAGES,
  findPackageBuildStrategyViolations,
  formatPackageBuildStrategyViolations,
  MIN_NODE_ESM_LIBRARY_PACKAGES,
  MIN_TSC_LIBRARY_PACKAGES,
  MIN_TYPED_BUILD_PACKAGES,
} from '../verify-package-build-strategies.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'verify-package-build-strategies.mjs');

function makeFixture(packages) {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-strategy-guard-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root' }));
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(path.join(dir, 'packages', 'config', 'tsconfig'), { recursive: true });
  writeFileSync(
    path.join(dir, 'packages', 'config', 'tsconfig', 'base.json'),
    JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } })
  );
  writeFileSync(
    path.join(dir, 'packages', 'config', 'tsconfig', 'node-library.json'),
    JSON.stringify({ extends: './base.json' })
  );

  for (const [directory, spec] of Object.entries(packages)) {
    const packageDir = path.join(dir, 'packages', directory);
    mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    const build = spec.build ?? 'pnpm run clean && tsc -b .';
    const manifest = {
      exports: spec.exports ?? {
        '.': {
          import: './dist/index.js',
          require: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
      name: spec.name ?? `@fixture/${directory}`,
      scripts: { build, ...(spec.dev ? { dev: spec.dev } : {}) },
      type: spec.type ?? 'module',
      types: './dist/index.d.ts',
      ...(spec.dependencies ? { devDependencies: spec.dependencies } : {}),
      ...(spec.manifest ?? {}),
    };
    writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      path.join(packageDir, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: { composite: true, declaration: true, outDir: 'dist', rootDir: 'src' },
          extends:
            spec.nodeLibrary === false
              ? '../config/tsconfig/base.json'
              : '../config/tsconfig/node-library.json',
          include: ['src/**/*'],
        },
        null,
        2
      )}\n`
    );
    writeFileSync(path.join(packageDir, 'src', 'dep.ts'), 'export const value = 1;\n');
    writeFileSync(
      path.join(packageDir, 'src', 'index.ts'),
      spec.source ?? "export { value } from './dep.js';\n"
    );
    if (spec.config) {
      writeFileSync(
        path.join(packageDir, 'tsup.config.ts'),
        "import { defineConfig } from 'tsup';\nexport default defineConfig({ entry: ['src/index.ts'] });\n"
      );
    }
  }
  return dir;
}

function runFixture(packages, options = {}) {
  const dir = makeFixture(packages);
  try {
    return findPackageBuildStrategyViolations({
      enforceBudget: false,
      enforceFloors: false,
      repoRoot: dir,
      ...options,
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function bundledFixture(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `bundle-${index}`,
      {
        build: 'tsc -b . && tsup --config ./tsup.config.ts',
        config: true,
        dependencies: { tsup: '1.0.0' },
        nodeLibrary: false,
      },
    ])
  );
}

test('the real tree satisfies the canonical build-strategy contract', () => {
  const violations = findPackageBuildStrategyViolations({ repoRoot });
  assert.deepEqual(
    violations,
    [],
    `build-strategy violations:\n${formatPackageBuildStrategyViolations(violations)}`
  );
});

test('the executable guard entrypoint runs and reports every inspected class', () => {
  const stdout = execFileSync(process.execPath, [guardScript], { encoding: 'utf8' });
  assert.match(stdout, /typed libraries use tsc-only builds/);
  assert.match(stdout, /packages perform explicit bundling/);
  assert.match(stdout, /packages build native addons/);
  assert.match(stdout, /node-library packages have Node-compatible ESM specifiers/);
});

test('the real tree clears every anti-vacuity floor and the bundling budget', () => {
  const packages = discoverPackageBuildStrategies(repoRoot);
  const bundled = packages.filter((pkg) => pkg.hasTsupInvocation);
  const tscOnly = packages.filter(
    (pkg) => !pkg.isNative && pkg.hasTscBuild && !pkg.hasTsupInvocation
  );
  const nodeLibraries = packages.filter((pkg) => pkg.hasNodeLibraryConfig);
  assert.ok(packages.length >= MIN_TYPED_BUILD_PACKAGES);
  assert.ok(tscOnly.length >= MIN_TSC_LIBRARY_PACKAGES);
  assert.ok(nodeLibraries.length >= MIN_NODE_ESM_LIBRARY_PACKAGES);
  assert.equal(bundled.length, EXPECTED_BUNDLED_PACKAGES);
});

test('MONEY TEST: an extensionless Node ESM import FAILS with the runtime reason', () => {
  for (const source of [
    "export { value } from './dep';\n",
    "export type Value = import('./dep').Value;\n",
    "export const load = () => import('./dep');\n",
  ]) {
    const violations = runFixture({ drifted: { source } });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'extensionless-node-esm');
    assert.equal(violations[0].value, './dep');
    assert.match(formatPackageBuildStrategyViolations(violations), /Node ESM does not/);
  }
});

test('MONEY TEST: an orphan tsup config FAILS after the build stops invoking tsup', () => {
  const violations = runFixture({ drifted: { config: true } });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'orphan-tsup-config');
  assert.match(formatPackageBuildStrategyViolations(violations), /script-shaped tsup residue/);
});

test('MONEY TEST: stale tsup dependency and watch command each FAIL independently', () => {
  const dependency = runFixture({ drifted: { dependencies: { tsup: '1.0.0' } } });
  assert.deepEqual(
    dependency.map((entry) => entry.kind),
    ['orphan-tsup-dependency']
  );

  const dev = runFixture({ drifted: { dev: 'tsup --watch' } });
  assert.deepEqual(
    dev.map((entry) => entry.kind),
    ['orphan-tsup-dev-script']
  );
});

test('MONEY TEST: inline tsup without a config FAILS as a third strategy', () => {
  const violations = runFixture({
    drifted: {
      build: 'tsc -b . && tsup src/index.ts --format esm,cjs',
      dependencies: { tsup: '1.0.0' },
      nodeLibrary: false,
    },
  });
  assert.deepEqual(
    violations.map((entry) => entry.kind),
    ['missing-tsup-config']
  );
});

test('MONEY TEST: a real bundler must declare its own tsup dependency', () => {
  const violations = runFixture({
    drifted: {
      build: 'tsc -b . && tsup --config ./tsup.config.ts',
      config: true,
      nodeLibrary: false,
    },
  });
  assert.deepEqual(
    violations.map((entry) => entry.kind),
    ['missing-tsup-dependency']
  );
});

test('MONEY TEST: growing or shrinking the bundling budget FAILS without an identity registry', () => {
  for (const count of [EXPECTED_BUNDLED_PACKAGES - 1, EXPECTED_BUNDLED_PACKAGES + 1]) {
    const violations = runFixture(bundledFixture(count), { enforceBudget: true });
    assert.equal(violations.filter((entry) => entry.kind === 'bundled-package-count').length, 1);
  }
  assert.deepEqual(
    runFixture(bundledFixture(EXPECTED_BUNDLED_PACKAGES), { enforceBudget: true }),
    []
  );
});

test('RULE: native typed packages remain a structural node-gyp exception', () => {
  assert.deepEqual(
    runFixture({ native: { build: 'node-gyp rebuild', nodeLibrary: false, type: 'commonjs' } }),
    []
  );
});

test('RULE: a typed non-native package with neither canonical tool FAILS', () => {
  const violations = runFixture({
    drifted: { build: 'node scripts/build.mjs', nodeLibrary: false },
  });
  assert.deepEqual(
    violations.map((entry) => entry.kind),
    ['unsupported-build']
  );
});

test('RULE: node-library packages must be type=module tsc-only packages with .js exports', () => {
  const wrongClass = runFixture({ drifted: { type: 'commonjs' } });
  assert.ok(wrongClass.some((entry) => entry.kind === 'invalid-node-library-class'));

  const bundledTarget = runFixture({
    drifted: {
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './dist/index.cjs',
          types: './dist/index.d.ts',
        },
      },
    },
  });
  assert.equal(
    bundledTarget.filter((entry) => entry.kind === 'bundled-export-in-node-library').length,
    2
  );

  const staleChunkPattern = runFixture({
    drifted: { manifest: { sideEffects: ['./dist/chunk-*.js'] } },
  });
  assert.deepEqual(
    staleChunkPattern.map((entry) => entry.kind),
    ['bundled-residue-in-node-library']
  );
});

test('VACUOUS PASS: a tiny discovered tree throws instead of certifying itself', () => {
  const dir = makeFixture({ only: {} });
  try {
    assert.throws(
      () =>
        findPackageBuildStrategyViolations({
          enforceBudget: false,
          enforceFloors: true,
          repoRoot: dir,
        }),
      new RegExp(`below the floor of ${MIN_TYPED_BUILD_PACKAGES}`)
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: a malformed package manifest throws', () => {
  const dir = makeFixture({ broken: {} });
  writeFileSync(path.join(dir, 'packages', 'broken', 'package.json'), '{ nope');
  try {
    assert.throws(
      () => discoverPackageBuildStrategies(dir),
      /could not parse packages[/\\]broken[/\\]package\.json/
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
