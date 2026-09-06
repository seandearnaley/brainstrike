import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import {
  COMPACTION_SUMMARY_METADATA_KEY,
  isCompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';
import {
  type RediscoveredToolApproval,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type RediscoveredToolSuspend,
  TOOL_SUSPEND_DATA_NAME,
  UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
} from '@brainstrike/assistant-contract/tool-suspend';
import { MigrationRunner, migrations } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  mapRunLedgerRow,
  RUN_LEDGER_AGGREGATION_SQL,
} from '../assistant-memory-repository';
import { createMigratedTestPGlite } from './helpers/test-pglite';

function makeMessagesOnlyRepository(): AssistantThreadRepository {
  return {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(),
    createThread: vi.fn(),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    deleteThreads: vi.fn(),
    getCrossRootUsage: vi.fn(async () => []),
    getRunLedger: vi.fn(async () => []),
    getThreadCumulativeUsage: vi.fn(async () => null),
    getThreadRunTurnMessageId: vi.fn(async () => null),
    listLatestThreadRuns: vi.fn(),
    listMessages: vi.fn(async () => [
      {
        content: { content: 'Please run the deploy.' },
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'message-1',
        role: 'user' as const,
      },
    ]),
    listThreadCheckpoints: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(),
    recordMessageParent: vi.fn(),
    recordRunOutcome: vi.fn(),
    recordRunUsage: vi.fn(),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
    updateThreadsMetadata: vi.fn(),
  };
}

function makeApproval(overrides: Partial<RediscoveredToolApproval>): RediscoveredToolApproval {
  return {
    runId: 'run-1',
    stale: false,
    suspendedAt: '2026-04-22T10:05:00.000Z',
    toolCallId: 'call-1',
    toolName: 'brainstrike.executeCommand',
    ...overrides,
  };
}

function makeSuspend(overrides: Partial<RediscoveredToolSuspend>): RediscoveredToolSuspend {
  return {
    runId: 'run-suspend-1',
    stale: false,
    suspendedAt: '2026-04-22T10:06:00.000Z',
    suspendPayload: { question: 'Which region?' },
    toolCallId: 'call-suspend-1',
    toolName: 'brainstrike.askUser',
    ...overrides,
  };
}

describe('createAssistantThreadHistoryAdapter', () => {
  // Mirrors the REAL persisted envelope pinned in
  // packages/agent mastra-memory-persistence.integration.spec.ts
  // ("persists a user image attachment part…") — never hand-edit the shape.
  const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=';
  const persistedImageUserContent = (text: string) => ({
    content: text,
    experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
    format: 2,
    parts: [
      ...(text ? [{ createdAt: 1_784_220_604_614, text, type: 'text' }] : []),
      {
        createdAt: 1_784_220_604_614,
        data: PNG_DATA_URL,
        mimeType: 'image/png',
        type: 'file',
      },
    ],
  });

  it('hydrates a persisted user image attachment into message.attachments', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () => [
      {
        content: persistedImageUserContent('what is in this screenshot?'),
        createdAt: new Date('2026-07-16T10:00:00Z'),
        id: 'user-image-1',
        role: 'user' as const,
      },
    ]);
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const { messages } = await adapter.load();
    const userMessage = messages.find((entry) => entry.message.id === 'user-image-1')?.message;
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toEqual([{ text: 'what is in this screenshot?', type: 'text' }]);
    expect(userMessage?.attachments).toEqual([
      {
        content: [{ image: PNG_DATA_URL, type: 'image' }],
        contentType: 'image/png',
        id: 'user-image-1-attachment-1',
        name: 'image-1.png',
        status: { type: 'complete' },
        type: 'image',
      },
    ]);
  });

  it('keeps an image-only user message alive through hydration', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () => [
      {
        content: persistedImageUserContent(''),
        createdAt: new Date('2026-07-16T10:00:00Z'),
        id: 'user-image-only',
        role: 'user' as const,
      },
    ]);
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const { messages } = await adapter.load();
    const userMessage = messages.find((entry) => entry.message.id === 'user-image-only')?.message;
    expect(userMessage).toBeDefined();
    expect(userMessage?.attachments).toHaveLength(1);
  });

  it('persists assistant-ui parent links without duplicating Mastra message content', async () => {
    const recordMessageParent = vi.fn(async () => undefined);
    const repository = Object.assign(makeMessagesOnlyRepository(), { recordMessageParent });
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await adapter.append({
      message: {
        attachments: [],
        content: [{ text: 'Edited prompt', type: 'text' }],
        createdAt: new Date('2026-07-13T10:01:00Z'),
        id: 'user-edited',
        metadata: { custom: {} },
        role: 'user',
      },
      parentId: 'assistant-before-edit',
    });

    expect(recordMessageParent).toHaveBeenCalledOnce();
    expect(recordMessageParent).toHaveBeenCalledWith({
      messageId: 'user-edited',
      parentId: 'assistant-before-edit',
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });
  });

  it('replays edited user prompts as carousel branches instead of consecutive messages', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () => [
      {
        content: { content: 'Original prompt' },
        createdAt: new Date('2026-07-13T10:00:00Z'),
        id: 'user-original',
        parentId: null,
        role: 'user',
      },
      {
        content: { content: 'Original response' },
        createdAt: new Date('2026-07-13T10:00:01Z'),
        id: 'assistant-original',
        parentId: 'user-original',
        role: 'assistant',
      },
      {
        content: { content: 'Edited prompt' },
        createdAt: new Date('2026-07-13T10:01:00Z'),
        id: 'user-edited',
        parentId: null,
        role: 'user',
      },
      {
        content: { content: 'Edited response' },
        createdAt: new Date('2026-07-13T10:01:01Z'),
        id: 'assistant-edited',
        parentId: 'user-edited',
        role: 'assistant',
      },
    ]);
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.headId).toBe('assistant-edited');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-original', null],
      ['assistant-original', 'user-original'],
      ['user-edited', null],
      ['assistant-edited', 'user-edited'],
    ]);
  });

  it('replays regenerated assistant responses as carousel siblings', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () => [
      {
        content: { content: 'Original prompt' },
        createdAt: new Date('2026-07-13T10:00:00Z'),
        id: 'user-original',
        parentId: null,
        role: 'user',
      },
      {
        content: { content: 'Original response' },
        createdAt: new Date('2026-07-13T10:00:01Z'),
        id: 'assistant-original',
        parentId: 'user-original',
        role: 'assistant',
      },
      {
        content: { content: 'Regenerated response' },
        createdAt: new Date('2026-07-13T10:00:02Z'),
        id: 'assistant-regenerated',
        parentId: 'user-original',
        role: 'assistant',
      },
    ]);
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.headId).toBe('assistant-regenerated');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-original', null],
      ['assistant-original', 'user-original'],
      ['assistant-regenerated', 'user-original'],
    ]);
  });

  it('keeps the assistant-ui id when Mastra seals one response into snapshot rows', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () => [
      {
        content: { content: 'Original prompt' },
        createdAt: new Date('2026-07-13T10:00:00Z'),
        id: 'user-original',
        parentId: null,
        role: 'user',
      },
      {
        content: { content: 'First response snapshot' },
        createdAt: new Date('2026-07-13T10:00:01Z'),
        id: 'assistant-client-id',
        parentId: 'user-original',
        role: 'assistant',
      },
      {
        content: { content: 'Final response snapshot' },
        createdAt: new Date('2026-07-13T10:00:02Z'),
        id: 'assistant-mastra-snapshot-id',
        role: 'assistant',
      },
      {
        content: { content: 'Edited follow-up' },
        createdAt: new Date('2026-07-13T10:01:00Z'),
        id: 'user-edited',
        parentId: 'assistant-client-id',
        role: 'user',
      },
    ]);
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.headId).toBe('user-edited');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-original', null],
      ['assistant-client-id', 'user-original'],
      ['user-edited', 'assistant-client-id'],
    ]);
  });

  it('hydrates assistant-ui history from Mastra memory messages', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { content: 'Remember the deploy window is Friday.' },
          createdAt: new Date('2026-04-22T10:00:00Z'),
          id: 'message-1',
          role: 'user',
        },
        {
          content: { content: 'I will remember that.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
          id: 'message-2',
          role: 'assistant',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };

    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(repository.listMessages).toHaveBeenCalledWith('thread-1', 'workspace-a', {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    expect(repository.listThreadRunEvents).toHaveBeenCalledWith('thread-1', 'workspace-a', {
      limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    expect(history.headId).toBe('message-2');
    expect(history.messages.map((item) => item.parentId)).toEqual([null, 'message-1']);
    expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-2']);
    expect(history.messages[0]?.message.content).toEqual([
      { text: 'Remember the deploy window is Friday.', type: 'text' },
    ]);
  });

  it('returns a closed branch graph when hydration evicts the parent before the latest 80 rows', async () => {
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(async () =>
      Array.from({ length: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT }, (_, index) => ({
        content: { content: `Prompt ${index + 1}` },
        createdAt: new Date(Date.UTC(2026, 6, 13, 10, index)),
        id: `message-${index + 1}`,
        parentId: `message-${index}`,
        role: 'user' as const,
      }))
    );
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    const retainedIds = new Set(history.messages.map((item) => item.message.id));
    expect(history.messages).toHaveLength(ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT);
    expect(history.messages[0]?.parentId).toBeNull();
    expect(
      history.messages.every((item) => item.parentId === null || retainedIds.has(item.parentId))
    ).toBe(true);
  });

  it('appends a synthetic approval notice message per rediscovered suspended run', async () => {
    const repository = makeMessagesOnlyRepository();
    const discoverSuspendedRuns = vi.fn(async () => ({
      approvals: [makeApproval({})],
      suspends: [],
    }));

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(discoverSuspendedRuns).toHaveBeenCalledWith('thread-1', 'workspace-a');
    const last = history.messages.at(-1);
    expect(last?.message.id).toBe('suspended-approval:run-1:call-1');
    expect(last?.parentId).toBe('message-1');
    expect(last?.message.role).toBe('assistant');
    expect(last?.message.content).toEqual([
      { data: makeApproval({}), name: TOOL_APPROVAL_DATA_NAME, type: 'data' },
    ]);
    expect(history.headId).toBe('suspended-approval:run-1:call-1');
  });

  it('runs discovery concurrently with the history query (off the serial load path)', async () => {
    let resolveMessages: (
      value: Awaited<ReturnType<AssistantThreadRepository['listMessages']>>
    ) => void = () => {
      // reassigned synchronously inside the Promise executor below
    };
    const messagesPromise = new Promise<
      Awaited<ReturnType<AssistantThreadRepository['listMessages']>>
    >((resolve) => {
      resolveMessages = resolve;
    });
    const repository = makeMessagesOnlyRepository();
    repository.listMessages = vi.fn(() => messagesPromise);
    const discoverSuspendedRuns = vi.fn(async () => ({ approvals: [], suspends: [] }));

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const loadPromise = adapter.load();
    // Discovery must be dispatched without waiting for the (still-pending) history query.
    await Promise.resolve();
    expect(discoverSuspendedRuns).toHaveBeenCalledTimes(1);

    resolveMessages([
      {
        content: { content: 'Please run the deploy.' },
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'message-1',
        role: 'user',
      },
    ]);
    await loadPromise;
  });

  it('orders multiple rediscovered approvals oldest-first as trailing messages', async () => {
    const repository = makeMessagesOnlyRepository();
    const newer = makeApproval({
      runId: 'run-newer',
      suspendedAt: '2026-04-22T12:00:00.000Z',
      toolCallId: 'call-newer',
    });
    const older = makeApproval({
      runId: 'run-older',
      suspendedAt: '2026-04-22T11:00:00.000Z',
      toolCallId: 'call-older',
    });
    const discoverSuspendedRuns = vi.fn(async () => ({ approvals: [newer, older], suspends: [] }));

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    const suspendedIds = history.messages
      .filter((item) => item.message.id.startsWith('suspended-approval:'))
      .map((item) => item.message.id);
    expect(suspendedIds).toEqual([
      'suspended-approval:run-older:call-older',
      'suspended-approval:run-newer:call-newer',
    ]);
    expect(history.headId).toBe('suspended-approval:run-newer:call-newer');
  });

  it('appends a synthetic SUSPEND notice message carrying the tool-suspend data part (BST-1084)', async () => {
    const repository = makeMessagesOnlyRepository();
    const pause = makeSuspend({});
    const discoverSuspendedRuns = vi.fn(async () => ({ approvals: [], suspends: [pause] }));

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    const last = history.messages.at(-1);
    expect(last?.message.id).toBe('suspended-pause:run-suspend-1:call-suspend-1');
    expect(last?.message.role).toBe('assistant');
    // The data part is IDENTICAL in name to the live-stream mapper's output,
    // so AssistantToolSuspendNotice renders it and its typed resume action
    // reuses the stateless resume seam unchanged.
    expect(last?.message.content).toEqual([
      { data: pause, name: TOOL_SUSPEND_DATA_NAME, type: 'data' },
    ]);
    expect(history.headId).toBe('suspended-pause:run-suspend-1:call-suspend-1');
  });

  it('interleaves rediscovered approvals and suspends oldest-first by suspendedAt', async () => {
    const repository = makeMessagesOnlyRepository();
    const olderSuspend = makeSuspend({
      runId: 'run-s-old',
      suspendedAt: '2026-04-22T10:30:00.000Z',
      toolCallId: 'call-s-old',
    });
    const newerApproval = makeApproval({
      runId: 'run-a-new',
      suspendedAt: '2026-04-22T11:00:00.000Z',
      toolCallId: 'call-a-new',
    });
    const discoverSuspendedRuns = vi.fn(async () => ({
      approvals: [newerApproval],
      suspends: [olderSuspend],
    }));

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();
    const pauseIds = history.messages
      .filter((item) => item.message.id.startsWith('suspended-'))
      .map((item) => item.message.id);
    expect(pauseIds).toEqual([
      'suspended-pause:run-s-old:call-s-old',
      'suspended-approval:run-a-new:call-a-new',
    ]);
    expect(history.headId).toBe('suspended-approval:run-a-new:call-a-new');
  });

  it('is byte-identical to the base hydration when no discovery capability is provided', async () => {
    const repository = makeMessagesOnlyRepository();
    const withoutCapability = await createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    }).load();

    const emptyDiscovery = vi.fn(async () => ({ approvals: [], suspends: [] }));
    const withEmptyDiscovery = await createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns: emptyDiscovery,
      repository: makeMessagesOnlyRepository(),
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    }).load();

    expect(withEmptyDiscovery).toEqual(withoutCapability);
  });

  it('hydrates only the bounded latest message window from Mastra memory', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => []),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await adapter.load();

    expect(repository.listMessages).toHaveBeenCalledWith('thread-1', 'workspace-a', {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
  });

  it('writes only client-side topology while Mastra remains the durable content writer', async () => {
    const recordMessageParent = vi.fn(async () => undefined);
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => []),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent,
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await expect(
      adapter.append({
        message: {
          attachments: [],
          content: [{ text: 'Hello', type: 'text' }],
          createdAt: new Date('2026-04-22T10:00:00Z'),
          id: 'message-1',
          metadata: { custom: {} },
          role: 'user',
        },
        parentId: null,
      })
    ).resolves.toBeUndefined();
    expect(repository.listMessages).not.toHaveBeenCalled();
    expect(recordMessageParent).toHaveBeenCalledWith({
      messageId: 'message-1',
      parentId: null,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });
  });

  it('hydrates cyclic message content without recursing indefinitely', async () => {
    const cyclicContent: Record<string, unknown> = {};
    cyclicContent['content'] = cyclicContent;
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: cyclicContent,
          createdAt: new Date('2026-04-22T10:00:00Z'),
          id: 'message-1',
          role: 'user',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await expect(adapter.load()).resolves.toEqual({ headId: null, messages: [] });
  });

  it('hydrates persisted assistant run events as assistant-ui data parts on the latest assistant message', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { content: 'Use memory' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-1',
          role: 'user',
        },
        {
          content: { content: 'I used memory.' },
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-2',
          role: 'assistant',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => [
        {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          metadata: { threadId: 'thread-1' },
          runId: 'run-1',
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
        } satisfies AssistantRunEvent,
      ]),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();
    const assistant = history.messages.find((item) => item.message.id === 'message-2');

    expect(repository.listThreadRunEvents).toHaveBeenCalledWith('thread-1', 'workspace-a', {
      limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    expect(assistant?.message.content).toEqual([
      {
        data: {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          metadata: { threadId: 'thread-1' },
          runId: 'run-1',
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
        },
        name: 'brainstrike.run-event',
        type: 'data',
      },
      { text: 'I used memory.', type: 'text' },
    ]);
  });

  it('hydrates persisted assistant tool-call parts after reload', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { content: 'Search files' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-1',
          role: 'user',
        },
        {
          content: {
            parts: [
              {
                args: { path: '.', pattern: '*.ts' },
                isError: false,
                result: { matches: ['src/a.ts'] },
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                type: 'tool-call',
              },
              { text: 'I found one match.', type: 'text' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-2',
          role: 'assistant',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();
    const assistant = history.messages.find((item) => item.message.id === 'message-2');

    expect(assistant?.message.content).toEqual([
      {
        args: { path: '.', pattern: '*.ts' },
        argsText: '{"path":".","pattern":"*.ts"}',
        isError: false,
        result: { matches: ['src/a.ts'] },
        toolCallId: 'call-files',
        toolName: 'filesystem.search_files',
        type: 'tool-call',
      },
      { text: 'I found one match.', type: 'text' },
    ]);
  });

  it('hydrates separate persisted tool result rows back onto assistant tool calls', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { content: 'Search files' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-1',
          role: 'user',
        },
        {
          content: {
            parts: [
              {
                args: { path: '.', pattern: '*.ts' },
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                type: 'tool-call',
              },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-2',
          role: 'assistant',
        },
        {
          content: {
            parts: [
              {
                isError: false,
                result: { matches: ['src/a.ts'] },
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                type: 'tool-result',
              },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:02Z'),
          id: 'message-3',
          role: 'tool',
        },
        {
          content: { content: 'I found one match.' },
          createdAt: new Date('2026-04-24T12:00:03Z'),
          id: 'message-4',
          role: 'assistant',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();
    // The tool-call row, tool-result row, and final text row are one live
    // assistant turn, so they hydrate back into ONE message (under the last
    // row's id) — exactly how the thread rendered while streaming.
    expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-4']);
    const toolAssistant = history.messages.find((item) => item.message.id === 'message-4');

    expect(toolAssistant?.message.content).toEqual([
      {
        args: { path: '.', pattern: '*.ts' },
        argsText: '{"path":".","pattern":"*.ts"}',
        isError: false,
        result: { matches: ['src/a.ts'] },
        toolCallId: 'call-files',
        toolName: 'filesystem.search_files',
        type: 'tool-call',
      },
      { text: 'I found one match.', type: 'text' },
    ]);
  });

  it('hydrates mixed content arrays and system messages while skipping malformed parts', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { text: 'System guard' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-system',
          role: 'system',
        },
        {
          content: ['Use', { content: 'nested text' }],
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-user',
          role: 'user',
        },
        {
          content: {
            parts: [
              null,
              ['bad'],
              { text: 'ignored', type: 'unknown' },
              { text: '  ', type: 'text' },
              { text: 'Visible answer', type: 'text' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:02Z'),
          id: 'message-assistant',
          role: 'assistant',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.messages.map((item) => item.parentId)).toEqual([
      null,
      'message-system',
      'message-user',
    ]);
    expect(history.messages.map((item) => item.message.content)).toEqual([
      [{ text: 'System guard', type: 'text' }],
      [{ text: 'Use\nnested text', type: 'text' }],
      [{ text: 'Visible answer', type: 'text' }],
    ]);
  });

  it('hydrates legacy tool-result output and error snapshots', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: {
            parts: [
              { toolCallId: 'call-output', toolName: 'workspace.read', type: 'tool-call' },
              { toolCallId: 'call-error', toolName: 'workspace.write', type: 'tool-call' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-1',
          role: 'assistant',
        },
        {
          content: { output: { ok: true }, toolCallId: 'call-output' },
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-2',
          role: 'tool',
        },
        {
          content: { error: 'denied', toolCallId: 'call-error' },
          createdAt: new Date('2026-04-24T12:00:02Z'),
          id: 'message-3',
          role: 'tool',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.messages[0]?.message.content).toEqual([
      {
        args: {},
        argsText: '{}',
        result: { ok: true },
        toolCallId: 'call-output',
        toolName: 'workspace.read',
        type: 'tool-call',
      },
      {
        args: {},
        argsText: '{}',
        isError: true,
        result: 'denied',
        toolCallId: 'call-error',
        toolName: 'workspace.write',
        type: 'tool-call',
      },
    ]);
  });

  it('drops malformed tool calls and empty system messages from hydrated history', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          content: { text: '   ' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
          id: 'message-empty-system',
          role: 'system',
        },
        {
          content: {
            parts: [
              { toolCallId: '', toolName: 'workspace.read', type: 'tool-call' },
              { toolCallId: 'call-missing-name', toolName: '', type: 'tool-call' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
          id: 'message-empty-assistant',
          role: 'assistant',
        },
        {
          content: { content: 'still visible' },
          createdAt: new Date('2026-04-24T12:00:02Z'),
          id: 'message-user',
          role: 'user',
        },
      ]),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.headId).toBe('message-user');
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.message.content).toEqual([{ text: 'still visible', type: 'text' }]);
  });

  describe('reasoning hydration', () => {
    function makeRepository(
      content: unknown
    ): Parameters<typeof createAssistantThreadHistoryAdapter>[0]['repository'] {
      return {
        appendThreadRunEvent: vi.fn(),
        completeThreadRun: vi.fn(),
        createThread: vi.fn(),
        createThreadRun: vi.fn(),
        deleteThread: vi.fn(),
        deleteThreads: vi.fn(),
        getCrossRootUsage: vi.fn(async () => []),
        getRunLedger: vi.fn(async () => []),
        getThreadCumulativeUsage: vi.fn(async () => null),
        getThreadRunTurnMessageId: vi.fn(async () => null),
        listLatestThreadRuns: vi.fn(),
        listMessages: vi.fn(async () => [
          {
            content: { content: 'Think first.' },
            createdAt: new Date('2026-04-22T10:00:00Z'),
            id: 'message-1',
            role: 'user',
          },
          {
            content,
            createdAt: new Date('2026-04-22T10:00:01Z'),
            id: 'message-2',
            role: 'assistant',
          },
        ]),
        listThreadCheckpoints: vi.fn(async () => []),
        listThreadRunEvents: vi.fn(async () => []),
        listThreads: vi.fn(),
        recordMessageParent: vi.fn(),
        recordRunOutcome: vi.fn(),
        recordRunUsage: vi.fn(),
        renameThread: vi.fn(),
        updateThreadMetadata: vi.fn(),
        updateThreadsMetadata: vi.fn(),
      } as Parameters<typeof createAssistantThreadHistoryAdapter>[0]['repository'];
    }

    function getReasoningTexts(
      history: Awaited<ReturnType<ReturnType<typeof createAssistantThreadHistoryAdapter>['load']>>
    ): string[] {
      return history.messages.flatMap((item) =>
        item.message.content
          .filter((part): part is { type: 'reasoning'; text: string } => part.type === 'reasoning')
          .map((part) => part.text)
      );
    }

    it('reconstructs a reasoning part with text field alongside a text part', async () => {
      const repository = makeRepository([
        { text: 'because X', type: 'reasoning' },
        { text: 'the answer is 42', type: 'text' },
      ]);
      const adapter = createAssistantThreadHistoryAdapter({
        repository,
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      });

      const history = await adapter.load();
      const assistant = history.messages.find((item) => item.message.id === 'message-2');

      expect(getReasoningTexts(history)).toEqual(['because X']);
      expect(assistant?.message.content).toContainEqual({ text: 'because X', type: 'reasoning' });
      expect(assistant?.message.content).toContainEqual({ text: 'the answer is 42', type: 'text' });
    });

    it('reconstructs a reasoning part using the reasoning field as fallback when text is absent', async () => {
      const repository = makeRepository([
        { reasoning: 'alt thinking', type: 'reasoning' },
        { text: 'done', type: 'text' },
      ]);
      const adapter = createAssistantThreadHistoryAdapter({
        repository,
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      });

      const history = await adapter.load();

      expect(getReasoningTexts(history)).toEqual(['alt thinking']);
    });

    it('drops a reasoning part whose text is only whitespace', async () => {
      const repository = makeRepository([
        { text: '   ', type: 'reasoning' },
        { text: 'still here', type: 'text' },
      ]);
      const adapter = createAssistantThreadHistoryAdapter({
        repository,
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      });

      const history = await adapter.load();

      expect(getReasoningTexts(history)).toEqual([]);
    });
  });
});

describe('createAssistantThreadHistoryAdapter — Mastra v2 persisted dialect', () => {
  // These fixtures mirror what Mastra 1.x ACTUALLY writes to mastra_messages
  // (format-2 content; tool calls as nested `tool-invocation` parts with
  // inline results; `data-om-*`/`step-start` bookkeeping parts; observational
  // memory persisting progressive snapshot rows of the same logical message).
  // The live-loop proof for this shape is
  // packages/agent/src/__tests__/mastra-memory-persistence.spec.ts — keep the
  // two in sync.
  interface HistoryMessageRow {
    content: unknown;
    createdAt: Date;
    id: string;
    role: 'assistant' | 'user';
  }

  function makeRepository(args: {
    messages: HistoryMessageRow[];
    runEvents?: AssistantRunEvent[];
  }): Parameters<typeof createAssistantThreadHistoryAdapter>[0]['repository'] {
    return {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      deleteThreads: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getRunLedger: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getThreadRunTurnMessageId: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => args.messages),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => args.runEvents ?? []),
      listThreads: vi.fn(),
      recordMessageParent: vi.fn(),
      recordRunOutcome: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
      updateThreadsMetadata: vi.fn(),
    } as Parameters<typeof createAssistantThreadHistoryAdapter>[0]['repository'];
  }

  function makeToolInvocationPart(args: {
    toolCallId: string;
    toolName: string;
    input?: Record<string, unknown>;
    state?: string;
    result?: unknown;
    errorText?: string;
  }): Record<string, unknown> {
    return {
      providerMetadata: { openai: { itemId: 'fc_test' } },
      toolInvocation: {
        args: args.input ?? {},
        state: args.state ?? 'result',
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        ...(args.result === undefined ? {} : { result: args.result }),
        ...(args.errorText === undefined ? {} : { errorText: args.errorText }),
      },
      type: 'tool-invocation',
    };
  }

  const OM_STATUS_PART = {
    createdAt: 1_781_183_967_655,
    data: { recordId: 'om-record-1', stepNumber: 1 },
    type: 'data-om-status',
  };

  async function loadHistory(args: {
    messages: HistoryMessageRow[];
    runEvents?: AssistantRunEvent[];
  }) {
    const adapter = createAssistantThreadHistoryAdapter({
      repository: makeRepository(args),
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });
    return await adapter.load();
  }

  it('hydrates tool-invocation parts with inline results from format-2 content', async () => {
    const history = await loadHistory({
      messages: [
        {
          content: {
            content: 'weather in Paris?',
            format: 2,
            parts: [{ text: 'weather in Paris?', type: 'text' }],
          },
          createdAt: new Date('2026-06-11T13:18:10Z'),
          id: 'message-user',
          role: 'user',
        },
        {
          content: {
            format: 2,
            parts: [
              OM_STATUS_PART,
              // OpenAI encrypted reasoning persists as an empty-reasoning part.
              { details: [{ text: '', type: 'text' }], reasoning: '', type: 'reasoning' },
              makeToolInvocationPart({
                input: { city: 'Paris' },
                result: { city: 'Paris', temperatureC: 21 },
                toolCallId: 'call-1',
                toolName: 'get_weather',
              }),
              { type: 'step-start' },
              { text: 'It is 21C in Paris.', type: 'text' },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'message-assistant',
          role: 'assistant',
        },
      ],
    });

    const assistant = history.messages.find((item) => item.message.id === 'message-assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.message.content).toContainEqual({
      args: { city: 'Paris' },
      argsText: '{"city":"Paris"}',
      result: { city: 'Paris', temperatureC: 21 },
      toolCallId: 'call-1',
      toolName: 'get_weather',
      type: 'tool-call',
    });
    expect(assistant?.message.content).toContainEqual({
      text: 'It is 21C in Paris.',
      type: 'text',
    });
    // Bookkeeping parts and empty reasoning never become visible content.
    const types = assistant?.message.content.map((part) => part.type);
    expect(types).not.toContain('reasoning');
    expect(types).toEqual(['tool-call', 'text']);
  });

  it('D3: normalizes a persisted sanitized native tool name back to its dotted display form', async () => {
    const history = await loadHistory({
      messages: [
        {
          content: {
            format: 2,
            parts: [
              // Mastra persists the REGISTERED (sanitized) native id; live turns
              // display the dotted form. Hydration must match the live label.
              makeToolInvocationPart({
                input: { pattern: 'flag' },
                result: { matches: [] },
                toolCallId: 'call-grep',
                toolName: 'brainstrike_grepSearch',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'message-assistant',
          role: 'assistant',
        },
      ],
    });

    expect(history.messages[0]?.message.content).toContainEqual({
      args: { pattern: 'flag' },
      argsText: '{"pattern":"flag"}',
      result: { matches: [] },
      toolCallId: 'call-grep',
      toolName: 'brainstrike.grepSearch',
      type: 'tool-call',
    });
  });

  it('marks output-error invocations as failed tool calls with the error text as result', async () => {
    const history = await loadHistory({
      messages: [
        {
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                errorText: 'city not found',
                input: { city: 'Atlantis' },
                state: 'output-error',
                toolCallId: 'call-err',
                toolName: 'get_weather',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'message-assistant',
          role: 'assistant',
        },
      ],
    });

    expect(history.messages[0]?.message.content).toContainEqual({
      args: { city: 'Atlantis' },
      argsText: '{"city":"Atlantis"}',
      isError: true,
      result: 'city not found',
      toolCallId: 'call-err',
      toolName: 'get_weather',
      type: 'tool-call',
    });
  });

  it('preserves guarded tool failures persisted as successful Mastra tool results', async () => {
    const guardedError = {
      error: {
        code: 'tool_failed',
        message: 'The tool did not complete successfully. Try another approach.',
        toolName: 'brainstrike_readWorkspaceFile',
      },
      ok: false,
    };
    const history = await loadHistory({
      messages: [
        {
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                input: { path: 'packages/agent/package.json' },
                result: guardedError,
                toolCallId: 'call-failed-read',
                toolName: 'brainstrike_readWorkspaceFile',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'message-assistant',
          role: 'assistant',
        },
      ],
    });

    expect(history.messages[0]?.message.content).toContainEqual({
      args: { path: 'packages/agent/package.json' },
      argsText: '{"path":"packages/agent/package.json"}',
      isError: true,
      result: guardedError,
      toolCallId: 'call-failed-read',
      toolName: 'brainstrike.readWorkspaceFile',
      type: 'tool-call',
    });
  });

  it('dedupes tool calls repeated across observational-memory snapshot rows', async () => {
    // OM sealing persists progressive snapshots of the same accumulating
    // assistant message under fresh row ids. The same toolCallId must render
    // once, at its first (chronological) position, with the richer result
    // merged in from the later snapshot.
    const history = await loadHistory({
      messages: [
        {
          content: {
            format: 2,
            parts: [
              OM_STATUS_PART,
              makeToolInvocationPart({
                input: { pattern: 'foo' },
                state: 'call',
                toolCallId: 'call-a',
                toolName: 'grep_search',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'snapshot-1',
          role: 'assistant',
        },
        {
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                input: { pattern: 'foo' },
                result: { matches: 3 },
                toolCallId: 'call-a',
                toolName: 'grep_search',
              }),
              makeToolInvocationPart({
                input: { path: 'a.ts' },
                result: { ok: true },
                toolCallId: 'call-b',
                toolName: 'read_file',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:29Z'),
          id: 'snapshot-2',
          role: 'assistant',
        },
        {
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                input: { pattern: 'foo' },
                result: { matches: 3 },
                toolCallId: 'call-a',
                toolName: 'grep_search',
              }),
              makeToolInvocationPart({
                input: { path: 'a.ts' },
                result: { ok: true },
                toolCallId: 'call-b',
                toolName: 'read_file',
              }),
              { text: 'Found 3 matches.', type: 'text' },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:40Z'),
          id: 'tail',
          role: 'assistant',
        },
      ],
    });

    // The snapshot rows collapse into ONE assistant message (under the last
    // row's id), mirroring the single live turn.
    expect(history.messages.map((item) => item.message.id)).toEqual(['tail']);
    const merged = history.messages[0];

    const toolCalls = merged?.message.content.filter((part) => part.type === 'tool-call') ?? [];
    expect(toolCalls.map((part) => (part as { toolCallId: string }).toolCallId)).toEqual([
      'call-a',
      'call-b',
    ]);

    // First occurrence of call-a (state 'call' with no result in snapshot-1)
    // was upgraded with the result from the later snapshot.
    expect(merged?.message.content).toContainEqual(
      expect.objectContaining({ result: { matches: 3 }, toolCallId: 'call-a' })
    );

    // Execution order, once each: call-a, call-b, then the final text.
    expect(merged?.message.content.map((part) => part.type)).toEqual([
      'tool-call',
      'tool-call',
      'text',
    ]);
  });

  it('interleaves run events with timestamped content parts in live order', async () => {
    const makeEvent = (id: string, timestamp: string, label: string): AssistantRunEvent => ({
      id,
      kind: 'run.step.finished',
      label,
      runId: 'run-1',
      sequence: Number.parseInt(id.split('-')[1] ?? '0', 10),
      status: 'completed',
      timestamp,
    });
    const history = await loadHistory({
      messages: [
        {
          content: { content: 'go', format: 2, parts: [{ text: 'go', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:18:10Z'),
          id: 'message-user',
          role: 'user',
        },
        {
          content: {
            format: 2,
            parts: [
              {
                ...makeToolInvocationPart({
                  input: { pattern: 'x' },
                  result: { matches: 1 },
                  toolCallId: 'call-1',
                  toolName: 'grep_search',
                }),
                createdAt: Date.parse('2026-06-11T13:18:15.000Z'),
              },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'snapshot-1',
          role: 'assistant',
        },
        {
          content: {
            format: 2,
            parts: [
              {
                createdAt: Date.parse('2026-06-11T13:18:40.000Z'),
                text: 'Done.',
                type: 'text',
              },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:41Z'),
          id: 'tail',
          role: 'assistant',
        },
      ],
      runEvents: [
        makeEvent('event-1', '2026-06-11T13:18:12.000Z', 'run started'),
        makeEvent('event-2', '2026-06-11T13:18:20.000Z', 'step 1 completed'),
        makeEvent('event-3', '2026-06-11T13:18:45.000Z', 'run completed'),
      ],
    });

    expect(history.messages.map((item) => item.message.id)).toEqual(['message-user', 'tail']);
    const merged = history.messages.at(-1);
    // Live order: run-start event → tool call (13:18:15) → step event
    // (13:18:20) → final text (13:18:40) → completion event (13:18:45).
    expect(
      merged?.message.content.map((part) =>
        part.type === 'data' ? `event:${(part.data as AssistantRunEvent).id}` : part.type
      )
    ).toEqual(['event:event-1', 'tool-call', 'event:event-2', 'text', 'event:event-3']);
  });

  it('hydrates a persisted agent-explore delegation with subAgentToolResults intact and weaves its subagent.* events into the group', async () => {
    // Copied from the REAL persisted parent row shape pinned agent-side in
    // mastra-subagent-execution.spec.ts: the delegation persists as a format-2
    // `tool-invocation` part (toolName agent-explore, state 'result') whose
    // inline result carries the child's subAgentToolResults. This is the
    // "reloaded thread renders identically" leg.
    const delegationResult = {
      subAgentToolResults: [
        {
          args: { pattern: 'flag' },
          isError: false,
          result: { files: ['src/main.ts'] },
          toolCallId: 'child-1',
          toolName: 'brainstrike_grepSearch',
        },
      ],
      text: 'Found the flag in src/main.ts.',
    };
    const history = await loadHistory({
      messages: [
        {
          content: {
            content: 'find the flag',
            format: 2,
            parts: [{ text: 'find the flag', type: 'text' }],
          },
          createdAt: new Date('2026-07-10T00:00:10Z'),
          id: 'message-user',
          role: 'user',
        },
        {
          content: {
            format: 2,
            parts: [
              {
                ...makeToolInvocationPart({
                  input: { prompt: 'find the flag' },
                  result: delegationResult,
                  toolCallId: 'delegation-1',
                  toolName: 'agent-explore',
                }),
                createdAt: Date.parse('2026-07-10T00:00:15.000Z'),
              },
              { createdAt: Date.parse('2026-07-10T00:00:40.000Z'), text: 'Done.', type: 'text' },
            ],
          },
          createdAt: new Date('2026-07-10T00:00:41Z'),
          id: 'delegation-tail',
          role: 'assistant',
        },
      ],
      runEvents: [
        {
          id: 'sub-started',
          kind: 'subagent.started',
          label: 'Subagent started',
          metadata: { parentToolCallId: 'delegation-1', personaId: 'explore' },
          runId: 'run-1',
          sequence: 1,
          status: 'running',
          timestamp: '2026-07-10T00:00:16.000Z',
        },
        {
          id: 'sub-tool-done',
          kind: 'subagent.tool.completed',
          label: 'Subagent tool completed',
          metadata: {
            childToolName: 'brainstrike_grepSearch',
            parentToolCallId: 'delegation-1',
            personaId: 'explore',
            toolCallId: 'child-1',
          },
          runId: 'run-1',
          sequence: 2,
          status: 'completed',
          timestamp: '2026-07-10T00:00:20.000Z',
        },
      ],
    });

    const merged = history.messages.at(-1);
    // The delegation tool-invocation survives merge/dedupe/re-timing with its
    // inline subAgentToolResults intact (the SubagentCard reads them on reload).
    const delegationCall = merged?.message.content.find(
      (part) => part.type === 'tool-call' && part.toolName === 'agent-explore'
    ) as { result?: { subAgentToolResults?: Array<{ toolCallId?: string }> } } | undefined;
    expect(delegationCall?.result?.subAgentToolResults).toEqual(
      delegationResult.subAgentToolResults
    );

    // The subagent.* events land in this group, ordered by timestamp between the
    // delegation call and the final text.
    const sequence = merged?.message.content.map((part) =>
      part.type === 'data'
        ? `event:${(part.data as AssistantRunEvent).id}`
        : `${part.type}:${(part as { toolName?: string }).toolName ?? ''}`
    );
    expect(sequence).toEqual([
      'tool-call:agent-explore',
      'event:sub-started',
      'event:sub-tool-done',
      'text:',
    ]);
  });

  it('re-times untimed tool calls to their tool.started events instead of clumping at snapshot boundaries', async () => {
    // Mastra does not persist per-part createdAt for tool invocations, but
    // every execution emits a tool.started run event carrying the toolCallId.
    const makeToolEvent = (
      id: string,
      kind: 'tool.started' | 'tool.completed',
      timestamp: string,
      toolCallId: string,
      sequence: number
    ): AssistantRunEvent => ({
      id,
      kind,
      label: toolCallId,
      metadata: { toolCallId },
      runId: 'run-1',
      sequence,
      status: kind === 'tool.started' ? 'running' : 'completed',
      timestamp,
    });
    const history = await loadHistory({
      messages: [
        {
          // BOTH calls persisted (untimed) in one snapshot row saved at
          // 13:18:35 — without event re-timing they would clump together
          // after every event.
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                input: { pattern: 'a' },
                result: { matches: 1 },
                toolCallId: 'call-early',
                toolName: 'grep_search',
              }),
              makeToolInvocationPart({
                input: { path: 'b.ts' },
                result: { ok: true },
                toolCallId: 'call-late',
                toolName: 'read_file',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:35Z'),
          id: 'snapshot-1',
          role: 'assistant',
        },
      ],
      runEvents: [
        makeToolEvent('event-1', 'tool.started', '2026-06-11T13:18:12.000Z', 'call-early', 1),
        makeToolEvent('event-2', 'tool.completed', '2026-06-11T13:18:13.000Z', 'call-early', 2),
        makeToolEvent('event-3', 'tool.started', '2026-06-11T13:18:30.000Z', 'call-late', 3),
        makeToolEvent('event-4', 'tool.completed', '2026-06-11T13:18:31.000Z', 'call-late', 4),
      ],
    });

    const merged = history.messages.at(-1);
    expect(
      merged?.message.content.map((part) =>
        part.type === 'data' ? `event:${(part.data as AssistantRunEvent).id}` : part.type
      )
    ).toEqual([
      'event:event-1', // call-early started
      'tool-call', //      call-early sits at its own start time
      'event:event-2', // call-early completed
      'event:event-3', // call-late started
      'tool-call', //      call-late sits at its own start time
      'event:event-4', // call-late completed
    ]);
  });

  it("anchors a run's early events to its own assistant turn, never an older one", async () => {
    // Early events (memory loads, tool starts) occur BEFORE the run's first
    // assistant row is saved. Pure time-splitting assigned those to the
    // PREVIOUS turn's group on reload.
    const makeEvent = (id: string, timestamp: string, sequence: number): AssistantRunEvent => ({
      id,
      kind: sequence === 1 ? 'memory.history.loaded' : 'run.finished',
      label: sequence === 1 ? 'Loaded conversation history' : 'Assistant run completed',
      runId: 'run-latest',
      sequence,
      status: 'completed',
      timestamp,
    });
    const history = await loadHistory({
      messages: [
        {
          content: { content: 'first', format: 2, parts: [{ text: 'first', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:18:10Z'),
          id: 'user-1',
          role: 'user',
        },
        {
          content: { format: 2, parts: [{ text: 'first answer', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'assistant-1',
          role: 'assistant',
        },
        {
          content: { content: 'second', format: 2, parts: [{ text: 'second', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:20:10Z'),
          id: 'user-2',
          role: 'user',
        },
        {
          content: { format: 2, parts: [{ text: 'second answer', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:20:16Z'),
          id: 'assistant-2',
          role: 'assistant',
        },
      ],
      runEvents: [
        // Emitted after user-2 sent but before assistant-2 was first saved.
        makeEvent('event-early', '2026-06-11T13:20:12.000Z', 1),
        makeEvent('event-finished', '2026-06-11T13:20:20.000Z', 2),
      ],
    });

    const firstAssistant = history.messages.find((item) => item.message.id === 'assistant-1');
    const secondAssistant = history.messages.find((item) => item.message.id === 'assistant-2');
    const eventIds = (content: readonly { type: string; data?: unknown }[] | undefined) =>
      (content ?? [])
        .filter((part) => part.type === 'data')
        .map((part) => (part.data as AssistantRunEvent).id);
    expect(eventIds(firstAssistant?.message.content)).toEqual([]);
    expect(eventIds(secondAssistant?.message.content)).toEqual(['event-early', 'event-finished']);
  });

  it('replays every recent run on its original assistant turn', async () => {
    const makeEvent = (
      runId: string,
      id: string,
      kind: 'run.started' | 'run.finished' | 'tool.started' | 'tool.failed',
      timestamp: string,
      sequence: number,
      toolCallId?: string
    ): AssistantRunEvent => ({
      id,
      kind,
      label: id,
      ...(toolCallId ? { metadata: { toolCallId } } : {}),
      runId,
      sequence,
      status:
        kind === 'tool.failed' ? 'failed' : kind.endsWith('started') ? 'running' : 'completed',
      timestamp,
    });
    const history = await loadHistory({
      messages: [
        {
          content: { format: 2, parts: [{ text: 'first', type: 'text' }] },
          createdAt: new Date('2026-07-12T05:36:51.869Z'),
          id: 'user-1',
          role: 'user',
        },
        {
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                result: {
                  error: { code: 'tool_failed', message: 'failed', toolName: 'read_file' },
                  ok: false,
                },
                toolCallId: 'call-1',
                toolName: 'read_file',
              }),
              { text: 'first answer', type: 'text' },
            ],
          },
          createdAt: new Date('2026-07-12T05:36:51.952Z'),
          id: 'assistant-1',
          role: 'assistant',
        },
        {
          content: { format: 2, parts: [{ text: 'second', type: 'text' }] },
          createdAt: new Date('2026-07-12T05:39:34.152Z'),
          id: 'user-2',
          role: 'user',
        },
        {
          content: { format: 2, parts: [{ text: 'second answer', type: 'text' }] },
          createdAt: new Date('2026-07-12T05:39:34.192Z'),
          id: 'assistant-2',
          role: 'assistant',
        },
      ],
      runEvents: [
        makeEvent('run-1', 'run-1-start', 'run.started', '2026-07-12T05:36:51.906Z', 1),
        makeEvent(
          'run-1',
          'run-1-tool-start',
          'tool.started',
          '2026-07-12T05:36:56.193Z',
          2,
          'call-1'
        ),
        makeEvent(
          'run-1',
          'run-1-tool-failed',
          'tool.failed',
          '2026-07-12T05:36:56.346Z',
          3,
          'call-1'
        ),
        makeEvent('run-1', 'run-1-finish', 'run.finished', '2026-07-12T05:37:06.769Z', 4),
        makeEvent('run-2', 'run-2-start', 'run.started', '2026-07-12T05:39:34.169Z', 1),
        makeEvent('run-2', 'run-2-finish', 'run.finished', '2026-07-12T05:39:38.305Z', 2),
      ],
    });

    const eventIds = (messageId: string) =>
      history.messages
        .find((item) => item.message.id === messageId)
        ?.message.content.filter((part) => part.type === 'data')
        .map((part) => (part.data as AssistantRunEvent).id);
    expect(eventIds('assistant-1')).toEqual([
      'run-1-start',
      'run-1-tool-start',
      'run-1-tool-failed',
      'run-1-finish',
    ]);
    expect(eventIds('assistant-2')).toEqual(['run-2-start', 'run-2-finish']);
  });

  it('uses per-part timestamps to restore equal-timestamp message and snapshot order', async () => {
    const history = await loadHistory({
      messages: [
        {
          content: {
            format: 2,
            parts: [
              { createdAt: 1000, text: 'answer', type: 'text' },
              { createdAt: 1100, text: 'tail', type: 'text' },
            ],
          },
          createdAt: new Date('2026-07-12T05:36:51.000Z'),
          id: 'a-assistant-sorts-first-by-id',
          role: 'assistant',
        },
        {
          content: {
            content: 'question',
            format: 2,
            parts: [{ createdAt: 900, text: 'question', type: 'text' }],
          },
          createdAt: new Date('2026-07-12T05:36:51.000Z'),
          id: 'z-user-sorts-last-by-id',
          role: 'user',
        },
      ],
    });

    expect(history.messages.map((item) => item.message.id)).toEqual([
      'z-user-sorts-last-by-id',
      'a-assistant-sorts-first-by-id',
    ]);
  });

  it('attaches run events to the newest assistant row even when no row has renderable parts', async () => {
    const runEvent: AssistantRunEvent = {
      id: 'event-1',
      kind: 'tool.completed',
      label: 'grep_search completed',
      runId: 'run-1',
      sequence: 0,
      status: 'completed',
      timestamp: '2026-06-11T13:18:20.000Z',
    };
    const history = await loadHistory({
      messages: [
        {
          content: { content: 'hi', format: 2, parts: [{ text: 'hi', type: 'text' }] },
          createdAt: new Date('2026-06-11T13:18:10Z'),
          id: 'message-user',
          role: 'user',
        },
        {
          content: { format: 2, parts: [OM_STATUS_PART] },
          createdAt: new Date('2026-06-11T13:18:16Z'),
          id: 'message-assistant-empty',
          role: 'assistant',
        },
      ],
      runEvents: [runEvent],
    });

    const assistant = history.messages.find(
      (item) => item.message.id === 'message-assistant-empty'
    );
    expect(assistant).toBeDefined();
    expect(assistant?.message.content).toEqual([
      { data: runEvent, name: 'brainstrike.run-event', type: 'data' },
    ]);
  });
});

describe('createPgliteAssistantThreadRepository thread runs', () => {
  it('loads curated thread metadata while omitting invalid curated values', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mastra_threads')) {
        return {
          rows: [
            {
              createdAt: new Date('2026-04-22T09:00:00Z'),
              id: 'thread-valid',
              metadata: JSON.stringify({
                color: 'rose',
                icon: 'bug',
                model: 'gpt-5.2',
                provider: 'openai',
              }),
              resourceId: '/tmp/workspace-a',
              title: 'Valid curated thread',
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
            {
              createdAt: new Date('2026-04-22T08:00:00Z'),
              id: 'thread-invalid',
              metadata: JSON.stringify({
                color: '#ff00ff',
                icon: 'raw-html',
                provider: 'anthropic',
              }),
              resourceId: '/tmp/workspace-a',
              title: 'Invalid curated thread',
              updatedAt: new Date('2026-04-22T09:00:00Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const threads = await repository.listThreads('/tmp/workspace-a');

    expect(threads[0]?.metadata).toEqual({
      color: 'rose',
      icon: 'bug',
      model: 'gpt-5.2',
      provider: 'openai',
    });
    expect(threads[1]?.metadata).toEqual({
      provider: 'anthropic',
    });
  });

  it('rejects invalid curated thread metadata before persistence', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        color: 'rose',
        icon: 'raw-html',
      } as never)
    ).rejects.toThrow('Invalid assistant thread metadata icon.');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('rejects an incomplete operating-root binding before persistence', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        operatingRootId: 'db-root-a',
      })
    ).rejects.toThrow('operating-root metadata is incomplete');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('persists secondaryRootIds as a deduped string array', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.updateThreadMetadata('thread-1', {
      secondaryRootIds: ['db-root-b', 'db-root-c', 'db-root-b'],
    });

    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE mastra_threads'));
    expect(update).toBeDefined();
    const persisted = JSON.parse(String(update?.[1]?.[1])) as { secondaryRootIds?: unknown };
    expect(persisted.secondaryRootIds).toEqual(['db-root-b', 'db-root-c']);
  });

  it('accepts an empty secondaryRootIds array as "no secondaries" and persists []', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: [],
      })
    ).resolves.toBeUndefined();

    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE mastra_threads'));
    expect(update).toBeDefined();
    const persisted = JSON.parse(String(update?.[1]?.[1])) as { secondaryRootIds?: unknown };
    expect(persisted.secondaryRootIds).toEqual([]);
  });

  it('persists a deduped secondaryRootIds array for the bulk metadata update path', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE mastra_threads')) {
        return { rows: [{ allFound: true, updatedThreadCount: 2 }] };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.updateThreadsMetadata(['thread-1', 'thread-2'], {
      secondaryRootIds: ['a', 'b', 'a'],
    });

    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE mastra_threads'));
    expect(update).toBeDefined();
    const params = update?.[1] as unknown[] | undefined;
    const persisted = JSON.parse(String(params?.at(-1))) as { secondaryRootIds?: unknown };
    expect(persisted.secondaryRootIds).toEqual(['a', 'b']);
  });

  it('rejects secondaryRootIds that are not an array of non-empty strings', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: ['db-root-b', ''],
      })
    ).rejects.toThrow('Invalid assistant thread metadata secondary root ids.');
    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: 'db-root-b' as never,
      })
    ).rejects.toThrow('Invalid assistant thread metadata secondary root ids.');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('rejects whitespace-only secondaryRootIds entries', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: ['a', '   '],
      })
    ).rejects.toThrow('Invalid assistant thread metadata secondary root ids.');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('throws on a malformed persisted secondaryRootIds while loading instead of coercing it', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (!sql.includes('FROM mastra_threads')) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            createdAt: new Date('2026-08-21T09:00:00Z'),
            id: 'thread-bad-secondaries',
            metadata: JSON.stringify({ secondaryRootIds: [42] }),
            resourceId: 'workspace-a',
            title: 'Bad secondaries',
            updatedAt: new Date('2026-08-21T09:00:00Z'),
          },
        ],
      };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(repository.listThreads('workspace-a')).rejects.toThrow(
      'Invalid assistant thread metadata secondary root ids.'
    );
  });

  it('rejects an incomplete operating-root binding while loading persisted metadata', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (!sql.includes('FROM mastra_threads')) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            createdAt: new Date('2026-07-23T09:00:00Z'),
            id: 'thread-incomplete-root',
            metadata: JSON.stringify({ operatingRootId: 'db-root-a' }),
            resourceId: 'workspace-a',
            title: 'Incomplete root',
            updatedAt: new Date('2026-07-23T09:00:00Z'),
          },
        ],
      };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(repository.listThreads('workspace-a')).rejects.toThrow(
      'operating-root metadata is incomplete'
    );
  });

  it.each([123, '   '])(
    'rejects malformed persisted operating-root ids instead of treating them as unbound (%j)',
    async (operatingRootId) => {
      const db = createMockDb();
      db.query.mockImplementation(async (sql: string) => {
        if (!sql.includes('FROM mastra_threads')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              createdAt: new Date('2026-07-23T09:00:00Z'),
              id: 'thread-malformed-root',
              metadata: JSON.stringify({ operatingRootId }),
              resourceId: 'workspace-a',
              title: 'Malformed root',
              updatedAt: new Date('2026-07-23T09:00:00Z'),
            },
          ],
        };
      });
      const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

      await expect(repository.listThreads('workspace-a')).rejects.toThrow(
        'Invalid assistant thread metadata operating root id.'
      );
    }
  );

  it('lists thread edit checkpoints across all runs and omits before_content', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM brainstrike_assistant_edit_checkpoints')) {
        return {
          rows: [
            {
              afterExisted: true,
              afterHash: 'after-hash',
              beforeExisted: false,
              beforeHash: null,
              beforeSize: null,
              captureStatus: 'created',
              fromPath: null,
              id: 'ckpt-1',
              occurredAt: new Date('2026-04-22T10:00:00Z'),
              op: 'write',
              path: '/new.ts',
              resourceId: '/tmp/workspace-a',
              revertedAt: null,
              rootId: 'root-1',
              runId: 'run-1',
              threadId: 'thread-1',
              toolCallId: 'call-1',
              toolName: 'brainstrike.writeWorkspaceFile',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const checkpoints = await repository.listThreadCheckpoints('thread-1');

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual({
      afterExisted: true,
      afterHash: 'after-hash',
      beforeExisted: false,
      beforeHash: null,
      beforeSize: null,
      captureStatus: 'created',
      fromPath: null,
      id: 'ckpt-1',
      occurredAt: '2026-04-22T10:00:00.000Z',
      op: 'write',
      path: '/new.ts',
      resourceId: '/tmp/workspace-a',
      revertedAt: null,
      rootId: 'root-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolCallId: 'call-1',
      toolName: 'brainstrike.writeWorkspaceFile',
    });
    expect(checkpoints[0]).not.toHaveProperty('beforeContent');
    // Queried by thread only (across all runs), never narrowed to a single run.
    const checkpointCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes('brainstrike_assistant_edit_checkpoints')
    );
    expect(String(checkpointCall?.[0])).not.toContain('LIMIT 1');
  });

  it('probes for the run table before writes and never creates schema', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.createThreadRun({
      id: 'run-1',
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 512 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high' } },
      resourceId: '/tmp/workspace-a',
      runtimeKind: 'hosted',
      threadId: 'thread-1',
    });

    // Migrations 117/118 own this schema now. The repository executes NO DDL:
    // a create-if-absent branch here is what let a fresh database diverge from
    // a migrated one without anything observing it (BST-1651).
    expect(db.exec).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("to_regclass('public.' || required.relation) IS NULL")
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_thread_runs'),
      expect.arrayContaining([
        'run-1',
        '/tmp/workspace-a',
        'thread-1',
        'openai',
        'gpt-5.2',
        JSON.stringify({ maxOutputTokens: 512 }),
        JSON.stringify({ openai: { reasoningEffort: 'high' } }),
        'hosted',
        'running',
      ])
    );
  });

  it('probes before inserting a usage row', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.recordRunUsage({
      inputTokens: 120,
      model: 'gpt-5.2',
      outputTokens: 45,
      provider: 'openai',
      resourceId: '/tmp/workspace-a',
      rootId: 'root-a',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    expect(db.exec).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_usage'),
      expect.arrayContaining([
        'thread-1',
        'run-1',
        '/tmp/workspace-a',
        'gpt-5.2',
        'openai',
        120,
        45,
        'root-a',
      ])
    );
  });

  it('bootstraps the migration-076 run-errors shape without retry fiction', async () => {
    const dataDir = createPgliteTestDataDir('assistant-run-errors-bootstrap-shape');
    const db = await createMigratedTestPGlite(dataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThread('workspace-a');

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_assistant_run_errors'
         ORDER BY ordinal_position`
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'run_id',
        'thread_id',
        'resource_id',
        'code',
        'message',
        'cause_chain',
        'http_status',
        'provider_request_id',
        'response_headers',
        'occurred_at',
        'created_at',
      ]);

      const constraints = await db.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint
         WHERE conrelid = 'brainstrike_assistant_run_errors'::regclass`
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          'brainstrike_assistant_run_errors_pkey',
          'bst_assistant_run_errors_cause_chain_check',
          'bst_assistant_run_errors_http_status_check',
          'bst_assistant_run_errors_response_headers_check',
        ])
      );

      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE tablename = 'brainstrike_assistant_run_errors'`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'bst_assistant_run_errors_resource_idx',
          'bst_assistant_run_errors_thread_idx',
        ])
      );
    } finally {
      await db.close();
    }
  });

  it('bootstraps the migration-083+092 tool-call telemetry shape for thread deletion', async () => {
    const dataDir = createPgliteTestDataDir('tool-call-telemetry-bootstrap-shape');
    const db = await createMigratedTestPGlite(dataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThread('workspace-a');

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_tool_call_telemetry'
         ORDER BY ordinal_position`
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'id',
        'thread_id',
        'run_id',
        'tool_id',
        'occurred_at',
        'model_facing_chars',
        'truncated',
        'zero_match',
        'is_pagination_followup',
        // Migration 092 (BST-1247): substrate flags split out of `truncated`.
        'engine',
        'scan_limited',
        'candidates_truncated',
      ]);

      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE tablename = 'brainstrike_tool_call_telemetry'`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'brainstrike_tool_call_telemetry_thread_idx',
          'brainstrike_tool_call_telemetry_tool_time_idx',
          'brainstrike_tool_call_telemetry_occurred_at_idx',
        ])
      );
    } finally {
      await db.close();
    }
  });

  it('keeps the token-estimate calibration bootstrap shape identical to migrations 086, 089, then 091', async () => {
    const bootstrapDataDir = createPgliteTestDataDir('token-estimate-calibration-bootstrap-shape');
    const migratedDataDir = createPgliteTestDataDir('token-estimate-calibration-migrated-shape');
    const bootstrapDb = await createMigratedTestPGlite(bootstrapDataDir);
    const migratedDb = await createMigratedTestPGlite(migratedDataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(bootstrapDb as DbHandle);
      await repository.createThread('workspace-a');

      const migration086 = migrations.find((migration) => migration.version === 86);
      const migration089 = migrations.find((migration) => migration.version === 89);
      const migration091 = migrations.find((migration) => migration.version === 91);
      expect(migration086).toBeDefined();
      expect(migration089).toBeDefined();
      expect(migration091).toBeDefined();
      const runner = new MigrationRunner(migratedDb);
      await runner.initialize();
      await runner.runMigration(migration086!);
      await runner.runMigration(migration089!);
      await runner.runMigration(migration091!);

      const bootstrapColumns = await bootstrapDb.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_token_estimate_calibration'
         ORDER BY ordinal_position`
      );
      const migratedColumns = await migratedDb.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_token_estimate_calibration'
         ORDER BY ordinal_position`
      );
      expect(migratedColumns.rows).toEqual([
        { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'thread_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'run_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'model', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'provider', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'estimated_prompt_tokens', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'final_step_prompt_tokens', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'step_count', data_type: 'integer', is_nullable: 'NO' },
        {
          column_name: 'model_visible_projection_count',
          data_type: 'integer',
          is_nullable: 'NO',
        },
        {
          column_name: 'occurred_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
        },
        {
          column_name: 'resolved_domain_budget_tokens',
          data_type: 'integer',
          is_nullable: 'YES',
        },
        {
          column_name: 'resolved_transport_budget_tokens',
          data_type: 'integer',
          is_nullable: 'YES',
        },
        {
          column_name: 'prompt_baseline_tokens',
          data_type: 'integer',
          is_nullable: 'YES',
        },
      ]);
      expect(bootstrapColumns.rows).toEqual(migratedColumns.rows);

      const indexes = await bootstrapDb.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE tablename = 'brainstrike_token_estimate_calibration'
           AND indexname <> 'brainstrike_token_estimate_calibration_pkey'`
      );
      expect(indexes.rows.map((row) => row.indexname).sort()).toEqual(
        [
          'brainstrike_token_estimate_calibration_model_idx',
          'brainstrike_token_estimate_calibration_occurred_at_idx',
          'brainstrike_token_estimate_calibration_thread_idx',
        ].sort()
      );
    } finally {
      await bootstrapDb.close();
      await migratedDb.close();
    }
  });

  /**
   * BST-1651 found a REAL divergence here, and this expectation records the
   * winner. The retired renderer bootstrap declared `kind` inline in its
   * `CREATE TABLE` (ordinal 5); migrations 084 + 087 create the table without
   * it and ADD it (ordinal 8). A freshly bootstrapped database and a migrated
   * one therefore had different column ORDER for the same table, and nothing
   * could observe it — the bootstrap's `IF NOT EXISTS` never fires on a
   * migrated database. The migrations are now the only author, so there is one
   * order.
   */
  it('carries the migration-084/087 tool projection rewrite shape for thread deletion', async () => {
    const dataDir = createPgliteTestDataDir('tool-projection-rewrite-bootstrap-shape');
    const db = await createMigratedTestPGlite(dataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThread('workspace-a');

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_assistant_tool_projection_rewrites'
         ORDER BY ordinal_position`
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'tool_call_id',
        'thread_id',
        'rewrite_id',
        'superseded_by_tool_call_id',
        'marker_text',
        'original_chars',
        'created_at',
        'kind',
      ]);
    } finally {
      await db.close();
    }
  });

  it('bootstraps the migration-088 compaction range shape for thread deletion', async () => {
    const dataDir = createPgliteTestDataDir('compaction-range-bootstrap-shape');
    const db = await createMigratedTestPGlite(dataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThread('workspace-a');

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_assistant_compaction_ranges'
         ORDER BY ordinal_position`
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'compaction_message_id',
        'thread_id',
        'compacted_message_ids',
        'kind',
        'created_at',
      ]);
    } finally {
      await db.close();
    }
  });

  it('persists provider-reported billed cost with run usage', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.recordRunUsage({
      billedCostUsd: 0.0042,
      inputTokens: 120,
      model: 'z-ai/glm-5.2',
      outputTokens: 45,
      provider: 'openrouter',
      resourceId: '/tmp/workspace-a',
      rootId: 'root-a',
      runId: 'run-cost',
      threadId: 'thread-cost',
    });

    const insert = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_run_usage')
    );
    expect(insert?.[1]).toContain(0.0042);
  });

  it('rejects malformed provider-reported billed cost before persistence', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.recordRunUsage({
        billedCostUsd: Number.NaN,
        inputTokens: 1,
        model: 'z-ai/glm-5.2',
        outputTokens: 1,
        provider: 'openrouter',
        resourceId: '/tmp/workspace-a',
        runId: 'run-bad-cost',
        threadId: 'thread-cost',
      })
    ).rejects.toThrow(/billedCostUsd/);
  });

  it('persists a null root_id when no root is focused (honest unattributed)', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.recordRunUsage({
      inputTokens: 10,
      model: 'gpt-5.2',
      outputTokens: 5,
      provider: 'openai',
      resourceId: '/tmp/workspace-a',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    const insert = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_run_usage')
    );
    // root_id is the 10th positional param; absent rootId persists as null.
    expect(insert?.[1]?.[9]).toBeNull();
  });

  it('rejects negative token counts before persistence (no silent coercion)', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.recordRunUsage({
        inputTokens: -1,
        model: 'gpt-5.2',
        outputTokens: 0,
        provider: 'openai',
        resourceId: '/tmp/workspace-a',
        runId: 'run-1',
        threadId: 'thread-1',
      })
    ).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_run_usage'),
      expect.anything()
    );
  });

  it('persists compact redacted assistant run event summaries', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.appendThreadRunEvent('run-1', {
      id: 'event-1',
      kind: 'tool.completed',
      label: 'Used workspace.read',
      metadata: {
        'api-key': 'hyphenated-secret',
        apiKey: 'secret-key',
        result: { content: 'full tool output' },
        threadId: 'thread-1',
      },
      sequence: 7,
      status: 'completed',
      timestamp: '2026-04-24T12:00:00.000Z',
    });

    const insert = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_run_events')
    );
    const params = insert?.[1] ?? [];

    expect(db.exec).not.toHaveBeenCalled();
    expect(params).toEqual(
      expect.arrayContaining([
        'event-1',
        'run-1',
        7,
        'tool.completed',
        'completed',
        'Used workspace.read',
      ])
    );
    const metadataParam = params.find((value) =>
      typeof value === 'string' ? value.includes('thread-1') : false
    );
    expect(JSON.parse(String(metadataParam))).toEqual({
      threadId: 'thread-1',
    });
  });

  it('lists assistant run events in run sequence order', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM brainstrike_assistant_run_events')) {
        return {
          rows: [
            {
              detail: null,
              duration_ms: null,
              id: 'event-1',
              kind: 'run.started',
              label: 'Assistant run started',
              metadata: JSON.stringify({ model: 'gpt-5.2' }),
              occurred_at: '2026-04-24T12:00:00.000Z',
              run_id: 'run-1',
              sequence: 1,
              status: 'running',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const events = await repository.listThreadRunEvents('thread-1', '/tmp/workspace-a');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM brainstrike_assistant_run_events'),
      ['thread-1', '/tmp/workspace-a']
    );
    expect(events).toEqual([
      {
        id: 'event-1',
        kind: 'run.started',
        label: 'Assistant run started',
        metadata: { model: 'gpt-5.2' },
        runId: 'run-1',
        sequence: 1,
        status: 'running',
        timestamp: '2026-04-24T12:00:00.000Z',
      },
    ]);
  });

  it('bounds replay events to the latest requested runs while returning them chronologically', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.listThreadRunEvents('thread-1', '/tmp/workspace-a', {
      limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /ORDER BY recent_run\.started_at DESC[\s\S]*LIMIT \$3[\s\S]*ORDER BY run\.started_at ASC/
      ),
      ['thread-1', '/tmp/workspace-a', ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT]
    );
  });

  it('rejects invalid assistant run event hydration limits', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.listThreadRunEvents('thread-1', '/tmp/workspace-a', { limitLatestRuns: 0 })
    ).rejects.toThrow('Assistant run event history limit must be a positive safe integer.');
  });

  it('hydrates persisted subagent.* run events (requireRunEventKind accepts the new kinds)', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM brainstrike_assistant_run_events')) {
        return {
          rows: [
            {
              detail: null,
              duration_ms: null,
              id: 'sub-1',
              kind: 'subagent.started',
              label: 'Subagent started',
              metadata: JSON.stringify({ parentToolCallId: 'delegation-1', personaId: 'explore' }),
              occurred_at: '2026-04-24T12:00:01.000Z',
              run_id: 'run-1',
              sequence: 2,
              status: 'running',
            },
            {
              detail: null,
              duration_ms: null,
              id: 'sub-2',
              kind: 'subagent.tool.completed',
              label: 'Subagent tool completed',
              metadata: JSON.stringify({
                childToolName: 'brainstrike_grepSearch',
                parentToolCallId: 'delegation-1',
                personaId: 'explore',
                toolCallId: 'child-1',
              }),
              occurred_at: '2026-04-24T12:00:02.000Z',
              run_id: 'run-1',
              sequence: 3,
              status: 'completed',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const events = await repository.listThreadRunEvents('thread-1', '/tmp/workspace-a');

    expect(events.map((event) => event.kind)).toEqual([
      'subagent.started',
      'subagent.tool.completed',
    ]);
    expect(events[1]?.metadata).toEqual({
      childToolName: 'brainstrike_grepSearch',
      parentToolCallId: 'delegation-1',
      personaId: 'explore',
      toolCallId: 'child-1',
    });
  });

  it('hydrates a persisted tool.resume.unsupported row (survives a thread reload)', async () => {
    // BST-558 finding C: the `brainstrike.tool-suspend` data part is transient
    // (aui-data, never persisted). Since BST-1084 `appendSuspendedPauseMessages`
    // re-appends that notice on reload for pauses that are STILL suspended, but
    // only at the END of the thread and only while one is pending. The durable
    // IN-TRANSCRIPT surface is this run event — it has to survive the read path.
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM brainstrike_assistant_run_events')) {
        return {
          rows: [
            {
              detail: null,
              duration_ms: null,
              id: 'unsupported-1',
              kind: 'tool.resume.unsupported',
              label: 'Tool pause cannot be answered by this build',
              metadata: JSON.stringify({
                resumeSupportedByClient: false,
                runStillSuspended: true,
                toolCallId: 'call-future-tool',
                toolName: 'brainstrike.someFutureSuspendingTool',
              }),
              occurred_at: '2026-07-24T12:00:01.000Z',
              run_id: 'run-1',
              sequence: 2,
              status: 'failed',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const events = await repository.listThreadRunEvents('thread-1', '/tmp/workspace-a');

    expect(events.map((event) => event.kind)).toEqual(['tool.resume.unsupported']);
    expect(events[0]?.status).toBe('failed');
    expect(events[0]?.metadata).toEqual({
      resumeSupportedByClient: false,
      runStillSuspended: true,
      toolCallId: 'call-future-tool',
      toolName: 'brainstrike.someFutureSuspendingTool',
    });
  });

  it('sorts a forge pr.* row after every real stream row on the same run (BST-1391 M3)', async () => {
    // Real PGlite, not `createMockDb()` (which just returns whatever `rows`
    // array a test hard-codes — it never executes an `ORDER BY`). This pins
    // the actual DB-level fact `use-forge-run-events.ts`'s
    // `FORGE_OBSERVATION_SEQUENCE` (1_000_000_000, well under the `sequence
    // integer` column's int4 ceiling) relies on: a large `sequence` sorts
    // after the run's own small, monotonic stream-counter values under
    // `ORDER BY sequence ASC, occurred_at ASC, id ASC`. The forge row's
    // `occurred_at` is deliberately set BEFORE the run's own rows, to prove
    // the ordering is driven by `sequence`, not `occurred_at`.
    const dataDir = createPgliteTestDataDir('forge-observation-sequence-order');
    const db = await createMigratedTestPGlite(dataDir);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const thread = await repository.createThread('workspace-a');
      await repository.createThreadRun({
        id: 'run-forge-order',
        model: 'gpt-test',
        provider: 'openai',
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        startedAt: new Date('2026-04-24T12:00:00Z'),
        status: 'running',
        threadId: thread.id,
      });
      await repository.appendThreadRunEvent('run-forge-order', {
        id: 'event-run-started',
        kind: 'run.started',
        label: 'Assistant run started',
        sequence: 1,
        status: 'running',
        timestamp: '2026-04-24T12:00:01.000Z',
      } satisfies AssistantRunEvent);
      await repository.appendThreadRunEvent('run-forge-order', {
        id: 'event-run-finished',
        kind: 'run.finished',
        label: 'Assistant run finished',
        sequence: 2,
        status: 'completed',
        timestamp: '2026-04-24T12:00:02.000Z',
      } satisfies AssistantRunEvent);
      // Mirrors `FORGE_OBSERVATION_SEQUENCE` from
      // `packages/app-shell/src/hooks/use-forge-run-events.ts` — kept as a
      // literal here rather than an import because assistant-data must not
      // depend on app-shell (the dependency runs the other way).
      const FORGE_OBSERVATION_SEQUENCE = 1_000_000_000;
      await repository.appendThreadRunEvent('run-forge-order', {
        id: 'event-pr-opened',
        kind: 'pr.opened',
        label: 'Opened pull request #1',
        sequence: FORGE_OBSERVATION_SEQUENCE,
        status: 'info',
        timestamp: '2026-04-24T11:59:00.000Z',
      } satisfies AssistantRunEvent);

      const events = await repository.listThreadRunEvents(thread.id, 'workspace-a');

      expect(events.map((event) => event.id)).toEqual([
        'event-run-started',
        'event-run-finished',
        'event-pr-opened',
      ]);
    } finally {
      await db.close();
    }
  });

  it('completes assistant run records without mutating thread metadata', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.completeThreadRun('run-1', {
      error: 'model unavailable',
      status: 'failed',
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
      expect.arrayContaining(['run-1', 'failed', 'model unavailable'])
    );
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('loads latest run metadata for thread list badges', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mastra_threads')) {
        return {
          rows: [
            {
              createdAt: new Date('2026-04-22T09:00:00Z'),
              id: 'thread-1',
              latestRunCompletedAt: new Date('2026-04-22T10:31:00Z'),
              latestRunCreatedAt: new Date('2026-04-22T10:30:00Z'),
              latestRunError: null,
              latestRunId: 'run-2',
              latestRunModel: 'claude-sonnet-4-6',
              latestRunModelSettings: JSON.stringify({ maxOutputTokens: 2048 }),
              latestRunProvider: 'anthropic',
              latestRunProviderOptions: null,
              latestRunResourceId: '/tmp/workspace-a',
              latestRunRuntimeKind: 'hosted',
              latestRunStartedAt: new Date('2026-04-22T10:30:00Z'),
              latestRunStatus: 'completed',
              latestRunThreadId: 'thread-1',
              latestRunTurnMessageId: null,
              latestRunUpdatedAt: new Date('2026-04-22T10:31:00Z'),
              resourceId: '/tmp/workspace-a',
              title: 'Persistence bug',
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const threads = await repository.listThreads('/tmp/workspace-a');

    expect(threads[0]?.latestRun).toEqual({
      completedAt: new Date('2026-04-22T10:31:00Z'),
      createdAt: new Date('2026-04-22T10:30:00Z'),
      error: null,
      id: 'run-2',
      model: 'claude-sonnet-4-6',
      modelSettings: { maxOutputTokens: 2048 },
      provider: 'anthropic',
      resourceId: '/tmp/workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-04-22T10:30:00Z'),
      status: 'completed',
      threadId: 'thread-1',
      turnMessageId: null,
      updatedAt: new Date('2026-04-22T10:31:00Z'),
    });
    // The schema probe plus the single projection query — the badge read still
    // makes exactly ONE round trip of its own.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN'), [
      '/tmp/workspace-a',
    ]);
  });

  it('rejects corrupt message timestamps instead of substituting the current time', async () => {
    const db = createMockDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          content: { content: 'Hello' },
          createdAt: 'not-a-date',
          id: 'message-1',
          role: 'user',
        },
      ],
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(repository.listMessages('thread-1', '/tmp/workspace-a')).rejects.toThrow(
      /invalid timestamp/i
    );
  });

  it('queries latest messages through a bounded ascending hydration window', async () => {
    const db = createMockDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          content: { content: 'Latest window' },
          createdAt: '2026-04-24T12:00:00.000Z',
          id: 'message-80',
          role: 'user',
        },
      ],
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    const messages = await repository.listMessages('thread-1', '/tmp/workspace-a', {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $3'), [
      'thread-1',
      '/tmp/workspace-a',
      ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    ]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY recent_messages."createdAt" ASC'),
      ['thread-1', '/tmp/workspace-a', ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT]
    );
    expect(messages.map((message) => message.id)).toEqual(['message-80']);
  });

  it('rejects invalid assistant history hydration limits', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.listMessages('thread-1', '/tmp/workspace-a', { limitLatest: 0 })
    ).rejects.toThrow('Assistant message history limit must be a positive safe integer.');
  });

  it('re-probes after a transient probe failure instead of caching the failure', async () => {
    const db = createMockDb();
    // Displace the seeded probe answer with a transport failure, then let the
    // default implementation ({ rows: [] } — nothing missing) answer the retry.
    db.query.mockReset();
    db.query
      .mockRejectedValueOnce(new Error('temporary probe failure'))
      .mockImplementation(async () => ({ rows: [] }));
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.createThreadRun({
        id: 'run-1',
        model: 'gpt-5.2',
        provider: 'openai',
        resourceId: '/tmp/workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-1',
      })
    ).rejects.toThrow('temporary probe failure');

    await expect(
      repository.createThreadRun({
        id: 'run-2',
        model: 'gpt-5.2',
        provider: 'openai',
        resourceId: '/tmp/workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-1',
      })
    ).resolves.toMatchObject({
      id: 'run-2',
      resourceId: '/tmp/workspace-a',
      threadId: 'thread-1',
    });
    const probeCalls = db.query.mock.calls.filter(([sql]) =>
      String(sql).includes("to_regclass('public.' || required.relation) IS NULL")
    );
    expect(probeCalls).toHaveLength(2);
  });

  it('deletes thread-owned rows in one atomic statement including observational memory', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.deleteThread('thread-1');

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM mastra_threads'), [
      'thread-1',
      'thread:thread-1',
    ]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_observational_memory'),
      ['thread-1', 'thread:thread-1']
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM mastra_messages'), [
      'thread-1',
      'thread:thread-1',
    ]);
  });

  it('deletes thread-owned rows when the database handle only exposes query and exec', async () => {
    const db = createMockDb();
    const { exec, query } = db;
    const repository = createPgliteAssistantThreadRepository({
      exec,
      query,
    } as unknown as DbHandle);

    await repository.deleteThread('thread-1');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM mastra_threads'), [
      'thread-1',
      'thread:thread-1',
    ]);
  });

  it('rejects malformed bulk thread operations before querying', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(repository.deleteThreads([])).rejects.toThrow(
      'At least one assistant thread id is required.'
    );
    await expect(repository.deleteThreads(['thread-1', ' '])).rejects.toThrow(
      'Assistant thread id is required.'
    );
    await expect(repository.updateThreadsMetadata(['thread-1'], {})).rejects.toThrow(
      'Assistant thread metadata must include at least one field.'
    );
    await expect(
      repository.updateThreadsMetadata(['thread-1'], { color: 'magenta' as never })
    ).rejects.toThrow('Invalid assistant thread metadata color.');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('reuses the same repository instance for a shared database handle', async () => {
    const db = createMockDb();
    const repositoryA = createPgliteAssistantThreadRepository(db as unknown as DbHandle);
    const repositoryB = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    expect(repositoryA).toBe(repositoryB);

    await repositoryA.createThreadRun({
      id: 'run-1',
      model: 'gpt-5.2',
      provider: 'openai',
      resourceId: '/tmp/workspace-a',
      runtimeKind: 'hosted',
      threadId: 'thread-1',
    });
    await repositoryB.createThreadRun({
      id: 'run-2',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      resourceId: '/tmp/workspace-a',
      runtimeKind: 'hosted',
      threadId: 'thread-2',
    });

    // One probe for the shared handle, not one per repository consumer.
    const probeCalls = db.query.mock.calls.filter(([sql]) =>
      String(sql).includes("to_regclass('public.' || required.relation) IS NULL")
    );
    expect(probeCalls).toHaveLength(1);
  });
});

describe('createPgliteAssistantThreadRepository integration', () => {
  let pgliteDataDir: string | undefined;

  it('persists an explicit initial title in the same operation that creates the thread', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-create-with-title');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    const thread = await repository.createThread('workspace-a', 'Evidence review');

    expect(thread.title).toBe('Evidence review');
    const threads = await repository.listThreads('workspace-a');
    expect(threads).toEqual([expect.objectContaining({ id: thread.id, title: 'Evidence review' })]);
    expect(threads[0]?.metadata).toEqual({ source: 'brainstrike' });
  });

  it('round-trips the durable operating-root binding through thread metadata', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-operating-root');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a', 'Bound thread');

    await repository.updateThreadMetadata(thread.id, {
      operatingRootDisplayName: 'ProjectA',
      operatingRootId: 'root-a',
      operatingRootPath: '/Users/me/ProjectA',
    });

    const [reloaded] = await repository.listThreads('workspace-a');
    expect(reloaded?.metadata).toEqual({
      operatingRootDisplayName: 'ProjectA',
      operatingRootId: 'root-a',
      operatingRootPath: '/Users/me/ProjectA',
      source: 'brainstrike',
    });
  });

  it('persists and reloads a worktree checkout', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-worktree-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await repository.updateThreadMetadata(thread.id, {
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'root-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });

    const [reloaded] = await repository.listThreads('r');
    expect(reloaded?.metadata).toMatchObject({
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'root-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });

    await repository.updateThreadMetadata(thread.id, { checkoutMode: 'local' });

    const [local] = await repository.listThreads('r');
    expect(local?.metadata).toMatchObject({ checkoutMode: 'local' });
    expect(local?.metadata?.checkoutBranch).toBeUndefined();
    expect(local?.metadata?.checkoutLocalRootId).toBeUndefined();
    expect(local?.metadata?.checkoutWorktreeId).toBeUndefined();
    expect(local?.metadata?.checkoutWorktreePath).toBeUndefined();
  });

  it('loads a legacy persisted worktree checkout with no durable Local root id', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-legacy-worktree-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');
    const legacyMetadata = {
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-legacy',
      checkoutWorktreePath: '/managed/repo/legacy-worktree',
    } as const;

    await db.query('UPDATE mastra_threads SET metadata = $2::jsonb WHERE id = $1', [
      thread.id,
      JSON.stringify(legacyMetadata),
    ]);

    const [reloaded] = await repository.listThreads('r');
    expect(reloaded?.metadata).toEqual(legacyMetadata);
    expect(reloaded?.metadata?.checkoutLocalRootId).toBeUndefined();
  });

  it('persists a local checkout with no worktree keys', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-local-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await repository.updateThreadMetadata(thread.id, { checkoutMode: 'local' });

    const [reloaded] = await repository.listThreads('r');
    expect(reloaded?.metadata?.checkoutMode).toBe('local');
    expect(reloaded?.metadata?.checkoutWorktreeId).toBeUndefined();
  });

  it('rejects a worktree checkout missing its authority id', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-incomplete-worktree-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await expect(
      repository.updateThreadMetadata(thread.id, {
        checkoutLocalRootId: 'root-local',
        checkoutMode: 'worktree',
        checkoutWorktreePath: '/managed/repo/bright-fox',
      })
    ).rejects.toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('rejects a worktree id with no mode', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-modeless-worktree-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await expect(
      repository.updateThreadMetadata(thread.id, { checkoutWorktreeId: 'w-1' })
    ).rejects.toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('rejects a local checkout that still carries worktree keys', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-inconsistent-local-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await expect(
      repository.updateThreadMetadata(thread.id, {
        checkoutMode: 'local',
        checkoutWorktreeId: 'w-1',
        checkoutWorktreePath: '/managed/repo/bright-fox',
      })
    ).rejects.toThrow('Assistant thread checkout metadata is inconsistent.');
  });

  it('rejects an unknown checkout mode rather than coercing it', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-unknown-checkout');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('r');

    await expect(
      repository.updateThreadMetadata(thread.id, {
        checkoutMode: 'cloud' as unknown as 'local',
      })
    ).rejects.toThrow('Invalid assistant thread metadata checkout mode.');
  });

  it('persists carousel topology before Mastra content and hydrates the selected edit branch', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-message-carousel-topology');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    const edges = [
      { messageId: 'user-original', parentId: null },
      { messageId: 'assistant-original', parentId: 'user-original' },
      { messageId: 'user-edited', parentId: null },
      { messageId: 'assistant-edited', parentId: 'user-edited' },
    ] as const;

    for (const edge of edges) {
      await repository.recordMessageParent({
        ...edge,
        resourceId: 'workspace-a',
        threadId: thread.id,
      });
    }

    const rows = [
      ['user-original', 'Original prompt', 'user', '2026-07-13T10:00:00Z'],
      ['assistant-original', 'Original response', 'assistant', '2026-07-13T10:00:01Z'],
      ['user-edited', 'Edited prompt', 'user', '2026-07-13T10:01:00Z'],
      ['assistant-edited', 'Edited response', 'assistant', '2026-07-13T10:01:01Z'],
    ] as const;
    for (const [id, text, role, createdAt] of rows) {
      await db.query(
        `INSERT INTO mastra_messages
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
        [
          id,
          thread.id,
          JSON.stringify({ content: text, format: 2, parts: [{ text, type: 'text' }] }),
          role,
          new Date(createdAt),
          'workspace-a',
        ]
      );
    }

    const history = await createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
    }).load();

    expect(history.headId).toBe('assistant-edited');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-original', null],
      ['assistant-original', 'user-original'],
      ['user-edited', null],
      ['assistant-edited', 'user-edited'],
    ]);
  });

  it('topologically hydrates regeneration after Mastra updates the reused user timestamp', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-regeneration-topology-order');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    for (const edge of [
      { messageId: 'user-reused', parentId: null },
      { messageId: 'assistant-original', parentId: 'user-reused' },
      { messageId: 'assistant-regenerated', parentId: 'user-reused' },
    ] as const) {
      await repository.recordMessageParent({
        ...edge,
        resourceId: 'workspace-a',
        threadId: thread.id,
      });
    }

    const saveMessage = async (args: {
      createdAt: string;
      id: string;
      role: 'assistant' | 'user';
      text: string;
    }): Promise<void> => {
      await db.query(
        `INSERT INTO mastra_messages
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)
         ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          "createdAt" = EXCLUDED."createdAt"`,
        [
          args.id,
          thread.id,
          JSON.stringify({
            content: args.text,
            format: 2,
            parts: [{ text: args.text, type: 'text' }],
          }),
          args.role,
          new Date(args.createdAt),
          'workspace-a',
        ]
      );
    };

    await saveMessage({
      createdAt: '2026-07-13T10:00:00Z',
      id: 'user-reused',
      role: 'user',
      text: 'Original prompt',
    });
    await saveMessage({
      createdAt: '2026-07-13T10:00:01Z',
      id: 'assistant-original',
      role: 'assistant',
      text: 'Original response',
    });
    await saveMessage({
      createdAt: '2026-07-13T10:00:02Z',
      id: 'user-reused',
      role: 'user',
      text: 'Original prompt',
    });
    await saveMessage({
      createdAt: '2026-07-13T10:00:03Z',
      id: 'assistant-regenerated',
      role: 'assistant',
      text: 'Regenerated response',
    });

    const history = await createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
    }).load();

    expect(history.headId).toBe('assistant-regenerated');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-reused', null],
      ['assistant-original', 'user-reused'],
      ['assistant-regenerated', 'user-reused'],
    ]);
  });

  it('replays the first regenerated response in a legacy thread as an assistant sibling', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-legacy-regeneration');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await repository.recordMessageParent({
      messageId: 'assistant-regenerated',
      parentId: 'user-reused',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });

    const rows = [
      ['user-reused', 'Original prompt', 'user', '2026-07-13T10:00:00Z'],
      ['assistant-original', 'Original response', 'assistant', '2026-07-13T10:00:01Z'],
      ['assistant-regenerated', 'Regenerated response', 'assistant', '2026-07-13T10:00:03Z'],
    ] as const;
    for (const [id, text, role, createdAt] of rows) {
      await db.query(
        `INSERT INTO mastra_messages
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
        [
          id,
          thread.id,
          JSON.stringify({ content: text, format: 2, parts: [{ text, type: 'text' }] }),
          role,
          new Date(createdAt),
          'workspace-a',
        ]
      );
    }

    const history = await createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
    }).load();

    expect(history.headId).toBe('assistant-regenerated');
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-reused', null],
      ['assistant-original', 'user-reused'],
      ['assistant-regenerated', 'user-reused'],
    ]);
  });

  describe('soft-rewind tombstone hydration (BST-1115)', () => {
    async function seedRewindThread(dataDirName: string): Promise<{
      db: Awaited<ReturnType<typeof createMigratedTestPGlite>>;
      repository: AssistantThreadRepository;
      threadId: string;
    }> {
      pgliteDataDir = createPgliteTestDataDir(dataDirName);
      const db = await createMigratedTestPGlite(pgliteDataDir);
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const thread = await repository.createThread('workspace-a');
      for (const [index, id] of ['message-1', 'message-2', 'message-3'].entries()) {
        await db.query(
          `INSERT INTO mastra_messages
            (id, thread_id, content, role, type, "createdAt", "resourceId")
           VALUES ($1, $2, $3::jsonb, $4, 'text', $5, 'workspace-a')`,
          [
            id,
            thread.id,
            JSON.stringify({ content: `turn ${index + 1}` }),
            index % 2 === 0 ? 'user' : 'assistant',
            new Date(`2026-08-04T10:00:0${index}Z`),
          ]
        );
      }
      return { db, repository, threadId: thread.id };
    }

    async function tombstone(
      db: Pick<DbHandle, 'query'>,
      threadId: string,
      messageId: string
    ): Promise<void> {
      await db.query(
        `INSERT INTO brainstrike_assistant_message_tombstones (message_id, thread_id, rewind_id)
         VALUES ($1, $2, 'rewind-1')`,
        [messageId, threadId]
      );
    }

    it('omits a tombstoned message from the hydration window', async () => {
      const { db, repository, threadId } = await seedRewindThread('assistant-rewind-hydration');
      await tombstone(db, threadId, 'message-3');

      const messages = await repository.listMessages(threadId, 'workspace-a');

      expect(messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    });

    it('keeps the message hidden after a simulated reload', async () => {
      const { db, threadId } = await seedRewindThread('assistant-rewind-reload');
      await tombstone(db, threadId, 'message-3');

      // A reload rebuilds the repository from nothing over the same database:
      // the tombstone row is the only thing carrying the rewind across it, and
      // the renderer holds no memory of the rewind at all.
      const reloadedRepository = createPgliteAssistantThreadRepository(db as DbHandle);
      const history = await createAssistantThreadHistoryAdapter({
        repository: reloadedRepository,
        resourceId: 'workspace-a',
        threadId,
      }).load();

      expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-2']);
    });

    it('restores the message when the rewind batch is undone (redo)', async () => {
      const { db, repository, threadId } = await seedRewindThread('assistant-rewind-redo');
      await tombstone(db, threadId, 'message-3');
      await db.query(
        `DELETE FROM brainstrike_assistant_message_tombstones WHERE rewind_id = 'rewind-1'`
      );

      const messages = await repository.listMessages(threadId, 'workspace-a');

      expect(messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
      ]);
    });

    it('fills the bounded hydration window with VISIBLE messages, not hidden ones', async () => {
      const { db, repository, threadId } = await seedRewindThread('assistant-rewind-window');
      await tombstone(db, threadId, 'message-2');

      // limitLatest applies AFTER the exclusion, so a window of 2 returns the
      // two newest visible messages rather than one message and a hole.
      const messages = await repository.listMessages(threadId, 'workspace-a', { limitLatest: 2 });

      expect(messages.map((message) => message.id)).toEqual(['message-1', 'message-3']);
    });

    it('reloads compaction-summary custom metadata intact through the bounded history path', async () => {
      const { db, threadId } = await seedRewindThread('assistant-compaction-summary-reload');
      const payload = {
        createdAt: '2026-08-09T12:00:00.000Z',
        fallbackKind: 'agentic',
        firstCompactedMessageId: 'message-1',
        lastCompactedMessageId: 'message-2',
        rewriteId: 'rewrite-1',
      } as const;
      await db.query(
        `INSERT INTO mastra_messages
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ('summary-1', $1, $2::jsonb, 'assistant', 'v2',
                 '2026-08-09T12:00:00Z', 'workspace-a')`,
        [
          threadId,
          JSON.stringify({
            format: 2,
            metadata: { custom: { [COMPACTION_SUMMARY_METADATA_KEY]: payload } },
            parts: [{ text: 'Goal\nContinue the work.', type: 'text' }],
          }),
        ]
      );

      const reloadedRepository = createPgliteAssistantThreadRepository(db as DbHandle);
      const history = await createAssistantThreadHistoryAdapter({
        repository: reloadedRepository,
        resourceId: 'workspace-a',
        threadId,
      }).load();
      const summary = history.messages.find((item) => item.message.id === 'summary-1')?.message;
      const marker = summary?.metadata.custom?.[COMPACTION_SUMMARY_METADATA_KEY];

      expect(summary?.role).toBe('assistant');
      expect(marker).toEqual(payload);
      expect(isCompactionSummaryPayload(marker)).toBe(true);
    });

    it('hydrates an assistant tool turn and a rooted compaction summary as separate groups', async () => {
      const { db, repository, threadId } = await seedRewindThread(
        'assistant-compaction-summary-after-tool-turn'
      );
      const payload = {
        createdAt: '2026-08-09T12:00:00.000Z',
        fallbackKind: 'agentic',
        firstCompactedMessageId: 'message-1',
        lastCompactedMessageId: 'message-3',
        rewriteId: 'rewrite-tool-turn',
      } as const;
      await db.query('DELETE FROM mastra_messages WHERE thread_id = $1', [threadId]);
      await repository.recordMessageParent({
        messageId: 'assistant-final',
        parentId: 'user-tool-turn',
        resourceId: 'workspace-a',
        threadId,
      });
      await repository.recordMessageParent({
        messageId: 'summary-after-tool-turn',
        parentId: null,
        resourceId: 'workspace-a',
        threadId,
      });
      for (const row of [
        {
          content: { content: 'Inspect the repository.' },
          createdAt: '2026-08-09T11:59:00Z',
          id: 'user-tool-turn',
          role: 'user',
        },
        {
          content: {
            parts: [
              {
                args: { path: 'src/a.ts' },
                isError: false,
                result: { content: 'source' },
                toolCallId: 'call-read',
                toolName: 'brainstrike.readWorkspaceFile',
                type: 'tool-call',
              },
              { text: 'The repository is ready.', type: 'text' },
            ],
          },
          createdAt: '2026-08-09T11:59:02Z',
          id: 'assistant-final',
          role: 'assistant',
        },
        {
          content: {
            format: 2,
            metadata: { custom: { [COMPACTION_SUMMARY_METADATA_KEY]: payload } },
            parts: [{ text: 'Goal:\nContinue the repository work.', type: 'text' }],
          },
          createdAt: '2026-08-09T12:00:00Z',
          id: 'summary-after-tool-turn',
          role: 'assistant',
        },
      ] as const) {
        await db.query(
          `INSERT INTO mastra_messages
            (id, thread_id, content, role, type, "createdAt", "resourceId")
           VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, 'workspace-a')`,
          [row.id, threadId, JSON.stringify(row.content), row.role, row.createdAt]
        );
      }

      const history = await createAssistantThreadHistoryAdapter({
        repository: createPgliteAssistantThreadRepository(db as DbHandle),
        resourceId: 'workspace-a',
        threadId,
      }).load();
      const priorAssistant = history.messages.find(
        (item) => item.message.id === 'assistant-final'
      )?.message;
      const summary = history.messages.find(
        (item) => item.message.id === 'summary-after-tool-turn'
      )?.message;

      expect(history.messages.map((item) => item.message.id)).toEqual([
        'user-tool-turn',
        'assistant-final',
        'summary-after-tool-turn',
      ]);
      expect(priorAssistant?.content).toEqual([
        expect.objectContaining({ toolCallId: 'call-read', type: 'tool-call' }),
        { text: 'The repository is ready.', type: 'text' },
      ]);
      expect(summary?.content).toEqual([
        { text: 'Goal:\nContinue the repository work.', type: 'text' },
      ]);
      expect(
        isCompactionSummaryPayload(summary?.metadata.custom?.[COMPACTION_SUMMARY_METADATA_KEY])
      ).toBe(true);
      expect(priorAssistant?.metadata.custom?.[COMPACTION_SUMMARY_METADATA_KEY]).toBeUndefined();
    });
  });

  it('deletes messages and cascades thread runs and run events in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-delete-cascade');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await db.query(
      `INSERT INTO mastra_messages
        (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [
        'message-delete',
        thread.id,
        JSON.stringify({ content: 'Delete this thread.' }),
        'user',
        'text',
        new Date('2026-04-24T12:00:00Z'),
        'workspace-a',
      ]
    );
    await repository.recordMessageParent({
      messageId: 'message-delete',
      parentId: null,
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await repository.createThreadRun({
      id: 'run-delete',
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-04-24T12:00:01Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.appendThreadRunEvent('run-delete', {
      id: 'event-delete',
      kind: 'memory.configured',
      label: 'Memory configured',
      sequence: 1,
      status: 'completed',
      timestamp: '2026-04-24T12:00:02.000Z',
    } satisfies AssistantRunEvent);
    await db.query(
      `INSERT INTO brainstrike_assistant_run_errors
        (run_id, thread_id, resource_id, code, occurred_at)
       VALUES ('run-delete', $1, 'workspace-a', 'provider_error', NOW())`,
      [thread.id]
    );
    // Soft-rewind tombstones (BST-1115) are a thread-keyed sidecar: a deleted
    // thread must not leave rows hiding messages that no longer exist.
    await db.query(
      `INSERT INTO brainstrike_assistant_message_tombstones
        (message_id, thread_id, rewind_id)
       VALUES ('message-delete', $1, 'rewind-delete')`,
      [thread.id]
    );
    await db.query(
      `INSERT INTO brainstrike_canvas_versions
        (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
       VALUES ('canvas-version-delete', 'canvas-delete', $1, 'workspace-a',
        'Delete me', '<p>Delete me</p>', 1, 'assistant')`,
      [thread.id]
    );
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, model_facing_chars)
       VALUES ('tool-telemetry-delete', $1, 'run-delete', 'brainstrike.grepSearch', 42)`,
      [thread.id]
    );
    await db.query(
      `INSERT INTO brainstrike_token_estimate_calibration
        (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
         final_step_prompt_tokens)
       VALUES ('calibration-delete', $1, 'run-delete', 'model', 'provider', 42, 50)`,
      [thread.id]
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_tool_projection_rewrites
        (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('read-old', $1, 'rewrite-delete', 'read-new', 'read a.ts lines 1-2/2 [superseded]', 42)`,
      [thread.id]
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_compaction_ranges
        (compaction_message_id, thread_id, compacted_message_ids, kind)
       VALUES ('summary-delete', $1, '["message-delete"]'::jsonb, 'agentic')`,
      [thread.id]
    );

    await repository.deleteThread(thread.id);

    await expect(countRows(db, 'mastra_threads', 'id', thread.id)).resolves.toBe(0);
    await expect(countRows(db, 'mastra_messages', 'thread_id', thread.id)).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_message_parents', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_thread_runs', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_run_events', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_run_errors', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_message_tombstones', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_canvas_versions', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_tool_call_telemetry', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_token_estimate_calibration', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_tool_projection_rewrites', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_compaction_ranges', 'thread_id', thread.id)
    ).resolves.toBe(0);
  });

  it('atomically deletes many threads and every explicitly owned row in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-bulk-delete');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const first = await repository.createThread('workspace-a');
    const second = await repository.createThread('workspace-a');
    const survivor = await repository.createThread('workspace-a');

    // The placements table is bootstrapped by the repository itself now that
    // the delete cascade owns the placements stage on every path (BST-993).
    for (const thread of [first, second, survivor]) {
      await db.query(
        `INSERT INTO mastra_messages
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, '{}'::jsonb, 'user', 'text', NOW(), 'workspace-a')`,
        [`message-${thread.id}`, thread.id]
      );
      await db.query(
        `INSERT INTO brainstrike_assistant_edit_checkpoints (
           id, run_id, resource_id, thread_id, tool_name, op, root_id, path,
           before_existed, before_content, before_size, after_existed,
           capture_status, occurred_at, created_at, updated_at
         ) VALUES (
           $1, 'run-1', 'workspace-a', $2, 'brainstrike.writeWorkspaceFile', 'write',
           'root-1', '/a.txt', true, 'BEFORE', 6, true, 'ok', NOW(), NOW(), NOW()
         )`,
        [`checkpoint-${thread.id}`, thread.id]
      );
      await db.query(
        `INSERT INTO brainstrike_assistant_thread_placements
          (thread_id, resource_id, group_id, rank, flat_rank)
         VALUES ($1, 'workspace-a', null, $2, $3)`,
        [thread.id, `group-${thread.id}`, `flat-${thread.id}`]
      );
      await db.query(
        `INSERT INTO brainstrike_assistant_run_errors
          (run_id, thread_id, resource_id, code, occurred_at)
         VALUES ($1, $2, 'workspace-a', 'provider_error', NOW())`,
        [`run-error-${thread.id}`, thread.id]
      );
      // BST-993 census: bulk delete leaked branch topology — the single-thread
      // CTE deleted message_parents but the bulk CTE did not.
      await db.query(
        `INSERT INTO brainstrike_assistant_message_parents
          (message_id, thread_id, resource_id)
         VALUES ($1, $2, 'workspace-a')`,
        [`message-${thread.id}`, thread.id]
      );
      await db.query(
        `INSERT INTO brainstrike_canvas_versions
          (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
         VALUES ($1, $2, $3, 'workspace-a', 'Bulk canvas', '<p>canvas</p>', 1, 'assistant')`,
        [`canvas-version-${thread.id}`, `canvas-${thread.id}`, thread.id]
      );
      await db.query(
        `INSERT INTO brainstrike_tool_call_telemetry
          (id, thread_id, run_id, tool_id, model_facing_chars)
         VALUES ($1, $2, $3, 'brainstrike.globWorkspace', 17)`,
        [`tool-telemetry-${thread.id}`, thread.id, `run-${thread.id}`]
      );
      await db.query(
        `INSERT INTO brainstrike_token_estimate_calibration
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           final_step_prompt_tokens)
         VALUES ($1, $2, $3, 'model', 'provider', 17, 20)`,
        [`calibration-${thread.id}`, thread.id, `run-${thread.id}`]
      );
      await db.query(
        `INSERT INTO brainstrike_assistant_compaction_ranges
          (compaction_message_id, thread_id, compacted_message_ids, kind)
         VALUES ($1, $2, $3::jsonb, 'deterministic')`,
        [`summary-${thread.id}`, thread.id, JSON.stringify([`message-${thread.id}`])]
      );
    }

    await repository.deleteThreads([first.id, second.id]);

    await expect(countRows(db, 'mastra_threads', 'id', first.id)).resolves.toBe(0);
    await expect(countRows(db, 'mastra_threads', 'id', second.id)).resolves.toBe(0);
    await expect(countRows(db, 'mastra_threads', 'id', survivor.id)).resolves.toBe(1);
    await expect(countRows(db, 'mastra_messages', 'thread_id', first.id)).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_edit_checkpoints', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(countRows(db, 'mastra_messages', 'thread_id', survivor.id)).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_assistant_edit_checkpoints', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_assistant_thread_placements', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_thread_placements', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_thread_placements', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_assistant_run_errors', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_run_errors', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_run_errors', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_assistant_message_parents', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_message_parents', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_message_parents', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(countRows(db, 'brainstrike_canvas_versions', 'thread_id', first.id)).resolves.toBe(
      0
    );
    await expect(
      countRows(db, 'brainstrike_canvas_versions', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_canvas_versions', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_tool_call_telemetry', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_tool_call_telemetry', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_tool_call_telemetry', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_token_estimate_calibration', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_token_estimate_calibration', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_token_estimate_calibration', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    await expect(
      countRows(db, 'brainstrike_assistant_compaction_ranges', 'thread_id', first.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_compaction_ranges', 'thread_id', second.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_compaction_ranges', 'thread_id', survivor.id)
    ).resolves.toBe(1);
    // The op-log seam (BST-993): one tombstone per actually-deleted thread.
    await expect(countRows(db, 'brainstrike_mind_ops', 'entity_id', first.id)).resolves.toBe(1);
    await expect(countRows(db, 'brainstrike_mind_ops', 'entity_id', second.id)).resolves.toBe(1);
    await expect(countRows(db, 'brainstrike_mind_ops', 'entity_id', survivor.id)).resolves.toBe(0);
  });

  it('emits a single tombstone op per delete; idempotent deletes emit none (BST-993)', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-delete-mind-ops');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    // Placements now cascade on the SINGLE-thread path too — previously only
    // the bulk CTE owned this stage and the panel compensated in TS.
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements
        (thread_id, resource_id, group_id, rank, flat_rank)
       VALUES ($1, 'workspace-a', null, 'a0', 'a0')`,
      [thread.id]
    );

    await repository.deleteThread(thread.id);

    await expect(
      countRows(db, 'brainstrike_assistant_thread_placements', 'thread_id', thread.id)
    ).resolves.toBe(0);
    const ops = await db.query<{
      entity_kind: string;
      op: string;
      resource_id: string | null;
      seq: string | number;
    }>('SELECT entity_kind, op, resource_id, seq FROM brainstrike_mind_ops WHERE entity_id = $1', [
      thread.id,
    ]);
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]?.entity_kind).toBe('thread');
    expect(ops.rows[0]?.op).toBe('delete');
    // Workspace scope is captured at delete time — unrecoverable afterwards.
    expect(ops.rows[0]?.resource_id).toBe('workspace-a');

    // Deleting an already-gone thread is a no-op for the log: a tombstone
    // must record an actual deletion, not an attempt.
    await repository.deleteThread(thread.id);
    await expect(countRows(db, 'brainstrike_mind_ops', 'entity_id', thread.id)).resolves.toBe(1);
  });

  it('rejects an unknown bulk-delete id without deleting known threads', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-bulk-delete-unknown');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    // The placements table is bootstrapped by the repository itself now that
    // the delete cascade owns the placements stage on every path (BST-993).

    await expect(repository.deleteThreads([thread.id, 'thread-unknown'])).rejects.toThrow(
      'One or more assistant threads do not exist.'
    );

    await expect(countRows(db, 'mastra_threads', 'id', thread.id)).resolves.toBe(1);
    // A rejected bulk delete must not write tombstones for threads it kept.
    await expect(countRows(db, 'brainstrike_mind_ops', 'entity_id', thread.id)).resolves.toBe(0);
  });

  it('purges edit-checkpoint rows for the deleted thread in real PGlite', async () => {
    // The checkpoint journal has NO FK to mastra_threads (bare-PGlite migration
    // constraint), so deleteThread must explicitly delete its rows or up to
    // 32 MB/thread of before_content is stranded until factory reset.
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-delete-checkpoints');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    const insertCheckpoint = async (id: string, threadId: string): Promise<void> => {
      await db.query(
        `INSERT INTO brainstrike_assistant_edit_checkpoints (
           id, run_id, resource_id, thread_id, tool_name, op, root_id, path,
           before_existed, before_content, before_size, after_existed,
           capture_status, occurred_at, created_at, updated_at
         ) VALUES (
           $1, 'run-1', 'workspace-a', $2, 'brainstrike.writeWorkspaceFile', 'write',
           'root-1', '/a.txt', true, 'BEFORE', 6, true, 'ok', NOW(), NOW(), NOW()
         )`,
        [id, threadId]
      );
    };
    await insertCheckpoint('ckpt-1', thread.id);
    await insertCheckpoint('ckpt-2', thread.id);
    // A sibling thread's checkpoint must survive the delete.
    await insertCheckpoint('ckpt-other', 'other-thread');

    await repository.deleteThread(thread.id);

    await expect(
      countRows(db, 'brainstrike_assistant_edit_checkpoints', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_edit_checkpoints', 'thread_id', 'other-thread')
    ).resolves.toBe(1);
  });

  it('persists curated metadata without changing conversational recency', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-curated-metadata');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    const conversationalUpdatedAt = new Date('2026-04-22T08:00:00.000Z');
    await db.query(`UPDATE mastra_threads SET "updatedAt" = $2 WHERE id = $1`, [
      thread.id,
      conversationalUpdatedAt,
    ]);

    await repository.updateThreadMetadata(thread.id, {
      color: 'rose',
      icon: 'bug',
    });

    const threads = await repository.listThreads('workspace-a');

    expect(threads[0]?.metadata).toEqual({
      color: 'rose',
      icon: 'bug',
      source: 'brainstrike',
    });
    expect(threads[0]?.updatedAt).toEqual(conversationalUpdatedAt);
  });

  it('atomically updates curated metadata for many threads without changing recency', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-bulk-metadata');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const first = await repository.createThread('workspace-a');
    const second = await repository.createThread('workspace-a');
    const firstUpdatedAt = new Date('2026-04-22T08:00:00.000Z');
    const secondUpdatedAt = new Date('2026-04-22T09:00:00.000Z');
    await db.query(`UPDATE mastra_threads SET "updatedAt" = $2 WHERE id = $1`, [
      first.id,
      firstUpdatedAt,
    ]);
    await db.query(`UPDATE mastra_threads SET "updatedAt" = $2 WHERE id = $1`, [
      second.id,
      secondUpdatedAt,
    ]);

    await repository.updateThreadsMetadata([first.id, second.id], {
      color: 'emerald',
      icon: 'research',
    });

    const threads = await repository.listThreads('workspace-a');
    expect(threads).toEqual([
      expect.objectContaining({
        id: second.id,
        metadata: expect.objectContaining({ color: 'emerald', icon: 'research' }),
        updatedAt: secondUpdatedAt,
      }),
      expect.objectContaining({
        id: first.id,
        metadata: expect.objectContaining({ color: 'emerald', icon: 'research' }),
        updatedAt: firstUpdatedAt,
      }),
    ]);
  });

  it('rejects checkout transitions through the bulk metadata writer', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-bulk-checkout-metadata');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await expect(
      repository.updateThreadsMetadata([thread.id], { checkoutMode: 'local' })
    ).rejects.toThrow('Bulk assistant thread metadata updates cannot change checkout state.');
  });

  it('rejects an unknown bulk metadata id without changing known threads', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-bulk-metadata-unknown');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await expect(
      repository.updateThreadsMetadata([thread.id, 'thread-unknown'], { color: 'rose' })
    ).rejects.toThrow('One or more assistant threads do not exist.');

    const threads = await repository.listThreads('workspace-a');
    expect(threads[0]?.metadata).toEqual({ source: 'brainstrike' });
  });

  it('seeds a new thread as OM-overwritable, then a manual rename clears the marker', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-title-marker');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    expect(await readThreadTitleSource(db, thread.id)).toBe('om');

    await repository.renameThread(thread.id, 'My Curated Thread');

    expect(await readThreadTitleSource(db, thread.id)).toBeUndefined();
    const threads = await repository.listThreads('workspace-a');
    expect(threads[0]?.title).toBe('My Curated Thread');
  });

  it('records run usage and aggregates cumulative tokens per model in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-usage-cumulative');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    // Same thread, three runs across TWO models — cost must be attributable
    // per model, so the read API returns per-model subtotals.
    await repository.recordRunUsage({
      inputTokens: 1000,
      model: 'gpt-5.2',
      outputTokens: 200,
      provider: 'openai',
      resourceId: 'workspace-a',
      runId: 'run-1',
      threadId: 'thread-cost',
    });
    await repository.recordRunUsage({
      inputTokens: 500,
      model: 'gpt-5.2',
      outputTokens: 100,
      provider: 'openai',
      resourceId: 'workspace-a',
      runId: 'run-2',
      threadId: 'thread-cost',
    });
    await repository.recordRunUsage({
      inputTokens: 2000,
      model: 'claude-opus-4-8',
      outputTokens: 300,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runId: 'run-3',
      threadId: 'thread-cost',
    });
    // Child-run attribution (BST-953): a subagent leg on the parent's model and
    // an OM observation cycle on the observer model, both under run-1, must
    // aggregate as their OWN (provider, model, runKind) entries.
    await repository.recordRunUsage({
      inputTokens: 300,
      model: 'gpt-5.2',
      outputTokens: 40,
      provider: 'openai',
      resourceId: 'workspace-a',
      runId: 'run-1',
      runKind: 'subagent',
      threadId: 'thread-cost',
    });
    await repository.recordRunUsage({
      cacheReadInputTokens: 80,
      inputTokens: 120,
      model: 'google/gemini-2.5-flash',
      outputTokens: 30,
      provider: 'openrouter',
      resourceId: 'workspace-a',
      runId: 'run-1',
      runKind: 'om-observation',
      threadId: 'thread-cost',
    });
    // A different thread must not bleed into the aggregate.
    await repository.recordRunUsage({
      inputTokens: 9999,
      model: 'gpt-5.2',
      outputTokens: 9999,
      provider: 'openai',
      resourceId: 'workspace-a',
      runId: 'run-x',
      threadId: 'other-thread',
    });

    const usage = await repository.getThreadCumulativeUsage('thread-cost');
    expect(usage).not.toBeNull();
    expect(usage?.totalInputTokens).toBe(3920);
    expect(usage?.totalOutputTokens).toBe(670);

    // Per-(model, kind) subtotals so the UI can price each model AND break the
    // thread total down by source.
    const byModel = new Map(
      (usage?.perModel ?? []).map((entry) => [
        `${entry.provider}:${entry.model}:${entry.runKind}`,
        entry,
      ])
    );
    expect(byModel.get('openai:gpt-5.2:chat')).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      inputTokens: 1500,
      model: 'gpt-5.2',
      outputTokens: 300,
      provider: 'openai',
      runKind: 'chat',
    });
    expect(byModel.get('openai:gpt-5.2:subagent')).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      inputTokens: 300,
      model: 'gpt-5.2',
      outputTokens: 40,
      provider: 'openai',
      runKind: 'subagent',
    });
    expect(byModel.get('anthropic:claude-opus-4-8:chat')).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      inputTokens: 2000,
      model: 'claude-opus-4-8',
      outputTokens: 300,
      provider: 'anthropic',
      runKind: 'chat',
    });
    // Cache classes aggregate UNCONDITIONALLY (the savings line needs them for
    // billed rows too), alongside the unbilled-only estimated split.
    expect(byModel.get('openrouter:google/gemini-2.5-flash:om-observation')).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 80,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 80,
      inputTokens: 120,
      model: 'google/gemini-2.5-flash',
      outputTokens: 30,
      provider: 'openrouter',
      runKind: 'om-observation',
    });
  });

  it('aggregates provider-reported and legacy usage separately in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-usage-mixed-cost');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await repository.recordRunUsage({
      billedCostUsd: 0.0042,
      inputTokens: 100,
      model: 'z-ai/glm-5.2',
      outputTokens: 20,
      provider: 'openrouter',
      resourceId: 'workspace-a',
      runId: 'run-exact',
      threadId: 'thread-mixed-cost',
    });
    await repository.recordRunUsage({
      inputTokens: 50,
      model: 'z-ai/glm-5.2',
      outputTokens: 10,
      provider: 'openrouter',
      resourceId: 'workspace-a',
      runId: 'run-legacy',
      threadId: 'thread-mixed-cost',
    });

    await expect(repository.getThreadCumulativeUsage('thread-mixed-cost')).resolves.toEqual({
      perModel: [
        {
          billedCostUsd: 0.0042,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCacheCreationTokens: 0,
          estimatedCacheReadTokens: 0,
          estimatedInputTokens: 50,
          estimatedOutputTokens: 10,
          inputTokens: 150,
          model: 'z-ai/glm-5.2',
          outputTokens: 30,
          provider: 'openrouter',
          runKind: 'chat',
        },
      ],
      totalInputTokens: 150,
      totalOutputTokens: 30,
    });
  });

  it('returns null cumulative usage for a thread with no recorded runs', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-usage-empty');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await expect(repository.getThreadCumulativeUsage('never-seen')).resolves.toBeNull();
  });

  it('aggregates cross-root usage per (root, model), including a null root bucket', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-cross-root-usage');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    // The aggregation LEFT JOINs roots for display names (production has the
    // roots table from migration 039). Seed it: root-a is named, root-b is
    // deliberately absent so the join MISS surfaces a null name (not a crash).
    await db.query(
      `CREATE TABLE IF NOT EXISTS roots (
        id text PRIMARY KEY,
        kind text,
        display_name text NOT NULL,
        path text,
        status text,
        created_at timestamptz,
        last_verified_at timestamptz
      )`
    );
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ('root-a', 'path', 'project-alpha', '/tmp/project-alpha')`
    );

    // Workspace 'workspace-a': two roots + an unattributed (null-root) turn,
    // across two threads and two models. The aggregate must group by
    // (root, provider, model) and never bleed in a different workspace.
    await repository.recordRunUsage({
      inputTokens: 1000,
      model: 'gpt-5.2',
      outputTokens: 200,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: 'root-a',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    await repository.recordRunUsage({
      inputTokens: 500,
      model: 'gpt-5.2',
      outputTokens: 100,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: 'root-a',
      runId: 'run-2',
      threadId: 'thread-2',
    });
    await repository.recordRunUsage({
      inputTokens: 2000,
      model: 'claude-opus-4-8',
      outputTokens: 300,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      rootId: 'root-b',
      runId: 'run-3',
      threadId: 'thread-1',
    });
    // No focused root → unattributed bucket (null root_id), honest not fake.
    await repository.recordRunUsage({
      inputTokens: 50,
      model: 'gpt-5.2',
      outputTokens: 10,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: null,
      runId: 'run-4',
      threadId: 'thread-3',
    });
    // A different workspace must not contribute to workspace-a's aggregate.
    await repository.recordRunUsage({
      inputTokens: 9999,
      model: 'gpt-5.2',
      outputTokens: 9999,
      provider: 'openai',
      resourceId: 'workspace-b',
      rootId: 'root-a',
      runId: 'run-x',
      threadId: 'thread-x',
    });

    const rows = await repository.getCrossRootUsage('workspace-a');

    // NULLS FIRST, then by root id / provider / model — deterministic ordering.
    // root-a resolves its display name; root-b (no roots row) and the null
    // bucket carry a null name — never a fabricated one.
    expect(rows).toEqual([
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 50,
        model: 'gpt-5.2',
        outputTokens: 10,
        provider: 'openai',
        rootDisplayName: null,
        rootId: null,
      },
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 1500,
        model: 'gpt-5.2',
        outputTokens: 300,
        provider: 'openai',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 2000,
        model: 'claude-opus-4-8',
        outputTokens: 300,
        provider: 'anthropic',
        rootDisplayName: null,
        rootId: 'root-b',
      },
    ]);
  });

  it('returns an empty cross-root usage list for a workspace with no usage', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-cross-root-usage-empty');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    // roots exists in production (migration 039); the aggregation joins it.
    await db.query(
      'CREATE TABLE IF NOT EXISTS roots (id text PRIMARY KEY, display_name text NOT NULL)'
    );

    await expect(repository.getCrossRootUsage('never-seen')).resolves.toEqual([]);
  });

  it('records one outcome label per run and upserts later verdicts in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-outcome-upsert');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await repository.recordRunOutcome({
      labeledAt: new Date('2026-07-16T12:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-1',
      source: 'hook',
      threadId: 'thread-1',
      verdict: 'succeeded',
    });
    // A later explicit user verdict replaces the hook label — one row per run.
    await repository.recordRunOutcome({
      detail: 'edits reverted by user',
      labeledAt: new Date('2026-07-16T12:05:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-1',
      source: 'user',
      threadId: 'thread-1',
      verdict: 'failed',
    });

    const rows = await db.query<{ verdict: string; source: string; detail: string | null }>(
      `SELECT verdict, source, detail FROM brainstrike_assistant_run_outcomes WHERE run_id = 'run-1'`
    );
    expect(rows.rows).toEqual([
      { detail: 'edits reverted by user', source: 'user', verdict: 'failed' },
    ]);
  });

  it('never lets a hook-source outcome overwrite an existing user label in real PGlite', async () => {
    // Precedence contract (Task Ledger source 'hook'): a hook label upserts
    // over nothing/hook/edit_revert but NEVER over an explicit user verdict —
    // enforced in the upsert SQL itself, in EVERY write path (this repository
    // AND the byte-consistent main-process writer in apps/desktop
    // assistant-server/run-persistence.ts recordDesktopAssistantHookRunOutcome).
    pgliteDataDir = createPgliteTestDataDir('assistant-run-outcome-hook-precedence');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await repository.recordRunOutcome({
      detail: 'user verdict',
      resourceId: 'workspace-a',
      runId: 'run-1',
      source: 'user',
      threadId: 'thread-1',
      verdict: 'succeeded',
    });
    // A later hook write is SKIPPED, not an error and never an overwrite.
    await repository.recordRunOutcome({
      detail: '3 tests failing',
      resourceId: 'workspace-a',
      runId: 'run-1',
      source: 'hook',
      threadId: 'thread-1',
      verdict: 'failed',
    });

    const rows = await db.query<{ verdict: string; source: string; detail: string | null }>(
      `SELECT verdict, source, detail FROM brainstrike_assistant_run_outcomes WHERE run_id = 'run-1'`
    );
    expect(rows.rows).toEqual([{ detail: 'user verdict', source: 'user', verdict: 'succeeded' }]);

    // A hook label still replaces a derived edit_revert label on another run.
    await repository.recordRunOutcome({
      resourceId: 'workspace-a',
      runId: 'run-2',
      source: 'edit_revert',
      threadId: 'thread-1',
      verdict: 'failed',
    });
    await repository.recordRunOutcome({
      resourceId: 'workspace-a',
      runId: 'run-2',
      source: 'hook',
      threadId: 'thread-1',
      verdict: 'succeeded',
    });
    const derived = await db.query<{ verdict: string; source: string }>(
      `SELECT verdict, source FROM brainstrike_assistant_run_outcomes WHERE run_id = 'run-2'`
    );
    expect(derived.rows).toEqual([{ source: 'hook', verdict: 'succeeded' }]);
  });

  it('aggregates the run ledger across usage, tool events, checkpoints, and outcomes in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-ledger');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    // Run 1: completed, two usage rows (one with exact billed cost), two tool
    // completions + one tool failure, two edits (one later reverted), no label.
    await repository.createThreadRun({
      id: 'run-1',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-16T10:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.completeThreadRun('run-1', { status: 'completed' });
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs
       SET completed_at = $2 WHERE id = $1`,
      ['run-1', new Date('2026-07-16T10:01:30Z')]
    );
    await repository.recordRunUsage({
      billedCostUsd: 0.5,
      inputTokens: 1000,
      model: 'claude-sonnet-5',
      outputTokens: 200,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runId: 'run-1',
      threadId: thread.id,
    });
    await repository.recordRunUsage({
      inputTokens: 400,
      model: 'claude-sonnet-5',
      outputTokens: 100,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runId: 'run-1',
      threadId: thread.id,
    });
    const toolEvents: Array<{ id: string; kind: 'tool.completed' | 'tool.failed' }> = [
      { id: 'event-1', kind: 'tool.completed' },
      { id: 'event-2', kind: 'tool.completed' },
      { id: 'event-3', kind: 'tool.failed' },
    ];
    for (const [index, event] of toolEvents.entries()) {
      await repository.appendThreadRunEvent('run-1', {
        id: event.id,
        kind: event.kind,
        label: 'Tool call',
        sequence: index + 1,
        status: event.kind === 'tool.failed' ? 'failed' : 'completed',
        timestamp: '2026-07-16T10:00:05.000Z',
      } satisfies AssistantRunEvent);
    }
    // A non-tool event must not count toward toolCallCount.
    await repository.appendThreadRunEvent('run-1', {
      id: 'event-4',
      kind: 'memory.configured',
      label: 'Memory configured',
      sequence: 4,
      status: 'completed',
      timestamp: '2026-07-16T10:00:06.000Z',
    } satisfies AssistantRunEvent);
    // BST-558: a suspending tool with no registered resume UI is a CLIENT
    // CAPABILITY MISMATCH, not a tool failure — no tool ran and none failed.
    // The run deliberately stays suspended, so a later build that registers the
    // UI resumes the SAME toolCallId and emits the real `tool.completed`;
    // counting this notice would both invent a failure and double-count the call.
    // Deliberately the EMITTED constant, not a literal: if the rejection is ever
    // pointed back at `tool.failed` this test fails instead of quietly passing.
    await repository.appendThreadRunEvent('run-1', {
      id: 'event-5',
      kind: UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
      label: 'Tool pause cannot be answered by this build',
      metadata: {
        resumeSupportedByClient: false,
        runStillSuspended: true,
        toolCallId: 'call-future-tool',
        toolName: 'brainstrike.someFutureSuspendingTool',
      },
      sequence: 5,
      status: 'failed',
      timestamp: '2026-07-16T10:00:07.000Z',
    } satisfies AssistantRunEvent);
    await db.query(
      `INSERT INTO brainstrike_assistant_edit_checkpoints
        (id, run_id, resource_id, thread_id, tool_name, op, root_id, path,
         before_existed, after_existed, capture_status, reverted_at,
         occurred_at, created_at, updated_at)
       VALUES
        ('cp-1', 'run-1', 'workspace-a', $1, 'writeWorkspaceFile', 'write', 'root-1',
         'src/a.ts', true, true, 'ok', NULL, NOW(), NOW(), NOW()),
        ('cp-2', 'run-1', 'workspace-a', $1, 'writeWorkspaceFile', 'write', 'root-1',
         'src/b.ts', true, true, 'ok', NOW(), NOW(), NOW(), NOW())`,
      [thread.id]
    );

    // Run 2: newer, failed transport, no usage/events, labeled failed by revert.
    await repository.createThreadRun({
      id: 'run-2',
      model: 'gpt-5.2',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-16T11:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.completeThreadRun('run-2', { error: 'boom', status: 'failed' });
    await repository.recordRunOutcome({
      labeledAt: new Date('2026-07-16T11:02:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-2',
      source: 'edit_revert',
      threadId: thread.id,
      verdict: 'failed',
    });

    // A different workspace must not bleed into the ledger.
    await repository.createThreadRun({
      id: 'run-other',
      model: 'gpt-5.2',
      provider: 'openai',
      resourceId: 'workspace-b',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-16T11:30:00Z'),
      status: 'running',
      threadId: thread.id,
    });

    const ledger = await repository.getRunLedger('workspace-a');
    expect(ledger.map((row) => row.runId)).toEqual(['run-2', 'run-1']);

    const [run2, run1] = ledger;
    expect(run1).toMatchObject({
      billedCostUsd: 0.5,
      durationMs: 90_000,
      editCount: 2,
      // The second usage row carried no provider-reported cost, so its tokens
      // surface as the estimated remainder alongside the PARTIAL exact figure.
      estimatedInputTokens: 400,
      estimatedOutputTokens: 100,
      failedToolCallCount: 1,
      inputTokens: 1400,
      model: 'claude-sonnet-5',
      outcomeDetail: null,
      outcomeSource: null,
      outcomeVerdict: null,
      outputTokens: 300,
      provider: 'anthropic',
      revertedEditCount: 1,
      runId: 'run-1',
      status: 'completed',
      threadId: thread.id,
      toolCallCount: 3,
    });
    expect(run1?.startedAt.toISOString()).toBe('2026-07-16T10:00:00.000Z');
    expect(run1?.completedAt?.toISOString()).toBe('2026-07-16T10:01:30.000Z');

    expect(run2).toMatchObject({
      editCount: 0,
      failedToolCallCount: 0,
      inputTokens: 0,
      outcomeSource: 'edit_revert',
      outcomeVerdict: 'failed',
      outputTokens: 0,
      revertedEditCount: 0,
      runId: 'run-2',
      status: 'failed',
      toolCallCount: 0,
    });
    expect(run2?.billedCostUsd).toBeUndefined();
    expect(run2?.durationMs).toBeGreaterThanOrEqual(0);

    // limitLatest bounds the ledger to the newest runs.
    const limited = await repository.getRunLedger('workspace-a', { limitLatest: 1 });
    expect(limited.map((row) => row.runId)).toEqual(['run-2']);
  });

  it('keeps the ledger aggregation consumable by a PGlite live query (param-reuse regression)', async () => {
    // PGlite's live extension rewrites queries through format(), and REUSING a
    // bind parameter ($1 appearing more than once) breaks its arity with
    // "too few arguments for format()". The Task Ledger panel consumes
    // RUN_LEDGER_AGGREGATION_SQL through live.query, so the shared SQL must
    // bind each parameter exactly once. Caught live on desktop (2026-07-16).
    pgliteDataDir = createPgliteTestDataDir('assistant-run-ledger-live');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    await repository.createThreadRun({
      id: 'run-live',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-16T10:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });

    const liveSurface = db as unknown as {
      live?: {
        query: (options: { params: readonly unknown[]; query: string }) => Promise<{
          initialResults: { rows: Record<string, unknown>[] };
          unsubscribe: () => Promise<void>;
        }>;
      };
    };
    if (!liveSurface.live) {
      throw new Error('Test PGlite is missing the live extension');
    }
    const handle = await liveSurface.live.query({
      params: ['workspace-a', 50],
      query: RUN_LEDGER_AGGREGATION_SQL,
    });
    try {
      const rows = handle.initialResults.rows.map(mapRunLedgerRow);
      expect(rows.map((row) => row.runId)).toEqual(['run-live']);
    } finally {
      await handle.unsubscribe();
    }
  });
});

function createMockDb(): {
  exec: ReturnType<typeof vi.fn<(sql: string) => Promise<unknown>>>;
  query: ReturnType<
    typeof vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>
  >;
  transaction: ReturnType<
    typeof vi.fn<
      <T>(
        fn: (tx: {
          query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        }) => Promise<T>
      ) => Promise<T>
    >
  >;
} {
  const query = vi.fn(async () => ({ rows: [] }));
  // The repository PROBES for its schema once per handle (BST-1651) before any
  // behavior under test runs, and that probe is a QUERY where the retired
  // bootstrap was an `exec`. Consuming the first slot here keeps every suite's
  // `mockResolvedValueOnce` aligned with the first REAL query, exactly as it
  // was when the schema arrived through `exec`.
  query.mockResolvedValueOnce({ rows: [] });
  const db = {
    exec: vi.fn(async () => undefined),
    query,
  };
  return {
    ...db,
    transaction: vi.fn(async (fn) => await fn(db)),
  };
}

let pgliteDataDirCounter = 0;

function createPgliteTestDataDir(prefix: string): string {
  pgliteDataDirCounter += 1;
  return `memory://${prefix}-${pgliteDataDirCounter}`;
}

async function countRows(
  db: Pick<DbHandle, 'query'>,
  tableName: string,
  columnName: string,
  value: string
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName} WHERE ${columnName} = $1`,
    [value]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function readThreadTitleSource(
  db: Pick<DbHandle, 'query'>,
  threadId: string
): Promise<unknown> {
  const result = await db.query<{ metadata: unknown }>(
    'SELECT metadata FROM mastra_threads WHERE id = $1',
    [threadId]
  );
  const metadata = result.rows[0]?.metadata;
  const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  return (parsed as Record<string, unknown> | undefined)?.['titleSource'];
}
