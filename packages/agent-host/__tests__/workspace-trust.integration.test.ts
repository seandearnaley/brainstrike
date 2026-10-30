/**
 * ADR-0032 host-owned workspace trust: a folder is undecided until the person
 * answers, `workspace/trust` records the answer by the folder's absolute path,
 * the answer survives a host restart, and only trusted roots pass the filter
 * that run admission and discovery use.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import {
  readHostWorkspaceTrust,
  trustedHostWorkspaceRoots,
  writeHostWorkspaceTrust,
} from '../src/workspace-trust.js';

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
  await expect(read()).resolves.toEqual({ trust: 'undecided' });

  await expect(
    client.request('workspace/trust', { path: 'relative/repo', trust: 'trusted' })
  ).rejects.toMatchObject({
    failure: { code: 'workspace.trust-refused', kind: 'refusal' },
    message: /absolute path/u,
  });
  await expect(read()).resolves.toEqual({ trust: 'undecided' });

  await expect(
    client.request('workspace/trust', { path: `${workspace}/`, trust: 'trusted' })
  ).resolves.toEqual({ trust: 'trusted' });
  await expect(read()).resolves.toEqual({ trust: 'trusted' });

  await closeHosts();
  client = await open(stateRoot);
  await expect(read()).resolves.toEqual({ trust: 'trusted' });
  // Trust belongs to that folder alone: a folder inside it asks again.
  await mkdir(join(workspace, 'nested'));
  await expect(read(join(workspace, 'nested'))).resolves.toEqual({ trust: 'undecided' });

  await expect(
    client.request('workspace/trust', { path: workspace, trust: 'restricted' })
  ).resolves.toEqual({ trust: 'restricted' });
  await expect(read()).resolves.toEqual({ trust: 'restricted' });
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
    await expect(
      writeHostWorkspaceTrust(store, join(folder, 'missing'), 'trusted')
    ).rejects.toThrow(/does not exist/u);
  } finally {
    await store.close();
  }
});
