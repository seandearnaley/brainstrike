import assert from 'node:assert/strict';
import { access, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  joinProfileDirectory,
  openExistingNodeWorkspaceServices,
} from '@brainstrike/assistant-service/node-workspace-services';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { sendFixtureResult } from './fixture-result.mjs';

const [mode, fixture] = process.argv.slice(2);
assert.ok(mode === 'retarget' || mode === 'stable-alias');
assert.ok(fixture);
assert.equal(process.versions.electron, undefined);
const locationA = { profile: 'selected', rootPath: path.join(fixture, 'a'), source: 'test' };
const locationB = { ...locationA, rootPath: path.join(fixture, 'b') };
const profileA = await realpath(joinProfileDirectory(locationA.rootPath, locationA.profile));
const profileB = await realpath(joinProfileDirectory(locationB.rootPath, locationB.profile));
const alias = path.join(fixture, 'profile-alias');
await symlink(profileA, alias, 'dir');
let store;
let services;
const joins = [];
let report;
try {
  store = await StateStore.open(alias, { home: fixture });
  assert.equal(store.root, alias);
  assert.equal(store.lock.owner.root, profileA);
  if (mode === 'retarget') {
    await unlink(alias);
    await symlink(profileB, alias, 'dir');
  }
  const location = mode === 'retarget' ? locationB : locationA;
  const selectedProfile = mode === 'retarget' ? profileB : profileA;
  assert.equal(await realpath(store.root), selectedProfile);
  const ledger = path.join(
    location.rootPath,
    'explicit-existing-user-data',
    'electron-storage.json'
  );
  const originalLedger = await readFile(ledger, 'utf8');
  let grantReads = 0;
  let rejection;
  try {
    services = await openExistingNodeWorkspaceServices(
      {
        register: async (close) => {
          joins.push(close);
        },
        signal: new AbortController().signal,
        store,
      },
      {
        disposeCommandSessionsForRoot: async () => 0,
        evictLspServersForRoot: async () => undefined,
        grants: {
          getItem: async (key) => {
            grantReads += 1;
            return JSON.parse(await readFile(ledger, 'utf8'))[key] ?? null;
          },
        },
        location,
        subscribe: async () => {
          throw new Error('This read fixture supplies no subscription owner.');
        },
      }
    );
  } catch (cause) {
    rejection = cause instanceof Error ? cause.message : String(cause);
  }
  let catalogPaths;
  const pgLockDuringAttempt = false;
  if (services) {
    catalogPaths = await services.withCatalog(async (database) => {
      const { roots } = await database.workspaceRoots({ operation: 'list' });
      return roots
        .filter((root) => root.id === '630ae8f2-854e-41bc-86ab-e446aa02d063')
        .map((root) => root.path);
    });
    await assert.rejects(access(path.join(selectedProfile, '.db-process.lock')));
    await assert.rejects(access(path.join(selectedProfile, 'pgdata')));
  } else {
    await assert.rejects(access(path.join(selectedProfile, '.db-process.lock')));
  }
  assert.equal(store.lock.isReleased, false);
  const heldOwner = RootLock.inspect(profileA)?.owner;
  assert.equal(heldOwner?.token, store.lock.owner.token);
  assert.equal(heldOwner?.root, profileA);
  assert.notEqual(heldOwner?.released, true);
  assert.equal(RootLock.inspect(profileB)?.owner.released, true);
  assert.equal(await readFile(ledger, 'utf8'), originalLedger);
  report = {
    capturedRoot: store.lock.owner.root,
    catalogPaths,
    electron: false,
    grantReads,
    mode,
    opened: Boolean(services),
    pgLockDuringAttempt,
    profileA,
    profileB,
    rejection,
    selectedProfile,
  };
} finally {
  await services?.close();
  for (const join of joins) {
    await join();
  }
  if (store) {
    assert.equal(store.lock.isReleased, false);
    await store.close();
    assert.equal(store.lock.isReleased, true);
    assert.equal(RootLock.inspect(profileA)?.owner.released, true);
    await assert.rejects(access(path.join(profileA, '.db-process.lock')));
    await assert.rejects(access(path.join(profileB, '.db-process.lock')));
  }
}
await sendFixtureResult({ ...report, physicallyJoined: true });
