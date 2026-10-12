import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  MIN_PRUNED_TSC_LIBRARY_PACKAGES,
  MIN_TSC_LIBRARY_PACKAGES,
  MIN_TYPED_BUILD_PACKAGES,
} from '../verify-package-build-strategies.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'verify-package-build-strategies.mjs');
const tscBin = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');

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
    JSON.stringify({
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      extends: './base.json',
    })
  );

  for (const [directory, spec] of Object.entries(packages)) {
    const packageDir = path.join(dir, 'packages', directory);
    mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    const build = spec.build ?? 'node ../../scripts/prune-stale-dist.mjs && tsc -b .';
    const { scripts: extraScripts = {}, ...manifestOverrides } = spec.manifest ?? {};
    const manifest = {
      exports: spec.exports ?? {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
      name: spec.name ?? `@fixture/${directory}`,
      scripts: { build, ...(spec.dev ? { dev: spec.dev } : {}), ...extraScripts },
      type: spec.type ?? 'module',
      types: './dist/index.d.ts',
      ...(spec.dependencies ? { devDependencies: spec.dependencies } : {}),
      ...manifestOverrides,
    };
    writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (spec.intermediateNodeLibrary) {
      writeFileSync(
        path.join(packageDir, 'tsconfig.base.json'),
        JSON.stringify({ extends: '../config/tsconfig/node-library.json' })
      );
    }
    writeFileSync(
      path.join(packageDir, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            composite: true,
            declaration: true,
            outDir: 'dist',
            rootDir: spec.rootDir ?? 'src',
          },
          extends:
            spec.extends ??
            (spec.nodeLibrary === false
              ? '../config/tsconfig/base.json'
              : spec.intermediateNodeLibrary
                ? './tsconfig.base.json'
                : '../config/tsconfig/node-library.json'),
          include: spec.include ?? ['src/**/*'],
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
      const configName = typeof spec.config === 'string' ? spec.config : 'tsup.config.ts';
      writeFileSync(
        path.join(packageDir, configName),
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
  assert.match(stdout, /node-library packages use TypeScript-enforced NodeNext ESM/);
});

test('the real tree clears every anti-vacuity floor and the bundling budget', () => {
  const packages = discoverPackageBuildStrategies(repoRoot);
  const bundled = packages.filter((pkg) => pkg.hasTsupInvocation);
  const tscOnly = packages.filter(
    (pkg) => !pkg.isNative && pkg.hasTscBuild && !pkg.hasTsupInvocation
  );
  const nodeLibraries = packages.filter((pkg) => pkg.hasNodeLibraryConfig);
  const prunedTscOnly = tscOnly.filter(
    (pkg) => pkg.supportsStaleOutputPruner && pkg.usesStaleOutputPruner
  );
  assert.ok(packages.length >= MIN_TYPED_BUILD_PACKAGES);
  assert.ok(tscOnly.length >= MIN_TSC_LIBRARY_PACKAGES);
  assert.ok(prunedTscOnly.length >= MIN_PRUNED_TSC_LIBRARY_PACKAGES);
  assert.ok(nodeLibraries.length >= MIN_NODE_ESM_LIBRARY_PACKAGES);
  assert.equal(bundled.length, EXPECTED_BUNDLED_PACKAGES);
  const browserOnly = packages.find((pkg) => pkg.name === '@brainstrike/file-explorer-hooks');
  assert.equal(browserOnly?.hasNodeLibraryConfig, false);
  assert.equal(browserOnly?.hasTscBuild, true);
  const rootLayoutWorker = packages.find((pkg) => pkg.name === '@brainstrike/workers');
  assert.equal(rootLayoutWorker?.supportsStaleOutputPruner, false);
  assert.equal(rootLayoutWorker?.usesStaleOutputPruner, false);
});

test('MONEY TEST: TypeScript NodeNext rejects extensionless Node ESM imports itself', () => {
  for (const source of [
    "export { value } from './dep';\n",
    "export type Value = import('./dep').Value;\n",
    "export const load = () => import('./dep');\n",
  ]) {
    const dir = makeFixture({ drifted: { source } });
    try {
      const result = spawnSync(
        process.execPath,
        [tscBin, '--project', 'packages/drifted/tsconfig.json'],
        {
          cwd: dir,
          encoding: 'utf8',
        }
      );
      assert.notEqual(result.status, 0, 'the compiler control must be observed failing');
      assert.match(`${result.stdout}${result.stderr}`, /TS2835/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test('MONEY TEST: an orphan tsup config FAILS after the build stops invoking tsup', () => {
  for (const config of ['tsup.config.ts', 'tsup.config.mts']) {
    const violations = runFixture({ drifted: { config } });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'orphan-tsup-config');
    assert.match(formatPackageBuildStrategyViolations(violations), /script-shaped tsup residue/);
  }
});

test('MONEY TEST: alternate and manifest tsup config shapes FAIL explicitly', () => {
  const alternate = runFixture({
    drifted: {
      build: 'tsup',
      config: 'tsup.config.mts',
      dependencies: { tsup: '1.0.0' },
      nodeLibrary: false,
    },
  });
  assert.deepEqual(
    alternate.map((entry) => entry.kind),
    ['noncanonical-tsup-config']
  );

  const manifest = runFixture({
    drifted: {
      build: 'tsup',
      dependencies: { tsup: '1.0.0' },
      manifest: { tsup: { entry: ['src/index.ts'] } },
      nodeLibrary: false,
    },
  });
  assert.deepEqual(
    manifest.map((entry) => entry.kind),
    ['noncanonical-tsup-config']
  );
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

test('MONEY TEST: lifecycle hooks cannot hide a second tsup emitter', () => {
  for (const scriptName of ['postbuild', 'prepare']) {
    const violations = runFixture({
      drifted: { manifest: { scripts: { [scriptName]: 'tsup src/index.ts' } } },
    });
    assert.deepEqual(
      violations.map((entry) => entry.kind),
      ['noncanonical-tsup-script']
    );
  }
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
          default: './dist/generated.js',
          types: './dist/index.d.ts',
        },
      },
    },
  });
  assert.deepEqual(
    bundledTarget.map((entry) => entry.kind),
    ['non-tsc-export-target']
  );

  const staleChunkPattern = runFixture({
    drifted: { manifest: { sideEffects: ['./dist/chunk-*.js'] } },
  });
  assert.deepEqual(
    staleChunkPattern.map((entry) => entry.kind),
    ['bundled-residue-in-node-library']
  );
});

test('export patterns match emitted files and reject empty output patterns', () => {
  assert.deepEqual(runFixture({ library: { exports: { './*': './dist/*.js' } } }), []);
  assert.deepEqual(
    runFixture({ library: { exports: { './*': './dist/missing/*.js' } } }).map(
      (entry) => entry.kind
    ),
    ['non-tsc-export-target']
  );
});

test('MONEY TEST: NodeNext libraries use one truthful default runtime condition', () => {
  const violations = runFixture({
    drifted: {
      exports: {
        '.': {
          import: './dist/index.js',
          require: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    },
  });
  assert.deepEqual(
    violations.map((entry) => entry.kind),
    ['noncanonical-node-library-condition', 'noncanonical-node-library-condition']
  );
});

test('RULE: canonical NodeNext classification follows array and indirect extends', () => {
  const packages = discoverPackageBuildStrategies(
    makeFixture({
      array: { extends: ['../config/tsconfig/node-library.json'] },
      indirect: { intermediateNodeLibrary: true },
    })
  );
  try {
    assert.ok(packages.every((pkg) => pkg.hasNodeLibraryConfig));
  } finally {
    const fixtureRoot = path.resolve(packages[0].packageDir, '..', '..');
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('MONEY TEST: deleting incremental state is rejected as a noncanonical library build', () => {
  const violations = runFixture({ drifted: { build: 'pnpm run clean && tsc -b .' } });
  assert.deepEqual(
    violations.map((entry) => entry.kind),
    ['noncanonical-tsc-clean']
  );
});

test('RULE: a package-root TypeScript layout remains a structural cleaning exception', () => {
  assert.deepEqual(
    runFixture({
      worker: {
        build: 'pnpm run clean && tsc -b .',
        nodeLibrary: false,
        rootDir: '.',
      },
    }),
    []
  );
});

test('VACUOUS PASS: a NodeNext library with no configured sources throws', () => {
  assert.throws(
    () => runFixture({ empty: { include: [] } }),
    /No inputs were found|resolved TypeScript program contains zero source files/
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
