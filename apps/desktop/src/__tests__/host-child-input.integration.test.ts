// @vitest-environment node
/**
 * BST-1932 (AT-09): a host child view sends human input, with an image, to its
 * running child through the public client. The host ends the active run after
 * its step in flight and starts the input as the child's next run. Only the
 * model is scripted.
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
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';

const INPUT = 'HUMAN_INPUT_1723: check the date too.';
const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC'}`;

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const runsOf = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

test('a child view’s input steers its running child and runs next with its image', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = scriptedDelegation(
    { input: { prompt: 'Read the notes' }, toolId: 'agent-explore' },
    [{ input: {}, toolId: 'read_notes' }]
  );
  const root = await mkdtemp(join(tmpdir(), 'bs-host-child-input-'));
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
      resolveModel: async () => model,
      tools: {
        read_notes: {
          description: 'Read the notes',
          execute: async () => {
            entered.resolve();
            await release.promise;
            return { content: 'notes' };
          },
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
  cleanups.push(() => release.resolve());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes',
    threadId,
  });
  await entered.promise;
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  const view = createCommittedHostConversation({
    client,
    modelId: 'scripted',
    threadId: child.threadId,
  });
  cleanups.push(async () => {
    view.close();
    // close() sends `log/unsubscribe` without awaiting it. Requests on one
    // connection are written in order, so this round-trip joins that write
    // before the client closes; otherwise the writer rejects unhandled.
    await client.request('thread/list', {});
  });
  await expect.poll(() => view.store.getCommittedView().activeRunId).toBeDefined();
  await view.sendInput(
    {
      attachments: [{ data: PNG, filename: 'evidence.png', mediaType: 'image/png', type: 'file' }],
      id: randomUUID(),
      text: INPUT,
    },
    new AbortController().signal
  );
  release.resolve();

  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId: child.threadId })).rows;
      return rows.filter(({ event }) => event.type === 'run.finished').length;
    })
    .toBe(2);
  const [steered, next] = runsOf(rows);
  expect(next).toMatchObject({
    attachments: [{ mediaType: 'image/png', name: 'evidence.png', type: 'image' }],
    parentMessageId: steered?.runId,
    prompt: INPUT,
  });
  // The model read the input and its image in the child's next run.
  const read = model.doStreamCalls.find((call) =>
    call.prompt.some(
      (message) =>
        message.role === 'user' &&
        message.content.some((part) => part.type === 'text' && part.text === INPUT) &&
        message.content.some((part) => part.type === 'file' && part.mediaType === 'image/png')
    )
  );
  expect(read, 'the child model call must carry the input and its image').toBeDefined();
});
