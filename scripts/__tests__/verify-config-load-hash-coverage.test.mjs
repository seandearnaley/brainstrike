import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findConfigLoadHashGaps } from '../verify-config-load-hash-coverage.mjs';

// Guard: every cross-package file a vitest config imports/executes at
// CONFIG-LOAD time (including setupFiles/globalSetup) must be covered by a
// dependency edge, an explicit turbo.json `$TURBO_ROOT$` input, or the
// allowlist — otherwise the B4 `topo` cascade cannot invalidate the consumer's
// cached test when the executed file changes (#1658 review finding; the five
// pre-fix instances are replayed as fixtures below).
test('real tree: every config-load cross-package reference is hash-covered', async () => {
  const violations = await findConfigLoadHashGaps();
  assert.deepEqual(
    violations,
    [],
    'Config-load references with no dependency edge / turbo.json input:\n' +
      violations
        .map((v) => `  - ${v.package} [${v.config}] ${v.reference}: ${v.problem}`)
        .join('\n')
  );
});

/** Build a throwaway packages tree; returns its packages root. */
const writeFixture = async (files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b4-configload-guard-'));
  const packagesRoot = path.join(root, 'packages');
  const base = {
    'provider/package.json': JSON.stringify({ name: '@brainstrike/provider' }),
    'provider/src/vitest-helper.mjs': 'export const helper = () => [];\n',
    'provider/src/vitest.setup.ts': 'export {};\n',
    ...files,
  };
  for (const [rel, contents] of Object.entries(base)) {
    const full = path.join(packagesRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return packagesRoot;
};

const consumerPkg = (extra = {}) => JSON.stringify({ name: '@brainstrike/consumer', ...extra });

// PRE-FIX SHAPE (server-config -> test-utils vitest.setup): the config
// declares a cross-package setupFiles path and the package has no dependency
// edge on the provider. Must FAIL.
test('FIXTURE server-config shape: cross-package setupFiles with no dep edge fails', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg(),
    'consumer/vitest.config.mjs':
      "export default { test: { setupFiles: ['../provider/src/vitest.setup.ts'] } };\n",
  });
  const violations = await findConfigLoadHashGaps({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].owner, '@brainstrike/provider');
  assert.match(violations[0].problem, /no dependency on @brainstrike\/provider/);
});

// PRE-FIX SHAPE (embedding-worker/ui -> config's vitest-browser.ts, and
// db-explorer/vector-management -> agent's alias helper): the config IMPORTS a
// cross-package file with no dependency edge. Must FAIL.
test('FIXTURE ui/db-explorer shape: cross-package config import with no dep edge fails', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg(),
    'consumer/vitest.config.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\n" +
      'export default { resolve: { alias: helper() }, test: {} };\n',
  });
  const violations = await findConfigLoadHashGaps({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].owner, '@brainstrike/provider');
  assert.match(violations[0].problem, /replay a stale cached test/);
});

// POST-FIX (server-config / embedding-worker / ui): a devDependency edge on the
// provider covers the reference. Must PASS.
test('a declared devDependency on the provider covers the reference', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg({
      devDependencies: { '@brainstrike/provider': 'workspace:*' },
    }),
    'consumer/vitest.config.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\n" +
      "export default { resolve: { alias: helper() }, test: { setupFiles: ['../provider/src/vitest.setup.ts'] } };\n",
  });
  assert.deepEqual(await findConfigLoadHashGaps({ allowlist: {}, packagesRoot }), []);
});

// POST-FIX (db-explorer / vector-management): the app-shell precedent — an
// explicit `$TURBO_ROOT$` input on test (and test:coverage when the script
// exists) covers a defensive file reference without a dependency edge.
test('an explicit turbo.json $TURBO_ROOT$ input covers a file reference', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg({ scripts: { 'test:coverage': 'vitest run --coverage' } }),
    'consumer/turbo.json': JSON.stringify({
      extends: ['//'],
      tasks: {
        test: {
          inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/provider/src/vitest-helper.mjs'],
        },
        'test:coverage': {
          inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/provider/src/vitest-helper.mjs'],
        },
      },
    }),
    'consumer/vitest.config.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\n" +
      'export default { resolve: { alias: helper() }, test: {} };\n',
  });
  assert.deepEqual(await findConfigLoadHashGaps({ allowlist: {}, packagesRoot }), []);
});

// The input escape is per-lane: covering `test` but omitting `test:coverage`
// (when the package HAS a coverage script) still fails.
test('a $TURBO_ROOT$ input on test only fails when test:coverage exists uncovered', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg({ scripts: { 'test:coverage': 'vitest run --coverage' } }),
    'consumer/turbo.json': JSON.stringify({
      extends: ['//'],
      tasks: {
        test: {
          inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/provider/src/vitest-helper.mjs'],
        },
      },
    }),
    'consumer/vitest.config.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\n" +
      'export default { resolve: { alias: helper() }, test: {} };\n',
  });
  const violations = await findConfigLoadHashGaps({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
});

// Same-package config-load helpers are walked transitively: a LOCAL helper that
// itself imports the cross-package file is still caught.
test('transitive: a local helper importing cross-package is still flagged', async () => {
  const packagesRoot = await writeFixture({
    'consumer/local-helper.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\nexport const wrapped = helper;\n",
    'consumer/package.json': consumerPkg(),
    'consumer/vitest.config.mjs':
      "import { wrapped } from './local-helper.mjs';\n" +
      'export default { resolve: { alias: wrapped() }, test: {} };\n',
  });
  const violations = await findConfigLoadHashGaps({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].owner, '@brainstrike/provider');
});

// Bare workspace specifiers in configs need a dependency edge too (no file, so
// no turbo-input escape) — and inline-project setupFiles are read.
test('bare @brainstrike specifier without a dep edge fails; project setupFiles are read', async () => {
  const packagesRoot = await writeFixture({
    'consumer/package.json': consumerPkg(),
    'consumer/vitest.config.mjs':
      'export default { test: { projects: [{ test: { name: "unit", setupFiles: ["../provider/src/vitest.setup.ts"] } }] } };\n',
  });
  const violations = await findConfigLoadHashGaps({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reference, '../provider/src/vitest.setup.ts');
});

test('honors the allowlist (whole package and per-reference) with reasons', async () => {
  const files = {
    'consumer/package.json': consumerPkg(),
    'consumer/vitest.config.mjs':
      "import { helper } from '../provider/src/vitest-helper.mjs';\n" +
      'export default { resolve: { alias: helper() }, test: {} };\n',
  };
  const packagesRoot = await writeFixture(files);
  assert.deepEqual(
    await findConfigLoadHashGaps({
      allowlist: { '@brainstrike/consumer': { reason: 'intentional uncovered reference' } },
      packagesRoot,
    }),
    []
  );
  assert.deepEqual(
    await findConfigLoadHashGaps({
      allowlist: {
        '@brainstrike/consumer': {
          reason: 'helper is deliberately unhashed',
          references: ['../provider/src/vitest-helper.mjs'],
        },
      },
      packagesRoot,
    }),
    []
  );
  await assert.rejects(
    findConfigLoadHashGaps({ allowlist: { '@brainstrike/consumer': {} }, packagesRoot }),
    /needs a reason string/
  );
});
