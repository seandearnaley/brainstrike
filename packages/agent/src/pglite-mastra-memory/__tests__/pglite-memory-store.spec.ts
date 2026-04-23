import { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
