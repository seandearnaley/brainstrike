import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import { getTransformedToolPayload } from '@mastra/core/tools';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { saveBackgroundResult } from '../../mastra/background-results';
import { createPgliteMastraMemory } from '../memory-factory';
import type { PgliteDatabase } from '../types';

const scope = { resourceId: 'owner', threadId: 'root' } as const;

function port(database: PGlite): PgliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    query: (sql, values) => database.query(sql, values ? [...values] : undefined),
    transaction: (operation) =>
      database.transaction((transaction) =>
        operation({
          exec: (sql) => transaction.exec(sql),
          query: (sql, values) => transaction.query(sql, values ? [...values] : undefined),
        })
      ),
  };
}

function parentMessage(): MastraDBMessage {
  return {
    ...scope,
    content: {
      format: 2,
      metadata: {
        backgroundTasks: {
          'call-a': { taskId: 'task-a' },
          'call-b': { taskId: 'task-b' },
        },
        preserved: { source: 'native-snapshot' },
      },
      parts: [
        { text: 'Keep the unrelated assistant text.', type: 'text' },
        {
          providerMetadata: { vendor: { trace: 'a' } },
          toolInvocation: {
            args: { prompt: 'A' },
            result: { taskId: 'task-a' },
            state: 'result',
            toolCallId: 'call-a',
            toolName: 'agent-worker-a',
          },
          type: 'tool-invocation',
        },
        {
          toolInvocation: {
            args: { prompt: 'B' },
            result: { taskId: 'task-b' },
            state: 'result',
            toolCallId: 'call-b',
            toolName: 'agent-worker-b',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date('2026-09-16T12:00:00.000Z'),
    id: 'parent-message',
    role: 'assistant',
    type: 'v2',
  };
}

let database: PGlite;

beforeEach(async () => {
  database = await createEnginePglite();
});

afterEach(async () => {
  await database.close();
});

it('atomically overlays every terminal task onto stale native saves and acknowledges them', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Missing background task store');
  }
  for (const suffix of ['a', 'b']) {
    await tasks.createTask({
      ...scope,
      agentId: 'parent',
      args: { prompt: suffix.toUpperCase() },
      completedAt: new Date('2026-09-16T12:01:00.000Z'),
      createdAt: new Date('2026-09-16T12:00:00.000Z'),
      id: `task-${suffix}`,
      maxRetries: 0,
      result: {
        childThreadId: `child-${suffix}`,
        text: `canonical ${suffix.toUpperCase()}`,
      },
      retryCount: 0,
      runId: 'native-run',
      status: 'completed',
      timeoutMs: 30_000,
      toolCallId: `call-${suffix}`,
      toolName: `agent-worker-${suffix}`,
    });
  }

  const staleNativeSnapshot = parentMessage();
  const staleInvocation = staleNativeSnapshot.content.parts[1];
  if (staleInvocation?.type !== 'tool-invocation') {
    throw new Error('Missing stale invocation fixture');
  }
  staleNativeSnapshot.content.parts[1] = {
    ...staleInvocation,
    providerMetadata: {
      ...staleInvocation.providerMetadata,
      mastra: {
        toolPayloadTransform: {
          transcript: {
            'input-available': { transformed: { prompt: 'transformed input A' } },
            'output-available': { transformed: { taskId: 'stale-dispatch-a' } },
          },
        },
      },
    },
  };
  const firstSave = await backing.store.saveMessages({ messages: [staleNativeSnapshot] });
  const secondSave = await backing.store.saveMessages({ messages: [parentMessage()] });
  const persisted = await backing.store.listMessagesById({ messageIds: ['parent-message'] });

  for (const result of [firstSave, secondSave, persisted]) {
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content.metadata).toMatchObject({
      preserved: { source: 'native-snapshot' },
    });
    expect(result.messages[0]?.content.parts[0]).toEqual({
      text: 'Keep the unrelated assistant text.',
      type: 'text',
    });
    expect(result.messages[0]?.content.parts[1]).toMatchObject({
      providerMetadata: {
        mastra: { modelOutput: { type: 'text', value: 'canonical A' } },
        vendor: { trace: 'a' },
      },
      toolInvocation: {
        args: { prompt: 'transformed input A' },
        result: { childThreadId: 'child-a', text: 'canonical A' },
        state: 'result',
      },
    });
    expect(
      getTransformedToolPayload(
        result.messages[0]?.content.parts[1]?.providerMetadata,
        'transcript',
        'output-available'
      )
    ).toBeUndefined();
    expect(
      getTransformedToolPayload(
        result.messages[0]?.content.parts[1]?.providerMetadata,
        'transcript',
        'input-available'
      )
    ).toMatchObject({ transformed: { prompt: 'transformed input A' } });
    expect(result.messages[0]?.content.parts[2]).toMatchObject({
      providerMetadata: { mastra: { modelOutput: { type: 'text', value: 'canonical B' } } },
      toolInvocation: {
        result: { childThreadId: 'child-b', text: 'canonical B' },
        state: 'result',
      },
    });
  }
  expect(
    (
      await database.query(
        'SELECT id, delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks ORDER BY id'
      )
    ).rows
  ).toEqual([
    { delivered: true, id: 'task-a' },
    { delivered: true, id: 'task-b' },
  ]);
});

it('fails closed without mutating memory when named task metadata has no retained task row', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });

  await expect(backing.store.saveMessages({ messages: [parentMessage()] })).rejects.toThrow(
    'Background task metadata has no unique task in this conversation.'
  );
  await expect(backing.store.listMessagesById({ messageIds: ['parent-message'] })).resolves.toEqual(
    { messages: [] }
  );
});

it('rolls back delivery acknowledgement when the canonical message write fails', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Missing background task store');
  }
  for (const suffix of ['a', 'b']) {
    await tasks.createTask({
      ...scope,
      agentId: 'parent',
      args: { prompt: suffix },
      completedAt: new Date(),
      createdAt: new Date(),
      id: `task-${suffix}`,
      maxRetries: 0,
      result: { text: suffix },
      retryCount: 0,
      runId: 'native-run',
      status: 'completed',
      timeoutMs: 30_000,
      toolCallId: `call-${suffix}`,
      toolName: `agent-worker-${suffix}`,
    });
  }
  await database.exec(`
    CREATE FUNCTION reject_parent_message() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced message failure';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_parent_message
      BEFORE INSERT OR UPDATE ON mastra_messages
      FOR EACH ROW EXECUTE FUNCTION reject_parent_message();
  `);

  await expect(backing.store.saveMessages({ messages: [parentMessage()] })).rejects.toThrow(
    'forced message failure'
  );
  expect(
    (
      await database.query(
        'SELECT delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks ORDER BY id'
      )
    ).rows
  ).toEqual([{ delivered: false }, { delivered: false }]);
});

it('keeps newer parent content when a child callback holds an older message snapshot', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Missing background task store');
  }
  await tasks.createTask({
    ...scope,
    agentId: 'parent',
    args: { prompt: 'A' },
    createdAt: new Date(),
    id: 'task-a',
    maxRetries: 0,
    retryCount: 0,
    runId: 'native-run',
    status: 'running',
    timeoutMs: 30_000,
    toolCallId: 'call-a',
    toolName: 'agent-worker-a',
  });
  const initial = parentMessage();
  initial.content.metadata = {
    ...initial.content.metadata,
    backgroundTasks: { 'call-a': { taskId: 'task-a' } },
  };
  initial.content.parts = initial.content.parts.slice(0, 2);
  await backing.store.saveMessages({ messages: [initial] });
  const staleChildSnapshot = structuredClone(initial);
  await tasks.updateTask('task-a', {
    completedAt: new Date(),
    result: { childThreadId: 'child-a', text: 'canonical A' },
    status: 'completed',
  });
  const newerParent = structuredClone(initial);
  newerParent.content.parts[0] = { text: 'Newer parent text must survive.', type: 'text' };
  newerParent.content.metadata = {
    ...newerParent.content.metadata,
    preserved: { source: 'newer-parent-save' },
  };
  await backing.store.saveMessages({ messages: [newerParent] });

  const terminalTask = await tasks.getTask('task-a');
  if (!terminalTask) {
    throw new Error('Missing terminal task');
  }
  await saveBackgroundResult(backing.memory, terminalTask, {
    result: terminalTask.result,
    status: 'completed',
  });

  const saved = await backing.store.listMessagesById({ messageIds: [initial.id] });
  expect(saved.messages[0]?.content.parts[0]).toEqual({
    text: 'Newer parent text must survive.',
    type: 'text',
  });
  expect(saved.messages[0]?.content.metadata).toMatchObject({
    preserved: { source: 'newer-parent-save' },
  });
  expect(staleChildSnapshot.content.parts[0]).toEqual({
    text: 'Keep the unrelated assistant text.',
    type: 'text',
  });
});

it('reconciles legitimate progressive snapshot rows sharing one tool call', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Missing background task store');
  }
  await tasks.createTask({
    ...scope,
    agentId: 'parent',
    args: { prompt: 'A' },
    createdAt: new Date(),
    id: 'task-a',
    maxRetries: 0,
    retryCount: 0,
    runId: 'native-run',
    status: 'running',
    timeoutMs: 30_000,
    toolCallId: 'call-a',
    toolName: 'agent-worker-a',
  });
  const first = parentMessage();
  first.content.metadata = { backgroundTasks: { 'call-a': { taskId: 'task-a' } } };
  first.content.parts = first.content.parts.slice(0, 2);
  const second = structuredClone(first);
  second.id = 'parent-message-progressive';
  second.createdAt = new Date('2026-09-16T12:00:01.000Z');
  second.content.parts[0] = { text: 'Later progressive text.', type: 'text' };
  await backing.store.saveMessages({ messages: [first, second] });
  await tasks.updateTask('task-a', {
    completedAt: new Date(),
    result: { text: 'canonical A' },
    status: 'completed',
  });
  const terminal = await tasks.getTask('task-a');
  if (!terminal) {
    throw new Error('Missing terminal task');
  }
  await saveBackgroundResult(backing.memory, terminal, {
    result: terminal.result,
    status: 'completed',
  });

  const saved = await backing.store.listMessagesById({
    messageIds: [first.id, second.id],
  });
  expect(saved.messages.map((message) => message.content.parts[0])).toEqual([
    { text: 'Keep the unrelated assistant text.', type: 'text' },
    { text: 'Later progressive text.', type: 'text' },
  ]);
  for (const message of saved.messages) {
    expect(message.content.parts[1]).toMatchObject({
      toolInvocation: { result: { text: 'canonical A' }, state: 'result' },
    });
  }
});

it('rejects duplicate invocation parts before acknowledging the task', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Missing background task store');
  }
  await tasks.createTask({
    ...scope,
    agentId: 'parent',
    args: { prompt: 'A' },
    completedAt: new Date(),
    createdAt: new Date(),
    id: 'task-a',
    maxRetries: 0,
    result: { text: 'canonical A' },
    retryCount: 0,
    runId: 'native-run',
    status: 'completed',
    timeoutMs: 30_000,
    toolCallId: 'call-a',
    toolName: 'agent-worker-a',
  });
  const duplicate = parentMessage();
  duplicate.content.metadata = { backgroundTasks: { 'call-a': { taskId: 'task-a' } } };
  const invocation = duplicate.content.parts[1];
  if (!invocation) {
    throw new Error('Missing invocation fixture');
  }
  duplicate.content.parts = [invocation, structuredClone(invocation)];

  await expect(backing.store.saveMessages({ messages: [duplicate] })).rejects.toThrow(
    'missing or ambiguous'
  );
  expect(
    (
      await database.query(
        'SELECT delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks'
      )
    ).rows
  ).toEqual([{ delivered: false }]);
});
