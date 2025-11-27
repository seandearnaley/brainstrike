import { createLogger, generateUUID } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { ensureDimensionIndexExists } from '../migrations/dimension-index-helpers.js';
import type { EmbeddingDistance, EmbeddingSet } from '../models/embedding-set';

export class EmbeddingSetsRepository {
  private readonly logger = createLogger('EmbeddingSetsRepository');

  constructor(private db: PGlite) {}

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const id = generateUUID();
    const now = new Date().toISOString();

    // Generate default name if not provided
    const defaultName = `${modelKey} (${dimensions}D)`;
    const name = metadata?.name ?? defaultName;

    const insertResult = await this.db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at, name, description, tags, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        modelKey,
        modelId,
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
      throw new Error(`Failed to create embedding set for ${modelKey}/${dimensions}/${distance}`);
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
      modelKey,
      dimensions,
      distance,
      name,
    });
    return this.fromRow(insertResult.rows[0] as Record<string, unknown>);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const result = await this.db.query('SELECT * FROM embedding_sets WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? this.fromRow(row as Record<string, unknown>) : null;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[] | []> {
    const result = await this.db.query('SELECT * FROM embedding_sets WHERE model_key = $1', [
      modelKey,
    ]);
    return result.rows.map((row) => this.fromRow(row as Record<string, unknown>));
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
    if (row['name'] != null) result.name = String(row['name']);
    if (row['description'] != null) result.description = String(row['description']);
    if (row['tags'] != null) result.tags = String(row['tags']);
    if (row['category'] != null) result.category = String(row['category']);

    return result;
  }
}
