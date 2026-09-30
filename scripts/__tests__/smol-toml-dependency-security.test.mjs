import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(path.join(root, 'package.json'));
const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
const buildRequire = createRequire(vercelRequire.resolve('@vercel/build-utils'));
const owners = [
  ['vercel', vercelRequire],
  ['python-analysis', createRequire(buildRequire.resolve('@vercel/python-analysis'))],
  ['rust', createRequire(vercelRequire.resolve('@vercel/rust'))],
];

// GHSA-v3rj-xjv7-4jmq and GHSA-7w5x-hrqm-74c2: 1.7.1 clears both.
function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('smol-toml@'))
    .map((key) => key.slice('smol-toml@'.length));
  assert.ok(versions.length > 0, 'expected smol-toml in the graph');
  for (const version of versions) {
    assert.match(version, /^1\.\d+\.\d+$/, 'review an unknown smol-toml release line');
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(minor > 7 || (minor === 7 && patch >= 1), `vulnerable smol-toml@${version}`);
  }
}

test('the full graph excludes both TOML advisory ranges, with negative controls', async () => {
  assertPatched(parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['1.5.2', '1.6.1', '1.7.0']) {
    assert.throws(
      () => assertPatched({ packages: { [`smol-toml@${version}`]: {} } }),
      /vulnerable/
    );
  }
  assertPatched({ packages: { 'smol-toml@1.7.1': {}, 'smol-toml@1.8.0': {} } });
  assert.throws(() => assertPatched({ packages: {} }), /expected smol-toml/);
});

for (const [name, ownerRequire] of owners) {
  test(`${name}'s installed parser handles comment runs and rejects unterminated arrays`, () => {
    const entry = ownerRequire.resolve('smol-toml');
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { parse, stringify, TomlError } = require(${JSON.stringify(entry)});
      const value = { project: { name: 'api', version: '1.0.0' } };
      assert.deepEqual(parse(stringify(value)), value);
      assert.deepEqual(parse('# comment\\n'.repeat(20000) + 'key = "value"'), { key: 'value' });
      assert.throws(() => parse('a=[1 #'), TomlError);
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
    const { discoverPythonPackage } = buildRequire('@vercel/python-analysis');
    const result = await discoverPythonPackage({ entrypointDir: fixture, rootDir: fixture });
    assert.equal(result.manifest.path, 'pyproject.toml');
    assert.equal(result.manifest.data.project.name, 'api');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
