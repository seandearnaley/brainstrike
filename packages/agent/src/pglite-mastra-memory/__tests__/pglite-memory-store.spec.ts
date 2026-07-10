import { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteMemoryStore } from '../memory-store';

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function textMessage(
  id: string,
  threadId: string,
  resourceId: string,
  createdAt: string
): MastraDBMessage {
  return {
    content: { content: id },
    createdAt: new Date(createdAt),
    id,
    resourceId,
    role: id.endsWith('-assistant') ? 'assistant' : 'user',
    threadId,
    type: 'text',
  };
}

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

    const configColumn = await db.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_name = 'mastra_observational_memory'
         AND column_name = 'config'`
    );
    expect(configColumn.rows[0]?.data_type).toBe('jsonb');
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
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-older',
        metadata: { workspaceRootPath: '/repo/a' },
        resourceId: 'workspace-a',
        title: 'Older thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    const secondThread = await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T11:00:00Z'),
        id: 'thread-newer',
        resourceId: 'workspace-a',
        title: 'Newer thread',
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T12:00:00Z'),
        id: 'thread-other-workspace',
        resourceId: 'workspace-b',
        title: 'Other workspace',
        updatedAt: new Date('2026-04-22T12:00:00Z'),
      },
    });

    expect(firstThread.metadata).toEqual({ workspaceRootPath: '/repo/a' });

    const listed = await store.listThreads({
      filter: { resourceId: 'workspace-a' },
      orderBy: { direction: 'DESC', field: 'updatedAt' },
      perPage: false,
    });
    const emptyResourceListed = await store.listThreads({
      filter: { resourceId: '' },
      perPage: false,
    });

    expect(listed.threads.map((thread) => thread.id)).toEqual([secondThread.id, firstThread.id]);
    expect(listed.total).toBe(2);
    expect(listed.hasMore).toBe(false);
    expect(emptyResourceListed.threads).toEqual([]);
    expect(emptyResourceListed.total).toBe(0);
  });

  it('honors resourceId when loading a thread by id', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-resource-scoped',
        resourceId: 'workspace-a',
        title: 'Workspace A thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    await expect(
      store.getThreadById({ resourceId: 'workspace-a', threadId: 'thread-resource-scoped' })
    ).resolves.toMatchObject({
      id: 'thread-resource-scoped',
      resourceId: 'workspace-a',
    });
    await expect(
      store.getThreadById({ resourceId: 'workspace-b', threadId: 'thread-resource-scoped' })
    ).resolves.toBeNull();
    await expect(
      store.getThreadById({ resourceId: '', threadId: 'thread-resource-scoped' })
    ).resolves.toBeNull();
  });

  it('lets an automated title name a still-unnamed thread', async () => {
    // Mastra auto-creates threads with an empty title — fair game for the
    // observer's auto-title.
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-placeholder-empty',
        resourceId: 'workspace-a',
        title: '',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-placeholder-empty',
      metadata: {},
      title: 'Paris Weather Chat',
    });

    expect(updated.title).toBe('Paris Weather Chat');
    // The write stamps the OM marker so a later topic-change re-title stays
    // eligible (see the next test).
    expect(updated.metadata).toMatchObject({ titleSource: 'om' });
  });

  it('lets an automated title rename a thread whose title carries the OM marker', async () => {
    // A title the observer itself set earlier (or a seeded placeholder
    // stamped with the marker) is still system content, not user-chosen, so
    // a later topic-change re-title from the observer may replace it.
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-om-named',
        metadata: { titleSource: 'om' },
        resourceId: 'workspace-a',
        title: 'Paris Weather Chat',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-om-named',
      metadata: { note: 'topic shifted' },
      title: 'Lyon Restaurant Picks',
    });

    expect(updated.title).toBe('Lyon Restaurant Picks');
    expect(updated.metadata).toMatchObject({ note: 'topic shifted', titleSource: 'om' });
  });

  it('never lets an automated title overwrite an established (user-owned) title', async () => {
    // A real, non-empty title with no OM marker is user-owned — whether it
    // arrived through a manual rename (a dedicated raw-SQL path) or was
    // otherwise set directly — and a later observer-driven updateThread with
    // a DIFFERENT title must not clobber it.
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-user-named',
        resourceId: 'workspace-a',
        title: 'My Paris Trip',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-user-named',
      metadata: { note: 'observer metadata still lands' },
      title: 'Weather In France',
    });

    expect(updated.title).toBe('My Paris Trip');
    expect(updated.metadata).toMatchObject({ note: 'observer metadata still lands' });
    expect(updated.metadata).not.toHaveProperty('titleSource');
  });

  it('lets an automated title rename a legacy default-titled thread with no OM marker', async () => {
    // Threads seeded before the OM marker existed carry the literal
    // DEFAULT_THREAD_TITLE ('New Thread') with no titleSource metadata at
    // all. Without this legacy allowance, canOverwriteThreadTitle would
    // treat that placeholder as user-owned forever and these pre-existing
    // threads would never receive an automatic title.
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-legacy-default-title',
        metadata: { source: 'brainstrike' },
        resourceId: 'workspace-a',
        title: 'New Thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-legacy-default-title',
      metadata: {},
      title: 'Paris Weather Chat',
    });

    expect(updated.title).toBe('Paris Weather Chat');
    // The real Mastra caller merges the thread's existing metadata into this
    // write (see the comment on `canOverwriteThreadTitle`); this raw
    // updateThread call only asserts the marker this adapter itself stamps.
    expect(updated.metadata).toMatchObject({ titleSource: 'om' });
  });

  it('still protects a custom title that happens to have no OM marker', async () => {
    // A user-chosen title with no marker (the normal case for a manual
    // rename) must stay protected — only the literal DEFAULT_THREAD_TITLE
    // gets the legacy allowance above.
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-custom-no-marker',
        resourceId: 'workspace-a',
        title: 'My Custom Title',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-custom-no-marker',
      metadata: {},
      title: 'Auto Generated Title',
    });

    expect(updated.title).toBe('My Custom Title');
    expect(updated.metadata).not.toHaveProperty('titleSource');
  });

  it('lands metadata-only observer persists (title unchanged) without touching the title', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-metadata-only',
        resourceId: 'workspace-a',
        title: 'My Paris Trip',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const updated = await store.updateThread({
      id: 'thread-metadata-only',
      metadata: { currentTask: 'booking a hotel' },
      title: 'My Paris Trip',
    });

    expect(updated.title).toBe('My Paris Trip');
    expect(updated.metadata).toMatchObject({ currentTask: 'booking a hotel' });
    expect(updated.metadata).not.toHaveProperty('titleSource');
  });

  it('persists messages and supports thread/resource recall queries', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const messages: MastraDBMessage[] = [
      {
        content: { content: 'Remember that the deploy window is Friday.' },
        createdAt: new Date('2026-04-22T10:00:01Z'),
        id: 'message-1',
        resourceId: 'workspace-a',
        role: 'user',
        threadId: 'thread-1',
        type: 'text',
      },
      {
        content: { content: 'I will remember that.' },
        createdAt: new Date('2026-04-22T10:00:02Z'),
        id: 'message-2',
        resourceId: 'workspace-a',
        role: 'assistant',
        threadId: 'thread-1',
        type: 'text',
      },
    ];

    await store.saveMessages({ messages });

    const byThread = await store.listMessages({
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: false,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });
    const byResource = await store.listMessagesByResourceId({
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: false,
      resourceId: 'workspace-a',
    });
    const byEmptyResource = await store.listMessages({
      perPage: false,
      resourceId: '',
      threadId: 'thread-1',
    });
    const byId = await store.listMessagesById({ messageIds: ['message-2'] });

    expect(byThread.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(byResource.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(byEmptyResource.messages).toEqual([]);
    expect(byEmptyResource.total).toBe(0);
    expect(byId.messages.map((message) => message.id)).toEqual(['message-2']);
  });

  it('expands included thread messages with semantic recall context windows', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('message-3', 'thread-1', 'workspace-a', '2026-04-22T10:00:03Z'),
        textMessage('message-4', 'thread-1', 'workspace-a', '2026-04-22T10:00:04Z'),
        textMessage('message-5', 'thread-1', 'workspace-a', '2026-04-22T10:00:05Z'),
      ],
    });

    const result = await store.listMessages({
      include: [{ id: 'message-4', withNextMessages: 1, withPreviousMessages: 2 }],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    expect(result.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it('expands resource-level included messages using the include thread id', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'First thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T11:00:00Z'),
        id: 'thread-2',
        resourceId: 'workspace-a',
        title: 'Second thread',
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('thread-1-message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('thread-1-message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('thread-2-message-1', 'thread-2', 'workspace-a', '2026-04-22T11:00:01Z'),
        textMessage('thread-2-message-2', 'thread-2', 'workspace-a', '2026-04-22T11:00:02Z'),
        textMessage('thread-2-message-3', 'thread-2', 'workspace-a', '2026-04-22T11:00:03Z'),
      ],
    });

    const result = await store.listMessagesByResourceId({
      include: [
        {
          id: 'thread-2-message-2',
          threadId: 'thread-2',
          withNextMessages: 1,
          withPreviousMessages: 1,
        },
      ],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
    });

    expect(result.messages.map((message) => message.id)).toEqual([
      'thread-1-message-1',
      'thread-2-message-1',
      'thread-2-message-2',
      'thread-2-message-3',
    ]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
  });

  it('does not return included messages outside the requested thread or resource scope', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Scoped thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T11:00:00Z'),
        id: 'thread-foreign',
        resourceId: 'workspace-b',
        title: 'Foreign thread',
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('thread-1-message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('thread-1-message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('foreign-message-1', 'thread-foreign', 'workspace-b', '2026-04-22T11:00:01Z'),
        textMessage('foreign-message-2', 'thread-foreign', 'workspace-b', '2026-04-22T11:00:02Z'),
        textMessage('foreign-message-3', 'thread-foreign', 'workspace-b', '2026-04-22T11:00:03Z'),
      ],
    });

    const result = await store.listMessages({
      include: [
        {
          id: 'foreign-message-2',
          withNextMessages: 1,
          withPreviousMessages: 1,
        },
      ],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    expect(result.messages.map((message) => message.id)).toEqual(['thread-1-message-1']);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it('uses bounded adjacent-message queries for include windows', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('message-3', 'thread-1', 'workspace-a', '2026-04-22T10:00:03Z'),
        textMessage('message-4', 'thread-1', 'workspace-a', '2026-04-22T10:00:04Z'),
        textMessage('message-5', 'thread-1', 'workspace-a', '2026-04-22T10:00:05Z'),
      ],
    });
    const querySpy = vi.spyOn(db, 'query');

    const result = await store.listMessages({
      include: [{ id: 'message-3', withNextMessages: 1, withPreviousMessages: 1 }],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const sqlStatements = querySpy.mock.calls.map(([sql]) => String(sql));
    expect(result.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(sqlStatements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ORDER BY "createdAt" DESC, id DESC\s+LIMIT/),
        expect.stringMatching(/ORDER BY "createdAt" ASC, id ASC\s+LIMIT/),
      ])
    );
    expect(sqlStatements).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/WHERE thread_id = \$1\s+ORDER BY "createdAt" ASC, id ASC\s*$/),
      ])
    );
  });

  it('keeps hasMore tied to the date-filtered base page when include windows cross the date range', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('message-3', 'thread-1', 'workspace-a', '2026-04-22T10:00:03Z'),
        textMessage('message-4', 'thread-1', 'workspace-a', '2026-04-22T10:00:04Z'),
        textMessage('message-5', 'thread-1', 'workspace-a', '2026-04-22T10:00:05Z'),
      ],
    });

    const result = await store.listMessages({
      filter: {
        dateRange: { start: new Date('2026-04-22T10:00:04Z') },
      },
      include: [{ id: 'message-2', withNextMessages: 1, withPreviousMessages: 1 }],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    expect(result.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it('does not append adjacent include-window messages outside the requested resource scope', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('message-2', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
        textMessage('message-3', 'thread-1', 'workspace-b', '2026-04-22T10:00:03Z'),
      ],
    });

    const result = await store.listMessagesByResourceId({
      include: [{ id: 'message-2', withNextMessages: 1 }],
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: 1,
      resourceId: 'workspace-a',
    });

    expect(result.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('emits compact run events from real history and working-memory hooks', async () => {
    const events: string[] = [];
    const observedStore = new PgliteMemoryStore({
      database: db,
      eventSink: (event) => {
        events.push(`${event.kind}:${event.label}:${event.runId}`);
      },
      runId: 'run-1',
    });
    await observedStore.initialize();
    await observedStore.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await observedStore.saveMessages({
      messages: [
        {
          content: { content: 'Remember the deploy window.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
          id: 'message-1',
          resourceId: 'workspace-a',
          role: 'user',
          threadId: 'thread-1',
          type: 'text',
        },
      ],
    });

    await observedStore.listMessages({ perPage: false, threadId: 'thread-1' });
    await observedStore.updateResource({
      resourceId: 'workspace-a',
      workingMemory: 'Deploy window is Friday.',
    });

    expect(events).toEqual(
      expect.arrayContaining([
        'memory.history.loaded:Conversation history loaded:run-1',
        'memory.working.loaded:Working memory loaded:run-1',
        'memory.working.updated:Working memory updated:run-1',
      ])
    );
  });

  it('does not fail memory operations when run-event emission fails', async () => {
    const observedStore = new PgliteMemoryStore({
      database: db,
      eventSink: () => {
        throw new Error('run event sink unavailable');
      },
      runId: 'run-1',
    });
    await observedStore.initialize();
    await observedStore.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    await expect(
      observedStore.listMessages({ perPage: false, threadId: 'thread-1' })
    ).resolves.toMatchObject({
      messages: [],
    });
  });

  it('does not await slow run-event emission on memory read paths', async () => {
    const releaseSink = createDeferred<void>();
    const observedStore = new PgliteMemoryStore({
      database: db,
      eventSink: () => releaseSink.promise,
      runId: 'run-1',
    });
    await observedStore.initialize();
    await observedStore.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    await expect(
      observedStore.listMessages({ perPage: false, threadId: 'thread-1' })
    ).resolves.toMatchObject({
      messages: [],
    });
    releaseSink.resolve();
  });

  it('updates messages in one batched read-write cycle', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        {
          content: {
            content: 'Remember the Friday deploy window.',
            metadata: { provider: 'openai' },
          },
          createdAt: new Date('2026-04-22T10:00:01Z'),
          id: 'message-1',
          resourceId: 'workspace-a',
          role: 'user',
          threadId: 'thread-1',
          type: 'text',
        },
        {
          content: {
            content: 'I will remember that.',
            metadata: { model: 'gpt-5.2' },
          },
          createdAt: new Date('2026-04-22T10:00:02Z'),
          id: 'message-2',
          resourceId: 'workspace-a',
          role: 'assistant',
          threadId: 'thread-1',
          type: 'text',
        },
      ],
    });

    const querySpy = vi.spyOn(db, 'query');

    const updated = await store.updateMessages({
      messages: [
        {
          content: {
            metadata: { provider: 'anthropic' },
          },
          id: 'message-1',
        },
        {
          content: {
            content: 'Deploy window stored.',
          },
          id: 'message-2',
          role: 'tool',
        },
      ],
    });

    expect(updated).toHaveLength(2);
    expect(updated[0]?.content).toEqual({
      content: 'Remember the Friday deploy window.',
      metadata: { provider: 'anthropic' },
    });
    expect(updated[1]).toMatchObject({
      content: {
        content: 'Deploy window stored.',
        metadata: { model: 'gpt-5.2' },
      },
      id: 'message-2',
      role: 'tool',
    });
    expect(querySpy).toHaveBeenCalledTimes(4);
  });

  it('persists workspace-scoped working memory resources', async () => {
    const saved = await store.saveResource({
      resource: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'workspace-a',
        metadata: { workspaceRootPath: '/repo/a' },
        updatedAt: new Date('2026-04-22T10:00:00Z'),
        workingMemory: 'User prefers concise implementation notes.',
      },
    });

    expect(saved.workingMemory).toBe('User prefers concise implementation notes.');

    const updated = await store.updateResource({
      metadata: { source: 'thread', workspaceRootPath: '/repo/a' },
      resourceId: 'workspace-a',
      workingMemory: 'User prefers concise implementation notes and no fallbacks.',
    });
    const loaded = await store.getResourceById({ resourceId: 'workspace-a' });

    expect(updated.metadata).toEqual({ source: 'thread', workspaceRootPath: '/repo/a' });
    expect(loaded?.workingMemory).toBe(
      'User prefers concise implementation notes and no fallbacks.'
    );
  });

  it('persists observational memory records and history', async () => {
    const events: string[] = [];
    const observedStore = new PgliteMemoryStore({
      database: db,
      eventSink: (event) => {
        events.push(`${event.kind}:${event.status}:${event.label}`);
      },
      runId: 'run-1',
    });
    await observedStore.initialize();
    const created = await observedStore.initializeObservationalMemory({
      config: { observation: { messageTokens: 1000 } },
      observedTimezone: 'America/New_York',
      resourceId: 'workspace-a',
      scope: 'thread',
      threadId: 'thread-1',
    });

    await observedStore.updateActiveObservations({
      id: created.id,
      lastObservedAt: new Date('2026-04-22T10:00:00Z'),
      observations: '- User is wiring Mastra memory into Brainstrike.',
      observedMessageIds: ['message-1'],
      tokenCount: 12,
    });

    const active = await observedStore.getObservationalMemory('thread-1', 'workspace-a');
    const history = await observedStore.getObservationalMemoryHistory(
      'thread-1',
      'workspace-a',
      10
    );

    expect(active?.activeObservations).toContain('Mastra memory');
    expect(active?.observedMessageIds).toEqual(['message-1']);
    expect(active?.observedTimezone).toBe('America/New_York');
    expect(history.map((record) => record.id)).toEqual([created.id]);
    expect(events).toEqual(
      expect.arrayContaining([
        'memory.configured:completed:Observational memory configured',
        'memory.observation.completed:completed:Observations updated',
        'memory.observation.completed:completed:Observational memory read',
        'memory.observation.completed:completed:Observation history loaded',
      ])
    );
    expect(events).not.toEqual(
      expect.arrayContaining(['memory.observation.started:completed:Observational memory read'])
    );
  });

  it('emits inline detail strings on memory run events so the timeline shows real data', async () => {
    const events: Array<{ detail?: string; label: string }> = [];
    const observedStore = new PgliteMemoryStore({
      database: db,
      eventSink: (event) => {
        events.push({ label: event.label, ...(event.detail ? { detail: event.detail } : {}) });
      },
      runId: 'run-detail',
    });
    await observedStore.initialize();

    const created = await observedStore.initializeObservationalMemory({
      config: { observation: { messageTokens: 1000 } },
      resourceId: 'workspace-detail',
      scope: 'thread',
      threadId: 'thread-detail',
    });
    await observedStore.updateActiveObservations({
      id: created.id,
      lastObservedAt: new Date('2026-04-22T10:00:00Z'),
      observations: '- User asked about run-event details.',
      observedMessageIds: ['message-detail-1'],
      tokenCount: 7,
    });
    await observedStore.getObservationalMemory('thread-detail', 'workspace-detail');
    await observedStore.listMessages({ threadId: 'thread-detail' });
    await observedStore.getResourceById({ resourceId: 'workspace-detail' });

    const detailFor = (label: string): string | undefined =>
      events.find((event) => event.label === label)?.detail;

    expect(detailFor('Observational memory configured')).toBe('thread scope');
    expect(detailFor('Observational memory read')).toContain('observation tokens');
    expect(detailFor('Conversation history loaded')).toBe('0 messages');
    expect(detailFor('Working memory loaded')).toBe('empty');
  });

  it('deletes thread messages and observational memory atomically with the thread', async () => {
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-04-22T10:00:00Z'),
        id: 'thread-delete',
        resourceId: 'workspace-a',
        title: 'Delete me',
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        {
          content: { content: 'Delete this conversation.' },
          createdAt: new Date('2026-04-22T10:00:01Z'),
          id: 'message-delete',
          resourceId: 'workspace-a',
          role: 'user',
          threadId: 'thread-delete',
          type: 'text',
        } as MastraDBMessage,
      ],
    });
    const observation = await store.initializeObservationalMemory({
      config: {},
      resourceId: 'workspace-a',
      scope: 'thread',
      threadId: 'thread-delete',
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
      config: {},
      resourceId: 'workspace-a',
      scope: 'thread',
      threadId: 'thread-1',
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
      isBufferingObservation: true,
      isBufferingReflection: true,
      isObserving: false,
      isReflecting: true,
      lastBufferedAtTokens: 42,
      pendingMessageTokens: 77,
    });
  });

  it('activates buffered observational chunks and creates reflection generations', async () => {
    const created = await store.initializeObservationalMemory({
      config: {},
      resourceId: 'workspace-a',
      scope: 'thread',
      threadId: 'thread-1',
    });

    await store.updateBufferedObservations({
      chunk: {
        currentTask: 'Wire Mastra memory',
        cycleId: 'cycle-1',
        lastObservedAt: new Date('2026-04-22T10:00:02Z'),
        messageIds: ['message-1', 'message-2'],
        messageTokens: 200,
        observations: '- User chose a no-fallback memory architecture.',
        suggestedContinuation: 'Continue with the PGlite adapter.',
        tokenCount: 10,
      },
      id: created.id,
      lastBufferedAtTime: new Date('2026-04-22T10:00:04Z'),
    });

    const activation = await store.swapBufferedToActive({
      activationRatio: 0.8,
      currentPendingTokens: 240,
      id: created.id,
      messageTokensThreshold: 300,
    });
    const active = await store.getObservationalMemory('thread-1', 'workspace-a');

    expect(activation).toMatchObject({
      activatedMessageIds: ['message-1', 'message-2'],
      chunksActivated: 1,
      currentTask: 'Wire Mastra memory',
      messageTokensActivated: 200,
      observationTokensActivated: 10,
      suggestedContinuation: 'Continue with the PGlite adapter.',
    });
    expect(active?.bufferedObservationChunks).toBeUndefined();
    expect(active?.activeObservations).toContain('no-fallback');

    await store.updateBufferedReflection({
      id: created.id,
      inputTokenCount: 10,
      reflectedObservationLineCount: 1,
      reflection: '- The durable memory architecture is mandatory.',
      tokenCount: 8,
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
