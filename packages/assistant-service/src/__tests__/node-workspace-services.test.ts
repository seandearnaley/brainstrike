import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import {
  type NodeWorkspaceProfileOwner,
  type NodeWorkspaceProfileSelection,
  type NodeWorkspaceServices,
  type NodeWorkspaceServicesStartup,
  openNodeWorkspaceServices,
} from '../node-workspace-services';

const ROOT_ID = '630ae8f2-854e-41bc-86ab-e446aa02d063';
const OTHER_ID = '6f936fb9-1b3a-4491-9010-f8af5ba55e8b';
const fixtures: { close(): Promise<void>; directory: string; lock: RootLock }[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    fixture.lock.release();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

async function prepare() {
  const directory = await mkdtemp(path.join(tmpdir(), 'bs-m3-node-workspace-borrow-'));
  const profileDirectory = path.join(directory, 'profiles', 'selected');
  const workspace = path.join(directory, 'workspace');
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(workspace);
  const lock = await RootLock.acquire(profileDirectory);
  const root = { displayName: 'Existing root', path: workspace, rootId: ROOT_ID };
  let roots: readonly RuntimeWorkspaceRoot[] = [root];
  const controller = new AbortController();
  const joins: (() => Promise<void>)[] = [];
  const startup: NodeWorkspaceServicesStartup = {
    register: async (join) => {
      joins.push(join);
    },
    signal: new AbortController().signal,
    store: { lock, root: lock.owner.root },
  };
  // A recording port tests borrower ownership, not native/catalog qualification.
  const retire = vi.fn(async () => {
    controller.abort(new Error('Borrow retired'));
  });
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: await realpath(workspace),
    generation: 'existing-mount-generation',
    listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
    readFile: async () => ({ status: 'not-found' }),
    retire,
    rootId: ROOT_ID,
    signal: controller.signal,
    subscribe: async () => ({ close: async () => undefined }),
  };
  const database = { exactExistingCatalog: true };
  let location: NodeWorkspaceProfileSelection = {
    profile: 'selected',
    rootPath: directory,
    source: 'override',
  };
  const owner: NodeWorkspaceProfileOwner<typeof database> = {
    borrowSourceRoot: vi.fn(async () => lease),
    close: vi.fn(async () => undefined),
    database,
    get location() {
      return location;
    },
    profileDirectory,
    readRoots: vi.fn(async () => roots),
  };
  const close = async (): Promise<void> => {
    for (const join of joins) {
      await join();
    }
  };
  fixtures.push({ close, directory, lock });
  return {
    controller,
    database,
    joins,
    lease,
    lock,
    open: () => openNodeWorkspaceServices(startup, async () => owner),
    owner,
    retire,
    root,
    setLocation: (next: NodeWorkspaceProfileSelection) => {
      location = next;
    },
    setRoots: (next: readonly RuntimeWorkspaceRoot[]) => {
      roots = next;
    },
    startup,
  };
}

test('registers before acquisition and retains the selected owner and exact same lease', async () => {
  const f = await prepare();
  const service = await openNodeWorkspaceServices(f.startup, async () => {
    expect(f.joins).toHaveLength(1);
    expect(f.lock.isReleased).toBe(false);
    return f.owner;
  });
  expect(service.location).toBe(f.owner.location);
  expect(service.profileDirectory).toBe(f.owner.profileDirectory);
  expect(await service.readRoots()).toEqual([f.root]);
  expect(await service.borrowRoot(ROOT_ID)).toBe(f.lease);
  expect(await service.borrowRoot(ROOT_ID)).toBe(f.lease);
  expect(f.owner.borrowSourceRoot).toHaveBeenCalledTimes(1);
  expect(await service.withCatalog(async (database) => database)).toBe(f.database);
  await service.close();
  expect(f.retire).toHaveBeenCalledTimes(1);
  expect(f.owner.close).toHaveBeenCalledTimes(1);
  expect(f.lock.isReleased).toBe(false);
});

test('refuses unknown IDs, paths, revoked live IDs and disconnected captured roots', async () => {
  const f = await prepare();
  const service = await f.open();
  await expect(service.borrowRoot('')).rejects.toThrow('canonical root ID');
  await expect(service.borrowRoot(f.root.path)).rejects.toThrow('unavailable in the live catalog');
  await expect(service.borrowRoot(OTHER_ID)).rejects.toThrow('unavailable in the live catalog');
  expect(f.owner.borrowSourceRoot).not.toHaveBeenCalled();
  expect(await service.revalidate([ROOT_ID])).toEqual([f.root]);
  expect(await service.borrowRoot(ROOT_ID)).toBe(f.lease);
  f.setRoots([]);
  await expect(service.revalidate([ROOT_ID])).rejects.toThrow('unavailable in the live catalog');
  await expect(service.borrowRoot(ROOT_ID)).rejects.toThrow('unavailable in the live catalog');
  expect(f.owner.borrowSourceRoot).toHaveBeenCalledTimes(1);
});

test('a disconnect during acquisition never publishes or drops the acquired lease', async () => {
  const f = await prepare();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.owner.borrowSourceRoot = vi.fn(async () => {
    admitted.resolve();
    await release.promise;
    return f.lease;
  });
  const service = await f.open();
  const borrow = service.borrowRoot(ROOT_ID);
  void borrow.catch(() => undefined);
  await admitted.promise;
  f.setRoots([]);
  release.resolve();
  await expect(borrow).rejects.toThrow('unavailable in the live catalog');
  await service.close();
  expect(f.retire).toHaveBeenCalledTimes(1);
  expect(f.owner.close).toHaveBeenCalledTimes(1);
});

test('close joins a late acquisition, then retires its lease before the profile', async () => {
  const f = await prepare();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  f.owner.borrowSourceRoot = vi.fn(async () => {
    admitted.resolve();
    await release.promise;
    events.push('acquired');
    return f.lease;
  });
  f.lease.retire = vi.fn(async () => {
    events.push('retired');
  });
  f.owner.close = vi.fn(async () => {
    events.push('profile');
  });
  const service = await f.open();
  const borrow = service.borrowRoot(ROOT_ID);
  void borrow.catch(() => undefined);
  await admitted.promise;
  const close = service.close();
  expect(service.close()).toBe(close);
  expect(events).toEqual([]);
  await expect(service.readRoots()).rejects.toThrow('closing');
  release.resolve();
  await expect(borrow).rejects.toThrow('closing');
  await close;
  expect(events).toEqual(['acquired', 'retired', 'profile']);
});

test('close waits for catalog operations before closing the existing writer', async () => {
  const f = await prepare();
  const service = await f.open();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const query = service.withCatalog(async (database) => {
    expect(database).toBe(f.database);
    admitted.resolve();
    await release.promise;
    return 'result';
  });
  void query.catch(() => undefined);
  await admitted.promise;
  const close = service.close();
  expect(f.owner.close).not.toHaveBeenCalled();
  release.resolve();
  await expect(query).rejects.toThrow('closing');
  await close;
  expect(f.owner.close).toHaveBeenCalledTimes(1);
});

test('failed borrow retirement retains its failure, profile and Root without automatic retry', async () => {
  const f = await prepare();
  const failure = new Error('Native lease close failed');
  f.lease.retire = vi.fn(async () => {
    throw failure;
  });
  const service = await f.open();
  await service.borrowRoot(ROOT_ID);
  const close = service.close();
  await expect(close).rejects.toMatchObject({ errors: [failure] });
  expect(service.close()).toBe(close);
  expect(f.lease.retire).toHaveBeenCalledTimes(1);
  expect(f.owner.close).not.toHaveBeenCalled();
  expect(f.lock.isReleased).toBe(false);
  // Explicit fixture cleanup after verifying the retained failed promise.
  const fixture = fixtures.at(-1);
  if (!fixture) {
    throw new Error('Fixture owner was not registered');
  }
  fixture.close = () => f.owner.close();
});

test('a different selected profile fails before catalog use and joins acquisition cleanup', async () => {
  const f = await prepare();
  f.setLocation({ ...f.owner.location, profile: 'other' });
  await expect(f.open()).rejects.toThrow();
  expect(f.owner.readRoots).not.toHaveBeenCalled();
  expect(f.owner.close).toHaveBeenCalledTimes(1);
});

test('accepts a presentation alias of the captured Root identity', async () => {
  const f = await prepare();
  const alias = path.join(f.owner.location.rootPath, 'profile-alias');
  await symlink(f.owner.profileDirectory, alias, 'dir');
  const startup = { ...f.startup, store: { lock: f.lock, root: alias } };
  const service = await openNodeWorkspaceServices(startup, async () => f.owner);
  expect(await realpath(service.profileDirectory)).toBe(f.lock.owner.root);
  expect(startup.store.root).not.toBe(f.lock.owner.root);
  expect(await service.withCatalog(async (database) => database)).toBe(f.database);
  await service.close();
  expect(f.lock.isReleased).toBe(false);
});

test('rejects a retargeted presentation alias and joins the mismatched acquired profile', async () => {
  const f = await prepare();
  const alias = path.join(f.owner.location.rootPath, 'profile-alias');
  const otherProfile = path.join(f.owner.location.rootPath, 'profiles', 'other');
  await mkdir(otherProfile);
  await symlink(f.owner.profileDirectory, alias, 'dir');
  const startup = { ...f.startup, store: { lock: f.lock, root: alias } };
  await unlink(alias);
  await symlink(otherProfile, alias, 'dir');
  const owner = {
    ...f.owner,
    location: { ...f.owner.location, profile: 'other' },
    profileDirectory: otherProfile,
  };
  expect(await realpath(alias)).toBe(await realpath(otherProfile));
  expect(f.lock.owner.root).toBe(await realpath(f.owner.profileDirectory));
  await expect(openNodeWorkspaceServices(startup, async () => owner)).rejects.toThrow(
    'acquired canonical Root'
  );
  expect(owner.close).toHaveBeenCalledTimes(1);
  expect(owner.readRoots).not.toHaveBeenCalled();
  expect(f.lock.isReleased).toBe(false);
});

test('Root revocation refuses fresh catalog use without releasing another owner', async () => {
  const f = await prepare();
  const service: NodeWorkspaceServices<typeof f.database> = await f.open();
  f.lock.release();
  await expect(service.readRoots()).rejects.toThrow('Root was released');
  await expect(service.withCatalog(async () => 'unexpected')).rejects.toThrow('Root was released');
  await service.close();
  expect(f.owner.close).toHaveBeenCalledTimes(1);
});

test('startup close joins an admitted late profile and refuses its publication', async () => {
  const f = await prepare();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opening = openNodeWorkspaceServices(f.startup, async () => {
    admitted.resolve();
    await release.promise;
    return f.owner;
  });
  void opening.catch(() => undefined);
  await admitted.promise;
  const registeredClose = f.joins[0];
  if (!registeredClose) {
    throw new Error('Startup join was not registered');
  }
  const close = registeredClose();
  expect(f.owner.close).not.toHaveBeenCalled();
  release.resolve();
  await expect(opening).rejects.toThrow('closing');
  await close;
  expect(f.owner.close).toHaveBeenCalledTimes(1);
  expect(f.lock.isReleased).toBe(false);
});

test('a mismatched acquired mount is retained for retirement and never published', async () => {
  const f = await prepare();
  f.owner.borrowSourceRoot = vi.fn(async () => ({ ...f.lease, rootId: OTHER_ID }));
  const service = await f.open();
  await expect(service.borrowRoot(ROOT_ID)).rejects.toThrow('pinned canonical mount');
  await service.close();
  expect(f.retire).toHaveBeenCalledTimes(1);
  expect(f.owner.close).toHaveBeenCalledTimes(1);
});

test('revalidation refuses a revoked captured lease even while its catalog ID remains live', async () => {
  const f = await prepare();
  const service = await f.open();
  await service.borrowRoot(ROOT_ID);
  const revoked = new Error('Existing mounted capability was revoked');
  f.controller.abort(revoked);
  await expect(service.revalidate([ROOT_ID])).rejects.toBe(revoked);
  expect(f.owner.borrowSourceRoot).toHaveBeenCalledTimes(1);
});

test('revalidation cannot retarget a captured ID to a replacement catalog path', async () => {
  const f = await prepare();
  const service = await f.open();
  await service.borrowRoot(ROOT_ID);
  const replacement = path.join(f.owner.location.rootPath, 'replacement');
  await mkdir(replacement);
  f.setRoots([{ ...f.root, path: replacement }]);
  await expect(service.revalidate([ROOT_ID])).rejects.toThrow('pinned canonical mount');
  expect(f.owner.borrowSourceRoot).toHaveBeenCalledTimes(1);
});
