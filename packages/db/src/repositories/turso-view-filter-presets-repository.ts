import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { createLogger, generateUUID } from '@brainstrike/utils';
import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';
import type { IViewFilterPresetsRepository } from './interfaces.js';

interface TursoViewFilterPresetRow {
  readonly created_at: string;
  readonly description: string | null;
  readonly excludes: string;
  readonly icon: string;
  readonly id: string;
  readonly includes: string;
  readonly is_default: number;
  readonly name: string;
  readonly sort_order: number;
  readonly updated_at: string;
  readonly use_regex: number;
}

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

export class TursoViewFilterPresetsRepository implements IViewFilterPresetsRepository {
  private readonly logger = createLogger('TursoViewFilterPresetsRepository');

  constructor(private readonly db: BrainstrikeDbTransactionClient) {}

  async findAll(): Promise<ViewFilterPreset[]> {
    const result = await this.db.query<TursoViewFilterPresetRow>(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       ORDER BY sort_order ASC`
    );

    return result.rows.map((row) => this.fromRow(row));
  }

  async getById(id: string): Promise<ViewFilterPreset | null> {
    const result = await this.db.query<TursoViewFilterPresetRow>(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       WHERE id = ?`,
      [id]
    );

    const row = result.rows[0];
    return row ? this.fromRow(row) : null;
  }

  async getDefaults(): Promise<ViewFilterPreset[]> {
    const result = await this.db.query<TursoViewFilterPresetRow>(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
       FROM view_filter_presets
       WHERE is_default = 1
       ORDER BY sort_order ASC`
    );

    return result.rows.map((row) => this.fromRow(row));
  }

  async create(input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> {
    const id = generateUUID();
    const now = new Date().toISOString();
    const maxResult = await this.db.query<{ max_sort: number | null }>(
      'SELECT MAX(sort_order) AS max_sort FROM view_filter_presets'
    );
    const nextSortOrder = (maxResult.rows[0]?.max_sort ?? 0) + 1;

    await this.db.exec(
      `INSERT INTO view_filter_presets (
        id, name, description, icon, includes, excludes, use_regex, is_default, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.icon ?? 'file',
        JSON.stringify(input.includes),
        JSON.stringify(input.excludes),
        input.useRegex ? 1 : 0,
        nextSortOrder,
        now,
        now,
      ]
    );

    const created = await this.getById(id);
    if (!created) {
      throw new Error(`Failed to create view filter preset: ${input.name}`);
    }

    this.logger.info('Created Turso view filter preset', { id, name: input.name });
    return created;
  }

  async update(id: string, input: UpdateViewFilterPresetInput): Promise<ViewFilterPreset | null> {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [new Date().toISOString()];

    validateUpdateColumn('updated_at');
    updates.push('updated_at = ?');
    appendOptionalUpdate(updates, params, 'name', input.name);
    appendOptionalUpdate(updates, params, 'description', input.description);
    appendOptionalUpdate(updates, params, 'icon', input.icon);
    appendOptionalUpdate(
      updates,
      params,
      'includes',
      input.includes === undefined ? undefined : JSON.stringify(input.includes)
    );
    appendOptionalUpdate(
      updates,
      params,
      'excludes',
      input.excludes === undefined ? undefined : JSON.stringify(input.excludes)
    );
    appendOptionalUpdate(
      updates,
      params,
      'use_regex',
      input.useRegex === undefined ? undefined : input.useRegex ? 1 : 0
    );
    appendOptionalUpdate(updates, params, 'sort_order', input.sortOrder);
    params.push(id);

    await this.db.exec(`UPDATE view_filter_presets SET ${updates.join(', ')} WHERE id = ?`, params);

    this.logger.info('Updated Turso view filter preset', { id });
    return await this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) {
      return false;
    }
    if (existing.isDefault) {
      this.logger.warn('Attempted to delete Turso default preset', { id, name: existing.name });
      return false;
    }

    await this.db.exec('DELETE FROM view_filter_presets WHERE id = ?', [id]);
    return (await this.getById(id)) === null;
  }

  private fromRow(row: TursoViewFilterPresetRow): ViewFilterPreset {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon as ViewFilterPreset['icon'],
      includes: parseJsonStringArray(row.includes, 'includes', row.id),
      excludes: parseJsonStringArray(row.excludes, 'excludes', row.id),
      useRegex: row.use_regex === 1,
      isDefault: row.is_default === 1,
      sortOrder: row.sort_order,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

function appendOptionalUpdate(
  updates: string[],
  params: unknown[],
  column: string,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }
  validateUpdateColumn(column);
  updates.push(`${column} = ?`);
  params.push(value);
}

function validateUpdateColumn(column: string): void {
  if (!ALLOWED_UPDATE_COLUMNS.has(column)) {
    throw new Error(`Invalid column name for UPDATE: ${column}`);
  }
}

function parseJsonStringArray(value: string, column: string, id: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid Turso view filter preset ${column} JSON for preset ${id}.`);
  }
  return parsed;
}
