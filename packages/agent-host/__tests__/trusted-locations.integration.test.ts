/**
 * ADR-0032 trusted locations: a folder the person marked so that every folder
 * inside it reads as trusted without an ask. Only the person's explicit action
 * records one, as the parent of a folder they are trusting; a folder's own
 * answer still wins; and a folder is judged by where it really is, through the
 * host's own records, never by what it contains.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import {
  hostTrustedLocationOffer,
  readHostTrustedLocations,
  readHostWorkspaceTrust,
  readHostWorkspaceTrustAnswer,
  removeHostTrustedLocation,
  trustedHostWorkspaceRoots,
  writeHostWorkspaceTrust,
} from '../src/workspace-trust.js';
import { addManagedWorktree, recordWorktree, repositoryAt } from './fixtures/managed-worktree.js';

const dirs: string[] = [];
const stores: StateStore[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
async function closeHosts(): Promise<void> {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
}
afterEach(async () => {
  await closeHosts();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A fresh folder by its real path, the spelling trust is kept under. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function openStore(): Promise<StateStore> {
  const store = await StateStore.open(await tempDir('bs-trusted-locations-state-'));
  stores.push(store);
  return store;
}

/** A new folder named `name` inside `parent`. */
async function folderIn(parent: string, name: string): Promise<string> {
  const folder = join(parent, name);
  await mkdir(folder, { recursive: true });
  return folder;
}

/** A place a person keeps their repositories, and a home directory that is somewhere else. */
async function codeFolder(): Promise<{ readonly code: string; readonly home: string }> {
  return {
    code: await folderIn(await tempDir('bs-trusted-locations-'), 'code'),
    home: await tempDir('bs-trusted-locations-home-'),
  };
}

test('trusting a folder records no location unless the person asks for one', async () => {
  const store = await openStore();
  const { code } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  const later = await folderIn(code, 'later');

  await writeHostWorkspaceTrust(store, cloned, 'trusted');

  await expect(readHostTrustedLocations(store)).resolves.toEqual([]);
  await expect(readHostWorkspaceTrust(store, later)).resolves.toBe('undecided');
});

test('every folder inside a trusted location is trusted without an answer, and a folder outside it is not', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  const later = await folderIn(code, 'later');
  const nested = await folderIn(code, 'group/deeper');
  const outside = await folderIn(await tempDir('bs-trusted-locations-outside-'), 'download');
  // A neighbour whose name starts with the location's is not inside it.
  const neighbour = await folderIn(`${code}-review`, 'download');

  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });

  await expect(readHostTrustedLocations(store)).resolves.toEqual([code]);
  await expect(readHostWorkspaceTrust(store, later)).resolves.toBe('trusted');
  await expect(readHostWorkspaceTrust(store, nested)).resolves.toBe('trusted');
  await expect(readHostWorkspaceTrust(store, outside)).resolves.toBe('undecided');
  await expect(readHostWorkspaceTrust(store, neighbour)).resolves.toBe('undecided');
  // A run loads the configuration of the folders the location covers, and no others.
  const roots = [later, nested, outside, neighbour].map((path) => ({ path }));
  await expect(trustedHostWorkspaceRoots(store, roots)).resolves.toEqual([
    { path: later },
    { path: nested },
  ]);
  // The read says why a folder is trusted: through the location, or by its own answer.
  await expect(readHostWorkspaceTrustAnswer(store, later)).resolves.toMatchObject({
    trust: 'trusted',
    trustedThrough: code,
  });
  await expect(readHostWorkspaceTrustAnswer(store, cloned)).resolves.toMatchObject({
    trust: 'trusted',
    trustedThrough: undefined,
  });
});

test('a folder kept restricted inside a trusted location stays restricted', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  const suspect = await folderIn(code, 'suspect');
  await writeHostWorkspaceTrust(store, suspect, 'restricted');

  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });

  await expect(readHostWorkspaceTrustAnswer(store, suspect)).resolves.toMatchObject({
    trust: 'restricted',
    trustedThrough: undefined,
  });
  await expect(trustedHostWorkspaceRoots(store, [{ path: suspect }])).resolves.toEqual([]);
});

test('a symlink is judged by where it really is, not by where the link sits', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });
  const elsewhere = await tempDir('bs-trusted-locations-elsewhere-');
  const download = await folderIn(elsewhere, 'download');

  // A link inside the location that points outside it brings no trust.
  // A junction on Windows needs no privilege; POSIX ignores the type.
  await symlink(download, join(code, 'linked'), 'junction');
  await expect(readHostWorkspaceTrust(store, join(code, 'linked'))).resolves.toBe('undecided');
  // A link outside the location to a folder inside it is that folder.
  await symlink(await folderIn(code, 'later'), join(elsewhere, 'shortcut'), 'junction');
  await expect(readHostWorkspaceTrust(store, join(elsewhere, 'shortcut'))).resolves.toBe('trusted');
});

test("a managed worktree is trusted through a location by its repository's place, not its own", async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });

  // A repository inside the location, with its worktree kept elsewhere.
  const inside = await repositoryAt(await folderIn(code, 'app'));
  const insideWorktree = await addManagedWorktree(
    store,
    inside,
    await tempDir('bs-trusted-locations-worktrees-')
  );
  await expect(readHostWorkspaceTrust(store, insideWorktree.path)).resolves.toBe('trusted');

  // A repository outside the location, with its worktree put inside it.
  const outside = await repositoryAt(await tempDir('bs-trusted-locations-repo-'));
  const outsideWorktree = await addManagedWorktree(
    store,
    outside,
    await folderIn(code, 'worktrees')
  );
  await expect(readHostWorkspaceTrust(store, outsideWorktree.path)).resolves.toBe('undecided');
});

test('nothing a folder contains makes it trusted through a location or records one', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const repository = await repositoryAt(await folderIn(code, 'app'));
  await writeHostWorkspaceTrust(store, repository.path, 'trusted', { home, location: code });

  // A downloaded folder whose .git names the repository inside the location, as a worktree's does,
  // and which the ledger lists: the repository does not link it back.
  const downloaded = await tempDir('bs-trusted-locations-downloaded-');
  const claimed = await folderIn(downloaded, 'claimed');
  await writeFile(join(claimed, '.git'), `gitdir: ${repository.commonDir}/worktrees/claimed\n`);
  await recordWorktree(store, claimed, repository.commonDir);
  // It also carries files that name its own parent as a trusted location.
  await mkdir(join(claimed, '.brainstrike'));
  await writeFile(
    join(claimed, '.brainstrike', 'settings.json'),
    JSON.stringify({ trustedLocations: [downloaded], 'workspace.trust.locations': [downloaded] })
  );

  await expect(readHostWorkspaceTrust(store, claimed)).resolves.toBe('undecided');
  await expect(readHostTrustedLocations(store)).resolves.toEqual([code]);
});

test('a location is recorded only as the parent of the folder being trusted, and a refused request records nothing', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  const unrelated = await tempDir('bs-trusted-locations-unrelated-');

  // Another folder, the folder itself and a folder further up are not its parent.
  for (const location of [unrelated, cloned, join(code, '..')]) {
    await expect(
      writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location })
    ).rejects.toThrow(/is not the folder that holds/u);
  }
  await expect(
    writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: 'code' })
  ).rejects.toThrow(/absolute path/u);
  // "Keep restricted" never widens trust.
  await expect(
    writeHostWorkspaceTrust(store, cloned, 'restricted', { home, location: code })
  ).rejects.toThrow(/only with a trusted answer/u);

  await expect(readHostTrustedLocations(store)).resolves.toEqual([]);
  await expect(readHostWorkspaceTrust(store, cloned)).resolves.toBe('undecided');
});

test('the home directory, a folder that holds it and the top of the filesystem are never offered as a location', async () => {
  const store = await openStore();
  const base = await tempDir('bs-trusted-locations-users-');
  const home = await folderIn(base, 'sean');
  const inHome = await folderIn(home, 'notes');
  const besideHome = await folderIn(base, 'shared');
  const inCode = await folderIn(home, 'code/app');

  // A folder kept in a folder of its own inside the home directory is offered that folder.
  expect(hostTrustedLocationOffer(inCode, home)).toBe(join(home, 'code'));
  // Trusting everything in the home directory, or in a folder that holds it, is not offered.
  expect(hostTrustedLocationOffer(inHome, home)).toBeUndefined();
  expect(hostTrustedLocationOffer(besideHome, home)).toBeUndefined();
  expect(hostTrustedLocationOffer(home, home)).toBeUndefined();
  // Nor is the top of the filesystem, for a folder directly under it or the top itself.
  const { root } = parse(base);
  expect(hostTrustedLocationOffer(join(root, 'srv'), home)).toBeUndefined();
  expect(hostTrustedLocationOffer(root, home)).toBeUndefined();

  // The writer refuses what is never offered, and records neither the answer nor a location.
  await expect(
    writeHostWorkspaceTrust(store, inHome, 'trusted', { home, location: home })
  ).rejects.toThrow(/home directory/u);
  await expect(
    writeHostWorkspaceTrust(store, besideHome, 'trusted', { home, location: base })
  ).rejects.toThrow(/home directory/u);
  await expect(readHostTrustedLocations(store)).resolves.toEqual([]);
  await expect(readHostWorkspaceTrust(store, inHome)).resolves.toBe('undecided');
});

test('removing a location leaves explicit answers alone, and folders trusted only through it are undecided again', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const cloned = await folderIn(code, 'cloned');
  const later = await folderIn(code, 'later');
  const suspect = await folderIn(code, 'suspect');
  await writeHostWorkspaceTrust(store, suspect, 'restricted');
  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });
  await expect(readHostWorkspaceTrust(store, later)).resolves.toBe('trusted');

  await expect(removeHostTrustedLocation(store, code)).resolves.toBe(true);

  await expect(readHostTrustedLocations(store)).resolves.toEqual([]);
  await expect(readHostWorkspaceTrust(store, later)).resolves.toBe('undecided');
  await expect(readHostWorkspaceTrust(store, cloned)).resolves.toBe('trusted');
  await expect(readHostWorkspaceTrust(store, suspect)).resolves.toBe('restricted');
  // Removing it again changes nothing, and says so.
  await expect(removeHostTrustedLocation(store, code)).resolves.toBe(false);
});

test('a location whose folder is gone can still be removed, and trusting two folders in one place keeps it once', async () => {
  const store = await openStore();
  const { code, home } = await codeFolder();
  const first = await folderIn(code, 'first');
  const second = await folderIn(code, 'second');
  // Each ask may offer the same parent; through a symlink it is still that folder.
  const link = join(await tempDir('bs-trusted-locations-link-'), 'code');
  await symlink(code, link, 'junction');
  await writeHostWorkspaceTrust(store, first, 'trusted', { home, location: code });
  await writeHostWorkspaceTrust(store, second, 'trusted', { home, location: `${link}/` });
  await expect(readHostTrustedLocations(store)).resolves.toEqual([code]);

  await rm(code, { force: true, recursive: true });
  await expect(removeHostTrustedLocation(store, code)).resolves.toBe(true);
  await expect(readHostTrustedLocations(store)).resolves.toEqual([]);
});

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () => {
    throw new Error('Workspace trust never resolves a model');
  },
  tools: {},
};

async function open(root: string): Promise<HostClient> {
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

test('a client records a location with its answer, lists it after a host restart and removes it', async () => {
  const stateRoot = await tempDir('bs-trusted-locations-host-');
  const code = await folderIn(await tempDir('bs-trusted-locations-wire-'), 'code');
  const cloned = await folderIn(code, 'cloned');
  const later = await folderIn(code, 'later');
  let client = await open(stateRoot);
  await expect(client.request('workspace/trust/locations', {})).resolves.toEqual({
    locations: [],
  });

  // Naming a folder that is not the parent is refused, and trusts nothing.
  await expect(
    client.request('workspace/trust', { location: later, path: cloned, trust: 'trusted' })
  ).rejects.toMatchObject({
    failure: { code: 'workspace.trust-refused', kind: 'refusal' },
    message: /is not the folder that holds/u,
  });
  await expect(client.request('workspace/trust/read', { path: cloned })).resolves.toEqual({
    trust: 'undecided',
  });

  await expect(
    client.request('workspace/trust', { location: code, path: cloned, trust: 'trusted' })
  ).resolves.toEqual({ trust: 'trusted' });
  await expect(client.request('workspace/trust/read', { path: later })).resolves.toEqual({
    trust: 'trusted',
  });

  await closeHosts();
  client = await open(stateRoot);
  await expect(client.request('workspace/trust/locations', {})).resolves.toEqual({
    locations: [{ path: code }],
  });
  await expect(client.request('workspace/trust/read', { path: later })).resolves.toEqual({
    trust: 'trusted',
  });

  await expect(client.request('workspace/trust/locations/remove', { path: code })).resolves.toEqual(
    { removed: true }
  );
  await expect(client.request('workspace/trust/read', { path: later })).resolves.toEqual({
    trust: 'undecided',
  });
  await expect(client.request('workspace/trust/read', { path: cloned })).resolves.toEqual({
    trust: 'trusted',
  });
});
