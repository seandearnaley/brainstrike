import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgliteVectorStore } from '../vector-store';

describe('PgliteVectorStore', () => {
  let db: PGlite;
  let store: PgliteVectorStore;

  beforeEach(async () => {
    db = await PGlite.create({ extensions: { vector } });
    store = new PgliteVectorStore({ database: db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and describes pgvector-backed Mastra indexes', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });

    await expect(
      store.createIndex({ indexName: 'memory_messages', dimension: 4, metric: 'cosine' })
    ).rejects.toThrow(/dimensions/i);

    await expect(store.listIndexes()).resolves.toEqual(['memory_messages']);
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 0,
      dimension: 3,
      metric: 'cosine',
    });
  });

  it('upserts, filters, queries, updates, and deletes vectors', async () => {
    await store.createIndex({ indexName: 'memory_messages', dimension: 3, metric: 'cosine' });
    const ids = await store.upsert({
      indexName: 'memory_messages',
      ids: ['message-a', 'message-b', 'message-c'],
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
      ],
      metadata: [
        { message_id: 'message-a', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-b', resource_id: 'workspace-a', thread_id: 'thread-1' },
        { message_id: 'message-c', resource_id: 'workspace-b', thread_id: 'thread-2' },
      ],
    });

    expect(ids).toEqual(['message-a', 'message-b', 'message-c']);

    const workspaceResults = await store.query({
      indexName: 'memory_messages',
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { resource_id: 'workspace-a' },
      includeVector: true,
    });

    expect(workspaceResults.map((result) => result.id)).toEqual(['message-a', 'message-b']);
    expect(workspaceResults[0]?.score).toBeGreaterThan(workspaceResults[1]?.score ?? 0);
    expect(workspaceResults[0]?.vector).toEqual([1, 0, 0]);

    await store.updateVector({
      indexName: 'memory_messages',
      id: 'message-c',
      update: {
        metadata: { resource_id: 'workspace-a', thread_id: 'thread-2', message_id: 'message-c' },
      },
    });

    const metadataOnly = await store.query({
      indexName: 'memory_messages',
      topK: 10,
      filter: { resource_id: 'workspace-a' },
    });
    expect(metadataOnly.map((result) => result.id).sort()).toEqual([
      'message-a',
      'message-b',
      'message-c',
    ]);

    await store.deleteVectors({
      indexName: 'memory_messages',
      filter: { thread_id: 'thread-1' },
    });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 1,
    });

    await store.deleteVector({ indexName: 'memory_messages', id: 'message-c' });
    await expect(store.describeIndex({ indexName: 'memory_messages' })).resolves.toMatchObject({
      count: 0,
    });
  });
});
