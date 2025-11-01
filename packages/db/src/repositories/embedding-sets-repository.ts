import { generateUUID } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type { EmbeddingDistance, EmbeddingSet } from '../models/embedding-set';

export class EmbeddingSetsRepository {
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

    // Use INSERT ... ON CONFLICT atomically to prevent race conditions
    // On conflict, DO NOTHING and then fetch the existing row
    const insertResult = await this.db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at, name, description, tags, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (model_key, dimensions, distance) DO NOTHING
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

    // If insert succeeded, return the new row
    if (insertResult.rows.length > 0) {
      console.log('[EmbeddingSetsRepo] Created new embedding set:', {
        id,
        modelKey,
        dimensions,
        distance,
        name,
      });
      return this.fromRow(insertResult.rows[0] as Record<string, unknown>);
    }

    // If conflict occurred, fetch the existing row
    const existing = await this.getByComposite(modelKey, dimensions, distance);
    if (!existing) {
      throw new Error(
        `Failed to get or create embedding set for ${modelKey}/${dimensions}/${distance}`
      );
    }

    console.log('[EmbeddingSetsRepo] Reusing existing embedding set:', {
      id: existing.id,
      modelKey,
      dimensions,
      distance,
      name: existing.name,
    });
    return existing;
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

  private async getByComposite(
    modelKey: string,
    dimensions: number,
    distance: EmbeddingDistance
  ): Promise<EmbeddingSet | null> {
    const result = await this.db.query(
      'SELECT * FROM embedding_sets WHERE model_key = $1 AND dimensions = $2 AND distance = $3',
      [modelKey, dimensions, distance]
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
