import { createLogger, generateUUID } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
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
import type {
  EmbeddingSpaceListing,
  EmbeddingSpaceStats,
  ListEmbeddingSpacesOptions,
} from './embedding-sets-repository.js';
import type { IEmbeddingSetsRepository } from './interfaces.js';

interface TursoEmbeddingSetRow {
  readonly category: string | null;
  readonly created_at: string;
  readonly description: string | null;
  readonly dimensions: number | string;
  readonly distance: EmbeddingDistance | null;
  readonly id: string;
  readonly model_id: string;
  readonly model_key: string;
  readonly name: string | null;
  readonly system_role: string | null;
  readonly tags: string | null;
}

interface TursoEmbeddingSpaceListingRow {
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

export class TursoEmbeddingSetsRepository implements IEmbeddingSetsRepository {
  private readonly logger = createLogger('TursoEmbeddingSetsRepository');

  constructor(private readonly db: BrainstrikeDbExecutionClient) {}

  waitForPendingDimensionIndexBuilds(): Promise<void> {
    return Promise.resolve();
  }

  async getOrCreateWorkspaceIndexSet(): Promise<EmbeddingSet> {
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(this.metadataDb(), {
      modelKey: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelKey,
      modelId: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelId,
    });

    const existing = await this.findWorkspaceIndexSetRow();
    if (existing) {
      await seedCollectionIndexingStats(this.db, existing.id);
      return this.readEmbeddingSet(existing);
    }

    const id = generateUUID();
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.exec(
        `INSERT OR IGNORE INTO embedding_sets (
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
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
    });

    const row = await this.findWorkspaceIndexSetRow();
    if (!row) {
      throw new Error('Failed to create or load the workspace index embedding set.');
    }

    await seedCollectionIndexingStats(this.db, row.id);
    return this.readEmbeddingSet(row);
  }

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(this.metadataDb(), {
      modelKey,
      modelId,
    });
    const id = generateUUID();
    const now = new Date().toISOString();
    const name = metadata?.name ?? `${normalizedMetadata.modelId} (${dimensions}D)`;

    await this.db.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO embedding_sets (
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      await seedCollectionIndexingStats(tx, id);
    });

    const row = await this.getRowById(id);
    if (!row) {
      throw new Error(
        `Failed to create embedding set for ${normalizedMetadata.modelKey}/${dimensions}/${distance}`
      );
    }

    this.logger.info('Created new Turso embedding set', {
      dimensions,
      distance,
      id,
      modelKey: normalizedMetadata.modelKey,
      name,
    });
    return this.fromRow(row);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const row = await this.getRowById(id);
    return row ? this.readEmbeddingSet(row) : null;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[]> {
    const normalizedMetadata = await tryResolveEmbeddingSetMetadata(this.metadataDb(), {
      modelKey,
      modelId: '',
    });
    const lookupModelKey = normalizedMetadata?.modelKey ?? modelKey;
    const result = await this.db.query<TursoEmbeddingSetRow>(
      'SELECT * FROM embedding_sets WHERE model_key = ?',
      [lookupModelKey]
    );
    return Promise.all(result.rows.map((row) => this.readEmbeddingSet(row)));
  }

  async updateMetadata(
    id: string,
    metadata: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    if (metadata.name !== undefined) {
      assignments.push('name = ?');
      params.push(metadata.name);
    }
    if (metadata.description !== undefined) {
      assignments.push('description = ?');
      params.push(metadata.description);
    }
    if (metadata.tags !== undefined) {
      assignments.push('tags = ?');
      params.push(metadata.tags);
    }
    if (metadata.category !== undefined) {
      assignments.push('category = ?');
      params.push(metadata.category);
    }
    if (assignments.length === 0) {
      return this.getById(id);
    }

    params.push(id);
    const result = await this.db.query<TursoEmbeddingSetRow>(
      `UPDATE embedding_sets
       SET ${assignments.join(', ')}
       WHERE id = ?
       RETURNING *`,
      params
    );
    const row = result.rows[0];
    return row ? this.fromRow(row) : null;
  }

  async findAll(): Promise<EmbeddingSet[]> {
    const result = await this.db.query<TursoEmbeddingSetRow>(
      'SELECT * FROM embedding_sets ORDER BY created_at DESC'
    );
    return Promise.all(result.rows.map((row) => this.readEmbeddingSet(row)));
  }

  async listEmbeddingSpaces(
    options: ListEmbeddingSpacesOptions = {}
  ): Promise<EmbeddingSpaceListing[]> {
    const result =
      options.includeStats === true
        ? await this.db.query<TursoEmbeddingSpaceListingRow>(
            `WITH file_stats AS (
               SELECT
                 embedding_set_id,
                 COUNT(*) AS fileCount
               FROM file_records
               WHERE embedding_set_id IS NOT NULL
               GROUP BY embedding_set_id
             ),
             chunk_stats AS (
               SELECT
                 embedding_set_id,
                 COUNT(*) AS totalChunks,
                 SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embeddedChunks,
                 COUNT(token_count) AS tokenizedChunkCount,
                 COALESCE(SUM(token_count), 0) AS totalTokens,
                 COALESCE(AVG(token_count), 0) AS averageTokensPerChunk
               FROM file_chunks
               WHERE embedding_set_id IS NOT NULL
               GROUP BY embedding_set_id
             )
             SELECT
               es.id,
               es.name,
               es.description,
               es.model_key AS modelKey,
               es.model_id AS modelId,
               es.dimensions,
               es.distance,
               es.created_at AS createdAt,
               COALESCE(fs.fileCount, 0) AS fileCount,
               COALESCE(cs.totalChunks, 0) AS totalChunks,
               COALESCE(cs.embeddedChunks, 0) AS embeddedChunks,
               COALESCE(cs.tokenizedChunkCount, 0) AS tokenizedChunkCount,
               COALESCE(cs.totalTokens, 0) AS totalTokens,
               COALESCE(cs.averageTokensPerChunk, 0) AS averageTokensPerChunk
             FROM embedding_sets es
             LEFT JOIN file_stats fs ON fs.embedding_set_id = es.id
             LEFT JOIN chunk_stats cs ON cs.embedding_set_id = es.id
             ORDER BY es.created_at DESC`
          )
        : await this.db.query<TursoEmbeddingSpaceListingRow>(
            `SELECT
               id,
               name,
               description,
               model_key AS modelKey,
               model_id AS modelId,
               dimensions,
               distance,
               created_at AS createdAt
             FROM embedding_sets
             ORDER BY created_at DESC`
          );

    return result.rows.map((row) => this.readEmbeddingSpaceListing(row, options));
  }

  async delete(id: string): Promise<boolean> {
    await this.db.exec('DELETE FROM file_chunks WHERE embedding_set_id = ?', [id]);
    const result = await this.db.query<{ id: string }>(
      'DELETE FROM embedding_sets WHERE id = ? RETURNING id',
      [id]
    );
    return result.rows.length > 0;
  }

  private async findWorkspaceIndexSetRow(): Promise<TursoEmbeddingSetRow | null> {
    const result = await this.db.query<TursoEmbeddingSetRow>(
      'SELECT * FROM embedding_sets WHERE system_role = ? LIMIT 1',
      [WORKSPACE_INDEX_SYSTEM_ROLE]
    );
    return result.rows[0] ?? null;
  }

  private async getRowById(id: string): Promise<TursoEmbeddingSetRow | null> {
    const result = await this.db.query<TursoEmbeddingSetRow>(
      'SELECT * FROM embedding_sets WHERE id = ?',
      [id]
    );
    return result.rows[0] ?? null;
  }

  private fromRow(row: TursoEmbeddingSetRow): EmbeddingSet {
    const result: EmbeddingSet = {
      createdAt: row.created_at,
      dimensions: readFiniteNumber(row.dimensions, 'dimensions'),
      distance: readDistance(row.distance),
      id: row.id,
      modelId: row.model_id,
      modelKey: row.model_key,
    };
    if (row.name !== null) {
      result.name = row.name;
    }
    if (row.description !== null) {
      result.description = row.description;
    }
    if (row.tags !== null) {
      result.tags = row.tags;
    }
    if (row.category !== null) {
      result.category = row.category;
    }
    if (row.system_role === WORKSPACE_INDEX_SYSTEM_ROLE) {
      result.systemRole = WORKSPACE_INDEX_SYSTEM_ROLE;
    }
    return result;
  }

  private readEmbeddingSpaceListing(
    row: TursoEmbeddingSpaceListingRow,
    options: ListEmbeddingSpacesOptions
  ): EmbeddingSpaceListing {
    const listing: EmbeddingSpaceListing = {
      createdAt: row.createdAt,
      description: row.description,
      dimensions: readFiniteNumber(row.dimensions, 'dimensions'),
      distance: row.distance,
      id: row.id,
      modelId: row.modelId,
      modelKey: row.modelKey,
      name: row.name,
    };
    if (options.includeStats !== true) {
      return listing;
    }
    return {
      ...listing,
      stats: {
        averageTokensPerChunk: readOptionalFiniteNumber(
          row.averageTokensPerChunk,
          'averageTokensPerChunk'
        ),
        embeddedChunks: readOptionalFiniteNumber(row.embeddedChunks, 'embeddedChunks'),
        fileCount: readOptionalFiniteNumber(row.fileCount, 'fileCount'),
        tokenizedChunkCount: readOptionalFiniteNumber(
          row.tokenizedChunkCount,
          'tokenizedChunkCount'
        ),
        totalChunks: readOptionalFiniteNumber(row.totalChunks, 'totalChunks'),
        totalTokens: readOptionalFiniteNumber(row.totalTokens, 'totalTokens'),
      } satisfies EmbeddingSpaceStats,
    };
  }

  private async readEmbeddingSet(row: TursoEmbeddingSetRow): Promise<EmbeddingSet> {
    const embeddingSet = this.fromRow(row);
    const repairedMetadata = await repairPersistedEmbeddingSetMetadata(this.metadataDb(), {
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

  private metadataDb(): {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  } {
    return {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        const result = await this.db.query<T>(sql, params);
        return { rows: Array.from(result.rows) };
      },
    };
  }
}

async function seedCollectionIndexingStats(
  db: BrainstrikeDbTransactionClient,
  embeddingSetId: string
): Promise<void> {
  await db.exec(
    `INSERT OR IGNORE INTO collection_indexing_stats (
      embedding_set_id,
      file_count,
      chunk_count,
      embedded_chunk_count,
      pending_chunk_count,
      dirty,
      last_refreshed_at
    )
    VALUES (?, 0, 0, 0, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [embeddingSetId]
  );
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

function readDistance(value: EmbeddingDistance | null): EmbeddingDistance {
  if (value === 'cosine' || value === 'l2' || value === 'ip') {
    return value;
  }
  throw new Error(`Invalid embedding set distance: ${String(value)}`);
}
