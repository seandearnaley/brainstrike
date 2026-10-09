/**
 * BST-1932: two views of one thread on the same connection. A delegation tree's
 * approval strip watches a child's log while that child's own tab may watch it
 * too; closing either view must never end the other's live rows.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { CommittedThreadSession } from '../src/thread-view.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function connectedClient(): Promise<HostClient> {
  const root = await mkdtemp(join(tmpdir(), 'bs-shared-log-subscription-'));
  roots.push(root);
  const model = scriptedModel();
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

/** The titles a session has received, in commit order. */
function titles(session: CommittedThreadSession): readonly string[] {
  return session
    .getSnapshot()
    .rows.flatMap(({ event }) =>
      event.type === 'thread.updated' && event.title !== undefined ? [event.title] : []
    );
}

test('one view leaving a thread keeps the other view of it on the same connection live', async () => {
  const client = await connectedClient();
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const tab = new CommittedThreadSession(client, threadId);
  const strip = new CommittedThreadSession(client, threadId);
  const leaveTab = tab.connect();
  const leaveStrip = strip.connect();
  await client.request('thread/update', { commandId: randomUUID(), threadId, title: 'First' });
  await expect.poll(() => titles(strip)).toEqual(['First']);
  await expect.poll(() => titles(tab)).toEqual(['First']);

  await leaveTab();
  await client.request('thread/update', { commandId: randomUUID(), threadId, title: 'Second' });
  await expect.poll(() => titles(strip)).toEqual(['First', 'Second']);

  // The last view leaving ends the connection's subscription.
  await leaveStrip();
  const delivered: unknown[] = [];
  const release = client.onEvent((row) => delivered.push(row));
  await client.request('thread/update', { commandId: randomUUID(), threadId, title: 'Third' });
  // One round-trip on the same connection: a notification sent first would have arrived.
  await client.request('thread/list', {});
  release();
  expect(delivered).toEqual([]);
});
