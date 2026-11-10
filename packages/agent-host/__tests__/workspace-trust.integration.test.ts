/**
 * ADR-0032 host-owned workspace trust: a folder is undecided until the person
 * answers, `workspace/trust` records the answer by the folder's absolute path,
 * the answer survives a host restart, and only trusted roots pass the filter
 * that run admission and discovery use.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import {
  readHostWorkspaceTrust,
  trustedHostWorkspaceRoots,
  writeHostWorkspaceTrust,
} from '../src/workspace-trust.js';
import {
  addManagedWorktree,
  linkWorktree,
  type Repository,
  recordWorktree,
  repositoryAt,
} from './fixtures/managed-worktree.js';

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
async function closeHosts(): Promise<void> {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
}
afterEach(async () => {
  await closeHosts();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
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

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function open(root: string): Promise<HostClient> {
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

test('a folder stays undecided until answered, and the answer survives a host restart', async () => {
  const stateRoot = await tempDir('bs-workspace-trust-');
  const workspace = await tempDir('bs-workspace-trust-ws-');
  let client = await open(stateRoot);
  const read = (path = workspace) => client.request('workspace/trust/read', { path });
  await expect(read()).resolves.toMatchObject({ trust: 'undecided' });

  await expect(
    client.request('workspace/trust', { path: 'relative/repo', trust: 'trusted' })
  ).rejects.toMatchObject({
    failure: { code: 'workspace.trust-refused', kind: 'refusal' },
    message: /absolute path/u,
  });
  await expect(read()).resolves.toMatchObject({ trust: 'undecided' });

  await expect(
    client.request('workspace/trust', { path: `${workspace}/`, trust: 'trusted' })
  ).resolves.toEqual({ trust: 'trusted' });
  await expect(read()).resolves.toMatchObject({ trust: 'trusted' });

  await closeHosts();
  client = await open(stateRoot);
  await expect(read()).resolves.toMatchObject({ trust: 'trusted' });
  // Trust belongs to that folder alone: a folder inside it asks again.
  await mkdir(join(workspace, 'nested'));
  await expect(read(join(workspace, 'nested'))).resolves.toMatchObject({
    trust: 'undecided',
  });

  await expect(
    client.request('workspace/trust', { path: workspace, trust: 'restricted' })
  ).resolves.toEqual({ trust: 'restricted' });
  await expect(read()).resolves.toMatchObject({ trust: 'restricted' });
});

test('only trusted roots load their agent configuration; restricted and undecided ones still mount', async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-filter-'));
  try {
    const roots = await Promise.all(
      ['trusted', 'restricted', 'cloned'].map(async (name) => ({
        path: await tempDir(`bs-workspace-trust-${name}-`),
        rootId: `root-${name}`,
      }))
    );
    const [trusted, restricted] = roots;
    if (!(trusted && restricted)) {
      throw new Error('The scenario needs its roots');
    }
    await writeHostWorkspaceTrust(store, trusted.path, 'trusted');
    await writeHostWorkspaceTrust(store, restricted.path, 'restricted');

    await expect(trustedHostWorkspaceRoots(store, roots)).resolves.toEqual([trusted]);
  } finally {
    await store.close();
  }
});

test('every spelling of a folder shares one answer, and a folder that is gone loads nothing', async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-identity-'));
  try {
    const folder = await tempDir('bs-workspace-trust-real-');
    const link = join(await tempDir('bs-workspace-trust-link-'), 'linked');
    // A junction on Windows needs no privilege; POSIX ignores the type.
    await symlink(folder, link, 'junction');
    await writeHostWorkspaceTrust(store, `${link}/`, 'trusted');

    await expect(readHostWorkspaceTrust(store, folder)).resolves.toBe('trusted');
    await expect(readHostWorkspaceTrust(store, join(folder, 'missing'))).resolves.toBe('undecided');
    // A path that runs through a file names no folder either.
    await writeFile(join(folder, 'notes.txt'), '');
    await expect(readHostWorkspaceTrust(store, join(folder, 'notes.txt', 'below'))).resolves.toBe(
      'undecided'
    );
    await expect(
      writeHostWorkspaceTrust(store, join(folder, 'missing'), 'trusted')
    ).rejects.toThrow(/does not exist/u);
  } finally {
    await store.close();
  }
});

async function repositoryCheckout(): Promise<Repository> {
  return repositoryAt(await realpath(await tempDir('bs-workspace-trust-repo-')));
}

/** A real linked worktree of `repository` and its ledger row, as worktree creation leaves them. */
async function recordManagedWorktree(
  store: StateStore,
  repository: Repository
): Promise<ManagedWorktreeRow> {
  // The ledger keeps the real path, as worktree creation records it.
  const managed = await realpath(await tempDir('bs-workspace-trust-worktrees-'));
  return addManagedWorktree(store, repository, managed);
}

test("a managed worktree shares its repository's answer, so a trusted repository's worktree never asks (ADR-0034)", async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-state-'));
  try {
    const repository = await repositoryCheckout();
    const worktree = await recordManagedWorktree(store, repository);
    await expect(readHostWorkspaceTrust(store, worktree.path)).resolves.toBe('undecided');

    await writeHostWorkspaceTrust(store, repository.path, 'trusted');
    await expect(readHostWorkspaceTrust(store, worktree.path)).resolves.toBe('trusted');
    // Every spelling of the worktree is that worktree, as for any folder.
    const link = join(await tempDir('bs-workspace-trust-worktree-link-'), 'linked');
    await symlink(worktree.path, link, 'junction');
    await expect(readHostWorkspaceTrust(store, `${link}/`)).resolves.toBe('trusted');
    // A run mounted on the worktree loads its instructions, skills and personas.
    const root = { path: worktree.path, rootId: 'root-worktree' };
    await expect(trustedHostWorkspaceRoots(store, [root])).resolves.toEqual([root]);

    await writeHostWorkspaceTrust(store, repository.path, 'restricted');
    await expect(readHostWorkspaceTrust(store, worktree.path)).resolves.toBe('restricted');
    await expect(trustedHostWorkspaceRoots(store, [root])).resolves.toEqual([]);
  } finally {
    await store.close();
  }
});

test('an answer given in a managed worktree is the answer for its repository and its other worktrees', async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-write-'));
  try {
    const repository = await repositoryCheckout();
    const asked = await recordManagedWorktree(store, repository);
    const later = await recordManagedWorktree(store, repository);

    await writeHostWorkspaceTrust(store, asked.path, 'trusted');

    await expect(readHostWorkspaceTrust(store, repository.path)).resolves.toBe('trusted');
    await expect(readHostWorkspaceTrust(store, later.path)).resolves.toBe('trusted');
    // The answer is the repository's alone: another repository's worktree still asks.
    const other = await recordManagedWorktree(store, await repositoryCheckout());
    await expect(readHostWorkspaceTrust(store, other.path)).resolves.toBe('undecided');
  } finally {
    await store.close();
  }
});

test('an answer given in a managed worktree replaces what was answered for that folder alone', async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-own-'));
  try {
    const repository = await repositoryCheckout();
    // A worktree made outside Brainstrike is trusted as its own folder, then adopted.
    const worktree = linkWorktree(
      repository,
      await realpath(await tempDir('bs-workspace-trust-worktrees-'))
    );
    await writeHostWorkspaceTrust(store, worktree, 'trusted');
    const row = await recordWorktree(store, worktree, repository.commonDir);
    await writeHostWorkspaceTrust(store, worktree, 'restricted');
    await expect(readHostWorkspaceTrust(store, repository.path)).resolves.toBe('restricted');

    // Archived, the folder answers for itself again, and "Keep restricted" still stands.
    await store.worktreeLedger({
      id: row.id,
      operation: 'archive',
      snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
    });
    await expect(readHostWorkspaceTrust(store, worktree)).resolves.toBe('undecided');
  } finally {
    await store.close();
  }
});

test("a folder cannot claim a trusted repository: neither its own .git nor a ledger row is enough without the repository's side", async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-claim-'));
  try {
    const repository = await repositoryCheckout();
    await writeHostWorkspaceTrust(store, repository.path, 'trusted');

    // A downloaded folder whose .git points at the trusted repository, as a linked worktree's does.
    const claimed = await realpath(await tempDir('bs-workspace-trust-claimed-'));
    await writeFile(join(claimed, '.git'), `gitdir: ${repository.commonDir}/worktrees/claimed\n`);
    await expect(readHostWorkspaceTrust(store, claimed)).resolves.toBe('undecided');
    // Even recorded as a worktree, it is not one: the repository does not list it.
    await recordWorktree(store, claimed, repository.commonDir);
    await expect(readHostWorkspaceTrust(store, claimed)).resolves.toBe('undecided');

    // An archived worktree is no longer a checkout, so a folder at its path has its own answer.
    const archived = await recordManagedWorktree(store, repository);
    await expect(readHostWorkspaceTrust(store, archived.path)).resolves.toBe('trusted');
    await store.worktreeLedger({
      id: archived.id,
      operation: 'archive',
      snapshotRef: `refs/brainstrike/worktree-archive/${archived.id}`,
    });
    await expect(readHostWorkspaceTrust(store, archived.path)).resolves.toBe('undecided');
  } finally {
    await store.close();
  }
});

test("a repository cannot claim someone else's folder by listing it as its worktree", async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-listed-'));
  try {
    // The person's own repository, which they trust.
    const own = await repositoryCheckout();
    await writeHostWorkspaceTrust(store, own.path, 'trusted');
    // A cloned repository lists that folder as its worktree, and the listing reaches the ledger.
    const cloned = await repositoryCheckout();
    const listing = join(cloned.commonDir, 'worktrees', 'own');
    await mkdir(listing, { recursive: true });
    await writeFile(join(listing, 'gitdir'), `${join(own.path, '.git')}\n`);
    await recordWorktree(store, own.path, cloned.commonDir);

    // The folder keeps its own answer, not the clone's.
    await expect(readHostWorkspaceTrust(store, own.path)).resolves.toBe('trusted');
    // An answer given for the folder stays the folder's: it never becomes the clone's.
    await writeHostWorkspaceTrust(store, own.path, 'trusted');
    await expect(readHostWorkspaceTrust(store, cloned.path)).resolves.toBe('undecided');
  } finally {
    await store.close();
  }
});

test('another repository put where a managed worktree was has its own answer', async () => {
  const store = await StateStore.open(await tempDir('bs-workspace-trust-worktree-replaced-'));
  try {
    const repository = await repositoryCheckout();
    await writeHostWorkspaceTrust(store, repository.path, 'trusted');
    const worktree = await recordManagedWorktree(store, repository);
    await expect(readHostWorkspaceTrust(store, worktree.path)).resolves.toBe('trusted');

    // The folder is deleted outside Brainstrike, so its ledger row stays, and a clone lands there.
    await rm(worktree.path, { force: true, recursive: true });
    await mkdir(worktree.path);
    await repositoryAt(worktree.path);
    await expect(readHostWorkspaceTrust(store, worktree.path)).resolves.toBe('undecided');
  } finally {
    await store.close();
  }
});
