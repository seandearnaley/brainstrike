import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('gemma local llm migration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-gemma-migration');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('restores legacy built-in local models when rolling back migration 028', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((entry) => entry.version <= 28));

    const beforeRollback = await db.query(`
        SELECT id
        FROM models
        WHERE id IN (
          'onnx-community/gemma-4-E2B-it-ONNX',
          'onnx-community/functiongemma-270m-it-ONNX',
          'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
          'onnx-community/Qwen3-0.6B-ONNX'
        )
        ORDER BY id
      `);
    const beforeIds = beforeRollback.rows.map((row) => (row as { id: string }).id);
    expect(beforeIds).toContain('onnx-community/gemma-4-E2B-it-ONNX');
    expect(beforeIds).not.toContain('onnx-community/functiongemma-270m-it-ONNX');
    expect(beforeIds).not.toContain('LiquidAI/LFM2.5-1.2B-Instruct-ONNX');
    expect(beforeIds).not.toContain('onnx-community/Qwen3-0.6B-ONNX');

    await runner.down(migrations, 27);

    const afterRollback = await db.query(`
        SELECT id
        FROM models
        WHERE id IN (
          'onnx-community/gemma-4-E2B-it-ONNX',
          'onnx-community/functiongemma-270m-it-ONNX',
          'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
          'onnx-community/Qwen3-0.6B-ONNX'
        )
        ORDER BY id
      `);
    const afterIds = afterRollback.rows.map((row) => (row as { id: string }).id);
    expect(afterIds).not.toContain('onnx-community/gemma-4-E2B-it-ONNX');
    expect(afterIds).toContain('onnx-community/functiongemma-270m-it-ONNX');
    expect(afterIds).toContain('LiquidAI/LFM2.5-1.2B-Instruct-ONNX');
    expect(afterIds).toContain('onnx-community/Qwen3-0.6B-ONNX');
  });

  it('has no inbound foreign keys to models(id) before deleting legacy built-in model rows', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.slice(0, 28));

    const constraints = await db.query<{
      constraint_name: string;
      source_table: string;
    }>(`
        SELECT
          conname AS constraint_name,
          conrelid::regclass::text AS source_table
        FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid = 'models'::regclass
        ORDER BY conname
      `);

    expect(constraints.rows).toEqual([]);
  });
});
