import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

async function modelIds(db: PGlite): Promise<string[]> {
  const res = await db.query('SELECT id FROM models ORDER BY id');
  return res.rows.map((r) => (r as { id: string }).id);
}

describe('frontier models migration (033)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-frontier');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('seeds the new frontier model IDs and removes superseded ones', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);

    const ids = await modelIds(db);

    // New hosted models present
    for (const id of [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-embedding-2',
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-4.6',
      'google/gemini-3.5-flash',
    ]) {
      expect(ids).toContain(id);
    }

    // Kept models still present
    for (const id of ['gpt-5.2', 'claude-haiku-4-5', 'gemini-embedding-001']) {
      expect(ids).toContain(id);
    }

    // Superseded models removed
    for (const id of [
      'gpt-5.2-chat-latest',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-flash-preview',
    ]) {
      expect(ids).not.toContain(id);
    }
  });

  it('rolls back faithfully: removes new rows, restores dropped ones, keeps gpt-5.2-pro', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);
    await runner.down(migrations, 32);

    const ids = await modelIds(db);

    // New 033 rows are gone.
    for (const id of [
      'gpt-5.5',
      'gpt-5.4',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'gemini-3.5-flash',
      'gemini-embedding-2',
    ]) {
      expect(ids).not.toContain(id);
    }
    // Dropped (pre-033) rows are restored.
    for (const id of [
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'gemini-3-flash-preview',
      'gpt-5.2-chat-latest',
    ]) {
      expect(ids).toContain(id);
    }
    // gpt-5.2-pro predates 033 (migration 026) — it must survive rollback, with
    // its pre-033 metadata restored (sort_order 3, not 033's 9).
    expect(ids).toContain('gpt-5.2-pro');
    const proRow = await db.query("SELECT sort_order FROM models WHERE id = 'gpt-5.2-pro'");
    expect((proRow.rows[0] as { sort_order: number } | undefined)?.sort_order).toBe(3);
  });

  it('preserves a user is_enabled choice on a kept model across the migration', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    // Apply everything up to (but not including) the new migration.
    await runner.up(migrations.filter((m) => m.version <= 32));

    // Simulate a user who disabled an existing model.
    await db.query("UPDATE models SET is_enabled = false WHERE id = 'gpt-5.2'");

    // Apply the new migration.
    await runner.up(migrations);

    const res = await db.query("SELECT is_enabled FROM models WHERE id = 'gpt-5.2'");
    expect((res.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(false);

    // New models arrive enabled so users get the fresh selection.
    const newModel = await db.query("SELECT is_enabled FROM models WHERE id = 'gpt-5.4'");
    expect((newModel.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(true);
  });
});
