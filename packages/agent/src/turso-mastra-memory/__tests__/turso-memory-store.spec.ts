import type { MastraDBMessage } from '@mastra/core/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TursoMemoryStore } from '../memory-store';
import { MASTRA_MEMORY_TABLES } from '../sql';
import { createTursoTestClient, type TursoTestClient } from './turso-test-client';

function textMessage(
  id: string,
  threadId: string,
  resourceId: string,
  createdAt: string
): MastraDBMessage {
  return {
    id,
    role: id.endsWith('-assistant') ? 'assistant' : 'user',
    type: 'text',
    threadId,
    resourceId,
    createdAt: new Date(createdAt),
    content: { content: id },
  };
}

describe('TursoMemoryStore', () => {
  let runtime: TursoTestClient;
  let store: TursoMemoryStore;

  beforeEach(async () => {
    runtime = await createTursoTestClient('brainstrike-turso-memory-');
    store = new TursoMemoryStore({ database: runtime.client });
    await store.initialize();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('creates SQLite Mastra memory tables idempotently', async () => {
    await store.initialize();

    const result = await runtime.client.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mastra_%' ORDER BY name"
    );
    const configColumn = await runtime.client.query<{ type: string }>(
      `SELECT type
       FROM pragma_table_info(?)
       WHERE name = ?`,
      [MASTRA_MEMORY_TABLES.observationalMemory, 'config']
    );

    expect(result.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        MASTRA_MEMORY_TABLES.messages,
        MASTRA_MEMORY_TABLES.observationalMemory,
        MASTRA_MEMORY_TABLES.resources,
        MASTRA_MEMORY_TABLES.threads,
      ])
    );
    expect(configColumn.rows[0]?.type).toBe('TEXT');
  });

  it('persists resources, threads, and message history through Turso SQL', async () => {
    await store.saveResource({
      resource: {
        id: 'workspace-a',
        workingMemory: 'Deploy window is Friday.',
        metadata: { workspaceRootPath: '/repo/a' },
        createdAt: new Date('2026-04-22T09:00:00Z'),
        updatedAt: new Date('2026-04-22T09:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        metadata: { workspaceRootPath: '/repo/a' },
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', 'thread-1', 'workspace-a', '2026-04-22T10:00:01Z'),
        textMessage('message-2-assistant', 'thread-1', 'workspace-a', '2026-04-22T10:00:02Z'),
      ],
    });

    const byThread = await store.listMessages({
      threadId: 'thread-1',
      resourceId: 'workspace-a',
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    const byId = await store.listMessagesById({ messageIds: ['message-2-assistant'] });
    const threads = await store.listThreads({
      filter: { resourceId: 'workspace-a', metadata: { workspaceRootPath: '/repo/a' } },
      perPage: false,
    });
    const resource = await store.getResourceById({ resourceId: 'workspace-a' });

    expect(byThread.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2-assistant',
    ]);
    expect(byId.messages.map((message) => message.id)).toEqual(['message-2-assistant']);
    expect(threads.threads.map((thread) => thread.id)).toEqual(['thread-1']);
    expect(resource?.workingMemory).toBe('Deploy window is Friday.');
    expect(runtime.queries.join('\n')).not.toMatch(/\$1|::|ANY\(|@>|JSONB|TIMESTAMPTZ/);
  });

  it('persists default non-vector observational memory records', async () => {
    await store.saveResource({
      resource: {
        id: 'workspace-a',
        createdAt: new Date('2026-04-22T09:00:00Z'),
        updatedAt: new Date('2026-04-22T09:00:00Z'),
      },
    });
    await store.saveThread({
      thread: {
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Memory thread',
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });
    const record = await store.initializeObservationalMemory({
      config: { observation: { messageTokens: 30_000 } },
      resourceId: 'workspace-a',
      scope: 'thread',
      threadId: 'thread-1',
    });

    await store.updateActiveObservations({
      id: record.id,
      lastObservedAt: new Date('2026-04-22T10:01:00Z'),
      observedMessageIds: ['message-1'],
      observations: 'Deploy window is Friday.',
      tokenCount: 12,
    });
    await store.setReflectingFlag(record.id, true);
    await store.setReflectingFlag(record.id, false);

    const active = await store.getObservationalMemory('thread-1', 'workspace-a');
    const history = await store.getObservationalMemoryHistory('thread-1', 'workspace-a', 10);

    expect(active).toMatchObject({
      activeObservations: 'Deploy window is Friday.',
      isReflecting: false,
      observationTokenCount: 12,
      observedMessageIds: ['message-1'],
    });
    expect(history.map((entry) => entry.id)).toEqual([record.id]);
  });
});
