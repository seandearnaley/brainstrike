import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findWorkspaceSrcAliasViolations } from '../verify-workspace-src-aliases.mjs';

// Guard: every runnable vitest config (base/integration/mutation/models, and
// every inline project) in every packages/* must resolve each runtime
// @brainstrike/* import to an existing NON-dist source path. Prevents
// #1066/#1207 (test lane silently executing built dist).
test('real tree: no package test lane resolves workspace imports from dist', async () => {
  const violations = await findWorkspaceSrcAliasViolations();
  assert.deepEqual(
    violations,
    [],
    'Package test lanes resolve @brainstrike/* imports from built dist ' +
      '(spread `...workspaceSrcAliases(...)` in the flagged config/project, or ' +
      'allowlist with a reason):\n' +
      violations
        .map((v) => `  - ${v.package} [${v.config} / ${v.project}] ${v.specifier}: ${v.problem}`)
        .join('\n')
  );
});

/**
 * Build a throwaway packages tree. `alphaFiles` maps relative paths to
 * contents; returns the packages root. Beta/gamma are dist-exporting deps with
 * real source files.
 */
const writeFixture = async (alphaFiles) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b3-alias-guard-'));
  const packagesRoot = path.join(root, 'packages');
  const files = {
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'beta/package.json': JSON.stringify({
      exports: { '.': { import: './dist/index.js' }, './extra': { import: './dist/extra.js' } },
      name: '@brainstrike/beta',
    }),
    'beta/src/extra.ts': 'export const extra = 1;\n',
    'beta/src/index.ts': 'export const thing = 1;\n',
    'gamma/package.json': JSON.stringify({
      exports: { '.': { import: './dist/index.js' } },
      name: '@brainstrike/gamma',
    }),
    'gamma/src/index.ts': 'export const g = 1;\n',
    ...alphaFiles,
  };
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(packagesRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return packagesRoot;
};

const srcAliasConfig = (packagesRoot, extraEntriesJs = '') =>
  `export default { resolve: { alias: [${extraEntriesJs}{ find: /^@brainstrike\\/beta$/, replacement: ${JSON.stringify(
    path.join(packagesRoot, 'beta/src/index.ts')
  )} }] }, test: {} };\n`;

test('passes when every runtime dep is aliased to existing source', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  assert.deepEqual(await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }), []);
});

test('BLIND SPOT: a dist override placed before the src spread fails', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  // First-match wins: the dist pin shadows the later src entry.
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    srcAliasConfig(
      packagesRoot,
      `{ find: '@brainstrike/beta', replacement: ${JSON.stringify(
        path.join(packagesRoot, 'beta/dist')
      )} }, `
    )
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0].problem, /alias resolves to built dist/);
});

test('BLIND SPOT: declaring no aliases fails even if the file mentions the registry', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  // Imported-but-never-spread: the executed config has NO alias entries. A
  // marker-string check would pass on the identifier alone; execution does not.
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    'const workspaceSrcAliases = () => [];\nvoid workspaceSrcAliases;\nexport default { resolve: { alias: [] }, test: {} };\n'
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0].problem, /falls through to built dist via exports/);
});

test('BLIND SPOT: one aliased dep does not excuse a second un-aliased dep', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts':
      "import { thing } from '@brainstrike/beta';\nimport { g } from '@brainstrike/gamma';\nexport const x = thing + g;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    srcAliasConfig(packagesRoot) // aliases beta only
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.deepEqual(
    violations.map((v) => v.specifier),
    ['@brainstrike/gamma']
  );
});

test('BLIND SPOT: a second runnable config (mutation lane) is checked too', async () => {
  // The live file-system case: base config aliased, stryker mutation config bare.
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.mutation.config.mjs'),
    'export default { test: {} };\n'
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.deepEqual(
    violations.map((v) => v.config),
    ['vitest.mutation.config.mjs']
  );
});

test('BLIND SPOT: each inline project is checked separately (no inheritance)', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  const aliased = `{ resolve: { alias: [{ find: /^@brainstrike\\/beta$/, replacement: ${JSON.stringify(
    path.join(packagesRoot, 'beta/src/index.ts')
  )} }] }, test: { name: 'unit' } }`;
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    `export default { test: { projects: [${aliased}, { test: { name: 'browser' } }] } };\n`
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.deepEqual(
    violations.map((v) => v.project),
    ['browser']
  );
});

test('flags an alias whose target does not exist', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    `export default { resolve: { alias: [{ find: /^@brainstrike\\/beta$/, replacement: ${JSON.stringify(
      path.join(packagesRoot, 'beta/src/nope.ts')
    )} }] }, test: {} };\n`
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0].problem, /alias target does not exist/);
});

test('detects side-effect and dynamic imports, ignores type-only imports', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts':
      "import '@brainstrike/beta';\nexport async function load() {\n  return await import('@brainstrike/gamma');\n}\n",
    'alpha/src/types-only.ts':
      "import type { Thing } from '@brainstrike/beta/extra';\nexport type X = Thing;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    'export default { test: {} };\n'
  );
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.deepEqual(
    violations.map((v) => v.specifier).sort(),
    ['@brainstrike/beta', '@brainstrike/gamma'] // beta/extra (type-only) is NOT here
  );
});

test('honors the allowlist (whole package and per-specifier) with reasons', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts':
      "import { thing } from '@brainstrike/beta';\nimport { g } from '@brainstrike/gamma';\nexport const x = thing + g;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    'export default { test: {} };\n'
  );
  // Whole-package exemption
  assert.deepEqual(
    await findWorkspaceSrcAliasViolations({
      allowlist: { '@brainstrike/alpha': { reason: 'intentionally consumes built artifacts' } },
      packagesRoot,
    }),
    []
  );
  // Per-specifier exemption still flags the other dep
  const partial = await findWorkspaceSrcAliasViolations({
    allowlist: {
      '@brainstrike/alpha': {
        reason: 'beta is a prebuilt worker bundle',
        specifiers: ['@brainstrike/beta'],
      },
    },
    packagesRoot,
  });
  assert.deepEqual(
    partial.map((v) => v.specifier),
    ['@brainstrike/gamma']
  );
});

test('rejects allowlist entries without a reason string', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'alpha/vitest.config.mjs'),
    'export default { test: {} };\n'
  );
  await assert.rejects(
    findWorkspaceSrcAliasViolations({
      allowlist: { '@brainstrike/alpha': {} },
      packagesRoot,
    }),
    /needs a reason string/
  );
});

test('BLIND SPOT: transitive src-graph deps are closed to a fixpoint', async () => {
  // alpha imports beta (aliased to src); beta's SOURCE imports gamma. The
  // config covers beta but not gamma — the fixpoint must flag gamma with the
  // referral chain, exactly the live embeddings -> embedding-worker(src) ->
  // worker-runtime shape.
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(
    path.join(packagesRoot, 'beta/src/index.ts'),
    "import { g } from '@brainstrike/gamma';\nexport const thing = g;\n"
  );
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  const violations = await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, '@brainstrike/gamma');
  assert.match(violations[0].problem, /falls through to built dist/);
  assert.match(violations[0].problem, /via @brainstrike\/beta \[@brainstrike\/beta src\]/);
});

test('transitive contributions exclude the dep package test files', async () => {
  // beta's TEST file imports gamma, but its shipped src does not — the consumer
  // lane never loads beta's tests, so gamma must NOT be flagged.
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await mkdir(path.join(packagesRoot, 'beta/src/__tests__'), { recursive: true });
  await writeFile(
    path.join(packagesRoot, 'beta/src/__tests__/beta.test.ts'),
    "import { g } from '@brainstrike/gamma';\nexport const t = g;\n"
  );
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  assert.deepEqual(await findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }), []);
});

test('DISCOVERY: a script/stryker config reference outside the convention throws', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  // package.json script references a config file the filename convention misses
  await writeFile(
    path.join(packagesRoot, 'alpha/package.json'),
    JSON.stringify({
      name: '@brainstrike/alpha',
      scripts: { 'test:custom': 'vitest run --config custom.vitest.mjs' },
    })
  );
  await assert.rejects(
    findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }),
    /references vitest config 'custom\.vitest\.mjs'.*discovery missed/
  );
});

test('DISCOVERY: stryker configFile references are cross-checked too', async () => {
  const packagesRoot = await writeFixture({
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
  });
  await writeFile(path.join(packagesRoot, 'alpha/vitest.config.mjs'), srcAliasConfig(packagesRoot));
  await writeFile(
    path.join(packagesRoot, 'alpha/stryker.config.js'),
    "module.exports = { tsconfigFile: 'tsconfig.json', vitest: { configFile: 'vitest.hidden.conf.mjs' } };\n"
  );
  await assert.rejects(
    findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }),
    /references vitest config 'vitest\.hidden\.conf\.mjs'.*discovery missed/
  );
});
