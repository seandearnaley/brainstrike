/**
 * ADR-0032, ADR-0034 decision 6: `workspace/trust/list` names the folder that
 * answers for each open folder. A managed worktree shares its repository's
 * answer, so the composer and Settings ask about, and show, the repository
 * once. Real git builds the worktrees, since git's own links decide it. The
 * list also says which trusted location a folder is trusted through, and which
 * parent a trust ask may offer as one.
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addManagedWorktree,
  recordWorktree,
  repositoryAt,
} from '@brainstrike/agent-host/test-fixtures/managed-worktree';
import { writeHostWorkspaceTrust } from '@brainstrike/agent-host/workspace-trust';
import type { RuntimeWorkspaceRoot } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { discoverWorkspaceTrust } from '../../src/workspace-context/workspace-discovery.ts';

const dirs: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A fresh folder by its real path, the spelling the ledger keeps. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function openStore(): Promise<StateStore> {
  const store = await StateStore.open(await tempDir('bs-trust-list-state-'));
  stores.push(store);
  return store;
}

/** The trust list over `roots`, in folders that hold no agent configuration. */
async function listTrust(store: StateStore, roots: readonly RuntimeWorkspaceRoot[]) {
  const result = await discoverTrust(store, roots, await tempDir('bs-trust-list-home-'));
  return result.roots.map(({ answeredBy, rootId, trust }) => ({ answeredBy, rootId, trust }));
}

/** Each listed folder's trust, the location it is trusted through and the parent its ask offers. */
async function listLocations(
  store: StateStore,
  roots: readonly RuntimeWorkspaceRoot[],
  home: string
) {
  const result = await discoverTrust(store, roots, home);
  return result.roots.map(({ offeredLocation, rootId, trust, trustedThrough }) => ({
    offeredLocation,
    rootId,
    trust,
    trustedThrough,
  }));
}

function discoverTrust(store: StateStore, roots: readonly RuntimeWorkspaceRoot[], home: string) {
  const none = { inspected: 0, truncated: false };
  return discoverWorkspaceTrust(
    {
      commands: () => ({
        dispose: () => undefined,
        listDir: () => null,
        readFile: () => ({ ok: false, reason: 'unreadable' }),
      }),
      homedir: () => home,
      readFile: async ({ requestedPath }) => {
        throw Object.assign(new Error(`ENOENT: ${requestedPath}`), { code: 'ENOENT' });
      },
      roots: async () => roots,
      skills: () => ({
        listDir: () => ({ entries: [], ...none }),
        readFileBytes: () => ({ ok: false, reason: 'unreadable' }),
        readFileText: () => ({ ok: false, reason: 'unreadable' }),
      }),
      trust: store,
    },
    new AbortController().signal
  );
}

test('an open worktree is listed as answered by its open repository, under the name and path that one is listed with', async () => {
  const store = await openStore();
  const repository = await repositoryAt(await tempDir('bs-trust-list-repo-'));
  const worktree = await addManagedWorktree(store, repository, await tempDir('bs-trust-list-wt-'));
  await writeHostWorkspaceTrust(store, worktree.path, 'trusted');
  // The repository was opened through a symlink, so its entry's path is not its real one.
  const opened = path.join(await tempDir('bs-trust-list-link-'), 'app');
  await symlink(repository.path, opened);

  await expect(
    listTrust(store, [
      { displayName: 'Brainstrike app', path: opened, rootId: 'root-repository' },
      { displayName: 'swift-badger', path: worktree.path, rootId: 'root-worktree' },
    ])
  ).resolves.toEqual([
    // The repository answers for itself; the answer given in the worktree is its own.
    { answeredBy: undefined, rootId: 'root-repository', trust: 'trusted' },
    {
      answeredBy: { displayName: 'Brainstrike app', path: opened },
      rootId: 'root-worktree',
      trust: 'trusted',
    },
  ]);
});

test('a worktree whose repository is not open still names the repository that answers for it', async () => {
  const store = await openStore();
  const repository = await repositoryAt(await tempDir('bs-trust-list-repo-'));
  const worktree = await addManagedWorktree(store, repository, await tempDir('bs-trust-list-wt-'));

  await expect(
    listTrust(store, [
      { displayName: 'swift-badger', path: worktree.path, rootId: 'root-worktree' },
    ])
  ).resolves.toEqual([
    {
      answeredBy: { displayName: path.basename(repository.path), path: repository.path },
      rootId: 'root-worktree',
      trust: 'undecided',
    },
  ]);
});

test('a folder the ledger lists but git does not link to the repository answers for itself', async () => {
  const store = await openStore();
  const repository = await repositoryAt(await tempDir('bs-trust-list-repo-'));
  const claimed = path.join(await tempDir('bs-trust-list-claimed-'), 'not-a-worktree');
  await mkdir(claimed);
  await recordWorktree(store, claimed, repository.commonDir);
  await writeHostWorkspaceTrust(store, repository.path, 'trusted');

  await expect(
    listTrust(store, [{ displayName: 'not-a-worktree', path: claimed, rootId: 'root-claimed' }])
  ).resolves.toEqual([{ answeredBy: undefined, rootId: 'root-claimed', trust: 'undecided' }]);
});

/** A new folder named `name` inside `parent`. */
async function folderIn(parent: string, name: string): Promise<string> {
  const folder = path.join(parent, name);
  await mkdir(folder, { recursive: true });
  return folder;
}

test("an unanswered folder's ask offers its parent as a trusted location, and a folder trusted through one is listed with it", async () => {
  const store = await openStore();
  const home = await tempDir('bs-trust-list-home-');
  const code = await folderIn(await tempDir('bs-trust-list-code-'), 'code');
  const cloned = await folderIn(code, 'cloned');
  const later = await folderIn(code, 'later');
  const kept = await folderIn(code, 'kept');
  await writeHostWorkspaceTrust(store, kept, 'restricted');
  const roots = [
    { displayName: 'cloned', path: cloned, rootId: 'root-cloned' },
    { displayName: 'later', path: later, rootId: 'root-later' },
    { displayName: 'kept', path: kept, rootId: 'root-kept' },
  ];

  // Before any answer, each ask may offer the folder the three share.
  await expect(listLocations(store, roots, home)).resolves.toEqual([
    { offeredLocation: code, rootId: 'root-cloned', trust: 'undecided' },
    { offeredLocation: code, rootId: 'root-later', trust: 'undecided' },
    { offeredLocation: code, rootId: 'root-kept', trust: 'restricted' },
  ]);

  await writeHostWorkspaceTrust(store, cloned, 'trusted', { home, location: code });

  await expect(listLocations(store, roots, home)).resolves.toEqual([
    // Trusted by the answer given for it.
    { rootId: 'root-cloned', trust: 'trusted' },
    // Trusted with no answer of its own, and the list says through which location.
    { rootId: 'root-later', trust: 'trusted', trustedThrough: code },
    // Kept restricted; its parent is a location already, so there is nothing more to offer.
    { rootId: 'root-kept', trust: 'restricted' },
  ]);
});

test("a worktree's ask offers its repository's parent, and a folder in the home directory is offered none", async () => {
  const store = await openStore();
  const home = await tempDir('bs-trust-list-home-');
  const code = await folderIn(await tempDir('bs-trust-list-code-'), 'code');
  const repository = await repositoryAt(await folderIn(code, 'app'));
  const worktree = await addManagedWorktree(store, repository, await tempDir('bs-trust-list-wt-'));
  const notes = await folderIn(home, 'notes');

  await expect(
    listLocations(
      store,
      [
        { displayName: 'swift-badger', path: worktree.path, rootId: 'root-worktree' },
        { displayName: 'notes', path: notes, rootId: 'root-notes' },
      ],
      home
    )
  ).resolves.toEqual([
    // The answer is the repository's, so the location offered is where the repository is kept.
    { offeredLocation: code, rootId: 'root-worktree', trust: 'undecided' },
    // Trusting everything in the home directory is never offered.
    { rootId: 'root-notes', trust: 'undecided' },
  ]);
});
