/**
 * BST-1932 (F19–F20): a parent's sidebar learns its children's status without
 * watching their logs. The host tells every client which thread's children
 * changed; the client re-reads `thread/children`, whose status is derived from
 * the child's runs. No view of the parent or the child is mounted here.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostChildStatus } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedDelegation } from '../src/test-fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('a collapsed parent’s child goes Working, Needs input, then idle, told only by the host', async () => {
  const release = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  const root = await mkdtemp(join(tmpdir(), 'bs-child-status-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      delegation: {
        personas: [
          {
            allowedToolIds: ['read_notes', 'write_notes'],
            description: 'Writes the notes.',
            id: 'worker',
            instructions: 'You are the Worker.',
            label: 'Worker',
            maxSteps: 4,
            mode: 'worker',
          },
        ],
        settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 1 },
      },
      maxSteps: 4,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () =>
        scriptedDelegation({ input: { prompt: 'Write the notes' }, toolId: 'agent-worker' }, [
          { input: {}, toolId: 'read_notes' },
          { input: {}, toolId: 'write_notes' },
        ]),
      tools: {
        read_notes: {
          description: 'Read the notes',
          execute: async () => {
            await release.promise;
            return { content: 'notes' };
          },
          identity: 'native-read-notes-generation-1',
          inputSchema: z.object({}),
          risk: 'read',
        },
        write_notes: {
          description: 'Write the notes',
          execute: async () => {
            await write.promise;
            return { written: true };
          },
          identity: 'native-write-notes-generation-1',
          inputSchema: z.object({}),
          risk: 'edit',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  // The sidebar of a collapsed parent: it re-reads only when the host tells it.
  const seen: HostChildStatus[] = [];
  let notices = 0;
  const reads: Promise<void>[] = [];
  const readFailures: unknown[] = [];
  const unsubscribe = client.onChildrenChanged((changed) => {
    if (changed !== threadId) {
      return;
    }
    notices += 1;
    reads.push(
      client
        .request('thread/children', { threadId })
        .then(({ children }) => {
          const status = children[0]?.status;
          if (status && seen.at(-1) !== status) {
            seen.push(status);
          }
        })
        .catch((cause: unknown) => {
          readFailures.push(cause);
        })
    );
  });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes',
    threadId,
  });
  await expect.poll(() => seen.at(-1)).toBe('working');

  release.resolve();
  await expect.poll(() => seen.at(-1)).toBe('needs-input');
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId: child.threadId });
  const asked = rows.find(({ event }) => event.type === 'interaction.requested')?.event;
  if (asked?.type !== 'interaction.requested') {
    throw new Error('The child asked nothing');
  }
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: asked.interactionId,
    runId: asked.runId,
    threadId: child.threadId,
  });
  // The answer resumes the child: it is working again before it ends.
  await expect.poll(() => seen.at(-1)).toBe('working');
  write.resolve();
  await expect.poll(() => seen.at(-1)).toBe('idle');
  expect(seen).toEqual(['working', 'needs-input', 'working', 'idle']);
  expect(notices).toBeGreaterThanOrEqual(4);
  unsubscribe();
  await Promise.all(reads);
  expect(readFailures).toEqual([]);
});
