/**
 * Host thread titles: `thread/rename` commits a `thread.renamed` event and the
 * thread catalog folds it. A title survives a host restart, a second client
 * sees it, and a repeated command is one rename.
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

async function titleOf(client: HostClient, threadId: string): Promise<string | undefined> {
  const { threads } = await client.request('thread/list', {});
  const thread = threads.find((entry) => entry.threadId === threadId);
  if (!thread) {
    throw new Error('The thread is not in the host catalog');
  }
  return thread.title;
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
    first.client.request('thread/rename', { commandId, threadId, title: '  Release plan  ' })
  ).resolves.toEqual({ accepted: true });
  expect(await titleOf(first.client, threadId)).toBe('Release plan');
  expect(await titleOf(first.client, other)).toBeUndefined();

  // A second client of the same host sees the committed title and its event.
  const second = await attachAgentHost(first.host.record);
  clients.push(second);
  expect(await titleOf(second, threadId)).toBe('Release plan');
  const { rows } = await second.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.filter(({ event }) => event.type === 'thread.renamed')).toEqual([
    expect.objectContaining({ event: { title: 'Release plan', type: 'thread.renamed' } }),
  ]);

  // A repeated command is one rename; reusing its ID with another title is refused.
  await expect(
    second.request('thread/rename', { commandId, threadId, title: 'Release plan' })
  ).resolves.toEqual({ accepted: true });
  await expect(
    second.request('thread/rename', { commandId, threadId, title: 'Another title' })
  ).rejects.toThrow();
  const after = await second.request('thread/read', { fromSeq: 0, threadId });
  expect(after.rows.filter(({ event }) => event.type === 'thread.renamed')).toHaveLength(1);

  // A blank title and an unknown thread are refused before anything commits.
  await expect(
    second.request('thread/rename', { commandId: randomUUID(), threadId, title: '   ' })
  ).rejects.toThrow();
  await expect(
    second.request('thread/rename', {
      commandId: randomUUID(),
      threadId: randomUUID(),
      title: 'Nowhere',
    })
  ).rejects.toThrow('Unknown thread');

  // The latest rename wins, and it survives a host restart.
  await second.request('thread/rename', {
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
