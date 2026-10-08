/**
 * Host-owned project hook trust: `hooks/trust` records a root's trust only for
 * the exact bytes of its hooks file on disk, the trust survives a host
 * restart, `hooks/untrust` revokes it, and admission reads a trust only for
 * the root at the path it was trusted at.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { ErrorCodes } from 'vscode-jsonrpc';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { readHostHookApproval, trustHostHooks } from '../src/hook-trust.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

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

/** A workspace root with `.brainstrike/hooks.json` holding `content`. */
async function workspaceWithHooks(content: string): Promise<string> {
  const workspace = await tempDir('bs-m3-hook-trust-ws-');
  await mkdir(join(workspace, '.brainstrike'));
  await writeFile(join(workspace, '.brainstrike', 'hooks.json'), content);
  return workspace;
}

const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');
const REVIEWED = '{"hooks":{"PreToolUse":[]}}';

test('a trust is recorded only for the reviewed bytes and survives a host restart until revoked', async () => {
  const stateRoot = await tempDir('bs-m3-hook-trust-');
  const workspace = await workspaceWithHooks(REVIEWED);
  const sha256 = sha256Of(REVIEWED);
  let client = await open(stateRoot);
  const read = () => client.request('hooks/trust/read', { rootId: 'root-1' });
  await expect(read()).resolves.toEqual({ trust: null });

  // Refusals answer InvalidParams with the host's reason: a stale review (the
  // file on disk is not what the client hashed), a relative path, no file.
  const file = join(workspace, '.brainstrike', 'hooks.json');
  await expect(
    client.request('hooks/trust', { path: workspace, rootId: 'root-1', sha256: sha256Of('{}') })
  ).rejects.toMatchObject({
    code: ErrorCodes.InvalidParams,
    message: `${file} changed since it was reviewed; review it again`,
  });
  await expect(
    client.request('hooks/trust', { path: 'relative/root', rootId: 'root-1', sha256 })
  ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams, message: /absolute path/ });
  const noHooks = await tempDir('bs-m3-hook-trust-none-');
  await expect(
    client.request('hooks/trust', { path: noHooks, rootId: 'root-1', sha256 })
  ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams, message: /cannot be read/ });
  await expect(read()).resolves.toEqual({ trust: null });

  await expect(
    client.request('hooks/trust', { path: workspace, rootId: 'root-1', sha256 })
  ).resolves.toEqual({ trusted: true });

  await closeHosts();
  client = await open(stateRoot);
  await expect(read()).resolves.toEqual({ trust: { path: workspace, sha256 } });

  await expect(client.request('hooks/untrust', { rootId: 'root-1' })).resolves.toEqual({
    untrusted: true,
  });
  await expect(client.request('hooks/untrust', { rootId: 'root-1' })).resolves.toEqual({
    untrusted: false,
  });
  await expect(read()).resolves.toEqual({ trust: null });
});

test('admission reads a trust only for the same root at the path it was trusted at', async () => {
  const store = await StateStore.open(await tempDir('bs-m3-hook-approval-'));
  try {
    const workspace = await workspaceWithHooks(REVIEWED);
    const sha256 = sha256Of(REVIEWED);
    await trustHostHooks(store, { path: workspace, rootId: 'root-1', sha256 });

    await expect(
      readHostHookApproval(store, { absPath: workspace, rootId: 'root-1' })
    ).resolves.toBe(sha256);
    // A re-pointed root and another root both start untrusted.
    await expect(
      readHostHookApproval(store, { absPath: join(workspace, 'elsewhere'), rootId: 'root-1' })
    ).resolves.toBeUndefined();
    await expect(
      readHostHookApproval(store, { absPath: workspace, rootId: 'root-2' })
    ).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});
