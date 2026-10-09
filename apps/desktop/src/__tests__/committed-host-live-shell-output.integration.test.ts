// @vitest-environment node
/**
 * AT-07 on host threads: a running command's output streams live into the
 * conversation as uncommitted host telemetry, and the committed result takes
 * over when the tool finishes (ADR-0011 amendment). A reload shows no slices,
 * as legacy did. Only the model is scripted.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  SHELL_OUTPUT_DATA_NAME,
  SHELL_OUTPUT_STREAM_PART_TYPE,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';

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

test('a host command’s output streams live, then its committed result takes over', async () => {
  const finish = Promise.withResolvers<void>();
  const root = await mkdtemp(join(tmpdir(), 'bs-host-live-shell-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () => scriptedModel('run_command'),
      tools: {
        run_command: {
          description: 'Run a command',
          execute: async (_input, context) => {
            await context.write?.({
              chunk: 'STREAM_STDOUT_FIRST\n',
              stream: 'stdout',
              toolCallId: context.toolCallId,
              type: SHELL_OUTPUT_STREAM_PART_TYPE,
            });
            await finish.promise;
            return { exitCode: 0, stdout: 'STREAM_STDOUT_FIRST\n' };
          },
          identity: 'native-run-command-generation-1',
          inputSchema: z.object({ text: z.string() }),
          risk: 'read',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  cleanups.push(() => finish.resolve());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const view = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
  cleanups.push(async () => {
    view.close();
    // close() sends `log/unsubscribe` without awaiting it; this round-trip joins it.
    await client.request('thread/list', {});
  });
  const live = view.store.liveShellOutputs;
  if (!live) {
    throw new Error('The host conversation offers no live shell output');
  }
  await expect.poll(() => view.store.getSnapshot().isLoading).toBe(false);

  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run the command',
    threadId,
  });
  await expect
    .poll(() => Object.values(live.getSnapshot()))
    .toEqual([{ text: 'STREAM_STDOUT_FIRST\n', truncated: false }]);

  finish.resolve();
  await expect
    .poll(() => view.source.getSnapshot().rows.some(({ event }) => event.type === 'run.finished'))
    .toBe(true);
  expect(live.getSnapshot()).toEqual({});

  // A reload folds the committed log alone: no slice was committed, so none shows.
  const reloaded = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
  cleanups.push(async () => {
    reloaded.close();
    await client.request('thread/list', {});
  });
  await expect.poll(() => reloaded.store.getSnapshot().isLoading).toBe(false);
  const shellParts = reloaded.store
    .getSnapshot()
    .repository.messages.flatMap(({ message }) =>
      [...message.content].filter(
        (part) => part.type === 'data' && part.name === SHELL_OUTPUT_DATA_NAME
      )
    );
  expect(shellParts).toEqual([]);
  expect(reloaded.store.liveShellOutputs?.getSnapshot()).toEqual({});
});
