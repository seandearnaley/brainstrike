/**
 * Drizzle-based EmbeddingSets Repository
 *
 * This is the Drizzle ORM version of the EmbeddingSetsRepository.
 * It demonstrates the pattern for converting raw SQL repositories to Drizzle.
 */

import { createLogger, generateUUID } from '@brainstrike/utils';
import { eq } from 'drizzle-orm';
import { type DrizzleDb, extractRows } from '../../drizzle/database.js';
import { ensureDimensionIndexExists } from '../../migrations/dimension-index-helpers.js';
import type { EmbeddingDistance, EmbeddingSet } from '../../models/embedding-set.js';
import { embeddingSets } from '../../schema/index.js';

export class DrizzleEmbeddingSetsRepository {
  private readonly logger = createLogger('DrizzleEmbeddingSetsRepository');

  constructor(private readonly db: DrizzleDb) {}

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const id = generateUUID();
    const now = new Date();

    // Generate default name if not provided
    const defaultName = `${modelKey} (${dimensions}D)`;
    const name = metadata?.name ?? defaultName;

    const [insertedRow] = await this.db
      .insert(embeddingSets)
      .values({
        id,
        modelKey,
        modelId,
        dimensions,
        distance,
        createdAt: now,
        name,
        description: metadata?.description ?? null,
        tags: metadata?.tags ?? null,
        category: metadata?.category ?? null,
      })
      .returning();

    if (!insertedRow) {
      throw new Error(`Failed to create embedding set for ${modelKey}/${dimensions}/${distance}`);
    }

    // Ensure HNSW index exists for this dimension (idempotent, best-effort)
    try {
      // Note: This still uses raw SQL as index creation isn't supported by Drizzle query builder
      // Create adapter that conforms to DimensionIndexDb interface
      const dbAdapter = {
        exec: async (sqlQuery: string) => {
          await this.db.execute(sqlQuery);
        },
        query: async <T = unknown>(sqlQuery: string) => {
          const result = await this.db.execute(sqlQuery);
          return { rows: extractRows(result) as T[] };
        },
      };
      await ensureDimensionIndexExists(dbAdapter, dimensions);
    } catch (error) {
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

    return this.fromRow(insertedRow);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const [row] = await this.db.select().from(embeddingSets).where(eq(embeddingSets.id, id));

    return row ? this.fromRow(row) : null;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[]> {
    const rows = await this.db
      .select()
      .from(embeddingSets)
      .where(eq(embeddingSets.modelKey, modelKey));

    return rows.map((row) => this.fromRow(row));
  }

  async updateMetadata(
    id: string,
    metadata: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet | null> {
    // Build update object with only defined fields
    const updateData: Partial<typeof embeddingSets.$inferInsert> = {};
    if (metadata.name !== undefined) {
      updateData.name = metadata.name;
    }
    if (metadata.description !== undefined) {
      updateData.description = metadata.description;
    }
    if (metadata.tags !== undefined) {
      updateData.tags = metadata.tags;
    }
    if (metadata.category !== undefined) {
      updateData.category = metadata.category;
    }

    if (Object.keys(updateData).length === 0) {
      // No updates to make, just return current value
      return this.getById(id);
    }

    const [row] = await this.db
      .update(embeddingSets)
      .set(updateData)
      .where(eq(embeddingSets.id, id))
      .returning();

    return row ? this.fromRow(row) : null;
  }

  async findAll(): Promise<EmbeddingSet[]> {
    const rows = await this.db.select().from(embeddingSets);
    return rows.map((row) => this.fromRow(row));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(embeddingSets).where(eq(embeddingSets.id, id)).returning();

    return result.length > 0;
  }

  private fromRow(row: typeof embeddingSets.$inferSelect): EmbeddingSet {
    const base: EmbeddingSet = {
      id: row.id,
      modelKey: row.modelKey,
      modelId: row.modelId,
      dimensions: row.dimensions,
      distance: row.distance as EmbeddingDistance,
      createdAt: row.createdAt.toISOString(),
    };

    // Add optional metadata fields only if they exist
    if (row.name !== null) {
      base.name = row.name;
    }
    if (row.description !== null) {
      base.description = row.description;
    }
    if (row.tags !== null) {
      base.tags = row.tags;
    }
    if (row.category !== null) {
      base.category = row.category;
    }

    return base;
  }
}
