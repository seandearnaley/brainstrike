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
  created_at: string;
  description: string | null;
  excludes: string[];
  icon: string;
  id: string;
  includes: string[];
  is_default: boolean;
  name: string;
  sort_order: number;
  updated_at: string;
  use_regex: boolean;
}

/**
 * Allowed column names for dynamic UPDATE queries.
 * This prevents SQL injection by validating column names against a whitelist.
 */
const ALLOWED_UPDATE_COLUMNS = new Set([
  'name',
  'description',
  'icon',
  'includes',
  'excludes',
  'use_regex',
  'sort_order',
  'updated_at',
]);

/**
 * Type guard to validate that a value conforms to the DbRow interface.
 * Provides runtime validation for type assertions.
 */
function isDbRow(value: unknown): value is DbRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['name'] === 'string' &&
    (obj['description'] === null || typeof obj['description'] === 'string') &&
    typeof obj['icon'] === 'string' &&
    Array.isArray(obj['includes']) &&
    Array.isArray(obj['excludes']) &&
    typeof obj['use_regex'] === 'boolean' &&
    typeof obj['is_default'] === 'boolean' &&
    typeof obj['sort_order'] === 'number' &&
    typeof obj['created_at'] === 'string' &&
    typeof obj['updated_at'] === 'string'
  );
}

/**
 * Validates that a column name is in the allowed list for UPDATE queries.
 * Throws an error if the column is not allowed, preventing SQL injection.
 */
function validateUpdateColumn(column: string): void {
  if (!ALLOWED_UPDATE_COLUMNS.has(column)) {
    throw new Error(`Invalid column name for UPDATE: ${column}`);
  }
}

export class ElectronViewFilterPresetsRepository implements IViewFilterPresetsRepository {
  private readonly logger = createLogger('ElectronViewFilterPresetsRepository');

  constructor(private readonly db: ElectronDbAPI) {}

  /**
   * Get all presets ordered by sort order.
   */
  async findAll(): Promise<ViewFilterPreset[]> {
    // Cast UUID and TIMESTAMPTZ columns to text for consistent serialization across IPC
    const result = await this.db.query(
      `SELECT id::text, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at::text, updated_at::text
       FROM view_filter_presets
       ORDER BY sort_order ASC`
    );

    return result.rows.filter(isDbRow).map((row) => this.fromRow(row));
  }

  /**
   * Get a preset by ID.
   */
  async getById(id: string): Promise<ViewFilterPreset | null> {
    // Cast UUID and TIMESTAMPTZ columns to text for consistent serialization across IPC
    const result = await this.db.query(
      `SELECT id::text, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at::text, updated_at::text
       FROM view_filter_presets
       WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];
    return row && isDbRow(row) ? this.fromRow(row) : null;
  }

  /**
   * Get all default (built-in) presets.
   */
  async getDefaults(): Promise<ViewFilterPreset[]> {
    // Cast UUID and TIMESTAMPTZ columns to text for consistent serialization across IPC
    const result = await this.db.query(
      `SELECT id::text, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at::text, updated_at::text
       FROM view_filter_presets
       WHERE is_default = true
       ORDER BY sort_order ASC`
    );

    return result.rows.filter(isDbRow).map((row) => this.fromRow(row));
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

    // Cast UUID and TIMESTAMPTZ columns to text in RETURNING for consistent serialization
    const result = await this.db.query(
      `INSERT INTO view_filter_presets (id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id::text, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at::text, updated_at::text`,
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

    const row = result.rows[0];
    if (!(row && isDbRow(row))) {
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
    // Column names are validated against ALLOWED_UPDATE_COLUMNS for defense-in-depth
    const updates: string[] = [];
    const params: unknown[] = [id, new Date().toISOString()];
    let paramIndex = 3;

    // Always include updated_at
    validateUpdateColumn('updated_at');
    updates.push('updated_at = $2');

    if (input.name !== undefined) {
      validateUpdateColumn('name');
      updates.push(`name = $${paramIndex}`);
      params.push(input.name);
      paramIndex++;
    }
    if (input.description !== undefined) {
      validateUpdateColumn('description');
      updates.push(`description = $${paramIndex}`);
      params.push(input.description);
      paramIndex++;
    }
    if (input.icon !== undefined) {
      validateUpdateColumn('icon');
      updates.push(`icon = $${paramIndex}`);
      params.push(input.icon);
      paramIndex++;
    }
    if (input.includes !== undefined) {
      validateUpdateColumn('includes');
      updates.push(`includes = $${paramIndex}`);
      params.push(input.includes);
      paramIndex++;
    }
    if (input.excludes !== undefined) {
      validateUpdateColumn('excludes');
      updates.push(`excludes = $${paramIndex}`);
      params.push(input.excludes);
      paramIndex++;
    }
    if (input.useRegex !== undefined) {
      validateUpdateColumn('use_regex');
      updates.push(`use_regex = $${paramIndex}`);
      params.push(input.useRegex);
      paramIndex++;
    }
    if (input.sortOrder !== undefined) {
      validateUpdateColumn('sort_order');
      updates.push(`sort_order = $${paramIndex}`);
      params.push(input.sortOrder);
      paramIndex++;
    }

    // Cast UUID and TIMESTAMPTZ columns to text in RETURNING for consistent serialization
    const result = await this.db.query(
      `UPDATE view_filter_presets
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING id::text, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at::text, updated_at::text`,
      params
    );

    const row = result.rows[0];
    if (!(row && isDbRow(row))) {
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
   * Note: includes/excludes are guaranteed non-null by schema (NOT NULL DEFAULT '{}')
   * and validated by isDbRow type guard (Array.isArray check).
   */
  private fromRow(row: DbRow): ViewFilterPreset {
    return {
      createdAt: new Date(row.created_at),
      description: row.description,
      excludes: row.excludes,
      icon: row.icon as ViewFilterPreset['icon'],
      id: row.id,
      includes: row.includes,
      isDefault: row.is_default,
      name: row.name,
      sortOrder: row.sort_order,
      updatedAt: new Date(row.updated_at),
      useRegex: row.use_regex,
    };
  }
}
