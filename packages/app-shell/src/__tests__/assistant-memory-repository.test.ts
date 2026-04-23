import type { DbHandle } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '../assistant-memory-repository';

describe('createAssistantThreadHistoryAdapter', () => {
  it('hydrates assistant-ui history from Mastra memory messages', async () => {
    const repository: AssistantThreadRepository = {
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
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

    expect(repository.listMessages).toHaveBeenCalledWith('thread-1', 'workspace-a');
    expect(history.headId).toBe('message-2');
    expect(history.messages.map((item) => item.parentId)).toEqual([null, 'message-1']);
    expect(history.messages.map((item) => item.message.id)).toEqual(['message-1', 'message-2']);
    expect(history.messages[0]?.message.content).toEqual([
      { type: 'text', text: 'Remember the deploy window is Friday.' },
    ]);
  });

  it('does not write client-side history because Mastra is the durable writer', async () => {
    const repository: AssistantThreadRepository = {
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
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
});

describe('createPgliteAssistantThreadRepository thread runs', () => {
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
              model: 'claude-sonnet-4-5',
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
      model: 'claude-sonnet-4-5',
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

  it('deletes thread-owned rows in a transaction including observational memory', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.deleteThread('thread-1');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_observational_memory'),
      ['thread-1', 'thread:thread-1']
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM mastra_messages'), [
      'thread-1',
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM mastra_threads'), [
      'thread-1',
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
      model: 'claude-sonnet-4-5',
      runtimeKind: 'hosted',
    });

    expect(db.exec).toHaveBeenCalledTimes(1);
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
