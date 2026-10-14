// @vitest-environment node
/**
 * Legacy parity: a host thread's first send binds it to the Main root, through
 * the host, before the run it starts; a bound thread keeps its folder.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppendMessage } from '@assistant-ui/react';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { ThreadRootsRemovedError } from '../agent-host-platform/desktop-workspace-binding';
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';
import { bindHostThreadToMainRoot } from '../renderer/host-thread-root-binding';

const MAIN = { displayName: 'project', path: '/work/project', rootId: 'root-project' };
const owned: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

function message(text: string): AppendMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId: null,
    role: 'user',
    runConfig: undefined,
    sourceId: null,
  };
}

/** A real host, a renderer view of one new thread, and the desktop's live roots. */
async function hostThread() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-root-binding-'));
  owned.push(() => rm(root, { force: true, recursive: true }));
  // Each admission's bound root, as Main receives it (production-desktop-capabilities).
  const admitted: (string | undefined)[] = [];
  const host: AgentHost = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      // Like Main: the committed binding's root is the run's bound workspace root.
      admitRun: async (request) => {
        const bound = request.workspaceBinding?.operatingRootId;
        admitted.push(bound);
        return {
          configuration: bound ? { boundWorkspaceRootId: bound } : {},
          model: scriptedModel(),
          snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
          tools: {},
        };
      },
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      // Main validates the root a binding names; this fixture's root is live.
      validateWorkspaceBinding: async ({ binding }) => {
        if (
          binding.operatingRootId &&
          !['root-project', 'root-other'].includes(binding.operatingRootId)
        ) {
          throw new ThreadRootsRemovedError([
            {
              rootId: binding.operatingRootId,
              ...(binding.operatingRootDisplayName
                ? { displayName: binding.operatingRootDisplayName }
                : {}),
            },
          ]);
        }
      },
    }
  );
  owned.push(() => host.close());
  const client: HostClient = await attachAgentHost(host.record);
  owned.push(() => client.close());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const view = (mainRoot: typeof MAIN | undefined) => {
    const conversation = createCommittedHostConversation({
      bindThreadRoot: () => bindHostThreadToMainRoot({ client, mainRoot, threadId }),
      client,
      modelId: 'scripted',
      threadId,
    });
    owned.push(async () => {
      conversation.close();
      // close() sends `log/unsubscribe` without awaiting it; this round-trip joins
      // that write before the client closes.
      await client.request('thread/list', {});
    });
    return conversation;
  };
  const rows = async (): Promise<readonly HostLogRow[]> =>
    (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
  const finished = async (count: number): Promise<void> => {
    await expect
      .poll(async () => (await rows()).filter(({ event }) => event.type === 'run.finished').length)
      .toBe(count);
  };
  return { admitted, client, finished, rows, threadId, view };
}

const kinds = (rows: readonly HostLogRow[]): string[] =>
  rows
    .map(({ event }) => event.type)
    .filter((type) => type === 'workspace.binding.updated' || type === 'run.started');

test("a host thread's first send commits its Main root binding before its run, once", async () => {
  const thread = await hostThread();
  const conversation = thread.view(MAIN);
  await conversation.commands.onNew?.(message('First question'));
  await thread.finished(1);
  await conversation.commands.onNew?.(message('Second question'));
  await thread.finished(2);

  const rows = await thread.rows();
  expect(kinds(rows)).toEqual(['workspace.binding.updated', 'run.started', 'run.started']);
  expect(thread.admitted).toEqual(['root-project', 'root-project']);
  expect(rows.find(({ event }) => event.type === 'workspace.binding.updated')?.event).toMatchObject(
    {
      binding: {
        operatingRootDisplayName: 'project',
        operatingRootId: 'root-project',
        operatingRootPath: MAIN.path,
      },
    }
  );
});

test('a thread bound to a folder keeps it, and no Main root leaves a thread unbound', async () => {
  const bound = await hostThread();
  await bound.client.request('thread/workspace/binding/update', {
    commandId: randomUUID(),
    patch: { operatingRootDisplayName: 'other', operatingRootId: 'root-other' },
    threadId: bound.threadId,
  });
  await bound.view(MAIN).commands.onNew?.(message('Question'));
  await bound.finished(1);
  expect(kinds(await bound.rows())).toEqual(['workspace.binding.updated', 'run.started']);
  expect(bound.admitted).toEqual(['root-other']);

  const unbound = await hostThread();
  await unbound.view(undefined).commands.onNew?.(message('Question'));
  await unbound.finished(1);
  expect(kinds(await unbound.rows())).toEqual(['run.started']);
  expect(unbound.admitted).toEqual([undefined]);
});

test('a Main root with no live workspace identity fails the send before any run', async () => {
  const thread = await hostThread();
  const conversation = thread.view({
    displayName: 'gone',
    path: '/work/gone',
    rootId: 'root-gone',
  });
  await expect(conversation.commands.onNew?.(message('Question'))).rejects.toMatchObject({
    code: 'workspace.folder-removed',
    failure: { category: 'conflict', code: 'workspace.folder-removed', kind: 'refusal' },
  });
  expect(kinds(await thread.rows())).toEqual([]);
});
