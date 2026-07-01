import { createLogger, generateUUID } from '@brainstrike/utils';
import type { BrainstrikeDbExecutionClient } from '../architecture/brainstrike-db-client-contract.js';
import type { EmbeddingCacheEntry } from '../schema/index.js';
import type {
  BatchLookupRequest,
  BatchLookupResult,
  EmbeddingCacheLookupResult,
  EmbeddingCacheMetrics,
  EmbeddingCacheStats,
} from './drizzle/embedding-cache-repository.js';
import {
  MAX_BATCH_SIZE,
  RECOMMENDED_MAX_CACHE_ENTRIES,
} from './drizzle/embedding-cache-repository.js';

interface TursoEmbeddingCacheRow {
  readonly access_count: number | string;
  readonly accessed_at: string;
  readonly content_hash: string;
  readonly created_at: string;
  readonly dimensions: number | string;
  readonly embedding: ArrayBuffer | Uint8Array | string;
  readonly id: string;
  readonly model_key: string;
}

export interface CreateTursoEmbeddingCacheRepositoryOptions {
  readonly maxEntries?: number;
}

function assertDimensions(embedding: readonly number[], dimensions: number, label: string): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Embedding cache ${label} has invalid dimensions (${dimensions}).`);
  }
  if (embedding.length !== dimensions) {
    throw new Error(
      `Embedding dimension mismatch for ${label}: expected ${dimensions}, got ${embedding.length}`
    );
  }
}

function encodeVector32Blob(embedding: readonly number[], label: string): Uint8Array {
  const bytes = new Uint8Array(embedding.length * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding cache ${label} contains a non-finite value.`);
    }
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  return bytes;
}

function decodeVector32Blob(value: ArrayBuffer | Uint8Array | string, label: string): number[] {
  if (typeof value === 'string') {
    throw new Error(`Invalid Turso embedding cache blob for ${label}: expected BLOB, got TEXT.`);
  }

  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength === 0) {
    throw new Error(`Invalid Turso embedding cache blob for ${label}: empty payload.`);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(
      `Invalid Turso embedding cache blob for ${label}: byte length ${bytes.byteLength} is not divisible by 4.`
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const embedding: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const number = Number(view.getFloat32(offset, true).toPrecision(7));
    if (!Number.isFinite(number)) {
      throw new Error(`Invalid Turso embedding cache vector32 value for ${label}.`);
    }
    embedding.push(number);
  }
  return embedding;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Embedding cache ${label} has invalid date value: ${String(value)}.`);
  }
  return date;
}

function parseInteger(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Embedding cache ${label} is not a finite number.`);
  }
  return parsed;
}

function mapRow(row: TursoEmbeddingCacheRow): EmbeddingCacheEntry {
  const embedding = decodeVector32Blob(row.embedding, row.content_hash);
  const dimensions = parseInteger(row.dimensions, 'dimensions');
  assertDimensions(embedding, dimensions, row.content_hash);

  return {
    accessCount: parseInteger(row.access_count, 'access_count'),
    accessedAt: parseDate(row.accessed_at, 'accessed_at'),
    contentHash: row.content_hash,
    createdAt: parseDate(row.created_at, 'created_at'),
    dimensions,
    embedding,
    id: row.id,
    modelKey: row.model_key,
  };
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function chunkArray<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function dedupeByContentAndModel<T extends { contentHash: string; modelKey: string }>(
  entries: readonly T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const key = `${entry.contentHash}\u0000${entry.modelKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

const EMBEDDING_CACHE_SELECT_COLUMNS =
  'id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count';

export class TursoEmbeddingCacheRepository {
  private readonly logger = createLogger('TursoEmbeddingCacheRepository');
  private readonly maxEntries: number;
  private readonly metrics: EmbeddingCacheMetrics = {
    failedAccessTimeUpdates: 0,
    failedBatchAccessTimeUpdates: 0,
  };
  private readonly pendingAccessTimeUpdates = new Set<Promise<void>>();

  constructor(
    private readonly db: BrainstrikeDbExecutionClient,
    options: CreateTursoEmbeddingCacheRepositoryOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? RECOMMENDED_MAX_CACHE_ENTRIES;
  }

  getMetrics(): EmbeddingCacheMetrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics.failedAccessTimeUpdates = 0;
    this.metrics.failedBatchAccessTimeUpdates = 0;
  }

  async flushPendingAccessTimeUpdates(): Promise<void> {
    if (this.pendingAccessTimeUpdates.size === 0) {
      return;
    }
    await Promise.allSettled([...this.pendingAccessTimeUpdates]);
  }

  async get(contentHash: string, modelKey: string): Promise<EmbeddingCacheLookupResult> {
    const result = await this.db.query<TursoEmbeddingCacheRow>(
      `SELECT ${EMBEDDING_CACHE_SELECT_COLUMNS}
       FROM embedding_cache
       WHERE content_hash = ? AND model_key = ?
       LIMIT 1`,
      [contentHash, modelKey]
    );
    const row = result.rows[0];
    if (!row) {
      return { entry: null, hit: false };
    }

    this.trackAccessTimeUpdate(this.updateAccessTime(row.id), {
      id: row.id,
      mode: 'single',
    });

    return { entry: mapRow(row), hit: true };
  }

  async getBatch(requests: readonly BatchLookupRequest[]): Promise<BatchLookupResult> {
    if (requests.length === 0) {
      return new Map();
    }

    const byModelKey = new Map<string, string[]>();
    for (const request of requests) {
      const contentHashes = byModelKey.get(request.modelKey) ?? [];
      contentHashes.push(request.contentHash);
      byModelKey.set(request.modelKey, contentHashes);
    }

    const hits: BatchLookupResult = new Map();
    const idsToUpdate: string[] = [];
    for (const [modelKey, contentHashes] of byModelKey) {
      for (const chunk of chunkArray([...new Set(contentHashes)], MAX_BATCH_SIZE)) {
        const result = await this.db.query<TursoEmbeddingCacheRow>(
          `SELECT ${EMBEDDING_CACHE_SELECT_COLUMNS}
           FROM embedding_cache
           WHERE model_key = ? AND content_hash IN (${createPlaceholders(chunk.length)})`,
          [modelKey, ...chunk]
        );

        for (const row of result.rows) {
          const entry = mapRow(row);
          hits.set(`${entry.contentHash}:${entry.modelKey}`, entry);
          idsToUpdate.push(entry.id);
        }
      }
    }

    if (idsToUpdate.length > 0) {
      this.trackAccessTimeUpdate(this.batchUpdateAccessTime(idsToUpdate), {
        count: idsToUpdate.length,
        mode: 'batch',
      });
    }

    return hits;
  }

  async set(
    contentHash: string,
    modelKey: string,
    embedding: number[],
    dimensions: number
  ): Promise<EmbeddingCacheEntry> {
    assertDimensions(embedding, dimensions, contentHash);
    const now = new Date().toISOString();
    const result = await this.db.query<TursoEmbeddingCacheRow>(
      `INSERT INTO embedding_cache (
         id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(content_hash, model_key)
       DO UPDATE SET
         accessed_at = excluded.accessed_at,
         access_count = embedding_cache.access_count + 1
       RETURNING ${EMBEDDING_CACHE_SELECT_COLUMNS}`,
      [
        generateUUID(),
        contentHash,
        modelKey,
        encodeVector32Blob(embedding, contentHash),
        dimensions,
        now,
        now,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Failed to cache Turso embedding for ${contentHash}:${modelKey}.`);
    }
    return mapRow(row);
  }

  async setBatch(
    entries: ReadonlyArray<{
      contentHash: string;
      modelKey: string;
      embedding: number[];
      dimensions: number;
    }>
  ): Promise<number> {
    const dedupedEntries = dedupeByContentAndModel(entries);
    if (dedupedEntries.length === 0) {
      return 0;
    }

    return this.db.transaction(async (tx) => {
      let stored = 0;
      for (const chunk of chunkArray(dedupedEntries, MAX_BATCH_SIZE)) {
        const now = new Date().toISOString();
        const params: unknown[] = [];
        const valuesSql = chunk.map((entry) => {
          assertDimensions(entry.embedding, entry.dimensions, entry.contentHash);
          params.push(
            generateUUID(),
            entry.contentHash,
            entry.modelKey,
            encodeVector32Blob(entry.embedding, entry.contentHash),
            entry.dimensions,
            now,
            now
          );
          return '(?, ?, ?, ?, ?, ?, ?, 1)';
        });

        const result = await tx.query<{ id: string }>(
          `INSERT INTO embedding_cache (
             id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count
           )
           VALUES ${valuesSql.join(', ')}
           ON CONFLICT(content_hash, model_key)
           DO UPDATE SET
             accessed_at = excluded.accessed_at,
             access_count = embedding_cache.access_count + 1
           RETURNING id`,
          params
        );
        stored += result.rows.length;
      }
      return stored;
    });
  }

  async evictOldest(count: number): Promise<number> {
    if (count <= 0) {
      return 0;
    }
    const deleted = await this.db.query<{ id: string }>(
      `DELETE FROM embedding_cache
       WHERE id IN (
         SELECT id
         FROM embedding_cache
         ORDER BY accessed_at ASC
         LIMIT ?
       )
       RETURNING id`,
      [count]
    );
    return deleted.rows.length;
  }

  async delete(contentHash: string, modelKey: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM embedding_cache WHERE content_hash = ? AND model_key = ? RETURNING id',
      [contentHash, modelKey]
    );
    return deleted.rows.length > 0;
  }

  async deleteByModel(modelKey: string): Promise<number> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM embedding_cache WHERE model_key = ? RETURNING id',
      [modelKey]
    );
    return deleted.rows.length;
  }

  async evictIfNeeded(
    options: { dryRun?: boolean; targetUtilization?: number } = {}
  ): Promise<{ needed: boolean; evicted: number; totalEntries: number }> {
    const { dryRun = false, targetUtilization = 0.9 } = options;
    const countResult = await this.db.query<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM embedding_cache'
    );
    const totalEntries = parseInteger(countResult.rows[0]?.count ?? 0, 'total_entries');
    if (totalEntries <= this.maxEntries) {
      return { evicted: 0, needed: false, totalEntries };
    }

    const targetCount = Math.floor(this.maxEntries * targetUtilization);
    const toEvict = totalEntries - targetCount;
    if (dryRun) {
      return { evicted: toEvict, needed: true, totalEntries };
    }

    const evicted = await this.evictOldest(toEvict);
    return { evicted, needed: true, totalEntries };
  }

  async getStats(): Promise<EmbeddingCacheStats> {
    const result = await this.db.query<{
      readonly newest_accessed_at: string | null;
      readonly oldest_accessed_at: string | null;
      readonly total_entries: number | string;
      readonly total_hits: number | string;
    }>(`SELECT
        COUNT(*) AS total_entries,
        COALESCE(SUM(access_count), 0) AS total_hits,
        MIN(accessed_at) AS oldest_accessed_at,
        MAX(accessed_at) AS newest_accessed_at
      FROM embedding_cache`);
    const row = result.rows[0];
    return {
      newestAccessedAt: row?.newest_accessed_at
        ? parseDate(row.newest_accessed_at, 'newest_accessed_at')
        : null,
      oldestAccessedAt: row?.oldest_accessed_at
        ? parseDate(row.oldest_accessed_at, 'oldest_accessed_at')
        : null,
      totalEntries: parseInteger(row?.total_entries ?? 0, 'total_entries'),
      totalHits: parseInteger(row?.total_hits ?? 0, 'total_hits'),
    };
  }

  private trackAccessTimeUpdate(
    update: Promise<void>,
    context: { count?: number; id?: string; mode: 'batch' | 'single' }
  ): void {
    const tracked = update
      .catch((error: unknown) => {
        if (context.mode === 'batch') {
          this.metrics.failedBatchAccessTimeUpdates += 1;
          this.logger.warn('Failed to update Turso embedding cache batch access times', {
            count: context.count,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        this.metrics.failedAccessTimeUpdates += 1;
        this.logger.warn('Failed to update Turso embedding cache access time', {
          error: error instanceof Error ? error.message : String(error),
          id: context.id,
        });
      })
      .finally(() => {
        this.pendingAccessTimeUpdates.delete(tracked);
      });
    this.pendingAccessTimeUpdates.add(tracked);
  }

  private async updateAccessTime(id: string): Promise<void> {
    await this.db.exec(
      'UPDATE embedding_cache SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
      [new Date().toISOString(), id]
    );
  }

  private async batchUpdateAccessTime(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const accessedAt = new Date().toISOString();
    for (const chunk of chunkArray(ids, MAX_BATCH_SIZE)) {
      await this.db.exec(
        `UPDATE embedding_cache
         SET accessed_at = ?, access_count = access_count + 1
         WHERE id IN (${createPlaceholders(chunk.length)})`,
        [accessedAt, ...chunk]
      );
    }
  }
}

export function createTursoEmbeddingCacheRepository(
  db: BrainstrikeDbExecutionClient,
  options?: CreateTursoEmbeddingCacheRepositoryOptions
): TursoEmbeddingCacheRepository {
  return new TursoEmbeddingCacheRepository(db, options);
}
