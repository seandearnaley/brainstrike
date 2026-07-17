import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findTsconfigPathsRegistryMismatches } from '../verify-tsconfig-paths-match-registry.mjs';

// Guard: every @brainstrike/* package-ROOT key the workspaceSrcAliases
// registry source-aliases must have a tsconfig.json `paths` entry resolving
// to the SAME file. tsconfig paths stay hand-written (TypeScript needs them)
// but are verified against the registry instead of hand-synced with it.
test('real tree: tsconfig.json paths matches the workspaceSrcAliases registry for every package root', () => {
  const violations = findTsconfigPathsRegistryMismatches();
  assert.deepEqual(
    violations,
    [],
    'tsconfig.json compilerOptions.paths diverges from the workspaceSrcAliases registry:\n' +
      violations.map((v) => `  - ${v.package}: ${v.problem}`).join('\n')
  );
});

/**
 * Build a throwaway packages tree (one package, `alpha`, with a real
 * `src/index.ts`) plus a tsconfig.json. `tsconfigPaths` is written verbatim
 * as `compilerOptions.paths`. Returns `{ packagesDir, repoRoot, tsconfigPath }`.
 */
async function writeFixture(tsconfigPaths) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'tsconfig-registry-guard-'));
  const packagesDir = path.join(repoRoot, 'packages');
  await mkdir(path.join(packagesDir, 'alpha/src'), { recursive: true });
  await writeFile(
    path.join(packagesDir, 'alpha/package.json'),
    JSON.stringify({
      exports: { '.': { import: './dist/index.js' } },
      name: '@brainstrike/alpha',
    })
  );
  await writeFile(path.join(packagesDir, 'alpha/src/index.ts'), 'export const x = 1;\n');
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { paths: tsconfigPaths } }));
  return { packagesDir, repoRoot, tsconfigPath };
}

test('MUST FAIL: a package the registry source-aliases with no tsconfig paths entry', async () => {
  // The exact "add a package to the registry, forget tsconfig" regression
  // this guard exists to catch (Step 5 of the Series C R6 task-5 brief).
  const { packagesDir, repoRoot, tsconfigPath } = await writeFixture({});
  const violations = findTsconfigPathsRegistryMismatches({ packagesDir, repoRoot, tsconfigPath });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].package, '@brainstrike/alpha');
  assert.match(violations[0].problem, /no entry for '@brainstrike\/alpha'/);
});

test('passes when the tsconfig paths entry resolves to the same file as the registry', async () => {
  const { packagesDir, repoRoot, tsconfigPath } = await writeFixture({
    '@brainstrike/alpha': ['./packages/alpha/src'],
  });

  assert.deepEqual(
    findTsconfigPathsRegistryMismatches({ packagesDir, repoRoot, tsconfigPath }),
    []
  );
});

test('fails when the tsconfig paths entry resolves to a DIFFERENT file than the registry', async () => {
  const { packagesDir, repoRoot, tsconfigPath } = await writeFixture({
    '@brainstrike/alpha': ['./packages/alpha/dist'],
  });
  await mkdir(path.join(packagesDir, 'alpha/dist'), { recursive: true });
  await writeFile(path.join(packagesDir, 'alpha/dist/index.ts'), 'export const x = 1;\n');

  const violations = findTsconfigPathsRegistryMismatches({ packagesDir, repoRoot, tsconfigPath });

  assert.equal(violations.length, 1);
  assert.match(
    violations[0].problem,
    /resolves to .*dist\/index\.ts.*registry resolves .* to .*src\/index\.ts/s
  );
});

test('fails when the tsconfig paths entry does not resolve to any existing file', async () => {
  const { packagesDir, repoRoot, tsconfigPath } = await writeFixture({
    '@brainstrike/alpha': ['./packages/alpha/nope'],
  });

  const violations = findTsconfigPathsRegistryMismatches({ packagesDir, repoRoot, tsconfigPath });

  assert.equal(violations.length, 1);
  assert.match(violations[0].problem, /does not resolve to an existing source file/);
});

test('a package the registry EXCLUDES (no src/ dir) is out of scope, even with no tsconfig entry', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'tsconfig-registry-guard-'));
  const packagesDir = path.join(repoRoot, 'packages');
  // No `src/` dir — mirrors @brainstrike/workers: the registry skips it, so
  // this guard must not demand a tsconfig entry for it either.
  await mkdir(path.join(packagesDir, 'beta'), { recursive: true });
  await writeFile(
    path.join(packagesDir, 'beta/package.json'),
    JSON.stringify({ name: '@brainstrike/beta' })
  );
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { paths: {} } }));

  assert.deepEqual(
    findTsconfigPathsRegistryMismatches({ packagesDir, repoRoot, tsconfigPath }),
    []
  );
});
