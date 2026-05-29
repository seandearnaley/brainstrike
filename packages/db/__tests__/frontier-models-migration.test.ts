import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';

async function modelIds(db: PGlite): Promise<string[]> {
  const res = await db.query('SELECT id FROM models ORDER BY id');
  return res.rows.map((r) => (r as { id: string }).id);
}

describe('frontier models migration (033)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = `/tmp/pglite-test-frontier-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
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
