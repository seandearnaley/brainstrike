import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration071OpenRouterJulyCodingModels } from '../src/migrations/071-openrouter-july-coding-models.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

const targetIds = [
  'poolside/laguna-s-2.1',
  'poolside/laguna-xs-2.1',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash-lite',
  'meituan/longcat-2.0',
  'thinkingmachines/inkling',
  'kwaipilot/kat-coder-air-v2.5',
  'kwaipilot/kat-coder-pro-v2.5',
  'x-ai/grok-4.5',
];
const migration = migration071OpenRouterJulyCodingModels;
type ModelRow = Record<string, unknown> & {
  id: string;
  is_enabled: boolean;
  provider_id: string;
  sort_order: number;
};

describe('migration 071 catalog rollback semantics', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('rollback-071'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((candidate) => candidate.version < 71));
    await db.query(
      `INSERT INTO models
      (id, provider_id, name, capabilities, sort_order, is_enabled, created_at, updated_at)
      VALUES ($1, 'openrouter', 'User-authored fixture', '{"type":"llm"}', 20, true,
              '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z')`,
      [targetIds[0]]
    );
  });

  afterEach(async () => {
    await db.close();
  });

  async function readModels(): Promise<ModelRow[]> {
    return (await db.query<ModelRow>('SELECT * FROM models ORDER BY id')).rows;
  }

  it('preserves conflict-row intent on up but cannot recover that intent after down', async () => {
    const before = await readModels();
    const others = before.filter((row) => !targetIds.includes(row.id));
    const original = before.find((row) => row.id === targetIds[0]);
    expect(original).toBeDefined();
    await runner.runMigration(migration);
    const applied = await readModels();
    const target = applied.find((row) => row.id === targetIds[0]);
    expect(target).toMatchObject({
      created_at: original?.['created_at'],
      is_enabled: true,
      name: 'Laguna S 2.1 (OpenRouter)',
      sort_order: 1,
      updated_at: original?.['updated_at'],
    });
    expect(applied.filter((row) => !targetIds.includes(row.id))).toEqual(
      others.map((row) =>
        row.provider_id === 'openrouter' ? { ...row, sort_order: row.sort_order + 9 } : row
      )
    );
    expect(applied.filter((row) => targetIds.includes(row.id)).map((row) => row.id)).toEqual(
      [...targetIds].sort()
    );
    await runner.runMigration(migration);
    expect(await readModels()).toEqual(applied);

    await runner.rollback(migration);
    expect(await runner.isApplied(71)).toBe(false);
    expect(await readModels()).toEqual(others);
    // Only the runner's ledger skip is idempotent; raw down shifts ordering again.
    await runner.rollback(migration);
    expect(await readModels()).toEqual(others);
    await runner.runMigration(migration);
    expect(await runner.isApplied(71)).toBe(true);
    const rebuilt = await readModels();
    expect(rebuilt.filter((row) => targetIds.includes(row.id))).toHaveLength(9);
    expect(
      rebuilt.filter((row) => targetIds.includes(row.id)).every((row) => !row.is_enabled)
    ).toBe(true);
  });

  it('does not delete a targeted id now owned by another provider', async () => {
    await runner.runMigration(migration);
    await db.query('UPDATE models SET provider_id = $1 WHERE id = $2', ['anthropic', targetIds[0]]);
    const before = await readModels();
    const protectedRows = before.filter((row) => row.provider_id !== 'openrouter');
    expect(protectedRows.some((row) => row.id === targetIds[0])).toBe(true);
    await runner.rollback(migration);
    expect((await readModels()).filter((row) => row.provider_id !== 'openrouter')).toEqual(
      protectedRows
    );
  });

  it('restores deleted catalog rows and the ledger when the later order update fails', async () => {
    await runner.runMigration(migration);
    const before = await readModels();
    await db.exec(`
      CREATE FUNCTION rollback_reject_shift() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM models WHERE id = 'poolside/laguna-s-2.1') THEN
          RAISE EXCEPTION 'target DELETE must precede order shift';
        END IF;
        RAISE EXCEPTION 'fixture rejects order shift after target deletion';
      END $$;
      CREATE TRIGGER rollback_reject_shift BEFORE UPDATE OF sort_order ON models
        FOR EACH ROW EXECUTE FUNCTION rollback_reject_shift();
    `);
    await expect(runner.rollback(migration)).rejects.toThrow('fixture rejects order shift');
    expect(await runner.isApplied(71)).toBe(true);
    expect(await readModels()).toEqual(before);
    await db.exec(
      'DROP TRIGGER rollback_reject_shift ON models; DROP FUNCTION rollback_reject_shift()'
    );
    await runner.rollback(migration);
    expect(await runner.isApplied(71)).toBe(false);
    expect((await readModels()).some((row) => targetIds.includes(row.id))).toBe(false);
  });
});
