import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  resolveChildTaskTimeoutMs,
} from '@brainstrike/assistant-contract/subagent-settings';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { MessageList } from '@mastra/core/agent';
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

it.each([
  { batch: false, progressive: false },
  { batch: false, progressive: true },
  { batch: true, progressive: false },
  { batch: true, progressive: false, rotations: 2 },
  { batch: false, malformedUnrelated: true, progressive: false },
])(
  'persists the native observation suffix without moving its sealed parent invocations ($progressive/$batch)',
  async ({ progressive, batch, rotations, malformedUnrelated }) => {
    const backing = await createPgliteMastraMemory({
      backgroundTaskScope: scope,
      backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
      database: port(database),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    if (malformedUnrelated) {
      await backing.store.saveMessages({
        messages: [null, [], 42, 'malformed'].map((value, index) => ({
          ...parentMessage(),
          content: {
            format: 2,
            metadata: { backgroundTasks: value },
            parts: [{ text: 'Unrelated retained content.', type: 'text' }],
          },
          id: `unrelated-${index}`,
        })),
      });
    }
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
        result: { text: `canonical ${suffix}` },
        retryCount: 0,
        runId: 'native-run',
        status: 'completed',
        timeoutMs: 30_000,
        toolCallId: `call-${suffix}`,
        toolName: `agent-worker-${suffix}`,
      });
    }
    const original = parentMessage();
    if (progressive) {
      await backing.store.saveMessages({
        messages: [{ ...structuredClone(original), id: 'earlier-progressive' }],
      });
    }
    original.content.metadata = { ...original.content.metadata, mastra: { sealed: true } };
    const last = original.content.parts.at(-1);
    if (!last) {
      throw new Error('Missing seal boundary fixture');
    }
    Object.assign(last, { metadata: { mastra: { sealedAt: Date.now() } } });
    if (!batch) {
      await backing.store.saveMessages({ messages: [original] });
    }
    const list = new MessageList();
    list.add(structuredClone(original), 'response');
    const extended = structuredClone(original);
    extended.content.parts.push({ text: 'Continuation after observation.', type: 'text' });
    list.add(extended, 'response');
    if (rotations === 2) {
      const next = list.get.all.db()[1];
      if (!next?.content.parts[0]) {
        throw new Error('Missing native next suffix');
      }
      Object.assign(next.content.parts[0], { metadata: { mastra: { sealedAt: Date.now() } } });
      list.add(next, 'response');
      const more = structuredClone(next);
      more.content.parts.push({ text: 'Second observation continuation.', type: 'text' });
      list.add(more, 'response');
    }
    const nativeMessages = list.get.all.db();
    expect(nativeMessages).toHaveLength(rotations === 2 ? 3 : 2);
    const suffix = nativeMessages[1];
    expect(suffix?.content.parts).toMatchObject([
      { text: 'Continuation after observation.', type: 'text' },
    ]);
    if (!suffix) {
      throw new Error('Missing native observation suffix');
    }
    if (batch) {
      await backing.store.saveMessages({ messages: nativeMessages });
    }
    await database.exec('UPDATE mastra_background_tasks SET delivered_at = NULL');
    const suffixOnly = await backing.store.saveMessages({ messages: [suffix] });
    expect(suffixOnly.messages[0]?.content.metadata?.['backgroundTasks']).toEqual({});
    expect(suffixOnly.messages[0]?.content.metadata).toMatchObject({
      mastra: { sealed: true },
      preserved: { source: 'native-snapshot' },
    });
    expect(
      (
        await database.query(
          'SELECT delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks'
        )
      ).rows
    ).toEqual([{ delivered: false }, { delivered: false }]);
    await expect(backing.store.saveMessages({ messages: nativeMessages })).resolves.toMatchObject({
      messages: nativeMessages.map((message, index) =>
        index === 0 ? { id: original.id } : { content: { parts: message.content.parts } }
      ),
    });
    const reloaded = await backing.store.listMessagesById({
      messageIds: nativeMessages.map(({ id }) => id),
    });
    expect(
      reloaded.messages[0]?.content.parts.filter((part) => part.type === 'tool-invocation')
    ).toHaveLength(2);
    expect(reloaded.messages.slice(1).map((message) => message.content.parts)).toEqual(
      nativeMessages.slice(1).map((message) => message.content.parts)
    );
    expect(
      reloaded.messages
        .slice(1)
        .flatMap((message) => message.content.parts)
        .every((part) => part.type !== 'tool-invocation')
    ).toBe(true);
  }
);

it.each([
  'missing-owner',
  'foreign-owner',
  'duplicate-owner-call',
  'unsealed-owner',
  'unsealed-suffix',
  'incoming-unsealed-owner',
  'malformed-owner',
  'non-assistant-owner',
  'non-assistant-suffix',
])(
  'rejects an unproven observation suffix (%s) without delivery or content mutation',
  async (failure) => {
    const backing = await createPgliteMastraMemory({
      backgroundTaskScope: scope,
      backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    const parent = parentMessage();
    parent.content.parts = parent.content.parts.slice(0, 2);
    parent.content.metadata = {
      backgroundTasks: { 'call-a': { taskId: 'task-a' } },
      mastra: { sealed: failure !== 'unsealed-owner' },
    };
    Object.assign(parent.content.parts[1] ?? {}, { metadata: { mastra: { sealedAt: 1 } } });
    await backing.store.saveMessages({ messages: [parent] });
    if (failure === 'missing-owner') {
      await database.exec('DELETE FROM mastra_messages');
    } else if (failure === 'foreign-owner') {
      await database.exec(`UPDATE mastra_messages SET "resourceId" = 'foreign'`);
    } else if (failure === 'malformed-owner') {
      await database.exec(
        "UPDATE mastra_messages SET content = jsonb_set(content, '{metadata,backgroundTasks}', 'null'::jsonb)"
      );
    } else if (failure === 'non-assistant-owner') {
      await database.exec("UPDATE mastra_messages SET role = 'user'");
    } else if (failure === 'duplicate-owner-call') {
      const invocation = parent.content.parts[1];
      if (!invocation) {
        throw new Error('Missing invocation fixture');
      }
      parent.content.parts.push(structuredClone(invocation));
      await database.query('UPDATE mastra_messages SET content = $1::jsonb', [
        JSON.stringify(parent.content),
      ]);
    }
    await database.exec('UPDATE mastra_background_tasks SET delivered_at = NULL');
    const suffix = structuredClone(parent);
    suffix.id = 'unproven-suffix';
    if (failure === 'non-assistant-suffix') {
      suffix.role = 'user';
    }
    suffix.createdAt = new Date(parent.createdAt.getTime() + 1);
    suffix.content.parts = [{ text: 'Ordinary continuation.', type: 'text' }];
    suffix.content.metadata = {
      ...suffix.content.metadata,
      mastra: { sealed: failure !== 'unsealed-suffix' },
    };
    const incomingOwner = structuredClone(parent);
    incomingOwner.content.metadata = {
      ...incomingOwner.content.metadata,
      mastra: { sealed: false },
    };
    await expect(
      backing.store.saveMessages({
        messages: failure === 'incoming-unsealed-owner' ? [incomingOwner, suffix] : [suffix],
      })
    ).rejects.toThrow('Background parent invocation is missing or ambiguous.');
    expect(
      (
        await database.query(
          'SELECT delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks'
        )
      ).rows
    ).toEqual([{ delivered: false }]);
    await expect(backing.store.listMessagesById({ messageIds: [suffix.id] })).resolves.toEqual({
      messages: [],
    });
  }
);

it('atomically overlays every terminal task onto stale native saves and acknowledges them', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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

it('reconciles cancellation across stale saves without terminalizing its running sibling', async () => {
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
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
      createdAt: new Date(),
      id: `task-${suffix}`,
      maxRetries: 0,
      retryCount: 0,
      runId: 'native-run',
      status: suffix === 'a' ? 'cancelled' : 'running',
      timeoutMs: 30_000,
      toolCallId: `call-${suffix}`,
      toolName: `agent-worker-${suffix}`,
    });
  }
  for (const snapshot of [parentMessage(), parentMessage()]) {
    const saved = await backing.store.saveMessages({ messages: [snapshot] });
    const cancelled = saved.messages[0]?.content.parts[1];
    expect(cancelled).toMatchObject({
      providerMetadata: {
        mastra: {
          modelOutput: { type: 'error-text', value: expect.stringContaining('cancelled') },
        },
      },
      toolInvocation: { errorText: expect.stringContaining('cancelled'), state: 'output-error' },
    });
    if (cancelled?.type !== 'tool-invocation') {
      throw new Error('Missing cancellation');
    }
    expect(cancelled.toolInvocation).not.toHaveProperty('result');
    expect(saved.messages[0]?.content.parts[2]).toMatchObject(
      parentMessage().content.parts[2] ?? {}
    );
  }
  expect(
    (
      await database.query(
        'SELECT id, status, delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks ORDER BY id'
      )
    ).rows
  ).toEqual([
    { delivered: true, id: 'task-a', status: 'cancelled' },
    { delivered: false, id: 'task-b', status: 'running' },
  ]);
});
