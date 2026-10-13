// @vitest-environment node
/**
 * BST-1990 (D4): a send the host refuses before admitting its run comes back
 * as the vendor's "message not sent", so the composer restores the user's
 * draft, with the host's refusal text, and the refusal is logged with the
 * host's code. Nothing was committed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppendMessage, isMessageNotSentError } from '@assistant-ui/react';
import { attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
import { HOST_RUN_NOT_ADMITTED_CODE } from '@brainstrike/agent-host/protocol';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (scope: string) => ({ ...actual.createLogger(scope), warn }),
  };
});

import { ThreadRootsRemovedError } from '../agent-host-platform/desktop-workspace-binding';
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';

// The typed refusal Main raises for a thread whose folder left the workspace (PR 2).
const REMOVED = new ThreadRootsRemovedError([{ displayName: 'bravo', rootId: 'r-bravo' }]);
const REFUSAL = REMOVED.message;
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

test('a send refused before admission is not sent, so its draft comes back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m6-not-admitted-'));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      admitRun: async () => {
        throw REMOVED;
      },
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    }
  );
  owned.push(() => host.close());
  const client = await attachAgentHost(host.record);
  owned.push(() => client.close());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const conversation = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
  owned.push(async () => {
    conversation.close();
    await client.request('thread/list', {});
  });

  const refusal: unknown = await conversation.commands.onNew?.(message('Hello')).then(
    () => undefined,
    (cause: unknown) => cause
  );

  expect(isMessageNotSentError(refusal)).toBe(true);
  expect(refusal).toMatchObject({ message: REFUSAL });
  // The refusal is logged at warn with the host's code, never silently dropped.
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ code: HOST_RUN_NOT_ADMITTED_CODE, method: 'run/start', threadId })
  );
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.some(({ event }) => event.type === 'run.started')).toBe(false);
});
