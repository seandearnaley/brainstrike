import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TursoViewFilterPresetsRepository } from '../src/repositories/turso-view-filter-presets-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoViewFilterPresetsRepository', () => {
  let client: TursoOwnerClient;
  let tempDir: string;
  let repository: TursoViewFilterPresetsRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-view-presets-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    repository = new TursoViewFilterPresetsRepository(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('reads seeded defaults from the Turso JSON/integer table shape', async () => {
    const defaults = await repository.getDefaults();

    expect(defaults).toHaveLength(7);
    expect(defaults[0]).toMatchObject({
      id: 'typescript-javascript',
      includes: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
      isDefault: true,
      useRegex: false,
    });
  });

  it('creates, updates, and deletes a user preset through the Turso owner client', async () => {
    const created = await repository.create({
      description: 'Docs and notes',
      excludes: ['node_modules', 'dist'],
      icon: 'file-text',
      includes: ['*.md', '*.mdx'],
      name: 'Docs',
      useRegex: true,
    });

    expect(created).toMatchObject({
      description: 'Docs and notes',
      excludes: ['node_modules', 'dist'],
      icon: 'file-text',
      includes: ['*.md', '*.mdx'],
      isDefault: false,
      name: 'Docs',
      useRegex: true,
    });

    await expect(repository.getById(created.id)).resolves.toMatchObject({
      id: created.id,
      includes: ['*.md', '*.mdx'],
      useRegex: true,
    });

    const updated = await repository.update(created.id, {
      excludes: ['coverage'],
      includes: ['*.md'],
      name: 'Markdown',
      sortOrder: 42,
      useRegex: false,
    });

    expect(updated).toMatchObject({
      excludes: ['coverage'],
      includes: ['*.md'],
      name: 'Markdown',
      sortOrder: 42,
      useRegex: false,
    });
    await expect(repository.delete(created.id)).resolves.toBe(true);
    await expect(repository.getById(created.id)).resolves.toBeNull();
  });

  it('refuses to delete seeded default presets', async () => {
    await expect(repository.delete('typescript-javascript')).resolves.toBe(false);
    await expect(repository.getById('typescript-javascript')).resolves.not.toBeNull();
  });

  it('reports the preset id and column when stored JSON is malformed', async () => {
    await client.exec('PRAGMA ignore_check_constraints = ON');
    await client.exec('UPDATE view_filter_presets SET includes = ? WHERE id = ?', [
      'not-json',
      'typescript-javascript',
    ]);

    await expect(repository.getById('typescript-javascript')).rejects.toThrow(
      'Invalid Turso view filter preset includes JSON for preset typescript-javascript.'
    );
  });
});
