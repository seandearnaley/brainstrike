import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const floors = new Map([
  [1, [1, 21]],
  [2, [1, 7]],
  [3, [0, 9]],
  [5, [0, 12]],
]);

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('brace-expansion@'))
    .map((key) => key.slice('brace-expansion@'.length));
  assert.ok(versions.length > 0, 'expected brace-expansion in the graph');
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.split('.').map(Number);
    const floor = floors.get(major);
    assert.ok(floor, `review an unknown brace-expansion release line: ${version}`);
    assert.ok(
      minor > floor[0] || (minor === floor[0] && patch >= floor[1]),
      `vulnerable brace-expansion@${version}`
    );
  }
}

test('every brace-expansion copy clears the current advisory floors', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
});

test('brace-expansion graph guard rejects vulnerable and empty controls', () => {
  for (const version of [
    '1.1.15',
    '1.1.20',
    '2.1.1',
    '2.1.6',
    '3.0.8',
    '4.0.1',
    '5.0.9',
    '5.0.11',
  ]) {
    assert.throws(() => assertPatched({ packages: { [`brace-expansion@${version}`]: {} } }));
  }
  for (const version of ['1.1.21', '2.1.7', '3.0.9', '5.0.12']) {
    assertPatched({ packages: { [`brace-expansion@${version}`]: {} } });
  }
  assert.throws(() => assertPatched({ packages: {} }), /expected brace-expansion/);
});

const owners = [
  ['apps/web', ['serve', 'serve-handler', 'minimatch']],
  ['apps/desktop', ['electron-builder', 'app-builder-lib', '@electron/asar', 'minimatch']],
  ['apps/desktop', ['electron-builder', 'app-builder-lib', '@electron/universal', 'minimatch']],
  ['apps/desktop', ['electron-builder', 'app-builder-lib', 'minimatch']],
];

function requireOwner(base, chain) {
  let ownerRequire = createRequire(path.join(root, base, 'package.json'));
  for (const name of chain) {
    ownerRequire = createRequire(ownerRequire.resolve(`${name}/package.json`));
  }
  return ownerRequire;
}

for (const [base, chain] of owners) {
  const label = chain.join(' > ');
  test(`${label} preserves public glob expansion`, () => {
    const { braceExpand } = requireOwner(base, chain)('minimatch');
    assert.deepEqual(braceExpand('src/{api,ui}/file.{ts,tsx}'), [
      'src/api/file.ts',
      'src/api/file.tsx',
      'src/ui/file.ts',
      'src/ui/file.tsx',
    ]);
    assert.deepEqual(braceExpand('file{01..03}.ts'), ['file01.ts', 'file02.ts', 'file03.ts']);
    assert.deepEqual(braceExpand('literal\\{a,b\\}'), ['literal{a,b}']);
  });
  test(`${label} bounds reported brace attack shapes`, () => {
    const ownerRequire = requireOwner(base, chain);
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { braceExpand } = require(${JSON.stringify(ownerRequire.resolve('minimatch'))});
      assert.deepEqual(braceExpand('a' + '{},'.repeat(30) + '{}'),
        ['a' + '{},'.repeat(30) + '{}']);
      const nested = '{'.repeat(10000) + 'a,b' + '}'.repeat(10000);
      assert.doesNotThrow(() => braceExpand(nested));
      assert.doesNotThrow(() => braceExpand('{' + '{a},'.repeat(7000) + 'b}'));
      assert.doesNotThrow(() => braceExpand('{a}' + '}'.repeat(64000) + ',z}'));
    `,
      ],
      { encoding: 'utf8', timeout: 6000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}
