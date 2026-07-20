import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleViewFilterPresetsRepository } from '../src/repositories/drizzle/view-filter-presets-repository.js';
import * as schema from '../src/schema/index.js';
import { viewFilterPresets } from '../src/schema/index.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('DrizzleViewFilterPresetsRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleViewFilterPresetsRepository;

  beforeEach(async () => {
    client = await createMigratedTestDb();
    db = drizzle(client, { schema });
    repository = new DrizzleViewFilterPresetsRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('finds defaults and sorts them by sort order', async () => {
    await db.insert(viewFilterPresets).values({
      description: null,
      excludes: [],
      icon: 'settings',
      id: '00000000-0000-0000-0000-000000000103',
      includes: ['*.json'],
      isDefault: false,
      name: 'Custom',
      sortOrder: 8,
      useRegex: false,
    });

    const defaults = await repository.getDefaults();
    const all = await repository.findAll();

    expect(defaults.length).toBe(7);
    expect(defaults.every((preset) => preset.isDefault)).toBe(true);
    expect(defaults.map((preset) => preset.name)).toEqual([
      'TypeScript/JavaScript',
      'All Code',
      'Documentation',
      'Config Files',
      'Styles',
      'Tests',
      'All Files',
    ]);
    expect(defaults.map((preset) => preset.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all.length).toBe(8);
  });

  it('creates presets with defaults and increments sort order from existing rows', async () => {
    const created = await repository.create({
      excludes: ['dist'],
      includes: ['*.ts'],
      name: 'Custom Preset',
    });

    expect(created.description).toBeNull();
    expect(created.icon).toBe('file');
    expect(created.useRegex).toBe(false);
    expect(created.isDefault).toBe(false);
    expect(created.sortOrder).toBe(8);

    const createdSecond = await repository.create({
      description: 'Regex only',
      excludes: [],
      icon: 'flask-conical',
      includes: ['.*\\.test\\.ts$'],
      name: 'Regex Preset',
      useRegex: true,
    });

    expect(createdSecond.sortOrder).toBe(9);
    expect(createdSecond.description).toBe('Regex only');
    expect(createdSecond.icon).toBe('flask-conical');
    expect(createdSecond.useRegex).toBe(true);
  });

  it('returns null when getById misses and update misses', async () => {
    expect(await repository.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(
      await repository.update('00000000-0000-0000-0000-000000000000', { name: 'x' })
    ).toBeNull();
  });

  it('updates only provided fields and keeps non-updated fields intact', async () => {
    const created = await repository.create({
      description: 'original',
      excludes: ['node_modules'],
      icon: 'file-text',
      includes: ['*.md'],
      name: 'Before Update',
      useRegex: false,
    });

    const updated = await repository.update(created.id, {
      includes: ['*.ts', '*.tsx'],
      name: 'After Update',
      sortOrder: 42,
    });

    expect(updated).not.toBeNull();
    expect(updated?.name).toBe('After Update');
    expect(updated?.includes).toEqual(['*.ts', '*.tsx']);
    expect(updated?.sortOrder).toBe(42);
    expect(updated?.description).toBe('original');
    expect(updated?.icon).toBe('file-text');
    expect(updated?.excludes).toEqual(['node_modules']);
    expect(updated?.useRegex).toBe(false);
  });

  it('prevents deleting defaults and deletes custom presets', async () => {
    const [firstDefault] = await db
      .insert(viewFilterPresets)
      .values({
        description: null,
        excludes: [],
        icon: 'shield',
        id: '00000000-0000-0000-0000-000000000104',
        includes: ['*'],
        isDefault: true,
        name: 'Protected Default',
        sortOrder: 1,
        useRegex: false,
      })
      .returning();
    if (!firstDefault) {
      throw new Error('failed to insert default preset fixture');
    }

    expect(await repository.delete(firstDefault.id)).toBe(false);
    expect(await repository.getById(firstDefault.id)).not.toBeNull();
    expect(await repository.delete('00000000-0000-0000-0000-000000000000')).toBe(false);

    const custom = await repository.create({
      excludes: [],
      includes: ['*'],
      name: 'Delete Me',
    });
    expect(await repository.delete(custom.id)).toBe(true);
    expect(await repository.getById(custom.id)).toBeNull();
  });
});
