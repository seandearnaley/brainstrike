import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

async function modelIds(db: PGlite): Promise<string[]> {
  const res = await db.query('SELECT id FROM models ORDER BY id');
  return res.rows.map((r) => (r as { id: string }).id);
}

describe('frontier models migrations', () => {
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
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-fable-5',
      'claude-sonnet-5',
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
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
      'z-ai/glm-5.2',
      'minimax/minimax-m3',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
      'qwen/qwen3.7-max',
      'qwen/qwen3.7-plus',
      'qwen/qwen3.6-flash',
      'qwen/qwen3-coder-next',
      'meta/muse-spark-1.1',
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k2.7-code',
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

    await expect(
      db.query('SELECT billed_cost_usd FROM brainstrike_assistant_run_usage LIMIT 0')
    ).resolves.toBeDefined();
  });

  it('rolls back faithfully: removes new rows, restores dropped ones, keeps gpt-5.2-pro', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);
    await runner.down(migrations, 32);

    const ids = await modelIds(db);

    // Rows introduced after version 32 are gone.
    for (const id of [
      'gpt-5.6-sol',
      'claude-sonnet-5',
      'z-ai/glm-5.2',
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

  it('preserves a user is_enabled choice across the July catalog migration', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 56));

    await db.query("UPDATE models SET is_enabled = false WHERE id = 'gpt-5.4'");

    await runner.up(migrations);

    const res = await db.query("SELECT is_enabled FROM models WHERE id = 'gpt-5.4'");
    expect((res.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(false);

    // New models arrive enabled so users get the fresh selection.
    const newModel = await db.query("SELECT is_enabled FROM models WHERE id = 'gpt-5.6-terra'");
    expect((newModel.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(true);

    const newGatewayModel = await db.query(
      "SELECT is_enabled FROM models WHERE id = 'z-ai/glm-5.2'"
    );
    expect((newGatewayModel.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(
      false
    );
  });

  it('adds and rolls back the provider billed-cost column', { timeout: 60_000 }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 57));
    await expect(
      db.query('SELECT billed_cost_usd FROM brainstrike_assistant_run_usage LIMIT 0')
    ).rejects.toThrow();

    await runner.up(migrations);
    await expect(
      db.query('SELECT billed_cost_usd FROM brainstrike_assistant_run_usage LIMIT 0')
    ).resolves.toBeDefined();

    await runner.down(migrations, 57);
    await expect(
      db.query('SELECT billed_cost_usd FROM brainstrike_assistant_run_usage LIMIT 0')
    ).rejects.toThrow();
  });

  it('adds the July 16 OpenRouter models disabled without changing existing toggles', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 59));
    await db.query("UPDATE models SET is_enabled = true WHERE id = 'moonshotai/kimi-k2.6'");

    await runner.up(migrations);

    const rows = await db.query<{ id: string; is_enabled: boolean; sort_order: number }>(`
      SELECT id, is_enabled, sort_order
      FROM models
      WHERE provider_id = 'openrouter'
        AND id IN ('meta/muse-spark-1.1', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.6')
      ORDER BY sort_order
    `);
    expect(rows.rows).toEqual([
      { id: 'meta/muse-spark-1.1', is_enabled: false, sort_order: 1 },
      { id: 'moonshotai/kimi-k3', is_enabled: false, sort_order: 2 },
      { id: 'moonshotai/kimi-k2.6', is_enabled: true, sort_order: 16 },
    ]);
  });
});
