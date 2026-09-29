import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import { drizzle, extractPGlite } from '../drizzle/database.js';
import type { EmbeddingCacheEntry } from '../schema/index.js';
import type { CreateEmbeddingCacheRepositoryOptions } from './_shared.js';
import {
  assertEmbeddingDimensions,
  assertFiniteEmbedding,
  dedupeByContentAndModel,
  parseEmbeddingLoose,
} from './_shared.js';
import type {
  BatchLookupRequest,
  BatchLookupResult,
  EmbeddingCacheLookupResult,
  EmbeddingCacheMetrics,
  EmbeddingCacheStats,
} from './drizzle/embedding-cache-repository.js';
import {
  DrizzleEmbeddingCacheRepository,
  MAX_BATCH_SIZE,
  RECOMMENDED_MAX_CACHE_ENTRIES,
} from './drizzle/embedding-cache-repository.js';
import type { IDatabase } from './interfaces.js';

interface EmbeddingCacheRow {
  access_count: number | string;
  accessed_at: Date | string;
  content_hash: string;
  created_at: Date | string;
  dimensions: number | string;
  embedding: unknown;
  id: string;
  model_key: string;
}

// Definition lives in _shared.ts so the Drizzle module can import it without
// depending on this factory module (review #2166: the type-only import here
// inverted the layering even though it erased at runtime).
export type { CreateEmbeddingCacheRepositoryOptions } from './_shared.js';

// Write-side validation now lives in _shared.ts so the Drizzle variant
// enforces the identical named-error contract (BST-989 Pair C review).
const assertDimensions = assertEmbeddingDimensions;

function toVectorLiteral(embedding: readonly number[], label: string): string {
  assertFiniteEmbedding(embedding, label);
  return `[${embedding.join(',')}]`;
}

function parseDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
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

function mapRow(row: EmbeddingCacheRow): EmbeddingCacheEntry {
  const embedding = parseEmbeddingLoose(row.embedding);
  if (!embedding) {
    throw new Error(`Failed to parse embedding cache vector for ${row.content_hash}.`);
  }

  return {
    accessCount: parseInteger(row.access_count, 'access_count'),
    accessedAt: parseDate(row.accessed_at, 'accessed_at'),
    contentHash: row.content_hash,
    createdAt: parseDate(row.created_at, 'created_at'),
    dimensions: parseInteger(row.dimensions, 'dimensions'),
    embedding,
    id: row.id,
    modelKey: row.model_key,
  };
}

function buildPlaceholders(startIndex: number, count: number): string {
  return Array.from({ length: count }, (_value, index) => `$${startIndex + index}`).join(', ');
}

function chunkArray<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// dedupeByContentAndModel moved to _shared.ts (BST-989 Pair C): the Drizzle
// variant needs the identical write-side de-dup, and importing it from this
// module would close a runtime cycle with the factory's Drizzle-class import.

export class EmbeddingCacheRepository {
  private readonly logger = createLogger('EmbeddingCacheRepository');
  private readonly maxEntries: number;
  private readonly metrics: EmbeddingCacheMetrics = {
    failedAccessTimeUpdates: 0,
    failedBatchAccessTimeUpdates: 0,
  };
  private readonly pendingAccessTimeUpdates = new Set<Promise<void>>();

  constructor(
    private readonly db: IDatabase,
    options: CreateEmbeddingCacheRepositoryOptions = {}
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
    const result = await this.db.query<EmbeddingCacheRow>(
      `
        SELECT id, content_hash, model_key, embedding::text AS embedding, dimensions,
               created_at, accessed_at, access_count
        FROM embedding_cache
        WHERE content_hash = $1 AND model_key = $2
        LIMIT 1
      `,
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
        const placeholders = buildPlaceholders(2, chunk.length);
        const result = await this.db.query<EmbeddingCacheRow>(
          `
            SELECT id, content_hash, model_key, embedding::text AS embedding, dimensions,
                   created_at, accessed_at, access_count
            FROM embedding_cache
            WHERE model_key = $1 AND content_hash IN (${placeholders})
          `,
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
    const now = new Date();
    const result = await this.db.query<EmbeddingCacheRow>(
      `
        INSERT INTO embedding_cache (
          id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count
        )
        VALUES ($1, $2, $3, $4::vector, $5, $6, $7, 1)
        ON CONFLICT (content_hash, model_key)
        DO UPDATE SET
          -- First value wins for a content/model key. Model changes must use a new model_key
          -- or explicit deleteByModel invalidation; reads still refresh LRU metadata.
          accessed_at = EXCLUDED.accessed_at,
          access_count = embedding_cache.access_count + 1
        RETURNING id, content_hash, model_key, embedding::text AS embedding, dimensions,
                  created_at, accessed_at, access_count
      `,
      [
        generateUUID(),
        contentHash,
        modelKey,
        toVectorLiteral(embedding, contentHash),
        dimensions,
        now,
        now,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Failed to cache embedding for ${contentHash}:${modelKey}.`);
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
    let stored = 0;
    for (const chunk of chunkArray(dedupedEntries, MAX_BATCH_SIZE)) {
      if (chunk.length === 0) {
        continue;
      }

      const now = new Date();
      const params: unknown[] = [];
      const valuesSql = chunk.map((entry) => {
        assertDimensions(entry.embedding, entry.dimensions, entry.contentHash);
        const start = params.length + 1;
        params.push(
          generateUUID(),
          entry.contentHash,
          entry.modelKey,
          toVectorLiteral(entry.embedding, entry.contentHash),
          entry.dimensions,
          now,
          now
        );
        return `($${start}, $${start + 1}, $${start + 2}, $${start + 3}::vector, $${start + 4}, $${start + 5}, $${start + 6}, 1)`;
      });

      const result = await this.db.query<{ id: string }>(
        `
          INSERT INTO embedding_cache (
            id, content_hash, model_key, embedding, dimensions, created_at, accessed_at, access_count
          )
          VALUES ${valuesSql.join(', ')}
          ON CONFLICT (content_hash, model_key)
          DO UPDATE SET
            -- First value wins for a content/model key. Model changes must use a new model_key
            -- or explicit deleteByModel invalidation; reads still refresh LRU metadata.
            accessed_at = EXCLUDED.accessed_at,
            access_count = embedding_cache.access_count + 1
          RETURNING id
        `,
        params
      );
      stored += result.rows.length;
    }

    return stored;
  }

  async evictOldest(count: number): Promise<number> {
    if (count <= 0) {
      return 0;
    }
    const deleted = await this.db.query<{ id: string }>(
      `
        WITH oldest AS (
          SELECT id
          FROM embedding_cache
          ORDER BY accessed_at ASC
          LIMIT $1
        )
        DELETE FROM embedding_cache
        WHERE id IN (SELECT id FROM oldest)
        RETURNING id
      `,
      [count]
    );
    return deleted.rows.length;
  }

  async delete(contentHash: string, modelKey: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      `
        DELETE FROM embedding_cache
        WHERE content_hash = $1 AND model_key = $2
        RETURNING id
      `,
      [contentHash, modelKey]
    );
    return deleted.rows.length > 0;
  }

  async deleteByModel(modelKey: string): Promise<number> {
    const deleted = await this.db.query<{ id: string }>(
      `
        DELETE FROM embedding_cache
        WHERE model_key = $1
        RETURNING id
      `,
      [modelKey]
    );
    return deleted.rows.length;
  }

  async evictIfNeeded(
    options: { dryRun?: boolean; targetUtilization?: number } = {}
  ): Promise<{ needed: boolean; evicted: number; totalEntries: number }> {
    const { dryRun = false, targetUtilization = 0.9 } = options;
    const countResult = await this.db.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM embedding_cache'
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
      newest_accessed_at: Date | string | null;
      oldest_accessed_at: Date | string | null;
      total_entries: number | string;
      total_hits: number | string;
    }>(`
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(access_count), 0)::int AS total_hits,
        MIN(accessed_at) AS oldest_accessed_at,
        MAX(accessed_at) AS newest_accessed_at
      FROM embedding_cache
    `);
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
          this.logger.warn('Failed to update embedding cache batch access times', {
            count: context.count,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        this.metrics.failedAccessTimeUpdates += 1;
        this.logger.warn('Failed to update embedding cache access time', {
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
    await this.db.query(
      `
        UPDATE embedding_cache
        SET accessed_at = $1, access_count = access_count + 1
        WHERE id = $2
      `,
      [new Date(), id]
    );
  }

  private async batchUpdateAccessTime(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const accessedAt = new Date();
    for (const chunk of chunkArray(ids, MAX_BATCH_SIZE)) {
      await this.db.query(
        `
          UPDATE embedding_cache
          SET accessed_at = $1, access_count = access_count + 1
          WHERE id IN (${buildPlaceholders(2, chunk.length)})
        `,
        [accessedAt, ...chunk]
      );
    }
  }
}

/**
 * BST-989 Pair C promotion — a capability dispatch, not a blanket swap.
 *
 * The Drizzle variant serves every IN-PROCESS execution surface: drizzle's
 * pglite driver passes a per-query config carrying parser FUNCTIONS as
 * `client.query`'s third argument, which is fine for a real PGlite, a
 * `createPriorityDbHandle` proxy, or web's scheduled handle (all in-process,
 * full-argument forwarding). The given handle is wrapped, never unwrapped —
 * reaching for `.raw` under a priority proxy would bypass the database work
 * scheduler; `extractPGlite` runs only for wrappers with no own surface.
 *
 * The Electron-style QUERY-ONLY handle (desktop renderer → main over IPC)
 * cannot host that driver: parser functions do not survive structured clone,
 * and the bridge deliberately exposes statement-list `runTransaction`
 * (#1141/#1145) instead of a callback `transaction`. That shape keeps the raw
 * implementation, whose 2-argument queries and strict row validation exist
 * precisely for the IPC serialization boundary. Detection key: an in-process
 * surface always carries callback `transaction`; the IPC bridge never does.
 *
 * NO SILENT FALLBACKS: a handle with neither surface throws.
 */
export function createEmbeddingCacheRepository(
  db: IDatabase,
  options?: CreateEmbeddingCacheRepositoryOptions
): DrizzleEmbeddingCacheRepository | EmbeddingCacheRepository {
  const surface = db as { query?: unknown; transaction?: unknown; runTransaction?: unknown };
  // Statement-list runTransaction (#1141/#1145) positively identifies the IPC
  // bridge — do not infer it from the ABSENCE of callback `transaction`:
  // DesktopDatabaseBridge's optional `transaction` member invites a future
  // preload to add one, which would otherwise flip desktop into
  // drizzle-over-IPC far from the change that caused it (review #2166).
  // The bridge returns EARLY, before any Drizzle branch: createDbHandle
  // unconditionally installs `.raw` (the executor — i.e. the bridge itself),
  // so a mere `!isIpcBridge` guard on the first branch would let
  // extractPGlite unwrap the same bridge below (review #2166 round 3).
  const isIpcBridge = typeof surface.runTransaction === 'function';
  if (isIpcBridge && typeof surface.query === 'function') {
    return new EmbeddingCacheRepository(db, options);
  }
  if (typeof surface.query === 'function' && typeof surface.transaction === 'function') {
    return new DrizzleEmbeddingCacheRepository(
      drizzle(db as unknown as Parameters<typeof drizzle>[0]),
      options
    );
  }
  const raw = extractPGlite(db);
  if (raw) {
    return new DrizzleEmbeddingCacheRepository(
      drizzle(raw as unknown as Parameters<typeof drizzle>[0]),
      options
    );
  }
  if (typeof surface.query === 'function') {
    return new EmbeddingCacheRepository(db, options);
  }
  throw new Error(
    'createEmbeddingCacheRepository requires a PGlite-compatible handle (query + transaction), a DbHandle exposing .raw, or an IPC-style query handle.'
  );
}
