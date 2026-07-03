import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../src/architecture/brainstrike-db-client-contract.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

function createSqlTrackingClient(delegate: TursoOwnerClient): {
  client: BrainstrikeDbExecutionClient;
  statements: string[];
} {
  const statements: string[] = [];

  const trackTransactionClient = (
    tx: BrainstrikeDbTransactionClient
  ): BrainstrikeDbTransactionClient => ({
    exec: async (sql, params, options) => {
      statements.push(sql);
      return tx.exec(sql, params, options);
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      options?: BrainstrikeDbWorkOptions
    ) => {
      statements.push(sql);
      return tx.query<TRecord>(sql, params, options);
    },
  });

  return {
    client: {
      exec: async (sql, params, options) => {
        statements.push(sql);
        return delegate.exec(sql, params, options);
      },
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[],
        options?: BrainstrikeDbWorkOptions
      ) => {
        statements.push(sql);
        return delegate.query<TRecord>(sql, params, options);
      },
      transaction: async (callback, options) =>
        delegate.transaction((tx) => callback(trackTransactionClient(tx)), options),
    },
    statements,
  };
}

function createMissingModelsTableClient(delegate: TursoOwnerClient): BrainstrikeDbExecutionClient {
  return {
    exec: (sql, params, options) => delegate.exec(sql, params, options),
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      options?: BrainstrikeDbWorkOptions
    ) => {
      if (/\bFROM\s+models\b/i.test(sql)) {
        const error = new Error('SQLITE_ERROR: no such table: models');
        Object.assign(error, { code: 'SQLITE_ERROR' });
        throw error;
      }
      return delegate.query<TRecord>(sql, params, options);
    },
    transaction: (callback, options) => delegate.transaction(callback, options),
  };
}

function findPostgresOnlySql(statements: readonly string[]): string[] {
  return statements.filter(
    (statement) =>
      /\$[1-9]\d*/.test(statement) ||
      /::[a-z_]/i.test(statement) ||
      /\bANY\s*\(/i.test(statement) ||
      /\bUNNEST\s*\(/i.test(statement) ||
      /\bFILTER\s*\(/i.test(statement)
  );
}

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
        null,
        'chunk-4',
        'file-2',
        1,
        'untokenized',
        null,
        null,
        null,
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

  it('keeps metadata create, update, and read queries in SQLite dialect for Turso', async () => {
    const tracked = createSqlTrackingClient(client);
    const trackedRepository = new TursoEmbeddingSetsRepository(tracked.client);

    const created = await trackedRepository.getOrCreateSet(
      'text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine'
    );

    await expect(
      trackedRepository.updateMetadata(created.id, { name: 'Updated Name' })
    ).resolves.toMatchObject({ name: 'Updated Name' });

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

    await expect(trackedRepository.getById('legacy-set')).resolves.toMatchObject({
      id: 'legacy-set',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      modelId: 'Xenova/all-MiniLM-L6-v2',
    });

    expect(findPostgresOnlySql(tracked.statements)).toEqual([]);
  });

  it('treats SQLite missing models table errors like the existing metadata fallback', async () => {
    const missingModelsRepository = new TursoEmbeddingSetsRepository(
      createMissingModelsTableClient(client)
    );

    await expect(
      missingModelsRepository.getOrCreateSet(
        'unregistered-model-key',
        'unregistered-model-id',
        32,
        'cosine'
      )
    ).resolves.toMatchObject({
      modelKey: 'unregistered-model-key',
      modelId: 'unregistered-model-id',
    });
  });

  it('deletes chunks associated with the set while clearing file record embedding metadata', async () => {
    const created = await repository.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine'
    );
    await client.query(
      `INSERT INTO file_records (
         id,
         name,
         path,
         size,
         embedding_set_id,
         chunks_processed_at,
         chunks_count,
         chunking_strategy
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['file-1', 'file.md', '/file.md', 12, created.id, '2026-06-29T18:00:00.000Z', 2, 'sentence']
    );
    await client.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding_set_id)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      ['chunk-1', 'file-1', 0, 'hello', created.id, 'chunk-2', 'file-1', 1, 'inherited', null]
    );
    await client.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, embedding_set_id)
       VALUES (?, ?, ?, ?, ?)`,
      ['job-1', 'embedding', 'embed_chunk', '{}', created.id]
    );
    const transaction = vi.spyOn(client, 'transaction');

    await expect(repository.delete(created.id)).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(1);
    await expect(
      client.query<{ id: string }>(
        'SELECT id FROM file_chunks WHERE file_record_id = ? ORDER BY id',
        ['file-1']
      )
    ).resolves.toEqual({ rows: [] });
    await expect(
      client.query<{
        chunking_strategy: string | null;
        chunks_count: number | null;
        chunks_processed_at: string | null;
        embedding_set_id: string | null;
        id: string;
      }>(
        `SELECT id, embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
           FROM file_records
          WHERE id = ?`,
        ['file-1']
      )
    ).resolves.toEqual({
      rows: [
        {
          chunking_strategy: null,
          chunks_count: null,
          chunks_processed_at: null,
          embedding_set_id: null,
          id: 'file-1',
        },
      ],
    });
    await expect(
      client.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM file_records WHERE embedding_set_id = ?',
        [created.id]
      )
    ).resolves.toEqual({ rows: [{ count: 0 }] });
    await expect(
      client.query<{ id: string }>('SELECT id FROM job_queue WHERE id = ?', ['job-1'])
    ).resolves.toEqual({ rows: [] });
    await expect(
      client.query<{ embedding_set_id: string }>(
        'SELECT embedding_set_id FROM collection_indexing_stats WHERE embedding_set_id = ?',
        [created.id]
      )
    ).resolves.toEqual({ rows: [] });
  });
});
