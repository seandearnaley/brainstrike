import type { IDatabase } from '@brainstrike/db';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProviderModelKey, startEmbeddingWorker } from '../index';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';

class FakeEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: 768,
      embedding: new Array(768).fill(0.1),
      model: 'fake-model',
      usage: { totalTokens: 10 },
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.generateEmbedding(t)));
  }
  async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      startIndex: number;
      endIndex: number;
      results: EmbeddingResult[];
    }) => Promise<void> | void
  ): Promise<void> {
    const results = await this.generateEmbeddings(texts);
    await onBatch({ endIndex: results.length, results, startIndex: 0 });
  }
  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }
  getStatus(): EmbeddingStatus {
    return this.status;
  }
  getConfig(): EmbeddingConfig {
    return { modelId: 'fake-model' };
  }
  async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}

function vectorString(dim: number, entries: [number, number][]): string {
  const values = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    values[idx] = value;
  }
  return `[${values.join(',')}]`;
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('embedding-worker', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker');
    await migrate(db);
  });

  it('processes an embed_chunk job and writes embedding', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-1';

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        embeddingSetId,
        'local::jinaai/jina-embeddings-v2-base-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        now,
      ]
    );

    // Insert a file record + chunk
    const fileId = 'file-1';
    const chunkId = 'chunk-1';
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'f.ts', '/f.ts', 100, 'hello world', 'hash1', 10, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'hello world', 'hash1', now]
    );
    // Enqueue job with embeddingSetId
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-1','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 768,
          modelKey: 'local::jinaai/jina-embeddings-v2-base-code',
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: (m) => console.error(m),
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new FakeEmbeddingService(),
    });

    // Wait for terminal state (succeeded/failed)
    let finalState = '';
    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-1'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      finalState = String(row?.['state'] ?? '');
      return finalState === 'succeeded' || finalState === 'failed';
    }, 10_000);
    expect(finalState).toBe('succeeded');

    const row = await db.query(
      'SELECT embedding, embedding_set_id, embedding_hash FROM file_chunks WHERE id = $1',
      [chunkId]
    );
    const rowData = row.rows[0] as
      | { embedding: string | null; embedding_set_id: string | null; embedding_hash: string | null }
      | undefined;
    expect(rowData?.embedding_set_id).toBeTruthy();
    expect(rowData?.embedding_hash).toBeTruthy();
    // Embedding is stored as TEXT in test path
    expect(typeof rowData?.embedding === 'string' || rowData?.embedding === null).toBe(true);

    await controller.stop();
  });

  it('writes embeddings to vector columns even when pg_extension detection is unavailable', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-hidden-vector-extension';
    const fileId = 'file-hidden-vector-extension';
    const chunkId = 'chunk-hidden-vector-extension';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        fileId,
        'hidden-vector.ts',
        '/hidden-vector.ts',
        100,
        'hello vector',
        'hidden-vector-hash',
        10,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'hello vector', 'hidden-vector-hash', now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-hidden-vector-extension','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
        }),
        now,
      ]
    );

    const dbWithUnavailableExtensionProbe: IDatabase = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        if (
          /FROM\s+information_schema\.columns/i.test(sql) &&
          /column_name\s*=\s*'embedding'/i.test(sql)
        ) {
          return {
            rows: [{ data_type: 'USER-DEFINED', udt_name: 'vector' }] as T[],
          };
        }
        if (/FROM\s+pg_extension/i.test(sql)) {
          return { rows: [] as T[] };
        }
        return await db.query<T>(sql, params);
      },
    };

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: dbWithUnavailableExtensionProbe,
      leaseMs: 2000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
    });

    let finalState = '';
    await waitFor(async () => {
      const res = await db.query(
        `SELECT state FROM job_queue WHERE id = 'job-hidden-vector-extension'`
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      finalState = String(row?.['state'] ?? '');
      return finalState === 'succeeded' || finalState === 'failed';
    }, 10_000);

    await controller.stop();

    expect(finalState).toBe('succeeded');
    const row = await db.query<{ embedding: string | null }>(
      'SELECT embedding::text AS embedding FROM file_chunks WHERE id = $1',
      [chunkId]
    );
    expect(row.rows[0]?.embedding).toMatch(/^\[/);
  });

  it('writes embeddings to vector columns when schema probes are unavailable', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-unavailable-vector-probes';
    const fileId = 'file-unavailable-vector-probes';
    const chunkId = 'chunk-unavailable-vector-probes';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        fileId,
        'unavailable-vector-probes.ts',
        '/unavailable-vector-probes.ts',
        100,
        'hello vector without probes',
        'unavailable-vector-probes-hash',
        10,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,10,'text',10,$5,$5)`,
      [chunkId, fileId, 'hello vector without probes', 'unavailable-vector-probes-hash', now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-unavailable-vector-probes','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
        }),
        now,
      ]
    );

    const dbWithUnavailableSchemaProbes: IDatabase = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        if (
          /FROM\s+information_schema\.columns/i.test(sql) &&
          /column_name\s*=\s*'embedding'/i.test(sql)
        ) {
          return { rows: [] as T[] };
        }
        if (/FROM\s+pg_extension/i.test(sql)) {
          return { rows: [] as T[] };
        }
        return await db.query<T>(sql, params);
      },
    };

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: dbWithUnavailableSchemaProbes,
      leaseMs: 2000,
      log: () => {},
      modelKey,
      service: new FakeEmbeddingService(),
    });

    let finalState = '';
    await waitFor(async () => {
      const res = await db.query(
        `SELECT state FROM job_queue WHERE id = 'job-unavailable-vector-probes'`
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      finalState = String(row?.['state'] ?? '');
      return finalState === 'succeeded' || finalState === 'failed';
    }, 10_000);

    await controller.stop();

    expect(finalState).toBe('succeeded');
    const row = await db.query<{ embedding: string | null }>(
      'SELECT embedding::text AS embedding FROM file_chunks WHERE id = $1',
      [chunkId]
    );
    expect(row.rows[0]?.embedding).toMatch(/^\[/);
  });

  it('is idempotent when embedding_hash matches (no write)', async () => {
    const now = new Date().toISOString();
    const embeddingSetId = 'set-2';
    const fileId = 'file-2';
    const chunkId = 'chunk-2';
    const modelKey = 'jinaai/jina-embeddings-v2-base-code';
    const compositeKey = formatProviderModelKey('local', modelKey);
    const expectedHash = await (await import('node:crypto'))
      .createHash('sha256')
      .update(`hash2:${compositeKey}`)
      .digest('hex');

    // Create embedding set first (required for jobs)
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, compositeKey, modelKey, 768, 'cosine', now]
    );

    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [fileId, 'g.ts', '/g.ts', 120, 'hello moon', 'hash2', 12, now]
    );
    // Pre-set matching hash and a dummy embedding string to verify it remains unchanged
    const dummyEmbedding = vectorString(768, [
      [0, 0.1],
      [1, 0.2],
      [2, 0.3],
    ]);
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding, embedding_hash, created_at, updated_at)
      VALUES ($1,$2,0,$3,$4,12,'text',10,$5,$6,$7,$7)`,
      [chunkId, fileId, 'hello moon', 'hash2', dummyEmbedding, expectedHash, now]
    );

    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
      VALUES ('job-2','embeddings','embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId,
          embeddingSetId,
          expectedDimension: 768,
          modelKey: compositeKey,
        }),
        now,
      ]
    );

    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 2000,
      log: (m) => console.error(m),
      modelKey,
      service: new FakeEmbeddingService(),
    });

    let finalState2 = '';
    await waitFor(async () => {
      const res = await db.query(`SELECT state FROM job_queue WHERE id = 'job-2'`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      finalState2 = String(row?.['state'] ?? '');
      return finalState2 === 'succeeded' || finalState2 === 'failed';
    }, 10_000);
    expect(finalState2).toBe('succeeded');

    const row = await db.query('SELECT embedding, embedding_hash FROM file_chunks WHERE id = $1', [
      chunkId,
    ]);
    const rowData = row.rows[0] as
      | { embedding: string | null; embedding_hash: string | null }
      | undefined;
    expect(rowData?.embedding).toBe(dummyEmbedding);
    expect(rowData?.embedding_hash).toBe(expectedHash);

    await controller.stop();
  });
});
// Increase timeouts to reduce flakiness under workspace-wide runs
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
