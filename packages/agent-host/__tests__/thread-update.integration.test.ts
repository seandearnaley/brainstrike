/**
 * Host thread presentation: `thread/update` commits a `thread.updated` event
 * and the thread catalog folds it. A title, colour and icon survive a host
 * restart, a second client sees them, and a repeated command is one update.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () => {
    throw new Error('Renaming a thread never resolves a model');
  },
  tools: {},
};

async function open(root: string): Promise<{ client: HostClient; host: AgentHost }> {
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return { client, host };
}

async function catalogEntry(client: HostClient, threadId: string) {
  const { threads } = await client.request('thread/list', {});
  const thread = threads.find((entry) => entry.threadId === threadId);
  if (!thread) {
    throw new Error('The thread is not in the host catalog');
  }
  return thread;
}

async function titleOf(client: HostClient, threadId: string): Promise<string | undefined> {
  return (await catalogEntry(client, threadId)).title;
}

test('a renamed thread keeps its title across a second client and a host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-thread-rename-'));
  roots.push(root);
  const first = await open(root);
  const { threadId } = await first.client.request('thread/start', { commandId: randomUUID() });
  const { threadId: other } = await first.client.request('thread/start', {
    commandId: randomUUID(),
  });
  // Never renamed: the catalog has no title, and the client shows its default.
  expect(await titleOf(first.client, threadId)).toBeUndefined();

  const commandId = randomUUID();
  await expect(
    first.client.request('thread/update', { commandId, threadId, title: '  Release plan  ' })
  ).resolves.toEqual({ accepted: true });
  expect(await titleOf(first.client, threadId)).toBe('Release plan');
  expect(await titleOf(first.client, other)).toBeUndefined();

  // A second client of the same host sees the committed title and its event.
  const second = await attachAgentHost(first.host.record);
  clients.push(second);
  expect(await titleOf(second, threadId)).toBe('Release plan');
  const { rows } = await second.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.filter(({ event }) => event.type === 'thread.updated')).toEqual([
    expect.objectContaining({ event: { title: 'Release plan', type: 'thread.updated' } }),
  ]);

  // A repeated command is one rename; reusing its ID with another title is refused.
  await expect(
    second.request('thread/update', { commandId, threadId, title: 'Release plan' })
  ).resolves.toEqual({ accepted: true });
  await expect(
    second.request('thread/update', { commandId, threadId, title: 'Another title' })
  ).rejects.toThrow();
  const after = await second.request('thread/read', { fromSeq: 0, threadId });
  expect(after.rows.filter(({ event }) => event.type === 'thread.updated')).toHaveLength(1);

  // A blank title and an unknown thread are refused before anything commits.
  await expect(
    second.request('thread/update', { commandId: randomUUID(), threadId, title: '   ' })
  ).rejects.toThrow();
  await expect(
    second.request('thread/update', {
      commandId: randomUUID(),
      threadId: randomUUID(),
      title: 'Nowhere',
    })
  ).rejects.toThrow('Unknown thread');

  // The latest rename wins, and it survives a host restart.
  await second.request('thread/update', {
    commandId: randomUUID(),
    threadId,
    title: 'Release plan v2',
  });
  await second.close();
  await first.client.close();
  await first.host.close();
  const restarted = await open(root);
  expect(await titleOf(restarted.client, threadId)).toBe('Release plan v2');
  expect(await titleOf(restarted.client, other)).toBeUndefined();
});

test('a thread colour and icon commit independently of its title and survive a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-thread-presentation-'));
  roots.push(root);
  const first = await open(root);
  const { threadId } = await first.client.request('thread/start', { commandId: randomUUID() });
  await first.client.request('thread/update', {
    commandId: randomUUID(),
    threadId,
    title: 'Release plan',
  });
  await first.client.request('thread/update', {
    color: 'emerald',
    commandId: randomUUID(),
    icon: 'rocket',
    threadId,
  });
  // Each update changes only its own fields.
  expect(await catalogEntry(first.client, threadId)).toEqual({
    color: 'emerald',
    icon: 'rocket',
    threadId,
    title: 'Release plan',
  });
  await first.client.request('thread/update', { color: 'rose', commandId: randomUUID(), threadId });
  // An update that changes nothing is refused before it commits.
  await expect(
    first.client.request('thread/update', { commandId: randomUUID(), threadId })
  ).rejects.toThrow();

  await first.client.close();
  await first.host.close();
  const restarted = await open(root);
  expect(await catalogEntry(restarted.client, threadId)).toEqual({
    color: 'rose',
    icon: 'rocket',
    threadId,
    title: 'Release plan',
  });
});
