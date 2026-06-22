import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { type DbHandle, wasmLoader } from '@brainstrike/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '../assistant-memory-repository';

describe('createAssistantThreadHistoryAdapter', () => {
  it('hydrates assistant-ui history from Mastra memory messages', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Remember the deploy window is Friday.' },
          createdAt: new Date('2026-04-22T10:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: { content: 'I will remember that.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
        },
      ]),
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
      { type: 'text', text: 'Remember the deploy window is Friday.' },
    ]);
  });

  it('hydrates only the bounded latest message window from Mastra memory', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listMessages: vi.fn(async () => []),
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
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listMessages: vi.fn(async () => []),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    await expect(
      adapter.append({
        parentId: null,
        message: {
          id: 'message-1',
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
          attachments: [],
          createdAt: new Date('2026-04-22T10:00:00Z'),
          metadata: { custom: {} },
        },
      })
    ).resolves.toBeUndefined();
    expect(repository.listMessages).not.toHaveBeenCalled();
  });

  it('hydrates cyclic message content without recursing indefinitely', async () => {
    const cyclicContent: Record<string, unknown> = {};
    cyclicContent['content'] = cyclicContent;
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: cyclicContent,
          createdAt: new Date('2026-04-22T10:00:00Z'),
        },
      ]),
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
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => [
        {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          runId: 'run-1',
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
          metadata: { threadId: 'thread-1' },
        } satisfies AssistantRunEvent,
      ]),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Use memory' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: { content: 'I used memory.' },
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
      ]),
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
        type: 'data',
        name: 'brainstrike.run-event',
        data: {
          id: 'event-1',
          kind: 'memory.configured',
          label: 'Memory configured',
          runId: 'run-1',
          sequence: 1,
          status: 'completed',
          timestamp: '2026-04-24T12:00:00.000Z',
          metadata: { threadId: 'thread-1' },
        },
      },
      { type: 'text', text: 'I used memory.' },
    ]);
  });

  it('hydrates persisted assistant tool-call parts after reload', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Search files' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: {
            parts: [
              {
                type: 'tool-call',
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                args: { path: '.', pattern: '*.ts' },
                result: { matches: ['src/a.ts'] },
                isError: false,
              },
              { type: 'text', text: 'I found one match.' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
      ]),
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
        type: 'tool-call',
        toolCallId: 'call-files',
        toolName: 'filesystem.search_files',
        args: { path: '.', pattern: '*.ts' },
        argsText: '{"path":".","pattern":"*.ts"}',
        result: { matches: ['src/a.ts'] },
        isError: false,
      },
      { type: 'text', text: 'I found one match.' },
    ]);
  });

  it('hydrates separate persisted tool result rows back onto assistant tool calls', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Search files' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: {
            parts: [
              {
                type: 'tool-call',
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                args: { path: '.', pattern: '*.ts' },
              },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
        {
          id: 'message-3',
          role: 'tool',
          content: {
            parts: [
              {
                type: 'tool-result',
                toolCallId: 'call-files',
                toolName: 'filesystem.search_files',
                result: { matches: ['src/a.ts'] },
                isError: false,
              },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:02Z'),
        },
        {
          id: 'message-4',
          role: 'assistant',
          content: { content: 'I found one match.' },
          createdAt: new Date('2026-04-24T12:00:03Z'),
        },
      ]),
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
        type: 'tool-call',
        toolCallId: 'call-files',
        toolName: 'filesystem.search_files',
        args: { path: '.', pattern: '*.ts' },
        argsText: '{"path":".","pattern":"*.ts"}',
        result: { matches: ['src/a.ts'] },
        isError: false,
      },
      { type: 'text', text: 'I found one match.' },
    ]);
  });

  it('hydrates mixed content arrays and system messages while skipping malformed parts', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listMessages: vi.fn(async () => [
        {
          id: 'message-system',
          role: 'system',
          content: { text: 'System guard' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-user',
          role: 'user',
          content: ['Use', { content: 'nested text' }],
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
        {
          id: 'message-assistant',
          role: 'assistant',
          content: {
            parts: [
              null,
              ['bad'],
              { type: 'unknown', text: 'ignored' },
              { type: 'text', text: '  ' },
              { type: 'text', text: 'Visible answer' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:02Z'),
        },
      ]),
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
      [{ type: 'text', text: 'System guard' }],
      [{ type: 'text', text: 'Use\nnested text' }],
      [{ type: 'text', text: 'Visible answer' }],
    ]);
  });

  it('hydrates legacy tool-result output and error snapshots', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listMessages: vi.fn(async () => [
        {
          id: 'message-1',
          role: 'assistant',
          content: {
            parts: [
              { type: 'tool-call', toolCallId: 'call-output', toolName: 'workspace.read' },
              { type: 'tool-call', toolCallId: 'call-error', toolName: 'workspace.write' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-2',
          role: 'tool',
          content: { toolCallId: 'call-output', output: { ok: true } },
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
        {
          id: 'message-3',
          role: 'tool',
          content: { toolCallId: 'call-error', error: 'denied' },
          createdAt: new Date('2026-04-24T12:00:02Z'),
        },
      ]),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.messages[0]?.message.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-output',
        toolName: 'workspace.read',
        args: {},
        argsText: '{}',
        result: { ok: true },
      },
      {
        type: 'tool-call',
        toolCallId: 'call-error',
        toolName: 'workspace.write',
        args: {},
        argsText: '{}',
        result: 'denied',
        isError: true,
      },
    ]);
  });

  it('drops malformed tool calls and empty system messages from hydrated history', async () => {
    const repository: AssistantThreadRepository = {
      appendThreadRunEvent: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listThreadRunEvents: vi.fn(async () => []),
      listMessages: vi.fn(async () => [
        {
          id: 'message-empty-system',
          role: 'system',
          content: { text: '   ' },
          createdAt: new Date('2026-04-24T12:00:00Z'),
        },
        {
          id: 'message-empty-assistant',
          role: 'assistant',
          content: {
            parts: [
              { type: 'tool-call', toolCallId: '', toolName: 'workspace.read' },
              { type: 'tool-call', toolCallId: 'call-missing-name', toolName: '' },
            ],
          },
          createdAt: new Date('2026-04-24T12:00:01Z'),
        },
        {
          id: 'message-user',
          role: 'user',
          content: { content: 'still visible' },
          createdAt: new Date('2026-04-24T12:00:02Z'),
        },
      ]),
    };
    const adapter = createAssistantThreadHistoryAdapter({
      repository,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const history = await adapter.load();

    expect(history.headId).toBe('message-user');
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.message.content).toEqual([{ type: 'text', text: 'still visible' }]);
  });

  describe('reasoning hydration', () => {
    function makeRepository(
      content: unknown
    ): Parameters<typeof createAssistantThreadHistoryAdapter>[0]['repository'] {
      return {
        appendThreadRunEvent: vi.fn(),
        createThread: vi.fn(),
        createThreadRun: vi.fn(),
        getThreadCumulativeUsage: vi.fn(async () => null),
        getCrossRootUsage: vi.fn(async () => []),
        recordRunUsage: vi.fn(),
        deleteThread: vi.fn(),
        listThreads: vi.fn(),
        listLatestThreadRuns: vi.fn(),
        renameThread: vi.fn(),
        completeThreadRun: vi.fn(),
        updateThreadMetadata: vi.fn(),
        listThreadRunEvents: vi.fn(async () => []),
        listMessages: vi.fn(async () => [
          {
            id: 'message-1',
            role: 'user',
            content: { content: 'Think first.' },
            createdAt: new Date('2026-04-22T10:00:00Z'),
          },
          {
            id: 'message-2',
            role: 'assistant',
            content,
            createdAt: new Date('2026-04-22T10:00:01Z'),
          },
        ]),
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
        { type: 'reasoning', text: 'because X' },
        { type: 'text', text: 'the answer is 42' },
      ]);
      const adapter = createAssistantThreadHistoryAdapter({
        repository,
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      });

      const history = await adapter.load();
      const assistant = history.messages.find((item) => item.message.id === 'message-2');

      expect(getReasoningTexts(history)).toEqual(['because X']);
      expect(assistant?.message.content).toContainEqual({ type: 'reasoning', text: 'because X' });
      expect(assistant?.message.content).toContainEqual({ type: 'text', text: 'the answer is 42' });
    });

    it('reconstructs a reasoning part using the reasoning field as fallback when text is absent', async () => {
      const repository = makeRepository([
        { type: 'reasoning', reasoning: 'alt thinking' },
        { type: 'text', text: 'done' },
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
        { type: 'reasoning', text: '   ' },
        { type: 'text', text: 'still here' },
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
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      getThreadCumulativeUsage: vi.fn(async () => null),
      getCrossRootUsage: vi.fn(async () => []),
      recordRunUsage: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      listThreadRunEvents: vi.fn(async () => args.runEvents ?? []),
      listLatestThreadRuns: vi.fn(),
      renameThread: vi.fn(),
      completeThreadRun: vi.fn(),
      updateThreadMetadata: vi.fn(),
      listMessages: vi.fn(async () => args.messages),
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
      type: 'tool-invocation',
      toolInvocation: {
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        args: args.input ?? {},
        state: args.state ?? 'result',
        ...(args.result === undefined ? {} : { result: args.result }),
        ...(args.errorText === undefined ? {} : { errorText: args.errorText }),
      },
      providerMetadata: { openai: { itemId: 'fc_test' } },
    };
  }

  const OM_STATUS_PART = {
    type: 'data-om-status',
    data: { stepNumber: 1, recordId: 'om-record-1' },
    createdAt: 1_781_183_967_655,
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
          id: 'message-user',
          role: 'user',
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'weather in Paris?' }],
            content: 'weather in Paris?',
          },
          createdAt: new Date('2026-06-11T13:18:10Z'),
        },
        {
          id: 'message-assistant',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              OM_STATUS_PART,
              // OpenAI encrypted reasoning persists as an empty-reasoning part.
              { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: '' }] },
              makeToolInvocationPart({
                toolCallId: 'call-1',
                toolName: 'get_weather',
                input: { city: 'Paris' },
                result: { city: 'Paris', temperatureC: 21 },
              }),
              { type: 'step-start' },
              { type: 'text', text: 'It is 21C in Paris.' },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
      ],
    });

    const assistant = history.messages.find((item) => item.message.id === 'message-assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.message.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'get_weather',
      args: { city: 'Paris' },
      argsText: '{"city":"Paris"}',
      result: { city: 'Paris', temperatureC: 21 },
    });
    expect(assistant?.message.content).toContainEqual({
      type: 'text',
      text: 'It is 21C in Paris.',
    });
    // Bookkeeping parts and empty reasoning never become visible content.
    const types = assistant?.message.content.map((part) => part.type);
    expect(types).not.toContain('reasoning');
    expect(types).toEqual(['tool-call', 'text']);
  });

  it('marks output-error invocations as failed tool calls with the error text as result', async () => {
    const history = await loadHistory({
      messages: [
        {
          id: 'message-assistant',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                toolCallId: 'call-err',
                toolName: 'get_weather',
                input: { city: 'Atlantis' },
                state: 'output-error',
                errorText: 'city not found',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
      ],
    });

    expect(history.messages[0]?.message.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'call-err',
      toolName: 'get_weather',
      args: { city: 'Atlantis' },
      argsText: '{"city":"Atlantis"}',
      result: 'city not found',
      isError: true,
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
          id: 'snapshot-1',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              OM_STATUS_PART,
              makeToolInvocationPart({
                toolCallId: 'call-a',
                toolName: 'grep_search',
                input: { pattern: 'foo' },
                state: 'call',
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
        {
          id: 'snapshot-2',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                toolCallId: 'call-a',
                toolName: 'grep_search',
                input: { pattern: 'foo' },
                result: { matches: 3 },
              }),
              makeToolInvocationPart({
                toolCallId: 'call-b',
                toolName: 'read_file',
                input: { path: 'a.ts' },
                result: { ok: true },
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:29Z'),
        },
        {
          id: 'tail',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                toolCallId: 'call-a',
                toolName: 'grep_search',
                input: { pattern: 'foo' },
                result: { matches: 3 },
              }),
              makeToolInvocationPart({
                toolCallId: 'call-b',
                toolName: 'read_file',
                input: { path: 'a.ts' },
                result: { ok: true },
              }),
              { type: 'text', text: 'Found 3 matches.' },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:40Z'),
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
      expect.objectContaining({ toolCallId: 'call-a', result: { matches: 3 } })
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
      runId: 'run-1',
      kind: 'run.step.finished',
      status: 'completed',
      label,
      sequence: Number.parseInt(id.split('-')[1] ?? '0', 10),
      timestamp,
    });
    const history = await loadHistory({
      runEvents: [
        makeEvent('event-1', '2026-06-11T13:18:12.000Z', 'run started'),
        makeEvent('event-2', '2026-06-11T13:18:20.000Z', 'step 1 completed'),
        makeEvent('event-3', '2026-06-11T13:18:45.000Z', 'run completed'),
      ],
      messages: [
        {
          id: 'message-user',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'go' }], content: 'go' },
          createdAt: new Date('2026-06-11T13:18:10Z'),
        },
        {
          id: 'snapshot-1',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                ...makeToolInvocationPart({
                  toolCallId: 'call-1',
                  toolName: 'grep_search',
                  input: { pattern: 'x' },
                  result: { matches: 1 },
                }),
                createdAt: Date.parse('2026-06-11T13:18:15.000Z'),
              },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
        {
          id: 'tail',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: 'Done.',
                createdAt: Date.parse('2026-06-11T13:18:40.000Z'),
              },
            ],
          },
          createdAt: new Date('2026-06-11T13:18:41Z'),
        },
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
      runId: 'run-1',
      kind,
      status: kind === 'tool.started' ? 'running' : 'completed',
      label: toolCallId,
      sequence,
      timestamp,
      metadata: { toolCallId },
    });
    const history = await loadHistory({
      runEvents: [
        makeToolEvent('event-1', 'tool.started', '2026-06-11T13:18:12.000Z', 'call-early', 1),
        makeToolEvent('event-2', 'tool.completed', '2026-06-11T13:18:13.000Z', 'call-early', 2),
        makeToolEvent('event-3', 'tool.started', '2026-06-11T13:18:30.000Z', 'call-late', 3),
        makeToolEvent('event-4', 'tool.completed', '2026-06-11T13:18:31.000Z', 'call-late', 4),
      ],
      messages: [
        {
          id: 'snapshot-1',
          role: 'assistant',
          // BOTH calls persisted (untimed) in one snapshot row saved at
          // 13:18:35 — without event re-timing they would clump together
          // after every event.
          content: {
            format: 2,
            parts: [
              makeToolInvocationPart({
                toolCallId: 'call-early',
                toolName: 'grep_search',
                input: { pattern: 'a' },
                result: { matches: 1 },
              }),
              makeToolInvocationPart({
                toolCallId: 'call-late',
                toolName: 'read_file',
                input: { path: 'b.ts' },
                result: { ok: true },
              }),
            ],
          },
          createdAt: new Date('2026-06-11T13:18:35Z'),
        },
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
      runId: 'run-latest',
      kind: sequence === 1 ? 'memory.history.loaded' : 'run.finished',
      status: 'completed',
      label: sequence === 1 ? 'Loaded conversation history' : 'Assistant run completed',
      sequence,
      timestamp,
    });
    const history = await loadHistory({
      runEvents: [
        // Emitted after user-2 sent but before assistant-2 was first saved.
        makeEvent('event-early', '2026-06-11T13:20:12.000Z', 1),
        makeEvent('event-finished', '2026-06-11T13:20:20.000Z', 2),
      ],
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'first' }], content: 'first' },
          createdAt: new Date('2026-06-11T13:18:10Z'),
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: { format: 2, parts: [{ type: 'text', text: 'first answer' }] },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
        {
          id: 'user-2',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'second' }], content: 'second' },
          createdAt: new Date('2026-06-11T13:20:10Z'),
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: { format: 2, parts: [{ type: 'text', text: 'second answer' }] },
          createdAt: new Date('2026-06-11T13:20:16Z'),
        },
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
      runId: 'run-1',
      kind: 'tool.completed',
      status: 'completed',
      label: 'grep_search completed',
      sequence: 0,
      timestamp: '2026-06-11T13:18:20.000Z',
    };
    const history = await loadHistory({
      runEvents: [runEvent],
      messages: [
        {
          id: 'message-user',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'hi' }], content: 'hi' },
          createdAt: new Date('2026-06-11T13:18:10Z'),
        },
        {
          id: 'message-assistant-empty',
          role: 'assistant',
          content: { format: 2, parts: [OM_STATUS_PART] },
          createdAt: new Date('2026-06-11T13:18:16Z'),
        },
      ],
    });

    const assistant = history.messages.find(
      (item) => item.message.id === 'message-assistant-empty'
    );
    expect(assistant).toBeDefined();
    expect(assistant?.message.content).toEqual([
      { type: 'data', name: 'brainstrike.run-event', data: runEvent },
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
              id: 'thread-valid',
              resourceId: '/tmp/workspace-a',
              title: 'Valid curated thread',
              metadata: JSON.stringify({
                icon: 'bug',
                color: 'rose',
                provider: 'openai',
                model: 'gpt-5.2',
              }),
              createdAt: new Date('2026-04-22T09:00:00Z'),
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
            {
              id: 'thread-invalid',
              resourceId: '/tmp/workspace-a',
              title: 'Invalid curated thread',
              metadata: JSON.stringify({
                icon: 'raw-html',
                color: '#ff00ff',
                provider: 'anthropic',
              }),
              createdAt: new Date('2026-04-22T08:00:00Z'),
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
      icon: 'bug',
      color: 'rose',
      provider: 'openai',
      model: 'gpt-5.2',
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
        icon: 'raw-html',
        color: 'rose',
      } as never)
    ).rejects.toThrow('Invalid assistant thread metadata icon.');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('bootstraps the Brainstrike-owned assistant run table before writes', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.createThreadRun({
      id: 'run-1',
      resourceId: '/tmp/workspace-a',
      threadId: 'thread-1',
      provider: 'openai',
      model: 'gpt-5.2',
      runtimeKind: 'hosted',
      modelSettings: { maxOutputTokens: 512 },
      providerOptions: { openai: { reasoningEffort: 'high' } },
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
      threadId: 'thread-1',
      runId: 'run-1',
      resourceId: '/tmp/workspace-a',
      rootId: 'root-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 120,
      outputTokens: 45,
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
      threadId: 'thread-1',
      runId: 'run-1',
      resourceId: '/tmp/workspace-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 5,
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
        threadId: 'thread-1',
        runId: 'run-1',
        resourceId: '/tmp/workspace-a',
        model: 'gpt-5.2',
        provider: 'openai',
        inputTokens: -1,
        outputTokens: 0,
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
      sequence: 7,
      status: 'completed',
      timestamp: '2026-04-24T12:00:00.000Z',
      metadata: {
        threadId: 'thread-1',
        apiKey: 'secret-key',
        'api-key': 'hyphenated-secret',
        result: { content: 'full tool output' },
      },
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
              id: 'event-1',
              run_id: 'run-1',
              sequence: 1,
              kind: 'run.started',
              status: 'running',
              label: 'Assistant run started',
              detail: null,
              duration_ms: null,
              metadata: JSON.stringify({ model: 'gpt-5.2' }),
              occurred_at: '2026-04-24T12:00:00.000Z',
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

  it('completes assistant run records without mutating thread metadata', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.completeThreadRun('run-1', {
      status: 'failed',
      error: 'model unavailable',
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
              id: 'thread-1',
              resourceId: '/tmp/workspace-a',
              title: 'Persistence bug',
              createdAt: new Date('2026-04-22T09:00:00Z'),
              updatedAt: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
        return {
          rows: [
            {
              id: 'run-2',
              resource_id: '/tmp/workspace-a',
              thread_id: 'thread-1',
              provider: 'anthropic',
              model: 'claude-sonnet-4-6',
              model_settings: JSON.stringify({ maxOutputTokens: 2048 }),
              provider_options: null,
              runtime_kind: 'hosted',
              status: 'completed',
              error: null,
              started_at: new Date('2026-04-22T10:30:00Z'),
              completed_at: new Date('2026-04-22T10:31:00Z'),
              created_at: new Date('2026-04-22T10:30:00Z'),
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
      id: 'run-2',
      resourceId: '/tmp/workspace-a',
      threadId: 'thread-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelSettings: { maxOutputTokens: 2048 },
      runtimeKind: 'hosted',
      status: 'completed',
      error: null,
      startedAt: new Date('2026-04-22T10:30:00Z'),
      completedAt: new Date('2026-04-22T10:31:00Z'),
      createdAt: new Date('2026-04-22T10:30:00Z'),
      updatedAt: new Date('2026-04-22T10:31:00Z'),
    });
  });

  it('rejects corrupt message timestamps instead of substituting the current time', async () => {
    const db = createMockDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'message-1',
          role: 'user',
          content: { content: 'Hello' },
          createdAt: 'not-a-date',
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
          id: 'message-80',
          role: 'user',
          content: { content: 'Latest window' },
          createdAt: '2026-04-24T12:00:00.000Z',
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
        resourceId: '/tmp/workspace-a',
        threadId: 'thread-1',
        provider: 'openai',
        model: 'gpt-5.2',
        runtimeKind: 'hosted',
      })
    ).rejects.toThrow('temporary bootstrap failure');

    await expect(
      repository.createThreadRun({
        id: 'run-2',
        resourceId: '/tmp/workspace-a',
        threadId: 'thread-1',
        provider: 'openai',
        model: 'gpt-5.2',
        runtimeKind: 'hosted',
      })
    ).resolves.toMatchObject({
      id: 'run-2',
      threadId: 'thread-1',
      resourceId: '/tmp/workspace-a',
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
      resourceId: '/tmp/workspace-a',
      threadId: 'thread-1',
      provider: 'openai',
      model: 'gpt-5.2',
      runtimeKind: 'hosted',
    });
    await repositoryB.createThreadRun({
      id: 'run-2',
      resourceId: '/tmp/workspace-a',
      threadId: 'thread-2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      runtimeKind: 'hosted',
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

  it('persists curated metadata updates in real PGlite thread rows', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-thread-curated-metadata');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await repository.updateThreadMetadata(thread.id, {
      icon: 'bug',
      color: 'rose',
    });

    const threads = await repository.listThreads('workspace-a');

    expect(threads[0]?.metadata).toEqual({
      icon: 'bug',
      color: 'rose',
      source: 'brainstrike',
    });
  });

  it('records run usage and aggregates cumulative tokens per model in real PGlite', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-run-usage-cumulative');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    // Same thread, three runs across TWO models — cost must be attributable
    // per model, so the read API returns per-model subtotals.
    await repository.recordRunUsage({
      threadId: 'thread-cost',
      runId: 'run-1',
      resourceId: 'workspace-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 200,
    });
    await repository.recordRunUsage({
      threadId: 'thread-cost',
      runId: 'run-2',
      resourceId: 'workspace-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 500,
      outputTokens: 100,
    });
    await repository.recordRunUsage({
      threadId: 'thread-cost',
      runId: 'run-3',
      resourceId: 'workspace-a',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 300,
    });
    // A different thread must not bleed into the aggregate.
    await repository.recordRunUsage({
      threadId: 'other-thread',
      runId: 'run-x',
      resourceId: 'workspace-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 9999,
      outputTokens: 9999,
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
      provider: 'openai',
      model: 'gpt-5.2',
      inputTokens: 1500,
      outputTokens: 300,
    });
    expect(byModel.get('anthropic:claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 2000,
      outputTokens: 300,
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
      threadId: 'thread-1',
      runId: 'run-1',
      resourceId: 'workspace-a',
      rootId: 'root-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 200,
    });
    await repository.recordRunUsage({
      threadId: 'thread-2',
      runId: 'run-2',
      resourceId: 'workspace-a',
      rootId: 'root-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 500,
      outputTokens: 100,
    });
    await repository.recordRunUsage({
      threadId: 'thread-1',
      runId: 'run-3',
      resourceId: 'workspace-a',
      rootId: 'root-b',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 300,
    });
    // No focused root → unattributed bucket (null root_id), honest not fake.
    await repository.recordRunUsage({
      threadId: 'thread-3',
      runId: 'run-4',
      resourceId: 'workspace-a',
      rootId: null,
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 50,
      outputTokens: 10,
    });
    // A different workspace must not contribute to workspace-a's aggregate.
    await repository.recordRunUsage({
      threadId: 'thread-x',
      runId: 'run-x',
      resourceId: 'workspace-b',
      rootId: 'root-a',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 9999,
      outputTokens: 9999,
    });

    const rows = await repository.getCrossRootUsage('workspace-a');

    // NULLS FIRST, then by root id / provider / model — deterministic ordering.
    // root-a resolves its display name; root-b (no roots row) and the null
    // bucket carry a null name — never a fabricated one.
    expect(rows).toEqual([
      {
        rootId: null,
        rootDisplayName: null,
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 50,
        outputTokens: 10,
      },
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 1500,
        outputTokens: 300,
      },
      {
        rootId: 'root-b',
        rootDisplayName: null,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 2000,
        outputTokens: 300,
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
