import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('uuid@'))
    .map((key) => key.slice('uuid@'.length));
  assert.ok(versions.length > 0, 'expected uuid in the graph');
  for (const version of versions) {
    assert.match(version, /^(11|12|13|14)\.\d+\.\d+$/, `review uuid@${version}`);
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      major === 14 ||
        (major === 11 ? minor > 1 || (minor === 1 && patch >= 1) : minor > 0 || patch >= 1),
      `vulnerable uuid@${version}`
    );
  }
}

test('every UUID copy clears the buffer-bounds advisory, with negative controls', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['10.0.0', '11.1.0', '12.0.0', '13.0.0']) {
    assert.throws(() => assertPatched({ packages: { [`uuid@${version}`]: {} } }));
  }
  assertPatched({
    packages: {
      'uuid@11.1.1': {},
      'uuid@12.0.1': {},
      'uuid@13.0.1': {},
      'uuid@14.0.0': {},
      'uuid@14.0.1': {},
    },
  });
  assert.throws(() => assertPatched({ packages: {} }), /expected uuid/);
});
