// @vitest-environment node

/**
 * Public-client contract for committed Edit and Regenerate (BST-1929, #3543
 * 6054394054 item 2).
 *
 * Frozen contract (#3543 6054972701), through the public client and a real host:
 * - `run/start` with `parentMessageId: string | null`: the new user message
 *   follows that committed message (null: the thread root; omitted: the
 *   current tip). This is Edit, and a send from a selected branch.
 * - `run/regenerate` with `userMessageId`: a new answer to an existing
 *   committed user message (its original run/start command ID), without a
 *   new user message.
 *
 * Both admit a new run whose model history is the selected path only.
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
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { CommittedAssistantLogStore } from '@brainstrike/assistant-ui';
import { afterEach, expect, test } from 'vitest';
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';

/** The fixture's recording model: it keeps every request's prompt. */
type RecordingModel = ReturnType<typeof scriptedModel>;

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface Answered {
  readonly client: HostClient;
  readonly model: RecordingModel;
  readonly rows: readonly HostLogRow[];
  readonly runId: string;
  readonly threadId: string;
}

async function finishedRows(
  client: HostClient,
  threadId: string,
  runId: string
): Promise<readonly HostLogRow[]> {
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some(({ event }) => event.type === 'run.finished' && event.runId === runId);
    })
    .toBe(true);
  return rows;
}

/** One committed exchange through the public client: 'First question', then its answer. */
async function answeredThread(): Promise<Answered> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-edit-regenerate-'));
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
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'First question',
    threadId,
  });
  return { client, model, rows: await finishedRows(client, threadId, runId), runId, threadId };
}

/** The roles and user text the model received for one call. */
function promptOf(model: RecordingModel, call: number) {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return {
    assistantMessages: prompt.filter((message) => message.role === 'assistant').length,
    userText: prompt
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : part.type)),
  };
}

// Control for the measurement: an omitted parent continues the current tip, so
// a follow-up carries the previous answer. Re-sending a prompt is therefore not
// a regeneration, and the history assertions below can tell the two apart.
test('a follow-up run/start continues the single committed history, previous answer included', async () => {
  const first = await answeredThread();
  expect(promptOf(first.model, 0)).toEqual({ assistantMessages: 0, userText: ['First question'] });
  const { runId } = await first.client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'First question',
    threadId: first.threadId,
  });
  const rows = await finishedRows(first.client, first.threadId, runId);
  expect(committedRunIdentity(rows, runId).parentMessageId).toBe(first.runId);
  expect(promptOf(first.model, 1)).toEqual({
    assistantMessages: 1,
    userText: ['First question', 'First question'],
  });
});

test('Regenerate answers the same committed user message on a sibling branch, without re-running the first run', async () => {
  const first = await answeredThread();
  const original = committedRunIdentity(first.rows, first.runId);
  const firstRunRows = first.rows.filter(
    ({ event }) => 'runId' in event && event.runId === first.runId
  );
  const { runId } = await first.client.request('run/regenerate', {
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId: first.threadId,
    userMessageId: original.userMessageId,
  });
  const rows = await finishedRows(first.client, first.threadId, runId);
  expect(committedRunIdentity(rows, runId)).toMatchObject({
    assistantMessageId: runId,
    parentMessageId: original.parentMessageId,
    userMessageId: original.userMessageId,
  });
  // The sibling answer never enters the regenerated run's model context.
  expect(promptOf(first.model, 1)).toEqual({ assistantMessages: 0, userText: ['First question'] });
  // The first run's committed rows are unchanged: nothing of it was folded again or replayed.
  expect(rows.filter(({ event }) => 'runId' in event && event.runId === first.runId)).toEqual(
    firstRunRows
  );
});

test('Edit starts a sibling user message at the edited message’s parent, with only that branch in context', async () => {
  const first = await answeredThread();
  const original = committedRunIdentity(first.rows, first.runId);
  const { runId } = await first.client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: original.parentMessageId,
    prompt: 'Edited question',
    threadId: first.threadId,
  });
  const rows = await finishedRows(first.client, first.threadId, runId);
  expect(committedRunIdentity(rows, runId).parentMessageId).toBe(original.parentMessageId);
  expect(promptOf(first.model, 1)).toEqual({
    assistantMessages: 0,
    userText: ['Edited question'],
  });
});

test('the desktop committed conversation offers Regenerate and Edit through the host, so the shipped controls render', async () => {
  const first = await answeredThread();
  const conversation = createCommittedHostConversation({
    client: first.client,
    modelId: 'scripted',
    threadId: first.threadId,
  });
  try {
    // The vendor derives `capabilities.reload` and `capabilities.edit` from these ports.
    expect(conversation.commands.onReload).toBeTypeOf('function');
    expect(conversation.commands.onEdit).toBeTypeOf('function');
  } finally {
    conversation.close();
    // close() sends `log/unsubscribe` without awaiting it. Requests on one
    // connection are written in order, so this round-trip joins that write
    // before the client closes; otherwise the writer rejects unhandled.
    await first.client.request('thread/list', {});
  }
});

/** A fresh client fold of exactly these committed rows, with the production identities. */
function freshFold(rows: readonly HostLogRow[], threadId: string) {
  const store = new CommittedAssistantLogStore({
    identifyRun: (row) => {
      const runId = row.event['runId'];
      if (typeof runId !== 'string') {
        throw new Error('Committed conversation has no run identity');
      }
      return committedRunIdentity(rows, runId);
    },
    source: {
      getSnapshot: () => ({ connected: true, error: undefined, rows }),
      subscribe: () => () => undefined,
    },
    threadId,
  });
  const { repository } = store.getSnapshot();
  store.dispose();
  return repository;
}

/** An edit as the installed vendor hands it to the adapter's onEdit port. */
function editOf(text: string, parentId: string | null, sourceId: string): AppendMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId,
    role: 'user',
    runConfig: undefined,
    sourceId,
  };
}

test('the live desktop view equals a fresh fold of the committed log at every resume point, across a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-branch-replay-'));
  roots.push(root);
  const model = scriptedModel();
  const platform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
  let host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  let client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  let live = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
  /** Wait for the live view to settle on `runId`, then compare it with a fresh fold. */
  const resumePoint = async (runId: string) => {
    const rows = await finishedRows(client, threadId, runId);
    await expect
      .poll(
        () =>
          !live.store.getSnapshot().isRunning &&
          live.store
            .getCommittedView()
            .repository.messages.some(
              ({ message }) => message.id === runId && message.status?.type !== 'running'
            )
      )
      .toBe(true);
    expect(live.store.getSnapshot().repository).toEqual(freshFold(rows, threadId));
    return rows;
  };
  /** The run the latest command admitted: a committed run.started not seen before. */
  const known = new Set<string>();
  const admitted = async (): Promise<string> => {
    let runId: string | undefined;
    await expect
      .poll(async () => {
        const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
        runId = rows.flatMap(({ event }) =>
          event.type === 'run.started' && !known.has(event.runId) ? [event.runId] : []
        )[0];
        return runId;
      })
      .toBeTypeOf('string');
    known.add(String(runId));
    return String(runId);
  };
  const close = async () => {
    live.close();
    // Join the view's unsubscribe write before the client closes.
    await client.request('thread/list', {});
  };
  try {
    const { runId: first } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'First question',
      threadId,
    });
    known.add(first);
    await resumePoint(first);
    const { runId: second } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Second question',
      threadId,
    });
    known.add(second);
    const afterSecond = await resumePoint(second);
    const secondUser = committedRunIdentity(afterSecond, second).userMessageId;

    // The shipped controls' ports: Regenerate, then an edit of the same message.
    await live.commands.onReload?.(secondUser, {
      parentId: secondUser,
      runConfig: {},
      sourceId: second,
    });
    const regenerated = await admitted();
    await resumePoint(regenerated);
    await live.commands.onEdit?.(editOf('Second question, edited', first, secondUser));
    const edited = await admitted();
    const afterEdit = await resumePoint(edited);
    expect(committedRunIdentity(afterEdit, edited).parentMessageId).toBe(first);
    const before = live.store.getSnapshot().repository;

    // Restart: a new host and view over the same Root fold the same tree.
    await close();
    await client.close();
    await host.close();
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    hosts.push(host);
    client = await attachAgentHost(host.record);
    clients.push(client);
    live = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
    await resumePoint(edited);
    expect(live.store.getSnapshot().repository).toEqual(before);

    // A send from the regenerated branch continues it after the restart.
    await live.commands.onNew?.({
      ...editOf('Third question', regenerated, ''),
      sourceId: null,
    });
    const continued = await admitted();
    const afterContinue = await resumePoint(continued);
    expect(committedRunIdentity(afterContinue, continued).parentMessageId).toBe(regenerated);
  } finally {
    await close();
  }
});
