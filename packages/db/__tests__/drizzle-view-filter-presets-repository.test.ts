import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleViewFilterPresetsRepository } from '../src/repositories/drizzle/view-filter-presets-repository.js';
import * as schema from '../src/schema/index.js';
import { viewFilterPresets } from '../src/schema/index.js';

describe('DrizzleViewFilterPresetsRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleViewFilterPresetsRepository;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector, pg_trgm: pgTrgm },
    });
    const migrationResult = await runMigrations(client);
    if (!migrationResult.success) {
      throw new Error(`Migrations failed: ${migrationResult.error}`);
    }
    db = drizzle(client, { schema });
    repository = new DrizzleViewFilterPresetsRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('finds defaults and sorts them by sort order', async () => {
    await db.insert(viewFilterPresets).values({
      id: '00000000-0000-0000-0000-000000000103',
      name: 'Custom',
      description: null,
      icon: 'settings',
      includes: ['*.json'],
      excludes: [],
      useRegex: false,
      isDefault: false,
      sortOrder: 8,
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
      name: 'Custom Preset',
      includes: ['*.ts'],
      excludes: ['dist'],
    });

    expect(created.description).toBeNull();
    expect(created.icon).toBe('file');
    expect(created.useRegex).toBe(false);
    expect(created.isDefault).toBe(false);
    expect(created.sortOrder).toBe(8);

    const createdSecond = await repository.create({
      name: 'Regex Preset',
      includes: ['.*\\.test\\.ts$'],
      excludes: [],
      description: 'Regex only',
      icon: 'flask-conical',
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
      name: 'Before Update',
      description: 'original',
      icon: 'file-text',
      includes: ['*.md'],
      excludes: ['node_modules'],
      useRegex: false,
    });

    const updated = await repository.update(created.id, {
      name: 'After Update',
      includes: ['*.ts', '*.tsx'],
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
        id: '00000000-0000-0000-0000-000000000104',
        name: 'Protected Default',
        description: null,
        icon: 'shield',
        includes: ['*'],
        excludes: [],
        useRegex: false,
        isDefault: true,
        sortOrder: 1,
      })
      .returning();
    if (!firstDefault) {
      throw new Error('failed to insert default preset fixture');
    }

    expect(await repository.delete(firstDefault.id)).toBe(false);
    expect(await repository.getById(firstDefault.id)).not.toBeNull();
    expect(await repository.delete('00000000-0000-0000-0000-000000000000')).toBe(false);

    const custom = await repository.create({
      name: 'Delete Me',
      includes: ['*'],
      excludes: [],
    });
    expect(await repository.delete(custom.id)).toBe(true);
    expect(await repository.getById(custom.id)).toBeNull();
  });
});
