import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoEmbeddingSetsRepository', () => {
  let client: TursoOwnerClient;
  let repository: TursoEmbeddingSetsRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-embedding-sets-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    repository = new TursoEmbeddingSetsRepository(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('creates duplicate-capable user sets and seeds indexing stats rows', async () => {
    const first = await repository.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      { name: 'Semantic Search', tags: 'search,openai' }
    );
    const second = await repository.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine'
    );

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      modelKey: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      name: 'Semantic Search',
      tags: 'search,openai',
    });
    expect(second.name).toBe('text-embedding-3-small (1536D)');

    await expect(
      client.query<{
        chunk_count: number;
        dirty: number;
        embedded_chunk_count: number;
        file_count: number;
        pending_chunk_count: number;
      }>(
        `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
           FROM collection_indexing_stats
          WHERE embedding_set_id IN (?, ?)
          ORDER BY embedding_set_id`,
        [first.id, second.id]
      )
    ).resolves.toEqual({
      rows: [
        {
          chunk_count: 0,
          dirty: 0,
          embedded_chunk_count: 0,
          file_count: 0,
          pending_chunk_count: 0,
        },
        {
          chunk_count: 0,
          dirty: 0,
          embedded_chunk_count: 0,
          file_count: 0,
          pending_chunk_count: 0,
        },
      ],
    });
  });

  it('creates exactly one protected workspace index set', async () => {
    const first = await repository.getOrCreateWorkspaceIndexSet();
    const second = await repository.getOrCreateWorkspaceIndexSet();

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      name: 'Workspace Index',
      description: 'System-managed workspace index for assistant retrieval.',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      distance: 'cosine',
      systemRole: 'workspace-index',
    });

    await expect(
      client.query<{ embedding_set_id: string }>(
        'SELECT embedding_set_id FROM collection_indexing_stats WHERE embedding_set_id = ?',
        [first.id]
      )
    ).resolves.toEqual({ rows: [{ embedding_set_id: first.id }] });
  });

  it('lists embedding spaces with SQLite-compatible live stats', async () => {
    const embeddingSet = await repository.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      { name: 'Workspace Index' }
    );
    await client.exec(
      `INSERT INTO file_records (id, name, path, size, token_count, embedding_set_id)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      [
        'file-1',
        'one.ts',
        '/src/one.ts',
        100,
        11,
        embeddingSet.id,
        'file-2',
        'two.ts',
        '/src/two.ts',
        200,
        17,
        embeddingSet.id,
      ]
    );
    await client.exec(
      `INSERT INTO file_chunks (
        id,
        file_record_id,
        chunk_index,
        content,
        token_count,
        embedding,
        embedding_set_id
      )
      VALUES
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?)`,
      [
        'chunk-1',
        'file-1',
        0,
        'one',
        5,
        new Uint8Array([1, 2, 3]),
        embeddingSet.id,
        'chunk-2',
        'file-1',
        1,
        'two',
        7,
        null,
        embeddingSet.id,
        'chunk-3',
        'file-2',
        0,
        'three',
        13,
        new Uint8Array([3, 2, 1]),
        embeddingSet.id,
        'chunk-4',
        'file-2',
        1,
        'untokenized',
        null,
        null,
        embeddingSet.id,
      ]
    );

    const spaces = await repository.listEmbeddingSpaces({ includeStats: true });

    expect(spaces).toEqual([
      expect.objectContaining({
        id: embeddingSet.id,
        modelKey: 'openai::text-embedding-3-small',
        modelId: 'text-embedding-3-small',
        dimensions: 1536,
        stats: expect.objectContaining({
          averageTokensPerChunk: 25 / 3,
          embeddedChunks: 2,
          fileCount: 2,
          tokenizedChunkCount: 3,
          totalChunks: 4,
          totalTokens: 25,
        }),
      }),
    ]);
  });

  it('updates, finds, repairs, and deletes embedding sets', async () => {
    const created = await repository.getOrCreateSet(
      'voyage:voyage-3-lite',
      'voyage-3-lite',
      512,
      'l2'
    );

    await expect(repository.getById(created.id)).resolves.toMatchObject({
      id: created.id,
      modelKey: 'voyage::voyage-3-lite',
    });
    await expect(repository.getByModelKey('voyage:voyage-3-lite')).resolves.toHaveLength(1);
    await expect(
      repository.updateMetadata(created.id, {
        category: 'general-text',
        description: 'Updated description',
        name: 'Updated Name',
      })
    ).resolves.toMatchObject({
      category: 'general-text',
      description: 'Updated description',
      name: 'Updated Name',
    });

    await client.exec(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'legacy-set',
        'Xenova/all-MiniLM-L6-v2',
        'all-MiniLM-L6-v2',
        384,
        'cosine',
        '2026-06-23T08:00:00.000Z',
      ]
    );

    await expect(repository.getById('legacy-set')).resolves.toMatchObject({
      id: 'legacy-set',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      modelId: 'Xenova/all-MiniLM-L6-v2',
    });

    await expect(repository.delete(created.id)).resolves.toBe(true);
    await expect(repository.getById(created.id)).resolves.toBeNull();
  });

  it('deletes chunks associated with the set while leaving file records', async () => {
    const created = await repository.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine'
    );
    await client.query(
      `INSERT INTO file_records (id, name, path, size, embedding_set_id)
       VALUES (?, ?, ?, ?, ?)`,
      ['file-1', 'file.md', '/file.md', 12, created.id]
    );
    await client.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding_set_id)
       VALUES (?, ?, ?, ?, ?)`,
      ['chunk-1', 'file-1', 0, 'hello', created.id]
    );
    const transaction = vi.spyOn(client, 'transaction');

    await expect(repository.delete(created.id)).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(1);
    await expect(
      client.query<{ id: string }>('SELECT id FROM file_chunks WHERE id = ?', ['chunk-1'])
    ).resolves.toEqual({ rows: [] });
    await expect(
      client.query<{ id: string }>('SELECT id FROM file_records WHERE id = ?', ['file-1'])
    ).resolves.toEqual({ rows: [{ id: 'file-1' }] });
  });
});
