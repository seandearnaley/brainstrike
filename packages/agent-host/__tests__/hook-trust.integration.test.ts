/**
 * Host-owned project hook approval: `hooks/trust` approves only the exact
 * bytes of a folder's hooks file on disk, for that folder's repository. The
 * approval survives a host restart, `hooks/untrust` revokes it, and a managed
 * worktree runs the versions its repository approved (ADR-0034 decision 6).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { readHostHookApproval, trustHostHooks, untrustHostHooks } from '../src/hook-trust.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
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
    throw new Error('Hook trust never resolves a model');
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

const hooksFile = (folder: string): string => join(folder, '.brainstrike', 'hooks.json');

/** Puts `content` in the folder's `.brainstrike/hooks.json`. */
async function writeHooks(folder: string, content: string): Promise<void> {
  await mkdir(join(folder, '.brainstrike'), { recursive: true });
  await writeFile(hooksFile(folder), content);
}

/** A workspace root with `.brainstrike/hooks.json` holding `content`. */
async function workspaceWithHooks(content: string): Promise<string> {
  const workspace = await tempDir('bs-m3-hook-trust-ws-');
  await writeHooks(workspace, content);
  return workspace;
}

/** A real repository whose checkout holds `content` as its hooks file. */
async function repositoryWithHooks(content: string): Promise<Repository> {
  const repository = await repositoryAt(await realpath(await tempDir('bs-m3-hook-trust-repo-')));
  await writeHooks(repository.path, content);
  return repository;
}

/** A real managed worktree of `repository` whose checkout holds `content` as its hooks file. */
async function managedWorktreeWithHooks(
  store: StateStore,
  repository: Repository,
  content: string
): Promise<string> {
  const managed = await realpath(await tempDir('bs-m3-hook-trust-worktrees-'));
  const { path } = await addManagedWorktree(store, repository, managed);
  await writeHooks(path, content);
  return path;
}

const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');
const REVIEWED = '{"hooks":{"PreToolUse":[]}}';
const EDITED = '{"hooks":{"PreToolUse":[],"Stop":[]}}';

test('an approval is recorded only for the reviewed bytes and survives a host restart until revoked', async () => {
  const stateRoot = await tempDir('bs-m3-hook-trust-');
  const workspace = await workspaceWithHooks(REVIEWED);
  const sha256 = sha256Of(REVIEWED);
  let client = await open(stateRoot);
  const read = () => client.request('hooks/trust/read', { path: workspace });
  await expect(read()).resolves.toEqual({ approvedSha256: null });

  // Refusals arrive as the host's typed refusal with its reason: a stale review
  // (the file on disk is not what the client hashed), a relative path, no file.
  await expect(
    client.request('hooks/trust', { path: workspace, sha256: sha256Of('{}') })
  ).rejects.toMatchObject({
    failure: { code: 'hooks.trust-refused', kind: 'refusal' },
    message: `${hooksFile(workspace)} changed since it was reviewed; review it again`,
  });
  await expect(
    client.request('hooks/trust', { path: 'relative/root', sha256 })
  ).rejects.toMatchObject({
    failure: { code: 'hooks.trust-refused', kind: 'refusal' },
    message: /absolute path/u,
  });
  const noHooks = await tempDir('bs-m3-hook-trust-none-');
  await expect(client.request('hooks/trust', { path: noHooks, sha256 })).rejects.toMatchObject({
    failure: { code: 'hooks.trust-refused', kind: 'refusal' },
    message: /cannot be read/u,
  });
  await expect(read()).resolves.toEqual({ approvedSha256: null });

  await expect(client.request('hooks/trust', { path: workspace, sha256 })).resolves.toEqual({
    trusted: true,
  });

  await closeHosts();
  client = await open(stateRoot);
  await expect(read()).resolves.toEqual({ approvedSha256: sha256 });
  await expect(client.request('hooks/trust/read', { path: 'relative/root' })).rejects.toMatchObject(
    {
      failure: { code: 'hooks.trust-refused', kind: 'refusal' },
      message: /absolute path/u,
    }
  );

  await expect(client.request('hooks/untrust', { path: workspace })).resolves.toEqual({
    untrusted: true,
  });
  await expect(client.request('hooks/untrust', { path: workspace })).resolves.toEqual({
    untrusted: false,
  });
  await expect(read()).resolves.toEqual({ approvedSha256: null });
});

test('an approval belongs to the folder it was given in, and an edited file is held against the approved hash', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-approval-'));
  try {
    const workspace = await workspaceWithHooks(REVIEWED);
    const sha256 = sha256Of(REVIEWED);
    await trustHostHooks(store, { path: workspace, sha256 });

    await expect(readHostHookApproval(store, workspace)).resolves.toBe(sha256);
    // Another folder holding the same bytes was never approved, and nor was a folder that is gone.
    const other = await workspaceWithHooks(REVIEWED);
    await expect(readHostHookApproval(store, other)).resolves.toBeUndefined();
    await expect(
      readHostHookApproval(store, join(workspace, 'elsewhere'))
    ).resolves.toBeUndefined();
    // Nor was a path that runs through a file, where no folder can be.
    await expect(
      readHostHookApproval(store, join(hooksFile(workspace), 'below'))
    ).resolves.toBeUndefined();

    // After an edit the approval is still the reviewed hash, so the loader reports the file as changed.
    await writeHooks(workspace, EDITED);
    await expect(readHostHookApproval(store, workspace)).resolves.toBe(sha256);
    // Approving the edit replaces the earlier version: going back to it needs a new review.
    await trustHostHooks(store, { path: workspace, sha256: sha256Of(EDITED) });
    await writeHooks(workspace, REVIEWED);
    await expect(readHostHookApproval(store, workspace)).resolves.toBe(sha256Of(EDITED));
  } finally {
    await store.close();
  }
});

test('a managed worktree runs the hooks its repository approved, and a repository has one approved version (ADR-0034)', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-worktree-'));
  try {
    const repository = await repositoryWithHooks(REVIEWED);
    const worktree = await managedWorktreeWithHooks(store, repository, REVIEWED);
    await expect(readHostHookApproval(store, worktree)).resolves.toBeUndefined();

    await trustHostHooks(store, { path: repository.path, sha256: sha256Of(REVIEWED) });
    // The worktree holds the reviewed bytes, so its hooks run without another ask.
    await expect(readHostHookApproval(store, worktree)).resolves.toBe(sha256Of(REVIEWED));

    // An edit in the worktree asks again: those bytes were never reviewed.
    await writeHooks(worktree, EDITED);
    await expect(readHostHookApproval(store, worktree)).resolves.toBe(sha256Of(REVIEWED));
    // Approved there, the edit is the repository's version for every checkout. The repository's
    // own checkout still holds the earlier bytes, which the loader now reports as changed.
    await trustHostHooks(store, { path: worktree, sha256: sha256Of(EDITED) });
    await expect(readHostHookApproval(store, worktree)).resolves.toBe(sha256Of(EDITED));
    await expect(readHostHookApproval(store, repository.path)).resolves.toBe(sha256Of(EDITED));
    // A later worktree holding the approved version runs without asking.
    const later = await managedWorktreeWithHooks(store, repository, EDITED);
    await expect(readHostHookApproval(store, later)).resolves.toBe(sha256Of(EDITED));

    // Revoking in any checkout revokes the repository's approval, for every checkout.
    await expect(untrustHostHooks(store, worktree)).resolves.toEqual({ untrusted: true });
    await expect(readHostHookApproval(store, repository.path)).resolves.toBeUndefined();
    await expect(readHostHookApproval(store, later)).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});

test('a revoke in a worktree also revokes what was approved there before the ledger listed it', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-revoke-'));
  try {
    const repository = await repositoryWithHooks(REVIEWED);
    const sha256 = sha256Of(REVIEWED);
    // A worktree made outside Brainstrike answers for itself, and is approved as that folder.
    const worktree = linkWorktree(
      repository,
      await realpath(await tempDir('bs-m3-hook-trust-worktrees-'))
    );
    await writeHooks(worktree, REVIEWED);
    await trustHostHooks(store, { path: worktree, sha256 });
    // Brainstrike adopts it, and it is approved again as its repository's checkout.
    const row = await recordWorktree(store, worktree, repository.commonDir);
    await trustHostHooks(store, { path: worktree, sha256 });

    await expect(untrustHostHooks(store, worktree)).resolves.toEqual({ untrusted: true });

    // Archived, the folder answers for itself again: the revoke still holds.
    await store.worktreeLedger({
      id: row.id,
      operation: 'archive',
      snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
    });
    await expect(readHostHookApproval(store, worktree)).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});

test('a revoke at the repository also revokes what a worktree was approved at before the ledger listed it', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-revoke-repo-'));
  try {
    const repository = await repositoryWithHooks(REVIEWED);
    const sha256 = sha256Of(REVIEWED);
    // A worktree made outside Brainstrike is approved as its own folder, then adopted.
    const worktree = linkWorktree(
      repository,
      await realpath(await tempDir('bs-m3-hook-trust-worktrees-'))
    );
    await writeHooks(worktree, REVIEWED);
    await trustHostHooks(store, { path: worktree, sha256 });
    const row = await recordWorktree(store, worktree, repository.commonDir);
    await trustHostHooks(store, { path: repository.path, sha256 });

    await expect(untrustHostHooks(store, repository.path)).resolves.toEqual({ untrusted: true });

    // Archived, the worktree's folder answers for itself again: nothing approves it.
    await store.worktreeLedger({
      id: row.id,
      operation: 'archive',
      snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
    });
    await expect(readHostHookApproval(store, worktree)).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});

test('an approval given in a managed worktree replaces what was approved for that folder alone', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-replace-'));
  try {
    const repository = await repositoryWithHooks(REVIEWED);
    // A worktree made outside Brainstrike is approved as its own folder, then adopted.
    const worktree = linkWorktree(
      repository,
      await realpath(await tempDir('bs-m3-hook-trust-worktrees-'))
    );
    await writeHooks(worktree, REVIEWED);
    await trustHostHooks(store, { path: worktree, sha256: sha256Of(REVIEWED) });
    const row = await recordWorktree(store, worktree, repository.commonDir);
    await writeHooks(worktree, EDITED);
    await trustHostHooks(store, { path: worktree, sha256: sha256Of(EDITED) });

    // Archived and back on the earlier bytes, the folder asks again: that approval was replaced.
    await store.worktreeLedger({
      id: row.id,
      operation: 'archive',
      snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
    });
    await writeHooks(worktree, REVIEWED);
    await expect(readHostHookApproval(store, worktree)).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});

test('a folder that only claims a repository runs none of its approved hooks, and gives it none', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-claim-'));
  try {
    const repository = await repositoryWithHooks(REVIEWED);
    await trustHostHooks(store, { path: repository.path, sha256: sha256Of(REVIEWED) });

    // A downloaded folder whose .git points at the repository, and which the ledger lists as its worktree.
    const claimed = await realpath(await tempDir('bs-m3-hook-claimed-'));
    await writeHooks(claimed, REVIEWED);
    await writeFile(join(claimed, '.git'), `gitdir: ${repository.commonDir}/worktrees/claimed\n`);
    await recordWorktree(store, claimed, repository.commonDir);
    await expect(readHostHookApproval(store, claimed)).resolves.toBeUndefined();

    // An approval given in that folder stays there: the repository's checkout gains nothing from it.
    await writeHooks(claimed, EDITED);
    await trustHostHooks(store, { path: claimed, sha256: sha256Of(EDITED) });
    await writeHooks(repository.path, EDITED);
    await expect(readHostHookApproval(store, repository.path)).resolves.toBe(sha256Of(REVIEWED));
  } finally {
    await store.close();
  }
});
