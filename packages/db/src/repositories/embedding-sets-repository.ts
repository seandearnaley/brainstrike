import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import {
  createDeferredDimensionIndexBuilder,
  type DeferredDimensionIndexBuilder,
  precreateEmptyDimensionIndex,
} from '../migrations/dimension-index-helpers.js';
import {
  type EmbeddingDistance,
  type EmbeddingSet,
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS,
  WORKSPACE_INDEX_SYSTEM_ROLE,
} from '../models/embedding-set.js';
import {
  normalizeEmbeddingSetInputMetadata,
  repairPersistedEmbeddingSetMetadata,
  tryResolveEmbeddingSetMetadata,
} from './embedding-set-metadata.js';
import {
  type EmbeddingSpaceListing,
  type ListEmbeddingSpacesOptions,
  runListEmbeddingSpacesQuery,
} from './embedding-space-listing.js';

interface EmbeddingSetsDb {
  exec(sql: string, params?: unknown): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class EmbeddingSetsRepository {
  private readonly logger = createLogger('EmbeddingSetsRepository');

  // Deferred so a long HNSW build never blocks embedding-set creation. getDb /
  // onError read this.db / this.logger lazily (the field initializes before the
  // constructor parameter property is assigned).
  private readonly dimensionIndexBuilder: DeferredDimensionIndexBuilder =
    createDeferredDimensionIndexBuilder({
      getDb: () => this.db,
      onError: (dimension, error) => {
        this.logger.warn('Failed to ensure dimension index exists', {
          dimension,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

  constructor(private readonly db: EmbeddingSetsDb) {}

  /**
   * Await any in-flight deferred HNSW index builds (snapshot at call time).
   * Used by tests that need the index materialized before asserting on it, and
   * available for future shutdown coordination — production shutdown does NOT
   * currently drain builds: a build lost to shutdown is benign because
   * CREATE INDEX IF NOT EXISTS self-heals on the next getOrCreate* OR getById
   * call. The workspace dimension re-schedules on every launch, and getById
   * re-arms the build whenever an existing set is read, so a unique-dimension
   * set recovers the next time it is actually used (the builder memoizes
   * per-session successes, keeping the re-arm free after the first build).
   */
  waitForPendingDimensionIndexBuilds(): Promise<void> {
    return this.dimensionIndexBuilder.whenSettled();
  }

  async getOrCreateWorkspaceIndexSet(): Promise<EmbeddingSet> {
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(this.db, {
      modelId: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelId,
      modelKey: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelKey,
    });
    const id = generateUUID();
    const now = new Date().toISOString();
    const result = await this.db.query(
      `WITH existing AS (
         SELECT *
           FROM embedding_sets
          WHERE system_role = $9
          LIMIT 1
       ),
       inserted AS (
         INSERT INTO embedding_sets (
           id,
           model_key,
           model_id,
           dimensions,
           distance,
           created_at,
           name,
           description,
           tags,
           category,
           system_role
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT DO NOTHING
         RETURNING *
       ),
       selected AS (
         SELECT * FROM existing
         UNION ALL
         SELECT * FROM inserted
         LIMIT 1
       ),
       seeded_stats AS (
         INSERT INTO collection_indexing_stats (
           embedding_set_id,
           file_count,
           chunk_count,
           embedded_chunk_count,
           pending_chunk_count,
           dirty,
           last_refreshed_at
         )
         SELECT id, 0, 0, 0, 0, FALSE, NOW()
           FROM selected
         ON CONFLICT (embedding_set_id) DO NOTHING
         RETURNING embedding_set_id
       )
       SELECT *
         FROM selected
        CROSS JOIN (SELECT COUNT(*) AS seeded_stats_count FROM seeded_stats) seeded_stats_count`,
      [
        id,
        normalizedMetadata.modelKey,
        normalizedMetadata.modelId,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.distance,
        now,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.name,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.description,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.systemRole,
      ]
    );

    if (result.rows.length === 0) {
      const fallback = await this.db.query(
        'SELECT * FROM embedding_sets WHERE system_role = $1 LIMIT 1',
        [WORKSPACE_INDEX_SYSTEM_ROLE]
      );
      const row = fallback.rows[0];
      if (!row) {
        throw new Error('Failed to create or load the workspace index embedding set.');
      }
      await precreateEmptyDimensionIndex(
        this.db,
        WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions
      );
      this.dimensionIndexBuilder.schedule(WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions);
      return this.readEmbeddingSet(row as Record<string, unknown>);
    }

    await precreateEmptyDimensionIndex(this.db, WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions);
    this.dimensionIndexBuilder.schedule(WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions);

    return this.readEmbeddingSet(result.rows[0] as Record<string, unknown>);
  }

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(this.db, {
      modelId,
      modelKey,
    });
    const id = generateUUID();
    const now = new Date().toISOString();

    // Generate default name if not provided
    const defaultName = `${normalizedMetadata.modelId} (${dimensions}D)`;
    const name = metadata?.name ?? defaultName;

    const insertResult = await this.db.query(
      `WITH inserted AS (
         INSERT INTO embedding_sets (
           id,
           model_key,
           model_id,
           dimensions,
           distance,
           created_at,
           name,
           description,
           tags,
           category
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *
       ),
       seeded_stats AS (
         INSERT INTO collection_indexing_stats (
           embedding_set_id,
           file_count,
           chunk_count,
           embedded_chunk_count,
           pending_chunk_count,
           dirty,
           last_refreshed_at
         )
         SELECT id, 0, 0, 0, 0, FALSE, NOW()
           FROM inserted
         ON CONFLICT (embedding_set_id) DO NOTHING
         RETURNING embedding_set_id
       )
       SELECT *
         FROM inserted
        CROSS JOIN (SELECT COUNT(*) AS seeded_stats_count FROM seeded_stats) seeded_stats_count`,
      [
        id,
        normalizedMetadata.modelKey,
        normalizedMetadata.modelId,
        dimensions,
        distance,
        now,
        name,
        metadata?.description ?? null,
        metadata?.tags ?? null,
        metadata?.category ?? null,
      ]
    );

    if (insertResult.rows.length === 0) {
      throw new Error(
        `Failed to create embedding set for ${normalizedMetadata.modelKey}/${dimensions}/${distance}`
      );
    }

    await precreateEmptyDimensionIndex(this.db, dimensions);
    this.dimensionIndexBuilder.schedule(dimensions);

    this.logger.info('Created new embedding set', {
      dimensions,
      distance,
      id,
      modelKey: normalizedMetadata.modelKey,
      name,
    });
    return this.fromRow(insertResult.rows[0] as Record<string, unknown>);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const result = await this.db.query('SELECT * FROM embedding_sets WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const set = await this.readEmbeddingSet(row as Record<string, unknown>);
    // Read-path re-arm: a deferred build lost to app quit (the 250ms delay +
    // 5-30s CREATE INDEX window) would otherwise leave a unique-dimension set
    // seq-scanning indefinitely — only same-dimension CREATES re-schedule. The
    // builder memoizes per-session successes, so this is a no-op after the
    // first successful build.
    this.dimensionIndexBuilder.schedule(set.dimensions);
    return set;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[] | []> {
    const normalizedMetadata = await tryResolveEmbeddingSetMetadata(this.db, {
      modelId: '',
      modelKey,
    });
    const lookupModelKey = normalizedMetadata?.modelKey ?? modelKey;
    const result = await this.db.query('SELECT * FROM embedding_sets WHERE model_key = $1', [
      lookupModelKey,
    ]);
    return Promise.all(
      result.rows.map((row) => this.readEmbeddingSet(row as Record<string, unknown>))
    );
  }

  /**
   * Updates metadata for an existing embedding set
   * @param id - The embedding set ID
   * @param metadata - Partial metadata to update (only provided fields are updated)
   * @returns Updated embedding set or null if not found
   */
  async updateMetadata(
    id: string,
    metadata: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet | null> {
    const result = await this.db.query(
      `UPDATE embedding_sets
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           tags = COALESCE($4, tags),
           category = COALESCE($5, category)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        metadata.name ?? null,
        metadata.description ?? null,
        metadata.tags ?? null,
        metadata.category ?? null,
      ]
    );
    const row = result.rows[0];
    return row ? this.fromRow(row as Record<string, unknown>) : null;
  }

  async findAll(): Promise<EmbeddingSet[]> {
    const result = await this.db.query('SELECT * FROM embedding_sets ORDER BY created_at DESC');
    return Promise.all(
      result.rows.map((row) => this.readEmbeddingSet(row as Record<string, unknown>))
    );
  }

  async listEmbeddingSpaces(
    options: ListEmbeddingSpacesOptions = {}
  ): Promise<EmbeddingSpaceListing[]> {
    return runListEmbeddingSpacesQuery((sql) => this.db.query(sql), options);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM embedding_sets WHERE id = $1 RETURNING id', [
      id,
    ]);
    return result.rows.length > 0;
  }

  private fromRow(row: Record<string, unknown>): EmbeddingSet {
    const base = {
      createdAt: String(row['created_at']),
      dimensions: Number(row['dimensions']),
      distance: String(row['distance']) as EmbeddingDistance,
      id: String(row['id']),
      modelId: String(row['model_id']),
      modelKey: String(row['model_key']),
    };

    // Add optional metadata fields only if they exist
    const result: EmbeddingSet = { ...base };
    if (row['name'] !== null) {
      result.name = String(row['name']);
    }
    if (row['description'] !== null) {
      result.description = String(row['description']);
    }
    if (row['tags'] !== null) {
      result.tags = String(row['tags']);
    }
    if (row['category'] !== null) {
      result.category = String(row['category']);
    }
    if (row['system_role'] === WORKSPACE_INDEX_SYSTEM_ROLE) {
      result.systemRole = WORKSPACE_INDEX_SYSTEM_ROLE;
    }

    return result;
  }

  private async readEmbeddingSet(row: Record<string, unknown>): Promise<EmbeddingSet> {
    const embeddingSet = this.fromRow(row);
    const repairedMetadata = await repairPersistedEmbeddingSetMetadata(this.db, {
      id: embeddingSet.id,
      modelId: embeddingSet.modelId,
      modelKey: embeddingSet.modelKey,
    });
    if (!repairedMetadata) {
      return embeddingSet;
    }
    return {
      ...embeddingSet,
      modelId: repairedMetadata.modelId,
      modelKey: repairedMetadata.modelKey,
    };
  }
}
