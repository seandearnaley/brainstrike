import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(path.join(root, 'package.json'));
const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
const owners = [
  ['@vercel/node', 6],
  ['@vercel/remix-builder', 6],
  ['@vercel/backends', 8],
  ['@vercel/express', 8],
  ['@vercel/hono', 8],
  ['@vercel/fun', 8],
];

// GHSA-9wv6-86v2-598j, GHSA-27v5-c462-wpq7, GHSA-j3q9-mxjg-w52f.
function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('path-to-regexp@'))
    .map((key) => key.slice('path-to-regexp@'.length));
  assert.ok(versions.length > 0, 'expected path-to-regexp in the graph');
  for (const version of versions) {
    assert.match(version, /^[368]\.\d+\.\d+$/, 'review an unknown route parser release line');
    const [major, minor] = version.split('.').map(Number);
    assert.ok(minor >= (major === 8 ? 4 : 3), `vulnerable path-to-regexp@${version}`);
  }
}

test('every route parser clears its own major advisory floor, with negative controls', async () => {
  assertPatched(parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['3.2.0', '6.1.0', '6.2.2', '8.2.0', '8.3.0']) {
    assert.throws(
      () => assertPatched({ packages: { [`path-to-regexp@${version}`]: {} } }),
      /vulnerable/
    );
  }
  assertPatched({
    packages: {
      'path-to-regexp@3.3.0': {},
      'path-to-regexp@6.3.0': {},
      'path-to-regexp@8.4.2': {},
    },
  });
  assert.throws(() => assertPatched({ packages: {} }), /expected path-to-regexp/);
});

for (const [owner, major] of owners) {
  test(`${owner} preserves routes and bounds unsafe patterns on its existing major`, () => {
    const ownerRequire = createRequire(vercelRequire.resolve(owner));
    const entry = ownerRequire.resolve('path-to-regexp');
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { match, compile, pathToRegexp } = require(${JSON.stringify(entry)});
      assert.equal(compile('/users/:id', { encode: encodeURIComponent })({ id: 'a b' }), '/users/a%20b');
      assert.equal(match('/users/:id')('/users/42').params.id, '42');
      assert.equal(match('/users/:id')('/projects/42'), false);
      if (${major} === 6) {
        assert.equal(match('/users/:id?')('/users').path, '/users');
        assert.deepEqual(match('/files/:parts*')('/files/a/b').params.parts, ['a', 'b']);
        assert.equal(pathToRegexp('/:a-:b').test('/a' + '-a'.repeat(80000) + '/a'), false);
      } else {
        assert.equal(match('/users{/:id}')('/users').path, '/users');
        assert.deepEqual(match('/files/*parts')('/files/a/b').params.parts, ['a', 'b']);
        assert.throws(() => pathToRegexp('/x' + '{/a}'.repeat(9)), /Too many path combinations/);
        const { regexp } = pathToRegexp('/*foo-*bar-:baz', { trailing: false });
        assert.equal(regexp.test('/a-b-c'), true);
        assert.equal(regexp.test('/a' + '-a'.repeat(20000) + '/'), false);
      }
    `,
      ],
      { encoding: 'utf8', timeout: 6000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}
