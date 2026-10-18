import assert from 'node:assert/strict';
import { access, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  joinProfileDirectory,
  openExistingNodeWorkspaceServices,
} from '@brainstrike/assistant-service/node-workspace-services';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { sendFixtureResult } from './fixture-result.mjs';

const [mode, fixture] = process.argv.slice(2);
assert.ok(mode && fixture);
assert.equal(process.versions.electron, undefined);
const location = { profile: 'selected', rootPath: fixture, source: 'test' };
const profile = joinProfileDirectory(location.rootPath, location.profile);
const workspace = path.join(fixture, 'workspace');
const userData = path.join(fixture, 'explicit-existing-user-data');
const ledger = path.join(userData, 'electron-storage.json');
const rootId = '630ae8f2-854e-41bc-86ab-e446aa02d063';
const aliasId = '6f936fb9-1b3a-4491-9010-f8af5ba55e8b';
const alias = path.join(fixture, 'existing-alias');
let services;
let store;
try {
  if (mode === 'seed') {
    await mkdir(profile, { recursive: true });
    await mkdir(workspace);
    await mkdir(userData);
    await writeFile(path.join(workspace, 'inside.txt'), 'actual pinned native bytes');
    await symlink(workspace, alias, 'dir');
  }
  store = await StateStore.open(profile, { home: fixture });
  if (mode === 'seed') {
    for (const [preferredId, rootPath, displayName] of [
      [rootId, workspace, 'Existing root'],
      [aliasId, alias, 'Existing alias'],
    ]) {
      await store.workspaceRoots({
        operation: 'register',
        root: { displayName, path: rootPath, preferredId },
      });
    }
    const roots = [
      { addedAt: 1_728_000_000_000, path: workspace, rootId },
      { addedAt: 1_728_000_000_001, path: alias, rootId: aliasId },
    ];
    // Exact existing storage envelope, explicitly fixture-owned; no product storage writer is used.
    await writeFile(
      ledger,
      JSON.stringify({
        lastFolderPath: workspace,
        recentRootsList: '[]',
        rootsList: JSON.stringify(roots),
      })
    );
    await store.close();
    store = undefined;
    await sendFixtureResult({ aliasId, electron: false, rootId, seeded: true });
  } else {
    const joins = [];
    const originalLedger = await readFile(ledger, 'utf8');
    const startup = {
      register: async (close) => {
        joins.push(close);
      },
      signal: new AbortController().signal,
      store,
    };
    const options = {
      disposeCommandSessionsForRoot: async () => 0,
      evictLspServersForRoot: async () => undefined,
      grants: { getItem: async (key) => JSON.parse(await readFile(ledger, 'utf8'))[key] ?? null },
      location,
      subscribe: async () => {
        throw new Error('This native read fixture supplies no subscription owner.');
      },
    };
    services = await openExistingNodeWorkspaceServices(startup, options);
    assert.equal(services.profileDirectory, await realpath(profile));
    assert.equal(services.location.profile, 'selected');
    assert.equal(joins.length, 1);
    await assert.rejects(
      openExistingNodeWorkspaceServices(startup, options),
      /already has a cold workspace owner/
    );
    await mkdir(joinProfileDirectory(fixture, 'wrong-profile'));
    await assert.rejects(
      openExistingNodeWorkspaceServices(startup, {
        ...options,
        location: { ...location, profile: 'wrong-profile' },
      }),
      /acquired canonical Root/
    );
    await assert.rejects(
      access(path.join(joinProfileDirectory(fixture, 'wrong-profile'), 'pgdata'))
    );
    const roots = await services.readRoots();
    assert.deepEqual(
      roots.map((root) => root.rootId),
      [rootId]
    );
    const catalog = await services.withCatalog(async (owner) => owner);
    assert.equal(catalog, store);
    await assert.rejects(access(path.join(profile, 'pgdata')));
    const lease = await services.borrowRoot(rootId);
    assert.equal(lease, await services.borrowRoot(rootId));
    const context = { requestId: 'actual-cold-native-read', signal: new AbortController().signal };
    const result = await lease.readFile('inside.txt', 100, context);
    assert.equal(result.status, 'ok');
    assert.equal(Buffer.from(result.content).toString('utf8'), 'actual pinned native bytes');
    assert.deepEqual(await lease.readFile('inside.txt', 3, context), { status: 'oversized' });
    await assert.rejects(services.borrowRoot(aliasId));
    assert.equal(await readFile(ledger, 'utf8'), originalLedger);
    const aliasRow = await services.withCatalog((owner) =>
      owner.workspaceRoots({ operation: 'list' })
    );
    assert.equal(aliasRow.roots.find((root) => root.id === aliasId)?.status, 'disconnected');
    if (mode === 'revoke') {
      const updated = JSON.parse(originalLedger);
      updated.rootsList = '[]';
      // Simulate the existing explicit grant owner revoking its fixture ledger.
      await writeFile(ledger, JSON.stringify(updated));
      assert.deepEqual(await services.readRoots(), []);
      assert.equal(lease.signal.aborted, true);
      await assert.rejects(services.revalidate([rootId]));
      await assert.rejects(lease.readFile('inside.txt', 100, context));
      const row = await services.withCatalog((owner) =>
        owner.workspaceRoots({ operation: 'list' })
      );
      assert.equal(row.roots.find((root) => root.id === rootId)?.status, 'disconnected');
    } else {
      await symlink('inside.txt', path.join(workspace, 'inside-link.txt'));
      assert.deepEqual(await lease.readFile('inside-link.txt', 100, context), {
        status: 'unreadable',
      });
      const replacement = path.join(fixture, 'replacement');
      await mkdir(replacement);
      await writeFile(path.join(replacement, 'inside.txt'), 'replacement must not be read');
      await rename(workspace, path.join(fixture, 'parked-original'));
      await symlink(replacement, workspace, 'dir');
      await assert.rejects(services.revalidate([rootId]));
      await assert.rejects(services.borrowRoot(rootId));
      await assert.rejects(lease.readFile('inside.txt', 100, context));
    }
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let admitted;
    const entered = new Promise((resolve) => {
      admitted = resolve;
    });
    const pending = services.withCatalog(async (db) => {
      await db.workspaceRoots({ operation: 'list' });
      admitted();
      await gate;
    });
    const rejected = assert.rejects(pending);
    await entered;
    const closing = services.close();
    assert.equal(closing, services.close());
    await assert.rejects(access(path.join(profile, '.db-process.lock')));
    assert.equal(store.lock.isReleased, false);
    release();
    await rejected;
    await closing;
    for (const join of joins) {
      await join();
    }
    assert.equal(lease.signal.aborted, true);
    assert.equal(store.lock.isReleased, false);
    await assert.rejects(access(path.join(profile, '.db-process.lock')));
    await assert.rejects(
      openExistingNodeWorkspaceServices(startup, {
        ...options,
        grants: { getItem: async () => '{malformed existing ledger' },
      })
    );
    await assert.rejects(access(path.join(profile, '.db-process.lock')));
    assert.equal(store.lock.isReleased, false);
    const previousGeneration = store.lock.gen;
    await store.close();
    assert.equal(store.lock.isReleased, true);
    assert.equal(RootLock.inspect(profile)?.owner.released, true);
    store = undefined;
    const nextOwner = await RootLock.acquire(profile);
    assert.ok(nextOwner.gen > previousGeneration);
    nextOwner.release();
    services = undefined;
    await sendFixtureResult({
      aliasRefused: true,
      catalogPreserved: true,
      electron: false,
      joined: true,
      mode,
      preferencesUnchanged: mode !== 'revoke',
      rootId,
      sameLease: true,
      secondWriterRefused: true,
      wrongProfileRefused: true,
    });
  }
} finally {
  await services?.close();
  await store?.close();
}
