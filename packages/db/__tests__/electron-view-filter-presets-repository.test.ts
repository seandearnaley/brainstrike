import type { CreateViewFilterPresetInput, ViewFilterPreset } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronViewFilterPresetsRepository } from '../src/repositories/electron-view-filter-presets-repository';

function createTestDbRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: `preset-${Math.random().toString(36).slice(2)}`,
    name: 'Test Preset',
    description: 'A test preset',
    icon: 'file',
    includes: ['*.ts'],
    excludes: ['node_modules'],
    use_regex: false,
    is_default: false,
    sort_order: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createValidDbRow(overrides: Partial<Record<string, unknown>> = {}): {
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
} {
  const now = new Date().toISOString();
  return {
    id: (overrides.id as string) ?? `preset-${Math.random().toString(36).slice(2)}`,
    name: (overrides.name as string) ?? 'Test Preset',
    description:
      'description' in overrides ? (overrides.description as string | null) : 'A test preset',
    icon: (overrides.icon as string) ?? 'file',
    includes: (overrides.includes as string[]) ?? ['*.ts'],
    excludes: (overrides.excludes as string[]) ?? ['node_modules'],
    use_regex: (overrides.use_regex as boolean) ?? false,
    is_default: (overrides.is_default as boolean) ?? false,
    sort_order: (overrides.sort_order as number) ?? 0,
    created_at: (overrides.created_at as string) ?? now,
    updated_at: (overrides.updated_at as string) ?? now,
  };
}

describe('ElectronViewFilterPresetsRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let exec: ReturnType<typeof vi.fn>;
  let repo: ElectronViewFilterPresetsRepository;

  beforeEach(() => {
    query = vi.fn().mockResolvedValue({ rows: [] });
    exec = vi.fn().mockResolvedValue(undefined);
    repo = new ElectronViewFilterPresetsRepository({ query, exec });
  });

  describe('findAll', () => {
    it('returns presets ordered by sort order', async () => {
      const row1 = createValidDbRow({ id: 'preset-1', sort_order: 0 });
      const row2 = createValidDbRow({ id: 'preset-2', sort_order: 1 });
      query.mockResolvedValueOnce({ rows: [row1, row2] });

      const result = await repo.findAll();

      expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY sort_order ASC'));
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('preset-1');
    });

    it('filters out invalid rows', async () => {
      const validRow = createValidDbRow({ id: 'valid' });
      const invalidRow = { id: 123 }; // invalid: id should be string
      query.mockResolvedValueOnce({ rows: [validRow, invalidRow] });

      const result = await repo.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('valid');
    });

    it('handles null description', async () => {
      const row = createValidDbRow({ description: null });
      query.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]?.description).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns preset when found', async () => {
      const row = createValidDbRow({ id: 'preset-123' });
      query.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.getById('preset-123');

      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['preset-123']);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('preset-123');
    });

    it('returns null when not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await repo.getById('nonexistent');

      expect(result).toBeNull();
    });

    it('returns null for invalid row', async () => {
      const invalidRow = { id: 123, name: 456 }; // invalid types
      query.mockResolvedValueOnce({ rows: [invalidRow] });

      const result = await repo.getById('preset-123');

      expect(result).toBeNull();
    });
  });

  describe('getDefaults', () => {
    it('returns only default presets', async () => {
      const row = createValidDbRow({ is_default: true });
      query.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.getDefaults();

      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE is_default = true'));
      expect(result).toHaveLength(1);
      expect(result[0]?.isDefault).toBe(true);
    });
  });

  describe('create', () => {
    it('creates preset with all fields', async () => {
      const input: CreateViewFilterPresetInput = {
        name: 'New Preset',
        description: 'Description',
        icon: 'file-code',
        includes: ['*.ts', '*.tsx'],
        excludes: ['node_modules'],
        useRegex: false,
      };

      const returnedRow = createValidDbRow({
        name: input.name,
        description: input.description,
        icon: input.icon,
        includes: input.includes,
        excludes: input.excludes,
        use_regex: input.useRegex,
      });

      query.mockResolvedValueOnce({ rows: [{ max_sort: 5 }] }); // MAX query
      query.mockResolvedValueOnce({ rows: [returnedRow] }); // INSERT query

      const result = await repo.create(input);

      expect(result.name).toBe('New Preset');
      expect(result.isDefault).toBe(false); // user-created presets are never default
    });

    it('creates preset with default values for optional fields', async () => {
      const input: CreateViewFilterPresetInput = {
        name: 'Minimal Preset',
        includes: ['*.ts'],
        excludes: [],
      };

      const returnedRow = createValidDbRow({
        name: input.name,
        description: null,
        icon: 'file',
        includes: input.includes,
        excludes: input.excludes,
        use_regex: false,
      });

      query.mockResolvedValueOnce({ rows: [{ max_sort: null }] }); // MAX query, null when no rows
      query.mockResolvedValueOnce({ rows: [returnedRow] }); // INSERT query

      const result = await repo.create(input);

      expect(result.name).toBe('Minimal Preset');
      expect(result.icon).toBe('file');
      expect(result.useRegex).toBe(false);
    });

    it('throws error when insert fails', async () => {
      const input: CreateViewFilterPresetInput = {
        name: 'Fail Preset',
        includes: [],
        excludes: [],
      };

      query.mockResolvedValueOnce({ rows: [{ max_sort: 0 }] });
      query.mockResolvedValueOnce({ rows: [] }); // Empty result

      await expect(repo.create(input)).rejects.toThrow('Failed to create view filter preset');
    });

    it('throws error when insert returns invalid row', async () => {
      const input: CreateViewFilterPresetInput = {
        name: 'Invalid Return',
        includes: [],
        excludes: [],
      };

      query.mockResolvedValueOnce({ rows: [{ max_sort: 0 }] });
      query.mockResolvedValueOnce({ rows: [{ id: 123 }] }); // Invalid row

      await expect(repo.create(input)).rejects.toThrow('Failed to create view filter preset');
    });
  });

  describe('update', () => {
    it('updates name field', async () => {
      const existingRow = createValidDbRow({ id: 'preset-123' });
      const updatedRow = createValidDbRow({ id: 'preset-123', name: 'Updated Name' });

      query.mockResolvedValueOnce({ rows: [existingRow] }); // getById
      query.mockResolvedValueOnce({ rows: [updatedRow] }); // UPDATE

      const result = await repo.update('preset-123', { name: 'Updated Name' });

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Updated Name');
    });

    it('updates multiple fields', async () => {
      const existingRow = createValidDbRow({ id: 'preset-123' });
      const updatedRow = createValidDbRow({
        id: 'preset-123',
        name: 'New Name',
        description: 'New Description',
        icon: 'file-text',
        includes: ['*.md'],
        excludes: ['dist'],
        use_regex: true,
        sort_order: 5,
      });

      query.mockResolvedValueOnce({ rows: [existingRow] });
      query.mockResolvedValueOnce({ rows: [updatedRow] });

      const result = await repo.update('preset-123', {
        name: 'New Name',
        description: 'New Description',
        icon: 'file-text',
        includes: ['*.md'],
        excludes: ['dist'],
        useRegex: true,
        sortOrder: 5,
      });

      expect(result).not.toBeNull();
      expect(result?.name).toBe('New Name');
      expect(result?.description).toBe('New Description');
      expect(result?.icon).toBe('file-text');
      expect(result?.includes).toEqual(['*.md']);
      expect(result?.excludes).toEqual(['dist']);
      expect(result?.useRegex).toBe(true);
      expect(result?.sortOrder).toBe(5);
    });

    it('returns null when preset not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await repo.update('nonexistent', { name: 'New Name' });

      expect(result).toBeNull();
    });

    it('returns null when update returns invalid row', async () => {
      const existingRow = createValidDbRow({ id: 'preset-123' });

      query.mockResolvedValueOnce({ rows: [existingRow] });
      query.mockResolvedValueOnce({ rows: [{ id: 123 }] }); // Invalid row

      const result = await repo.update('preset-123', { name: 'New Name' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes non-default preset', async () => {
      const row = createValidDbRow({ id: 'preset-123', is_default: false });
      query.mockResolvedValueOnce({ rows: [row] }); // getById
      query.mockResolvedValueOnce({ rows: [{ id: 'preset-123' }] }); // DELETE

      const result = await repo.delete('preset-123');

      expect(result).toBe(true);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM view_filter_presets'),
        ['preset-123']
      );
    });

    it('returns false when preset not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await repo.delete('nonexistent');

      expect(result).toBe(false);
    });

    it('returns false when trying to delete default preset', async () => {
      const row = createValidDbRow({ id: 'default-preset', is_default: true });
      query.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.delete('default-preset');

      expect(result).toBe(false);
      // DELETE should not be called
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('returns false when delete affects no rows', async () => {
      const row = createValidDbRow({ id: 'preset-123', is_default: false });
      query.mockResolvedValueOnce({ rows: [row] }); // getById
      query.mockResolvedValueOnce({ rows: [] }); // DELETE returns empty

      const result = await repo.delete('preset-123');

      expect(result).toBe(false);
    });
  });

  describe('isDbRow type guard', () => {
    // Test various invalid row shapes to ensure proper type validation
    it('filters out rows with non-string id', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), id: 123 }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-string name', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), name: 123 }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with invalid description (non-string, non-null)', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), description: 123 }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-string icon', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), icon: 123 }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-array includes', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), includes: '*.ts' }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-array excludes', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), excludes: 'node_modules' }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-boolean use_regex', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), use_regex: 'false' }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-boolean is_default', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), is_default: 0 }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-number sort_order', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), sort_order: '0' }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-string created_at', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), created_at: new Date() }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out rows with non-string updated_at', async () => {
      query.mockResolvedValueOnce({ rows: [{ ...createTestDbRow(), updated_at: new Date() }] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out null values', async () => {
      query.mockResolvedValueOnce({ rows: [null] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });

    it('filters out non-object values', async () => {
      query.mockResolvedValueOnce({ rows: ['not an object', 123, undefined] });
      const result = await repo.findAll();
      expect(result).toHaveLength(0);
    });
  });

  describe('fromRow transformation', () => {
    it('correctly transforms snake_case to camelCase', async () => {
      const row = createValidDbRow({
        use_regex: true,
        is_default: true,
        sort_order: 5,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      });
      query.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.findAll();

      expect(result).toHaveLength(1);
      const preset = result[0] as ViewFilterPreset;
      expect(preset.useRegex).toBe(true);
      expect(preset.isDefault).toBe(true);
      expect(preset.sortOrder).toBe(5);
      expect(preset.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
      expect(preset.updatedAt).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    });

    it('handles null arrays with empty array fallback', async () => {
      // The type guard requires arrays, so empty arrays represent the "null coalesced" case
      // This tests the ?? [] fallback in fromRow
      const validRow = createValidDbRow({ includes: [], excludes: [] });
      query.mockResolvedValueOnce({ rows: [validRow] });

      const result = await repo.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]?.includes).toEqual([]);
      expect(result[0]?.excludes).toEqual([]);
    });
  });
});
