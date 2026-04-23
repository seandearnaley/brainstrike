import { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteMemoryStore } from '../memory-store';

describe('PgliteMemoryStore', () => {
  let db: PGlite;
  let store: PgliteMemoryStore;

  beforeEach(async () => {
    db = new PGlite();
    store = new PgliteMemoryStore({ database: db });
    await store.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates Mastra memory tables idempotently', async () => {
    await store.initialize();

    const result = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'mastra_%' ORDER BY tablename"
    );

    expect(result.rows.map((row) => row.tablename)).toEqual(
      expect.arrayContaining([
        'mastra_messages',
        'mastra_observational_memory',
        'mastra_resources',
        'mastra_threads',
      ])
    );
  });

  it('retries schema initialization after a transient bootstrap failure', async () => {
    const database = {
      exec: vi
        .fn<(sql: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('temporary bootstrap failure'))
        .mockResolvedValue(undefined),
      query: vi.fn(),
    };
    const transientStore = new PgliteMemoryStore({ database });

    await expect(transientStore.initialize()).rejects.toThrow('temporary bootstrap failure');
    await expect(transientStore.initialize()).resolves.toBeUndefined();
    expect(database.exec).toHaveBeenCalledTimes(2);
  });

  it('persists and lists workspace-scoped threads by updated time', async () => {
    const firstThread = await store.saveThread({
      thread: {
        id: 'thread-older',
        resourceId: 'workspace-a',
        title: 'Older thread',
        metadata: { workspaceRootPath: '/repo/a' },
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    const secondThread = await store.saveThread({
      thread: {
        id: 'thread-newer',
        resourceId: 'workspace-a',
        title: 'Newer thread',
        createdAt: new Date('2026-04-22T11:00:00Z'),
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        id: 'thread-other-workspace',
        resourceId: 'workspace-b',
        title: 'Other workspace',
        createdAt: new Date('2026-04-22T12:00:00Z'),
        updatedAt: new Date('2026-04-22T12:00:00Z'),
      },
    });

    expect(firstThread.metadata).toEqual({ workspaceRootPath: '/repo/a' });

    const listed = await store.listThreads({
      filter: { resourceId: 'workspace-a' },
      orderBy: { field: 'updatedAt', direction: 'DESC' },
      perPage: false,
    });

    expect(listed.threads.map((thread) => thread.id)).toEqual([secondThread.id, firstThread.id]);
    expect(listed.total).toBe(2);
    expect(listed.hasMore).toBe(false);
  });

  it('persists messages and supports thread/resource recall queries', async () => {
    await store.saveThread({
      thread: {
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const messages: MastraDBMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        type: 'text',
        threadId: 'thread-1',
        resourceId: 'workspace-a',
        createdAt: new Date('2026-04-22T10:00:01Z'),
        content: { content: 'Remember that the deploy window is Friday.' },
      },
      {
        id: 'message-2',
        role: 'assistant',
        type: 'text',
        threadId: 'thread-1',
        resourceId: 'workspace-a',
        createdAt: new Date('2026-04-22T10:00:02Z'),
        content: { content: 'I will remember that.' },
      },
    ];

    await store.saveMessages({ messages });

    const byThread = await store.listMessages({
      threadId: 'thread-1',
      resourceId: 'workspace-a',
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    const byResource = await store.listMessagesByResourceId({
      resourceId: 'workspace-a',
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    const byId = await store.listMessagesById({ messageIds: ['message-2'] });

    expect(byThread.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(byResource.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(byId.messages.map((message) => message.id)).toEqual(['message-2']);
  });

  it('updates messages in one batched read-write cycle', async () => {
    await store.saveThread({
      thread: {
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          type: 'text',
          threadId: 'thread-1',
          resourceId: 'workspace-a',
          createdAt: new Date('2026-04-22T10:00:01Z'),
          content: {
            content: 'Remember the Friday deploy window.',
            metadata: { provider: 'openai' },
          },
        },
        {
          id: 'message-2',
          role: 'assistant',
          type: 'text',
          threadId: 'thread-1',
          resourceId: 'workspace-a',
          createdAt: new Date('2026-04-22T10:00:02Z'),
          content: {
            content: 'I will remember that.',
            metadata: { model: 'gpt-5.2' },
          },
        },
      ],
    });

    const querySpy = vi.spyOn(db, 'query');

    const updated = await store.updateMessages({
      messages: [
        {
          id: 'message-1',
          content: {
            metadata: { provider: 'anthropic' },
          },
        },
        {
          id: 'message-2',
          role: 'tool',
          content: {
            content: 'Deploy window stored.',
          },
        },
      ],
    });

    expect(updated).toHaveLength(2);
    expect(updated[0]?.content).toEqual({
      content: 'Remember the Friday deploy window.',
      metadata: { provider: 'anthropic' },
    });
    expect(updated[1]).toMatchObject({
      id: 'message-2',
      role: 'tool',
      content: {
        content: 'Deploy window stored.',
        metadata: { model: 'gpt-5.2' },
      },
    });
    expect(querySpy).toHaveBeenCalledTimes(4);
  });

  it('persists workspace-scoped working memory resources', async () => {
    const saved = await store.saveResource({
      resource: {
        id: 'workspace-a',
        workingMemory: 'User prefers concise implementation notes.',
        metadata: { workspaceRootPath: '/repo/a' },
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    expect(saved.workingMemory).toBe('User prefers concise implementation notes.');

    const updated = await store.updateResource({
      resourceId: 'workspace-a',
      workingMemory: 'User prefers concise implementation notes and no fallbacks.',
      metadata: { workspaceRootPath: '/repo/a', source: 'thread' },
    });
    const loaded = await store.getResourceById({ resourceId: 'workspace-a' });

    expect(updated.metadata).toEqual({ workspaceRootPath: '/repo/a', source: 'thread' });
    expect(loaded?.workingMemory).toBe(
      'User prefers concise implementation notes and no fallbacks.'
    );
  });

  it('persists observational memory records and history', async () => {
    const created = await store.initializeObservationalMemory({
      threadId: 'thread-1',
      resourceId: 'workspace-a',
      scope: 'thread',
      config: { observation: { messageTokens: 1000 } },
      observedTimezone: 'America/New_York',
    });

    await store.updateActiveObservations({
      id: created.id,
      observations: '- User is wiring Mastra memory into Brainstrike.',
      tokenCount: 12,
      lastObservedAt: new Date('2026-04-22T10:00:00Z'),
      observedMessageIds: ['message-1'],
    });

    const active = await store.getObservationalMemory('thread-1', 'workspace-a');
    const history = await store.getObservationalMemoryHistory('thread-1', 'workspace-a', 10);

    expect(active?.activeObservations).toContain('Mastra memory');
    expect(active?.observedMessageIds).toEqual(['message-1']);
    expect(active?.observedTimezone).toBe('America/New_York');
    expect(history.map((record) => record.id)).toEqual([created.id]);
  });

  it('deletes thread messages and observational memory atomically with the thread', async () => {
    await store.saveThread({
      thread: {
        id: 'thread-delete',
        resourceId: 'workspace-a',
        title: 'Delete me',
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        {
          id: 'message-delete',
          threadId: 'thread-delete',
          resourceId: 'workspace-a',
          role: 'user',
          type: 'text',
          content: { content: 'Delete this conversation.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
        } as MastraDBMessage,
      ],
    });
    const observation = await store.initializeObservationalMemory({
      threadId: 'thread-delete',
      resourceId: 'workspace-a',
      scope: 'thread',
      config: {},
    });

    await store.deleteThread({ threadId: 'thread-delete' });

    await expect(store.getThreadById({ threadId: 'thread-delete' })).resolves.toBeNull();
    await expect(store.listMessages({ threadId: 'thread-delete' })).resolves.toMatchObject({
      messages: [],
      total: 0,
    });
    const orphanedObservations = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM mastra_observational_memory WHERE id = $1',
      [observation.id]
    );
    expect(orphanedObservations.rows[0]?.count).toBe('0');
  });

  it('updates observational memory flags with targeted update statements', async () => {
    const created = await store.initializeObservationalMemory({
      threadId: 'thread-1',
      resourceId: 'workspace-a',
      scope: 'thread',
      config: {},
    });
    const querySpy = vi.spyOn(db, 'query');

    await store.setReflectingFlag(created.id, true);
    await store.setObservingFlag(created.id, false);
    await store.setBufferingObservationFlag(created.id, true, 42);
    await store.setBufferingReflectionFlag(created.id, true);
    await store.setPendingMessageTokens(created.id, 77);

    expect(querySpy).toHaveBeenCalledTimes(5);

    const updated = await store.getObservationalMemory('thread-1', 'workspace-a');

    expect(updated).toMatchObject({
      id: created.id,
      isReflecting: true,
      isObserving: false,
      isBufferingObservation: true,
      isBufferingReflection: true,
      lastBufferedAtTokens: 42,
      pendingMessageTokens: 77,
    });
  });

  it('activates buffered observational chunks and creates reflection generations', async () => {
    const created = await store.initializeObservationalMemory({
      threadId: 'thread-1',
      resourceId: 'workspace-a',
      scope: 'thread',
      config: {},
    });

    await store.updateBufferedObservations({
      id: created.id,
      lastBufferedAtTime: new Date('2026-04-22T10:00:04Z'),
      chunk: {
        cycleId: 'cycle-1',
        observations: '- User chose a no-fallback memory architecture.',
        tokenCount: 10,
        messageIds: ['message-1', 'message-2'],
        messageTokens: 200,
        lastObservedAt: new Date('2026-04-22T10:00:02Z'),
        suggestedContinuation: 'Continue with the PGlite adapter.',
        currentTask: 'Wire Mastra memory',
      },
    });

    const activation = await store.swapBufferedToActive({
      id: created.id,
      activationRatio: 0.8,
      messageTokensThreshold: 300,
      currentPendingTokens: 240,
    });
    const active = await store.getObservationalMemory('thread-1', 'workspace-a');

    expect(activation).toMatchObject({
      chunksActivated: 1,
      messageTokensActivated: 200,
      observationTokensActivated: 10,
      activatedMessageIds: ['message-1', 'message-2'],
      suggestedContinuation: 'Continue with the PGlite adapter.',
      currentTask: 'Wire Mastra memory',
    });
    expect(active?.bufferedObservationChunks).toBeUndefined();
    expect(active?.activeObservations).toContain('no-fallback');

    await store.updateBufferedReflection({
      id: created.id,
      reflection: '- The durable memory architecture is mandatory.',
      tokenCount: 8,
      inputTokenCount: 10,
      reflectedObservationLineCount: 1,
    });

    const reflection = await store.swapBufferedReflectionToActive({
      currentRecord: (await store.getObservationalMemory(
        'thread-1',
        'workspace-a'
      )) as ObservationalMemoryRecord,
      tokenCount: 8,
    });
    const history = await store.getObservationalMemoryHistory('thread-1', 'workspace-a', 10);

    expect(reflection.generationCount).toBe(1);
    expect(reflection.originType).toBe('reflection');
    expect(history.map((record) => record.generationCount)).toEqual([1, 0]);
  });
});
