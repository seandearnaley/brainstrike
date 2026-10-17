import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVercel = createRequire(requireRoot.resolve('vercel/package.json'));
const requireBuildUtils = createRequire(requireVercel.resolve('@vercel/build-utils'));
const ownerEntry = requireBuildUtils.resolve('@vercel/python-analysis');
const requireOwner = createRequire(ownerEntry);
const ownerDirectory = path.dirname(path.dirname(ownerEntry));

// Highest patched floors across the three current vendor advisories:
// https://github.com/isaacs/minimatch/security/advisories/GHSA-3ppc-4f35-3m26
// https://github.com/isaacs/minimatch/security/advisories/GHSA-7r86-cg39-jmmj
// https://github.com/isaacs/minimatch/security/advisories/GHSA-23c5-xmqv-rm74
const floors = ['3.1.4', '4.2.5', '5.1.8', '6.2.2', '7.4.8', '8.0.6', '9.0.7', '10.2.3'];

function isPatched(raw) {
  assert.match(raw, /^\d+\.\d+\.\d+$/, `unrecognized minimatch version: ${raw}`);
  const version = raw.split('.').map(Number);
  const floor = floors.find((candidate) => Number(candidate.split('.')[0]) === version[0]);
  if (version[0] < 3) {
    return false;
  }
  assert.ok(floor, `review advisory ranges for new minimatch major: ${raw}`);
  const bound = floor.split('.').map(Number);
  return version[1] > bound[1] || (version[1] === bound[1] && version[2] >= bound[2]);
}

test('all resolved minimatch versions clear the three advisory ranges', async () => {
  const lock = parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const versions = [
    ...new Set(
      Object.keys(lock.packages)
        .filter((key) => key.startsWith('minimatch@'))
        .map((key) => key.slice('minimatch@'.length))
    ),
  ];
  assert.ok(versions.length > 0, 'expected installed minimatch versions');
  assert.deepEqual(
    versions.filter((version) => !isPatched(version)),
    []
  );
  assert.equal(lock.snapshots['@vercel/python-analysis@0.15.0'].dependencies.minimatch, '10.2.6');
  assert.equal(requireOwner('minimatch/package.json').version, '10.2.6');
});

test('advisory guard rejects versions immediately below every fixed floor', () => {
  for (const floor of floors) {
    const pieces = floor.split('.').map(Number);
    assert.equal(isPatched(floor), true);
    pieces[2] -= 1;
    assert.equal(isPatched(pieces.join('.')), false);
  }
  assert.equal(isPatched('2.0.0'), false);
  assert.throws(() => isPatched('10.2.3-beta.1'), /unrecognized minimatch version/);
});

for (const mode of ['commonjs', 'module']) {
  test(`Vercel owner resolves patched public match API in ${mode}`, () => {
    const importApi =
      mode === 'module'
        ? "import { match } from 'minimatch'; import assert from 'node:assert/strict';"
        : "const { match } = require('minimatch'); const assert = require('node:assert/strict');";
    const result = spawnSync(
      process.execPath,
      [
        `--input-type=${mode}`,
        '--eval',
        `${importApi}
      assert.deepEqual(match(['packages/api', 'packages/excluded', 'other/api'], 'packages/*'),
        ['packages/api', 'packages/excluded']);
      assert.deepEqual(match(['packages/api', 'packages/excluded'], 'packages/excluded'),
        ['packages/excluded']);
      assert.deepEqual(match(['packages/api'], 'packages/**'), ['packages/api']);
    `,
      ],
      { cwd: ownerDirectory, encoding: 'utf8', timeout: 3000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('owning Python discovery honors uv workspace members and exclusions', async () => {
  const { discoverPythonPackage } = requireBuildUtils('@vercel/python-analysis');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-879-uv-workspace-'));
  try {
    await writeFile(
      path.join(fixture, 'pyproject.toml'),
      '[project]\nname = "workspace"\nversion = "1.0.0"\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/excluded"]\n'
    );
    for (const directory of ['packages/api', 'packages/excluded', 'other/api']) {
      const entrypointDir = path.join(fixture, directory);
      await mkdir(entrypointDir, { recursive: true });
      await writeFile(
        path.join(entrypointDir, 'pyproject.toml'),
        '[project]\nname = "child"\nversion = "1.0.0"\n'
      );
      const discovered = await discoverPythonPackage({ entrypointDir, rootDir: fixture });
      assert.equal(discovered.manifest.path, path.join(directory, 'pyproject.toml'));
      assert.equal(
        discovered.workspaceManifest?.path,
        directory === 'packages/api' ? 'pyproject.toml' : path.join(directory, 'pyproject.toml')
      );
    }
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test('owner-resolved matcher bounds the three advisory attack shapes', () => {
  const cases = [
    ['a'.repeat(100), `${'*'.repeat(34)}X`],
    [`${'a'.repeat(30)}z`, '*(*(*(a|b)))'],
    [new Array(30).fill('a').join('/'), `${new Array(13).fill('**/a').join('/')}/b`],
  ];
  for (const [input, pattern] of cases) {
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { match } = require(${JSON.stringify(requireOwner.resolve('minimatch'))});
      assert.deepEqual(match([${JSON.stringify(input)}], ${JSON.stringify(pattern)}), []);
    `,
      ],
      { encoding: 'utf8', timeout: 3000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});
