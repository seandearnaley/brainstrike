import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const lockfilePath = fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url));
const lockfile = parsePnpmLockfile(readFileSync(lockfilePath, 'utf8'));

test('every resolved tar copy clears BST-886 advisories', () => {
  const packageVersions = Object.keys(lockfile.packages)
    .filter((key) => key.startsWith('tar@'))
    .map((key) => key.slice(4));

  assert.ok(packageVersions.length > 0, 'expected tar in the lockfile');
  for (const version of packageVersions) {
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      major > 7 || (major === 7 && (minor > 5 || (minor === 5 && patch >= 21))),
      `tar@${version} is affected by at least one BST-886 advisory`
    );
  }

  for (const [parent, snapshot] of Object.entries(lockfile.snapshots)) {
    const resolved = snapshot.dependencies?.tar;
    if (resolved === undefined) {
      continue;
    }
    assert.ok(
      packageVersions.includes(resolved),
      `${parent} resolves tar@${resolved}, which has no audited package record`
    );
  }
});
