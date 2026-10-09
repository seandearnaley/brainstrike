// @vitest-environment node
/**
 * BST-1932 (F15): a host child's toolbar facts come from its own committed
 * log, read through the public client from a real host. Only the model is
 * scripted.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedDelegation } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { foldHostChildDetails, HostChildDetailsFold } from '../renderer/host-child-details';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('a child’s toolbar names its admitted profile, budget, tools and usage from its log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-child-details-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      delegation: {
        personas: [
          {
            allowedToolIds: ['read_notes'],
            description: 'Reads the notes.',
            id: 'explore',
            instructions: 'You are the Explorer.',
            label: 'Explorer',
            maxSteps: 4,
            mode: 'read-only',
          },
        ],
        settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 1 },
      },
      maxSteps: 4,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () =>
        scriptedDelegation({ input: { prompt: 'Read the notes' }, toolId: 'agent-explore' }, [
          { input: {}, toolId: 'read_notes' },
        ]),
      tools: {
        read_notes: {
          description: 'Read the notes',
          execute: async () => ({ content: 'notes' }),
          identity: 'native-read-notes-generation-1',
          inputSchema: z.object({}),
          risk: 'read',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes',
    threadId,
  });
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      const [child] = (await client.request('thread/children', { threadId })).children;
      rows = child
        ? (await client.request('thread/read', { fromSeq: 0, threadId: child.threadId })).rows
        : [];
      return rows.some(({ event }) => event.type === 'run.finished');
    })
    .toBe(true);

  // A client without a desktop configuration records no model settings.
  expect(foldHostChildDetails(rows)).toEqual({
    depth: 1,
    maxSteps: 4,
    modelId: 'scripted',
    planMode: false,
    profile: { label: 'Explorer', mode: 'read-only' },
    steps: 2,
    tools: ['read_notes'],
    usage: { inputTokens: 2, outputTokens: 2 },
  });
  // The live view folds the log as it grows: the same facts, one row at a time,
  // and the same value while nothing it shows has changed.
  const live = new HostChildDetailsFold();
  for (let length = 1; length <= rows.length; length += 1) {
    live.apply(rows.slice(0, length));
  }
  const settled = live.apply(rows);
  expect(settled).toEqual(foldHostChildDetails(rows));
  expect(live.apply(rows)).toBe(settled);
});

test('a top-level thread has no child toolbar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-child-details-root-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 2,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedDelegation({ input: {}, toolId: 'none' }, []),
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  expect(foldHostChildDetails(rows)).toBeUndefined();
});
