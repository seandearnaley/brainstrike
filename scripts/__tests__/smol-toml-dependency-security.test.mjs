import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function getOwnerRequire(name) {
  const rootRequire = createRequire(path.join(root, 'package.json'));
  const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
  if (name === 'vercel') {
    return vercelRequire;
  }
  if (name === 'python-analysis') {
    const buildRequire = createRequire(vercelRequire.resolve('@vercel/build-utils'));
    return createRequire(buildRequire.resolve('@vercel/python-analysis'));
  }
  return createRequire(vercelRequire.resolve(`@vercel/${name}`));
}

// 1.9.0 also clears GHSA-r4xh-jqrq-34v2's quadratic key parsing.
function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('smol-toml@'))
    .map((key) => key.slice('smol-toml@'.length));
  assert.ok(versions.length > 0, 'expected smol-toml in the graph');
  for (const version of versions) {
    assert.match(version, /^1\.\d+\.\d+$/, 'review an unknown smol-toml release line');
    const [, minor] = version.split('.').map(Number);
    assert.ok(minor >= 9, `vulnerable smol-toml@${version}`);
  }
}

test('the full graph excludes TOML advisory ranges, with negative controls', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['1.5.2', '1.6.1', '1.7.0', '1.7.1', '1.8.0']) {
    assert.throws(
      () => assertPatched({ packages: { [`smol-toml@${version}`]: {} } }),
      /vulnerable/
    );
  }
  assertPatched({ packages: { 'smol-toml@1.9.0': {}, 'smol-toml@1.9.1': {} } });
  assert.throws(() => assertPatched({ packages: {} }), /expected smol-toml/);
});

for (const name of ['vercel', 'python-analysis', 'rust', 'container']) {
  test(`${name}'s installed parser handles config values and hostile input`, () => {
    const ownerRequire = getOwnerRequire(name);
    const entry = ownerRequire.resolve('smol-toml');
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { parse, stringify, TomlError } = require(${JSON.stringify(entry)});
      const value = { project: { name: 'api', version: '1.0.0' } };
      const parsed = parse(stringify(value));
      // Since 1.9, parsed tables have null prototypes; callers read own fields.
      assert.equal(Object.getPrototypeOf(parsed), null);
      assert.equal(Object.getPrototypeOf(parsed.project), null);
      assert.deepEqual({ ...parsed, project: { ...parsed.project } }, value);
      assert.deepEqual({ ...parse('# comment\\n'.repeat(20000) + 'key = "value"') }, { key: 'value' });
      const flat = parse(Array.from({ length: 32000 }, (_, i) => 'k' + i + ' = 1').join('\\n'));
      assert.equal(Object.keys(flat).length, 32000);
      assert.equal(flat.k31999, 1);
      assert.throws(() => parse('a=[1 #'), TomlError);
      assert.throws(() => parse('a = 1e+-2'), TomlError);
    `,
      ],
      { encoding: 'utf8', timeout: 3000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('Vercel Python discovery reads a comment-heavy pyproject through its public API', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-884-pyproject-'));
  try {
    await writeFile(
      path.join(fixture, 'pyproject.toml'),
      `${'# comment\n'.repeat(20_000)}[project]\nname = "api"\nversion = "1.0.0"\n`
    );
    const vercelRequire = getOwnerRequire('vercel');
    const buildRequire = createRequire(vercelRequire.resolve('@vercel/build-utils'));
    const { discoverPythonPackage } = buildRequire('@vercel/python-analysis');
    const result = await discoverPythonPackage({ entrypointDir: fixture, rootDir: fixture });
    assert.equal(result.manifest.path, 'pyproject.toml');
    assert.equal(result.manifest.data.project.name, 'api');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
