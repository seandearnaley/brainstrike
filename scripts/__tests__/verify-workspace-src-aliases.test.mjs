import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findWorkspaceSrcAliasViolations } from '../verify-workspace-src-aliases.mjs';

// Guard: every real packages/* that imports a sibling workspace package at
// runtime must declare workspace-src aliasing (shared registry or explicit
// ../<pkg>/src alias). Prevents #1066/#1207 (test lane silently executing dist).
test('no real package imports workspace runtime without src aliasing', () => {
  const violations = findWorkspaceSrcAliasViolations();
  assert.deepEqual(
    violations,
    [],
    'Packages import @brainstrike/* at runtime but declare no workspace-src aliasing ' +
      '(add `...workspaceSrcAliases(...)` to the vitest config, or allowlist with a reason):\n' +
      violations.map((v) => `  - ${v.package}: ${v.deps.join(', ')}`).join('\n')
  );
});

const writeFixture = async (files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b3-alias-guard-'));
  const packagesRoot = path.join(root, 'packages');
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(packagesRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return packagesRoot;
};

test('flags a bare config that imports a workspace package with no aliasing', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
    'alpha/vitest.config.mts':
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  const violations = findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot });
  assert.deepEqual(violations, [{ deps: ['@brainstrike/beta'], package: '@brainstrike/alpha' }]);
});

test('passes when the config spreads the workspaceSrcAliases registry', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
    'alpha/vitest.config.mts':
      "import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';\n" +
      "export default { resolve: { alias: [...workspaceSrcAliases('..')] } };\n",
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  assert.deepEqual(findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }), []);
});

test('passes when the config has an explicit ../<pkg>/src alias', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
    'alpha/vitest.config.mts':
      "export default { resolve: { alias: [{ find: '@brainstrike/beta', replacement: '../beta/src' }] } };\n",
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  assert.deepEqual(findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }), []);
});

test('ignores type-only imports (erased at runtime)', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'alpha/src/index.ts':
      "import type { Thing } from '@brainstrike/beta';\nexport type X = Thing;\n",
    'alpha/vitest.config.mts': 'export default { test: {} };\n',
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  assert.deepEqual(findWorkspaceSrcAliasViolations({ allowlist: {}, packagesRoot }), []);
});

test('honors the allowlist for legitimate dist consumers', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({ name: '@brainstrike/alpha' }),
    'alpha/src/index.ts': "import { thing } from '@brainstrike/beta';\nexport const x = thing;\n",
    'alpha/vitest.config.mts': 'export default { test: {} };\n',
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  assert.deepEqual(
    findWorkspaceSrcAliasViolations({
      allowlist: { '@brainstrike/alpha': 'intentionally consumes built beta dist' },
      packagesRoot,
    }),
    []
  );
});
