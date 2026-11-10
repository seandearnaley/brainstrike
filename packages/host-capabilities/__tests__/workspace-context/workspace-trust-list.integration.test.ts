/**
 * ADR-0032, ADR-0034 decision 6: `workspace/trust/list` names the folder that
 * answers for each open folder. A managed worktree shares its repository's
 * answer, so the composer and Settings ask about, and show, the repository
 * once. Real git builds the worktrees, since git's own links decide it.
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
  const home = await tempDir('bs-trust-list-home-');
  const none = { inspected: 0, truncated: false };
  const result = await discoverWorkspaceTrust(
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
  return result.roots.map(({ answeredBy, rootId, trust }) => ({ answeredBy, rootId, trust }));
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
