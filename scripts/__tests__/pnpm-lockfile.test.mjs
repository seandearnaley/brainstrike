import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const application = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      owner: {specifier: 1.0.0, version: 1.0.0}
packages:
  owner@1.0.0: {}
snapshots:
  owner@1.0.0: {}
`;
const manager = `lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.11.2, version: 12.11.2}
packages:
  pnpm@12.11.2: {}
snapshots:
  pnpm@12.11.2: {}
`;

test('pnpm 11 and pnpm 12 expose the same application dependency graph', () => {
  const expected = parsePnpmLockfile(application);
  assert.deepEqual(parsePnpmLockfile(`---\n${manager}\n---\n${application}`), expected);
  assert.deepEqual(Object.keys(expected.packages), ['owner@1.0.0']);
});

test('missing, ambiguous and malformed application documents fail visibly', () => {
  assert.throws(() => parsePnpmLockfile(manager), /exactly one application document/);
  assert.throws(
    () => parsePnpmLockfile(`${application}\n---\n${application}`),
    /exactly one application document/
  );
  assert.throws(() => parsePnpmLockfile(`${manager}\n---\nsettings: [broken`));
  assert.throws(() => parsePnpmLockfile('settings: {}\nimporters: {}'), /packages/);
});
