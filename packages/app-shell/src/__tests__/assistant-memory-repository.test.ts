import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import {
  type RediscoveredToolApproval,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { type DbHandle, wasmLoader } from '@brainstrike/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '../assistant-memory-repository';

function makeMessagesOnlyRepository(): AssistantThreadRepository {
  return {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(),
    createThread: vi.fn(),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    getCrossRootUsage: vi.fn(async () => []),
    getThreadCumulativeUsage: vi.fn(async () => null),
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
    recordRunUsage: vi.fn(),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
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

describe('createAssistantThreadHistoryAdapter', () => {
  it('hydrates assistant-ui history from Mastra memory messages', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
    expect(history.headId).toBe('message-2');
    expect(history.messages.map((item) => item.parentId)).toEqual([null, 'message-1']);
    expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-2']);
    expect(history.messages[0]?.message.content).toEqual([
      { text: 'Remember the deploy window is Friday.', type: 'text' },
    ]);
  });

  it('appends a synthetic approval notice message per rediscovered suspended run', async () => {
    const repository = makeMessagesOnlyRepository();
    const discoverSuspendedApprovals = vi.fn(async () => [makeApproval({})]);

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedApprovals,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(discoverSuspendedApprovals).toHaveBeenCalledWith('thread-1', 'workspace-a');
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
    const discoverSuspendedApprovals = vi.fn(async () => []);

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedApprovals,
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const loadPromise = adapter.load();
    // Discovery must be dispatched without waiting for the (still-pending) history query.
    await Promise.resolve();
    expect(discoverSuspendedApprovals).toHaveBeenCalledTimes(1);

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
    const discoverSuspendedApprovals = vi.fn(async () => [newer, older]);

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedApprovals,
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

  it('is byte-identical to the base hydration when no discovery capability is provided', async () => {
    const repository = makeMessagesOnlyRepository();
    const withoutCapability = await createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    }).load();

    const emptyDiscovery = vi.fn(async () => []);
    const withEmptyDiscovery = await createAssistantThreadHistoryAdapter({
      discoverSuspendedApprovals: emptyDiscovery,
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => []),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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

  it('does not write client-side history because Mastra is the durable writer', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => []),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();
    const assistant = history.messages.find((item) => item.message.id === 'message-2');

    expect(repository.listThreadRunEvents).toHaveBeenCalledWith('thread-1', 'workspace-a');
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
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
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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
        getCrossRootUsage: vi.fn(async () => []),
        getThreadCumulativeUsage: vi.fn(async () => null),
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
        recordRunUsage: vi.fn(),
        renameThread: vi.fn(),
        updateThreadMetadata: vi.fn(),
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
      getCrossRootUsage: vi.fn(async () => []),
      getThreadCumulativeUsage: vi.fn(async () => null),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => args.messages),
      listThreadCheckpoints: vi.fn(async () => []),
      listThreadRunEvents: vi.fn(async () => args.runEvents ?? []),
      listThreads: vi.fn(),
      recordRunUsage: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
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

  it('anchors latest-run events to the latest assistant turn, never an older one', async () => {
    // listThreadRunEvents returns ONLY the latest run's events, and the early
    // ones (memory loads, tool starts) occur BEFORE the latest assistant row
    // is first saved. Pure time-splitting assigned those to the PREVIOUS
    // turn's group on reload.
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

  it('lists thread edit checkpoints across all runs and omits before_content', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('brainstrike_assistant_edit_checkpoints')) {
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

  it('bootstraps the Brainstrike-owned assistant run table before writes', async () => {
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

    expect(db.exec).toHaveBeenCalledTimes(1);
    expect(db.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_runs')
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

  it('bootstraps the run-usage table and inserts a usage row', async () => {
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

    expect(db.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_usage')
    );
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

    expect(db.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_events')
    );
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
              resourceId: '/tmp/workspace-a',
              title: 'Persistence bug',
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
        return {
          rows: [
            {
              completed_at: new Date('2026-04-22T10:31:00Z'),
              created_at: new Date('2026-04-22T10:30:00Z'),
              error: null,
              id: 'run-2',
              model: 'claude-sonnet-4-6',
              model_settings: JSON.stringify({ maxOutputTokens: 2048 }),
              provider: 'anthropic',
              provider_options: null,
              resource_id: '/tmp/workspace-a',
              runtime_kind: 'hosted',
              started_at: new Date('2026-04-22T10:30:00Z'),
              status: 'completed',
              thread_id: 'thread-1',
              updated_at: new Date('2026-04-22T10:31:00Z'),
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
      updatedAt: new Date('2026-04-22T10:31:00Z'),
    });
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
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY "createdAt" ASC'), [
      'thread-1',
      '/tmp/workspace-a',
      ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    ]);
    expect(messages.map((message) => message.id)).toEqual(['message-80']);
  });

  it('rejects invalid assistant history hydration limits', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.listMessages('thread-1', '/tmp/workspace-a', { limitLatest: 0 })
    ).rejects.toThrow('Assistant message history limit must be a positive safe integer.');
  });

  it('retries schema initialization after a transient bootstrap failure', async () => {
    const db = createMockDb();
    db.exec
      .mockRejectedValueOnce(new Error('temporary bootstrap failure'))
      .mockResolvedValue(undefined);
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
    ).rejects.toThrow('temporary bootstrap failure');

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
    expect(db.exec).toHaveBeenCalledTimes(2);
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

    expect(db.exec).toHaveBeenCalledTimes(1);
  });
});

describe('createPgliteAssistantThreadRepository integration', () => {
  let pgliteDataDir: string | undefined;

  afterEach(async () => {
    if (pgliteDataDir) {
      await wasmLoader.closeCached(pgliteDataDir);
      pgliteDataDir = undefined;
    }
  });

  it('persists an explicit initial title in the same operation that creates the thread', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-create-with-title');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    const thread = await repository.createThread('workspace-a', 'Evidence review');

    expect(thread.title).toBe('Evidence review');
    const threads = await repository.listThreads('workspace-a');
    expect(threads).toEqual([expect.objectContaining({ id: thread.id, title: 'Evidence review' })]);
    expect(threads[0]?.metadata).toEqual({ source: 'brainstrike' });
  });

  it('deletes messages and cascades thread runs and run events in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-delete-cascade');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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

    await repository.deleteThread(thread.id);

    await expect(countRows(db, 'mastra_threads', 'id', thread.id)).resolves.toBe(0);
    await expect(countRows(db, 'mastra_messages', 'thread_id', thread.id)).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_thread_runs', 'thread_id', thread.id)
    ).resolves.toBe(0);
    await expect(
      countRows(db, 'brainstrike_assistant_run_events', 'thread_id', thread.id)
    ).resolves.toBe(0);
  });

  it('purges edit-checkpoint rows for the deleted thread in real PGlite', async () => {
    // The checkpoint journal has NO FK to mastra_threads (bare-PGlite migration
    // constraint), so deleteThread must explicitly delete its rows or up to
    // 32 MB/thread of before_content is stranded until factory reset.
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-delete-checkpoints');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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

  it('persists curated metadata updates in real PGlite thread rows', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-curated-metadata');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

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
  });

  it('seeds a new thread as OM-overwritable, then a manual rename clears the marker', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-title-marker');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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
    expect(usage?.totalInputTokens).toBe(3500);
    expect(usage?.totalOutputTokens).toBe(600);

    // Per-model subtotals so the UI can compute cost against each model's price.
    const byModel = new Map(
      (usage?.perModel ?? []).map((entry) => [`${entry.provider}:${entry.model}`, entry])
    );
    expect(byModel.get('openai:gpt-5.2')).toEqual({
      inputTokens: 1500,
      model: 'gpt-5.2',
      outputTokens: 300,
      provider: 'openai',
    });
    expect(byModel.get('anthropic:claude-opus-4-8')).toEqual({
      inputTokens: 2000,
      model: 'claude-opus-4-8',
      outputTokens: 300,
      provider: 'anthropic',
    });
  });

  it('returns null cumulative usage for a thread with no recorded runs', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-usage-empty');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await expect(repository.getThreadCumulativeUsage('never-seen')).resolves.toBeNull();
  });

  it('aggregates cross-root usage per (root, model), including a null root bucket', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-cross-root-usage');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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
        inputTokens: 50,
        model: 'gpt-5.2',
        outputTokens: 10,
        provider: 'openai',
        rootDisplayName: null,
        rootId: null,
      },
      {
        inputTokens: 1500,
        model: 'gpt-5.2',
        outputTokens: 300,
        provider: 'openai',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
      {
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
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    // roots exists in production (migration 039); the aggregation joins it.
    await db.query(
      'CREATE TABLE IF NOT EXISTS roots (id text PRIMARY KEY, display_name text NOT NULL)'
    );

    await expect(repository.getCrossRootUsage('never-seen')).resolves.toEqual([]);
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
  const db = {
    exec: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
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
