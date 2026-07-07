/**
 * Drizzle-based View Filter Presets Repository
 *
 * Handles CRUD operations for view filter presets used in the file explorer.
 * Presets define include/exclude patterns for file filtering.
 */

import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { asc, eq } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { viewFilterPresets } from '../../schema/index.js';

type DrizzleDb = PgliteDatabase;

export class DrizzleViewFilterPresetsRepository {
  private readonly logger = createLogger('DrizzleViewFilterPresetsRepository');

  constructor(private readonly db: DrizzleDb) {}

  /**
   * Get all presets ordered by sort order.
   */
  async findAll(): Promise<ViewFilterPreset[]> {
    const rows = await this.db
      .select()
      .from(viewFilterPresets)
      .orderBy(asc(viewFilterPresets.sortOrder));

    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Get a preset by ID.
   */
  async getById(id: string): Promise<ViewFilterPreset | null> {
    const [row] = await this.db
      .select()
      .from(viewFilterPresets)
      .where(eq(viewFilterPresets.id, id));

    return row ? this.fromRow(row) : null;
  }

  /**
   * Get all default (built-in) presets.
   */
  async getDefaults(): Promise<ViewFilterPreset[]> {
    const rows = await this.db
      .select()
      .from(viewFilterPresets)
      .where(eq(viewFilterPresets.isDefault, true))
      .orderBy(asc(viewFilterPresets.sortOrder));

    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Create a new preset.
   */
  async create(input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> {
    const id = generateUUID();
    const now = new Date();

    // Get the next sort order
    const maxSortResult = await this.db
      .select({ sortOrder: viewFilterPresets.sortOrder })
      .from(viewFilterPresets)
      .orderBy(asc(viewFilterPresets.sortOrder));

    // Use reduce instead of spread to avoid stack overflow with large arrays
    const nextSortOrder = maxSortResult.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;

    const [insertedRow] = await this.db
      .insert(viewFilterPresets)
      .values({
        createdAt: now,
        description: input.description ?? null,
        excludes: input.excludes,
        icon: input.icon ?? 'file',
        id,
        includes: input.includes,
        isDefault: false,
        name: input.name,
        sortOrder: nextSortOrder,
        updatedAt: now,
        useRegex: input.useRegex ?? false,
      })
      .returning();

    if (!insertedRow) {
      throw new Error(`Failed to create view filter preset: ${input.name}`);
    }

    this.logger.info('Created view filter preset', {
      id,
      name: input.name,
    });

    return this.fromRow(insertedRow);
  }

  /**
   * Update an existing preset.
   * Cannot update default presets' isDefault flag.
   */
  async update(id: string, input: UpdateViewFilterPresetInput): Promise<ViewFilterPreset | null> {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    // Build update object with only defined fields
    const updateData: Partial<typeof viewFilterPresets.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) {
      updateData.name = input.name;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (input.icon !== undefined) {
      updateData.icon = input.icon;
    }
    if (input.includes !== undefined) {
      updateData.includes = input.includes;
    }
    if (input.excludes !== undefined) {
      updateData.excludes = input.excludes;
    }
    if (input.useRegex !== undefined) {
      updateData.useRegex = input.useRegex;
    }
    if (input.sortOrder !== undefined) {
      updateData.sortOrder = input.sortOrder;
    }

    const [row] = await this.db
      .update(viewFilterPresets)
      .set(updateData)
      .where(eq(viewFilterPresets.id, id))
      .returning();

    this.logger.info('Updated view filter preset', { id });

    return row ? this.fromRow(row) : null;
  }

  /**
   * Delete a preset.
   * Cannot delete default (built-in) presets.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) {
      return false;
    }

    if (existing.isDefault) {
      this.logger.warn('Attempted to delete default preset', { id, name: existing.name });
      return false;
    }

    const result = await this.db
      .delete(viewFilterPresets)
      .where(eq(viewFilterPresets.id, id))
      .returning();

    if (result.length > 0) {
      this.logger.info('Deleted view filter preset', { id });
      return true;
    }

    return false;
  }

  /**
   * Convert a database row to a ViewFilterPreset.
   */
  private fromRow(row: typeof viewFilterPresets.$inferSelect): ViewFilterPreset {
    return {
      createdAt: row.createdAt,
      description: row.description,
      excludes: row.excludes ?? [],
      icon: row.icon as ViewFilterPreset['icon'],
      id: row.id,
      includes: row.includes ?? [],
      isDefault: row.isDefault,
      name: row.name,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt,
      useRegex: row.useRegex,
    };
  }
}
