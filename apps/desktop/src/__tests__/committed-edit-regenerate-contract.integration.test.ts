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
