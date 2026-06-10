/**
 * Drizzle-based EmbeddingSets Repository
 *
 * This is the Drizzle ORM version of the EmbeddingSetsRepository.
 * It demonstrates the pattern for converting raw SQL repositories to Drizzle.
 */

import { createLogger, generateUUID } from '@brainstrike/utils';
import { eq } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import {
  createDeferredDimensionIndexBuilder,
  type DeferredDimensionIndexBuilder,
} from '../../migrations/dimension-index-helpers.js';
import {
  type EmbeddingDistance,
  type EmbeddingSet,
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS,
  WORKSPACE_INDEX_SYSTEM_ROLE,
} from '../../models/embedding-set.js';
import { collectionIndexingStats, embeddingSets } from '../../schema/index.js';
import {
  normalizeEmbeddingSetInputMetadata,
  repairPersistedEmbeddingSetMetadata,
  tryResolveEmbeddingSetMetadata,
} from '../embedding-set-metadata.js';

type DrizzleDb = PgliteDatabase;

export class DrizzleEmbeddingSetsRepository {
  private readonly logger = createLogger('DrizzleEmbeddingSetsRepository');

  // Deferred so a long HNSW build never blocks embedding-set creation. getDb /
  // onError read this lazily (the field initializes before the constructor
  // parameter property is assigned).
  private readonly dimensionIndexBuilder: DeferredDimensionIndexBuilder =
    createDeferredDimensionIndexBuilder({
      getDb: () => this.createQueryAdapter(),
      onError: (dimension, error) => {
        this.logger.warn('Failed to ensure dimension index exists', {
          dimension,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

  constructor(private readonly db: DrizzleDb) {}

  /**
   * Await any in-flight deferred HNSW index builds (snapshot at call time).
   * Used by tests that need the index materialized before asserting on it, and
   * available for future shutdown coordination — production shutdown does NOT
   * currently drain builds: a build lost to shutdown is benign because
   * CREATE INDEX IF NOT EXISTS self-heals on the next getOrCreate* call. The
   * workspace dimension re-schedules on every launch; a user-created set on a
   * unique dimension only re-schedules when another same-dimension set is
   * created, so its searches stay on a seq scan until then (slower, correct).
   */
  waitForPendingDimensionIndexBuilds(): Promise<void> {
    return this.dimensionIndexBuilder.whenSettled();
  }

  async getOrCreateWorkspaceIndexSet(): Promise<EmbeddingSet> {
    const dbAdapter = this.createQueryAdapter();
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(dbAdapter, {
      modelKey: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelKey,
      modelId: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.modelId,
    });
    const now = new Date();

    const row = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(embeddingSets)
        .where(eq(embeddingSets.systemRole, WORKSPACE_INDEX_SYSTEM_ROLE))
        .limit(1);

      if (existing) {
        await tx
          .insert(collectionIndexingStats)
          .values({ embeddingSetId: existing.id })
          .onConflictDoNothing();
        return existing;
      }

      const id = generateUUID();
      const [inserted] = await tx
        .insert(embeddingSets)
        .values({
          id,
          modelKey: normalizedMetadata.modelKey,
          modelId: normalizedMetadata.modelId,
          dimensions: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions,
          distance: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.distance,
          createdAt: now,
          name: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.name,
          description: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.description,
          tags: null,
          category: null,
          systemRole: WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.systemRole,
        })
        .onConflictDoNothing()
        .returning();

      const [selected] =
        inserted === undefined
          ? await tx
              .select()
              .from(embeddingSets)
              .where(eq(embeddingSets.systemRole, WORKSPACE_INDEX_SYSTEM_ROLE))
              .limit(1)
          : [inserted];

      if (!selected) {
        throw new Error('Failed to create or load the workspace index embedding set.');
      }

      await tx
        .insert(collectionIndexingStats)
        .values({ embeddingSetId: selected.id })
        .onConflictDoNothing();
      return selected;
    });

    this.dimensionIndexBuilder.schedule(WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS.dimensions);

    return this.readEmbeddingSet(row);
  }

  async getOrCreateSet(
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ): Promise<EmbeddingSet> {
    const dbAdapter = this.createQueryAdapter();
    const normalizedMetadata = await normalizeEmbeddingSetInputMetadata(dbAdapter, {
      modelKey,
      modelId,
    });
    const id = generateUUID();
    const now = new Date();

    // Generate default name if not provided
    const defaultName = `${normalizedMetadata.modelId} (${dimensions}D)`;
    const name = metadata?.name ?? defaultName;

    const insertedRow = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(embeddingSets)
        .values({
          id,
          modelKey: normalizedMetadata.modelKey,
          modelId: normalizedMetadata.modelId,
          dimensions,
          distance,
          createdAt: now,
          name,
          description: metadata?.description ?? null,
          tags: metadata?.tags ?? null,
          category: metadata?.category ?? null,
        })
        .returning();

      await tx.insert(collectionIndexingStats).values({ embeddingSetId: id }).onConflictDoNothing();

      return row;
    });

    if (!insertedRow) {
      throw new Error(
        `Failed to create embedding set for ${normalizedMetadata.modelKey}/${dimensions}/${distance}`
      );
    }

    this.dimensionIndexBuilder.schedule(dimensions);

    this.logger.info('Created new embedding set', {
      id,
      modelKey: normalizedMetadata.modelKey,
      dimensions,
      distance,
      name,
    });

    return this.fromRow(insertedRow);
  }

  async getById(id: string): Promise<EmbeddingSet | null> {
    const [row] = await this.db.select().from(embeddingSets).where(eq(embeddingSets.id, id));

    return row ? this.readEmbeddingSet(row) : null;
  }

  async getByModelKey(modelKey: string): Promise<EmbeddingSet[]> {
    const normalizedLookupKey =
      (
        await tryResolveEmbeddingSetMetadata(this.createQueryAdapter(), {
          modelKey,
          modelId: '',
        })
      )?.modelKey ?? modelKey;
    const rows = await this.db
      .select()
      .from(embeddingSets)
      .where(eq(embeddingSets.modelKey, normalizedLookupKey));

    return Promise.all(rows.map((row) => this.readEmbeddingSet(row)));
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
    return Promise.all(rows.map((row) => this.readEmbeddingSet(row)));
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
    if (row.systemRole === WORKSPACE_INDEX_SYSTEM_ROLE) {
      base.systemRole = WORKSPACE_INDEX_SYSTEM_ROLE;
    }

    return base;
  }

  private createQueryAdapter(): {
    exec: (sql: string) => Promise<void>;
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  } {
    const rawDb =
      '$client' in this.db
        ? (this.db.$client as {
            exec: (sql: string) => Promise<unknown>;
            query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
          })
        : null;
    return {
      exec: async (sql: string) => {
        if (rawDb) {
          await rawDb.exec(sql);
          return;
        }
        await this.db.execute(sql);
      },
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        if (rawDb) {
          const result = await rawDb.query<T>(sql, params);
          return { rows: result.rows };
        }
        const result = await this.db.execute(sql);
        return { rows: result.rows as T[] };
      },
    };
  }

  private async readEmbeddingSet(row: typeof embeddingSets.$inferSelect): Promise<EmbeddingSet> {
    const embeddingSet = this.fromRow(row);
    const repairedMetadata = await repairPersistedEmbeddingSetMetadata(this.createQueryAdapter(), {
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
