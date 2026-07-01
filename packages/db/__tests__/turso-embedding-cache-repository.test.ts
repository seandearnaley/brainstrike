import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TursoEmbeddingCacheRepository } from '../src/repositories/turso-embedding-cache-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoEmbeddingCacheRepository', () => {
  let client: TursoOwnerClient;
  let repository: TursoEmbeddingCacheRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-embedding-cache-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    repository = new TursoEmbeddingCacheRepository(client, { maxEntries: 2 });
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('stores and reads embeddings as vector32 blobs through Turso SQL', async () => {
    await repository.set('content-a', 'local:test-model', [0.1, 0.2, 0.3], 3);

    const hit = await repository.get('content-a', 'local:test-model');
    const miss = await repository.get('missing', 'local:test-model');
    const storage = await client.query<{ byte_length: number; storage_type: string }>(
      'SELECT typeof(embedding) AS storage_type, length(embedding) AS byte_length FROM embedding_cache WHERE content_hash = ?',
      ['content-a']
    );

    expect(hit.hit).toBe(true);
    expect(miss.hit).toBe(false);
    expect(storage.rows[0]).toEqual({ byte_length: 12, storage_type: 'blob' });
    if (hit.hit) {
      expect(hit.entry).toMatchObject({
        contentHash: 'content-a',
        dimensions: 3,
        embedding: [0.1, 0.2, 0.3],
        modelKey: 'local:test-model',
      });
    }
  });

  it('supports batch reads, duplicate-key first-wins writes, stats, and eviction', async () => {
    await expect(
      repository.setBatch([
        {
          contentHash: 'content-a',
          dimensions: 3,
          embedding: [0.1, 0.2, 0.3],
          modelKey: 'local:test-model',
        },
        {
          contentHash: 'content-b',
          dimensions: 3,
          embedding: [0.4, 0.5, 0.6],
          modelKey: 'local:test-model',
        },
        {
          contentHash: 'content-a',
          dimensions: 3,
          embedding: [0.7, 0.8, 0.9],
          modelKey: 'local:test-model',
        },
        {
          contentHash: 'content-c',
          dimensions: 3,
          embedding: [1, 1.1, 1.2],
          modelKey: 'local:test-model',
        },
      ])
    ).resolves.toBe(3);

    const batch = await repository.getBatch([
      { contentHash: 'content-a', modelKey: 'local:test-model' },
      { contentHash: 'content-b', modelKey: 'local:test-model' },
      { contentHash: 'missing', modelKey: 'local:test-model' },
    ]);
    await repository.flushPendingAccessTimeUpdates();
    const stats = await repository.getStats();
    const eviction = await repository.evictIfNeeded({ targetUtilization: 0.5 });
    const finalStats = await repository.getStats();

    expect(batch.size).toBe(2);
    expect(batch.get('content-a:local:test-model')?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(stats).toMatchObject({
      totalEntries: 3,
      totalHits: 5,
    });
    expect(eviction).toEqual({ evicted: 2, needed: true, totalEntries: 3 });
    expect(finalStats.totalEntries).toBe(1);
  });

  it('rejects invalid dimensions, non-finite embeddings, and malformed stored blobs', async () => {
    await expect(repository.set('bad-dims', 'local:test-model', [0.1, 0.2], 3)).rejects.toThrow(
      'Embedding dimension mismatch for bad-dims: expected 3, got 2'
    );
    await expect(
      repository.set('bad-value', 'local:test-model', [0.1, Number.NaN], 2)
    ).rejects.toThrow('Embedding cache bad-value contains a non-finite value.');

    await client.exec(
      `INSERT INTO embedding_cache (
        id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        'cache-row-malformed',
        'malformed',
        'local:test-model',
        new Uint8Array([1, 2, 3]),
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );

    await expect(repository.get('malformed', 'local:test-model')).rejects.toThrow(
      'Invalid Turso embedding cache blob for malformed: byte length 3 is not divisible by 4.'
    );
  });
});
