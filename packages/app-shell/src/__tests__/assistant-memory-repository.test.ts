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
    const toolAssistant = history.messages.find((item) => item.message.id === 'message-2');

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

  it('flushes supported PGlite handles after thread mutations', async () => {
    const syncToFs = vi.fn(async () => undefined);
    const db = {
      ...createMockDb(),
      syncToFs,
    };
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.createThread('workspace-a');
    await repository.renameThread('thread-1', 'Renamed thread');
    await repository.updateThreadMetadata('thread-1', {
      icon: 'bug',
      color: 'rose',
    });
    await repository.deleteThread('thread-1');

    expect(syncToFs).toHaveBeenCalledTimes(4);
  });

  it('propagates PGlite flush failures after metadata writes', async () => {
    const syncError = new Error('sync failed');
    const db = {
      ...createMockDb(),
      syncToFs: vi.fn(async () => {
        throw syncError;
      }),
    };
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        icon: 'bug',
      })
    ).rejects.toThrow(syncError);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
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
