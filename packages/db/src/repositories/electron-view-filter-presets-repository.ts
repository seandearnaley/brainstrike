/**
 * Electron IPC implementation of View Filter Presets Repository
 *
 * Used in Electron renderer process to communicate with main process database
 * for view filter presets CRUD operations.
 */

import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { createLogger, generateUUID } from '@brainstrike/utils';
import type { ElectronDbAPI } from './electron-file-record-repository.js';
import type { IViewFilterPresetsRepository } from './interfaces.js';

interface DbRow {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  includes: string[];
  excludes: string[];
  use_regex: boolean;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export class ElectronViewFilterPresetsRepository implements IViewFilterPresetsRepository {
  private readonly logger = createLogger('ElectronViewFilterPresetsRepository');

  constructor(private readonly db: ElectronDbAPI) {}

  /**
   * Get all presets ordered by sort order.
   */
  async findAll(): Promise<ViewFilterPreset[]> {
    const result = await this.db.query(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       ORDER BY sort_order ASC`
    );

    return (result.rows as DbRow[]).map((row) => this.fromRow(row));
  }

  /**
   * Get a preset by ID.
   */
  async getById(id: string): Promise<ViewFilterPreset | null> {
    const result = await this.db.query(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       WHERE id = $1`,
      [id]
    );

    const row = result.rows[0] as DbRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  /**
   * Get all default (built-in) presets.
   */
  async getDefaults(): Promise<ViewFilterPreset[]> {
    const result = await this.db.query(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       WHERE is_default = true
       ORDER BY sort_order ASC`
    );

    return (result.rows as DbRow[]).map((row) => this.fromRow(row));
  }

  /**
   * Create a new preset.
   */
  async create(input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> {
    const id = generateUUID();
    const now = new Date().toISOString();

    // Get the next sort order
    const maxResult = await this.db.query(
      'SELECT MAX(sort_order) as max_sort FROM view_filter_presets'
    );
    const maxRow = maxResult.rows[0] as { max_sort: number | null } | undefined;
    const nextSortOrder = (maxRow?.max_sort ?? 0) + 1;

    const result = await this.db.query(
      `INSERT INTO view_filter_presets (id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at`,
      [
        id,
        input.name,
        input.description ?? null,
        input.icon ?? 'file',
        input.includes,
        input.excludes,
        input.useRegex ?? false,
        false, // isDefault - user-created presets are never default
        nextSortOrder,
        now,
        now,
      ]
    );

    const row = result.rows[0] as DbRow | undefined;
    if (!row) {
      throw new Error(`Failed to create view filter preset: ${input.name}`);
    }

    this.logger.info('Created view filter preset', { id, name: input.name });

    return this.fromRow(row);
  }

  /**
   * Update an existing preset.
   */
  async update(id: string, input: UpdateViewFilterPresetInput): Promise<ViewFilterPreset | null> {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    // Build SET clause dynamically based on provided fields
    const updates: string[] = ['updated_at = $2'];
    const params: unknown[] = [id, new Date().toISOString()];
    let paramIndex = 3;

    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(input.name);
      paramIndex++;
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(input.description);
      paramIndex++;
    }
    if (input.icon !== undefined) {
      updates.push(`icon = $${paramIndex}`);
      params.push(input.icon);
      paramIndex++;
    }
    if (input.includes !== undefined) {
      updates.push(`includes = $${paramIndex}`);
      params.push(input.includes);
      paramIndex++;
    }
    if (input.excludes !== undefined) {
      updates.push(`excludes = $${paramIndex}`);
      params.push(input.excludes);
      paramIndex++;
    }
    if (input.useRegex !== undefined) {
      updates.push(`use_regex = $${paramIndex}`);
      params.push(input.useRegex);
      paramIndex++;
    }
    if (input.sortOrder !== undefined) {
      updates.push(`sort_order = $${paramIndex}`);
      params.push(input.sortOrder);
      paramIndex++;
    }

    const result = await this.db.query(
      `UPDATE view_filter_presets
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at`,
      params
    );

    const row = result.rows[0] as DbRow | undefined;
    if (!row) {
      return null;
    }

    this.logger.info('Updated view filter preset', { id });

    return this.fromRow(row);
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

    const result = await this.db.query(
      'DELETE FROM view_filter_presets WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length > 0) {
      this.logger.info('Deleted view filter preset', { id });
      return true;
    }

    return false;
  }

  /**
   * Convert a database row to a ViewFilterPreset.
   */
  private fromRow(row: DbRow): ViewFilterPreset {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon as ViewFilterPreset['icon'],
      includes: row.includes ?? [],
      excludes: row.excludes ?? [],
      useRegex: row.use_regex,
      isDefault: row.is_default,
      sortOrder: row.sort_order,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
