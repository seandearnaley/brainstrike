import { createLogger, generateUUID } from '@brainstrike/utils';
import { ensureDimensionIndexExists } from '../migrations/dimension-index-helpers.js';
import type { EmbeddingDistance, EmbeddingSet } from '../models/embedding-set';
import {
  normalizeEmbeddingSetInputMetadata,
  repairPersistedEmbeddingSetMetadata,
  tryResolveEmbeddingSetMetadata,
} from './embedding-set-metadata.js';

interface EmbeddingSetsDb {
  exec(sql: string, params?: unknown): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown): Promise<{ rows: T[] }>;
}

export interface ListEmbeddingSpacesOptions {
  readonly includeStats?: boolean;
}

export interface EmbeddingSpaceStats {
  /**
   * Average tokens across chunks that have a recorded token_count; uncounted chunks are excluded.
   */
  readonly averageTokensPerChunk: number;
  readonly embeddedChunks: number;
  readonly fileCount: number;
  readonly tokenizedChunkCount: number;
  readonly totalChunks: number;
  readonly totalTokens: number;
}

export interface EmbeddingSpaceListing {
  readonly createdAt: string;
  readonly description: string | null;
  readonly dimensions: number;
  readonly distance: EmbeddingDistance | null;
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name: string | null;
  readonly stats?: EmbeddingSpaceStats;
}

interface EmbeddingSpaceListingRow {
  readonly averageTokensPerChunk?: number | string | null;
  readonly createdAt: string;
  readonly description: string | null;
  readonly dimensions: number | string;
  readonly distance: EmbeddingDistance | null;
  readonly embeddedChunks?: number | string | null;
  readonly fileCount?: number | string | null;
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name: string | null;
  readonly tokenizedChunkCount?: number | string | null;
  readonly totalChunks?: number | string | null;
  readonly totalTokens?: number | string | null;
}

function readFiniteNumber(value: number | string, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid embedding space ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function readOptionalFiniteNumber(
  value: number | string | null | undefined,
  fieldName: string
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return readFiniteNumber(value, fieldName);
}

export class EmbeddingSetsRepository {
  private readonly logger = createLogger('EmbeddingSetsRepository');

  constructor(private readonly db: EmbeddingSetsDb) {}

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(this.db, {
      modelKey,
      modelId,
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

    // Ensure HNSW index exists for this dimension (idempotent, best-effort)
    // This allows new embedding dimensions to automatically get indexes
    try {
      await ensureDimensionIndexExists(this.db, dimensions);
    } catch (error) {
      // Non-fatal: queries will still work via sequential scan fallback
      this.logger.warn('Failed to ensure dimension index exists', {
        dimensions,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info('Created new embedding set', {
      id,
      modelKey: normalizedMetadata.modelKey,
      dimensions,
      distance,
      name,
    });
    return this.fromRow(insertResult.rows[0] as Record<string, unknown>);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const result = await this.db.query('SELECT * FROM embedding_sets WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? this.readEmbeddingSet(row as Record<string, unknown>) : null;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[] | []> {
    const normalizedMetadata = await tryResolveEmbeddingSetMetadata(this.db, {
      modelKey,
      modelId: '',
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
    const result =
      options.includeStats === true
        ? await this.db.query<EmbeddingSpaceListingRow>(
            `WITH file_stats AS (
               SELECT
                 embedding_set_id,
                 COUNT(*)::text AS file_count
               FROM file_records
               WHERE embedding_set_id IS NOT NULL
               GROUP BY embedding_set_id
             ),
             chunk_stats AS (
               SELECT
                 embedding_set_id,
                 COUNT(*)::text AS total_chunks,
                 COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS embedded_chunks,
                 COUNT(token_count)::text AS tokenized_chunk_count,
                 COALESCE(SUM(token_count), 0)::text AS total_tokens,
                 COALESCE(AVG(token_count), 0)::text AS average_tokens_per_chunk
               FROM file_chunks
               WHERE embedding_set_id IS NOT NULL
               GROUP BY embedding_set_id
             )
             SELECT
               es.id,
               es.name,
               es.description,
               es.model_key AS "modelKey",
               es.model_id AS "modelId",
               es.dimensions,
               es.distance,
               es.created_at AS "createdAt",
               COALESCE(fs.file_count, '0') AS "fileCount",
               COALESCE(cs.total_chunks, '0') AS "totalChunks",
               COALESCE(cs.embedded_chunks, '0') AS "embeddedChunks",
               COALESCE(cs.tokenized_chunk_count, '0') AS "tokenizedChunkCount",
               COALESCE(cs.total_tokens, '0') AS "totalTokens",
               COALESCE(cs.average_tokens_per_chunk, '0') AS "averageTokensPerChunk"
             FROM embedding_sets es
             LEFT JOIN file_stats fs ON fs.embedding_set_id = es.id
             LEFT JOIN chunk_stats cs ON cs.embedding_set_id = es.id
             ORDER BY es.created_at DESC`
          )
        : await this.db.query<EmbeddingSpaceListingRow>(
            `SELECT
               id,
               name,
               description,
               model_key AS "modelKey",
               model_id AS "modelId",
               dimensions,
               distance,
               created_at AS "createdAt"
             FROM embedding_sets
             ORDER BY created_at DESC`
          );

    return result.rows.map((row) => this.readEmbeddingSpaceListing(row, options));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM embedding_sets WHERE id = $1 RETURNING id', [
      id,
    ]);
    return result.rows.length > 0;
  }

  private fromRow(row: Record<string, unknown>): EmbeddingSet {
    const base = {
      id: String(row['id']),
      modelKey: String(row['model_key']),
      modelId: String(row['model_id']),
      dimensions: Number(row['dimensions']),
      distance: String(row['distance']) as EmbeddingDistance,
      createdAt: String(row['created_at']),
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

    return result;
  }

  private readEmbeddingSpaceListing(
    row: EmbeddingSpaceListingRow,
    options: ListEmbeddingSpacesOptions
  ): EmbeddingSpaceListing {
    const listing: EmbeddingSpaceListing = {
      id: row.id,
      name: row.name,
      description: row.description,
      modelKey: row.modelKey,
      modelId: row.modelId,
      dimensions: readFiniteNumber(row.dimensions, 'dimensions'),
      distance: row.distance,
      createdAt: row.createdAt,
    };
    if (options.includeStats !== true) {
      return listing;
    }
    return {
      ...listing,
      stats: {
        fileCount: readOptionalFiniteNumber(row.fileCount, 'fileCount'),
        totalChunks: readOptionalFiniteNumber(row.totalChunks, 'totalChunks'),
        embeddedChunks: readOptionalFiniteNumber(row.embeddedChunks, 'embeddedChunks'),
        tokenizedChunkCount: readOptionalFiniteNumber(
          row.tokenizedChunkCount,
          'tokenizedChunkCount'
        ),
        totalTokens: readOptionalFiniteNumber(row.totalTokens, 'totalTokens'),
        averageTokensPerChunk: readOptionalFiniteNumber(
          row.averageTokensPerChunk,
          'averageTokensPerChunk'
        ),
      },
    };
  }

  private async readEmbeddingSet(row: Record<string, unknown>): Promise<EmbeddingSet> {
    const embeddingSet = this.fromRow(row);
    const repairedMetadata = await repairPersistedEmbeddingSetMetadata(this.db, {
      id: embeddingSet.id,
      modelKey: embeddingSet.modelKey,
      modelId: embeddingSet.modelId,
    });
    if (!repairedMetadata) {
      return embeddingSet;
    }
    return {
      ...embeddingSet,
      modelKey: repairedMetadata.modelKey,
      modelId: repairedMetadata.modelId,
    };
  }
}
