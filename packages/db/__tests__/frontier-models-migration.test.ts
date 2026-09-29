import { listProviders } from '@brainstrike/assistant-contract';
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
      'gemini-3.7-flash',
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
      'qwen/qwen3.8-27b',
      'qwen/qwen3-coder-next',
      'meta/muse-spark-1.2',
      'meta/muse-spark-1.1',
      'moonshotai/kimi-k3',
      'poolside/laguna-s-2.1',
      'poolside/laguna-xs-2.1',
      'qwen/qwen3.8-2.4t-a95b',
      'nvidia/nemotron-3.5-lightning',
      'google/gemini-3.7-flash',
      'google/gemini-3.6-flash',
      'google/gemini-3.5-flash-lite',
      'meituan/longcat-2.0',
      'thinkingmachines/inkling',
      'kwaipilot/kat-coder-pro-v2.5',
      'x-ai/grok-4.6',
      'x-ai/grok-4.5',
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
      // BST-1697 (migration 121): delisted upstream and deleted from the
      // catalog. 'qwen/qwen3.8-max' is superseded by the dated
      // 'qwen/qwen3.8-max-0902' snapshot, which must still be here.
      'stealth/ox-alpha',
      'qwen/qwen3.8-max',
      'inclusionai/ling-3.0-flash:free',
      'kwaipilot/kat-coder-air-v2.5',
    ]) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain('qwen/qwen3.8-max-0902');

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
      'inclusionai/ling-3.0-flash:free',
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

  it('patches vision into every LLM catalog row and rolls back cleanly', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);

    const vision = async (id: string): Promise<string | null | undefined> => {
      const res = await db.query(
        "SELECT capabilities->>'vision' AS vision FROM models WHERE id = $1",
        [id]
      );
      return (res.rows[0] as { vision: string | null } | undefined)?.vision;
    };

    // Multimodal hosted/gateway families are vision-capable.
    expect(await vision('claude-sonnet-5')).toBe('true');
    expect(await vision('gpt-5.6-terra')).toBe('true');
    expect(await vision('gemini-3.5-flash')).toBe('true');
    expect(await vision('anthropic/claude-sonnet-5')).toBe('true');
    expect(await vision('minimax/minimax-m3')).toBe('true');

    // Text-only models (vision ships as separate -V/-VL variants; the
    // built-in Gemma runtime is a text-only pipeline).
    expect(await vision('qwen/qwen3-coder-next')).toBe('false');
    expect(await vision('moonshotai/kimi-k2.6')).toBe('false');
    expect(await vision('onnx-community/gemma-4-E2B-it-ONNX')).toBe('false');

    // Embedding rows are untouched — vision is an LLM-only capability.
    expect(await vision('text-embedding-3-small')).toBeNull();

    // No LLM row escapes the patch: an id the migration forgot would leave
    // the composer gate guessing.
    const unpatched = await db.query(
      "SELECT id FROM models WHERE capabilities->>'type' = 'llm' AND capabilities->>'vision' IS NULL"
    );
    expect(unpatched.rows).toEqual([]);

    await runner.down(migrations, 59);
    expect(await vision('claude-sonnet-5')).toBeNull();
    expect(await vision('onnx-community/gemma-4-E2B-it-ONNX')).toBeNull();
  });

  it('mirrors the static registry vision declarations VALUE-for-value', {
    timeout: 60_000,
  }, async () => {
    // Migration 061's id lists "must stay in sync" with the registry (its own
    // header comment). The blanket no-NULL check catches a FORGOTTEN id but
    // not a FLIPPED value: without this test, moving one model between the
    // true/false lists (or flipping its registry declaration) ships green
    // while the DB mirror silently disagrees with the gate's source of truth.
    await runner.initialize();
    await runner.up(migrations);

    const registryVisionById = new Map<string, string>();
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm') {
          registryVisionById.set(model.id, model.vision);
        }
      }
    }

    const rows = await db.query(
      "SELECT id, capabilities->>'vision' AS vision FROM models WHERE capabilities->>'type' = 'llm'"
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const raw of rows.rows) {
      const row = raw as { id: string; vision: string | null };
      const registryVision = registryVisionById.get(row.id);
      // Every catalog LLM row must exist in the static registry…
      expect(registryVision, `${row.id} has no static-registry entry`).toBeDefined();
      // …and carry the SAME vision value (jsonb boolean vs registry string).
      expect(row.vision, row.id).toBe(registryVision === 'supported' ? 'true' : 'false');
    }
  });

  it('corrects MiniMax M3 vision for existing catalogs and rolls back to the prior value', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 69));

    const vision = async (): Promise<string | null | undefined> => {
      const result = await db.query(
        "SELECT capabilities->>'vision' AS vision FROM models WHERE id = 'minimax/minimax-m3'"
      );
      return (result.rows[0] as { vision: string | null } | undefined)?.vision;
    };

    expect(await vision()).toBe('false');
    await runner.up(migrations);
    expect(await vision()).toBe('true');

    await runner.down(migrations, 69);
    expect(await vision()).toBe('false');
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

    await runner.up(migrations.filter((migration) => migration.version <= 70));

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

  it("adds Curator's July coding models disabled without changing existing toggles", {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 70));
    await db.query("UPDATE models SET is_enabled = true WHERE id = 'meta/muse-spark-1.1'");

    await runner.up(migrations.filter((migration) => migration.version <= 71));

    const rows = await db.query<{
      capabilities: { vision?: boolean };
      id: string;
      is_enabled: boolean;
      sort_order: number;
    }>(`
      SELECT id, capabilities, is_enabled, sort_order
      FROM models
      WHERE provider_id = 'openrouter'
        AND id IN (
          'poolside/laguna-s-2.1',
          'poolside/laguna-xs-2.1',
          'google/gemini-3.6-flash',
          'google/gemini-3.5-flash-lite',
          'meituan/longcat-2.0',
          'thinkingmachines/inkling',
          'kwaipilot/kat-coder-air-v2.5',
          'kwaipilot/kat-coder-pro-v2.5',
          'x-ai/grok-4.5',
          'meta/muse-spark-1.1'
        )
      ORDER BY sort_order
    `);
    expect(rows.rows).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'poolside/laguna-s-2.1',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'poolside/laguna-xs-2.1',
        is_enabled: false,
        sort_order: 2,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.6-flash',
        is_enabled: false,
        sort_order: 3,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.5-flash-lite',
        is_enabled: false,
        sort_order: 4,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'meituan/longcat-2.0',
        is_enabled: false,
        sort_order: 5,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'thinkingmachines/inkling',
        is_enabled: false,
        sort_order: 6,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'kwaipilot/kat-coder-air-v2.5',
        is_enabled: false,
        sort_order: 7,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'kwaipilot/kat-coder-pro-v2.5',
        is_enabled: false,
        sort_order: 8,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.5',
        is_enabled: false,
        sort_order: 9,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'meta/muse-spark-1.1',
        is_enabled: true,
        sort_order: 10,
      },
    ]);
  });

  it('adds Ling 3.0 Flash disabled without changing existing toggles', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 71));
    await db.query("UPDATE models SET is_enabled = true WHERE id = 'meta/muse-spark-1.1'");

    await runner.up(migrations.filter((migration) => migration.version <= 72));

    const rows = await db.query<{
      capabilities: { vision?: boolean };
      id: string;
      is_enabled: boolean;
      sort_order: number;
    }>(`
      SELECT id, capabilities, is_enabled, sort_order
      FROM models
      WHERE provider_id = 'openrouter'
        AND id IN ('inclusionai/ling-3.0-flash:free', 'meta/muse-spark-1.1')
      ORDER BY sort_order
    `);
    expect(rows.rows).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'inclusionai/ling-3.0-flash:free',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'meta/muse-spark-1.1',
        is_enabled: true,
        sort_order: 11,
      },
    ]);
  });

  it('adds Gemini 3.7 Flash disabled, preserves its toggle, and rolls back faithfully', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 94));

    const readGemini = async (): Promise<
      | {
          capabilities: { streaming: boolean; type: string; vision: boolean };
          is_enabled: boolean;
          sort_order: number;
        }
      | undefined
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id = 'google/gemini-3.7-flash'
      `);
      return result.rows[0];
    };

    expect(await readGemini()).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      is_enabled: false,
      sort_order: 1,
    });

    await db.query("UPDATE models SET is_enabled = true WHERE id = 'google/gemini-3.7-flash'");
    await runner.down(migrations, 93);
    expect(await readGemini()).toBeUndefined();

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'google/gemini-3.7-flash',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 94));

    expect(await readGemini()).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      is_enabled: true,
      sort_order: 1,
    });

    await runner.down(migrations, 93);
    expect(await readGemini()).toBeUndefined();
  });

  it('adds Qwen3.8 27B disabled, preserves its toggle, and rolls back faithfully', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 96));

    const readQwen = async (): Promise<
      | {
          capabilities: { streaming: boolean; type: string; vision: boolean };
          is_enabled: boolean;
          sort_order: number;
        }
      | undefined
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id = 'qwen/qwen3.8-27b'
      `);
      return result.rows[0];
    };

    const sortOrderOf = async (id: string): Promise<number | undefined> => {
      const result = await db.query<{ sort_order: number }>(
        'SELECT sort_order FROM models WHERE provider_id = $1 AND id = $2',
        ['openrouter', id]
      );
      return result.rows[0]?.sort_order;
    };

    expect(await readQwen()).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      is_enabled: false,
      sort_order: 1,
    });
    expect(await sortOrderOf('google/gemini-3.7-flash')).toBe(2);

    await db.query("UPDATE models SET is_enabled = true WHERE id = 'qwen/qwen3.8-27b'");
    await runner.down(migrations, 95);
    expect(await readQwen()).toBeUndefined();
    expect(await sortOrderOf('google/gemini-3.7-flash')).toBe(1);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'qwen/qwen3.8-27b',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 96));

    expect(await readQwen()).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      is_enabled: true,
      sort_order: 1,
    });
    expect(await sortOrderOf('google/gemini-3.7-flash')).toBe(2);

    await runner.down(migrations, 95);
    expect(await readQwen()).toBeUndefined();
    expect(await sortOrderOf('google/gemini-3.7-flash')).toBe(1);
  });

  it('adds Qwen3.8 2.4T disabled, preserves its toggle, and rolls back faithfully', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 97));

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT id, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN ('qwen/qwen3.8-2.4t-a95b', 'google/gemini-3.7-flash')
        ORDER BY sort_order
      `);
      return result.rows;
    };

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'qwen/qwen3.8-2.4t-a95b',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 3,
      },
    ]);

    await db.query("UPDATE models SET is_enabled = true WHERE id = 'qwen/qwen3.8-2.4t-a95b'");
    await runner.down(migrations, 95);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 1,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'qwen/qwen3.8-2.4t-a95b',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":true}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 97));

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'qwen/qwen3.8-2.4t-a95b',
        is_enabled: true,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 3,
      },
    ]);

    await runner.down(migrations, 95);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 1,
      },
    ]);
  });

  it('adds Qwen3.8 Max disabled, preserves its toggle, and rolls back migration 098', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 98));

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT id, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN (
            'qwen/qwen3.8-max',
            'qwen/qwen3.8-2.4t-a95b',
            'qwen/qwen3.8-27b',
            'google/gemini-3.7-flash'
          )
        ORDER BY sort_order
      `);
      return result.rows;
    };

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'qwen/qwen3.8-2.4t-a95b',
        is_enabled: false,
        sort_order: 2,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-27b',
        is_enabled: false,
        sort_order: 3,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 4,
      },
    ]);

    await db.query("UPDATE models SET is_enabled = true WHERE id = 'qwen/qwen3.8-max'");
    await runner.down(migrations, 97);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'qwen/qwen3.8-2.4t-a95b',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-27b',
        is_enabled: false,
        sort_order: 2,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 3,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'qwen/qwen3.8-max',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 98));

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: true,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'qwen/qwen3.8-2.4t-a95b',
        is_enabled: false,
        sort_order: 2,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-27b',
        is_enabled: false,
        sort_order: 3,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'google/gemini-3.7-flash',
        is_enabled: false,
        sort_order: 4,
      },
    ]);
  });

  it('adds Nemotron 3.5 Lightning disabled, preserves its toggle, and rolls back migration 099', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 98));

    const migration099 = migrations.find((migration) => migration.version === 99);
    if (!migration099) {
      throw new Error('Migration 099 is missing');
    }

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT id, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN ('nvidia/nemotron-3.5-lightning', 'qwen/qwen3.8-max')
        ORDER BY sort_order
      `);
      return result.rows;
    };

    await runner.runMigration(migration099);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: false,
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 98);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: false,
        sort_order: 1,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'nvidia/nemotron-3.5-lightning',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":true}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 99));

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: true,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: false,
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 98);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-max',
        is_enabled: false,
        sort_order: 1,
      },
    ]);
  });

  it('adds Grok 4.6 disabled, preserves its toggle, and rolls back migration 100', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 99));

    const migration100 = migrations.find((migration) => migration.version === 100);
    if (!migration100) {
      throw new Error('Migration 100 is missing');
    }

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        sort_order: number;
      }>(`
        SELECT id, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN ('x-ai/grok-4.6', 'nvidia/nemotron-3.5-lightning')
        ORDER BY sort_order
      `);
      return result.rows;
    };

    await runner.runMigration(migration100);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: false,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: false,
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 99);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: false,
        sort_order: 1,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'x-ai/grok-4.6',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 100));

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: true,
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: false,
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 99);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'nvidia/nemotron-3.5-lightning',
        is_enabled: false,
        sort_order: 1,
      },
    ]);
  });
  it('adds direct Gemini 3.7 Flash disabled, preserves its toggle, and rolls back migration 104', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        sort_order: number;
      }>(`
        SELECT id, name, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'google'
          AND id IN ('gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview')
        ORDER BY sort_order
      `);
      return result.rows;
    };

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.7-flash',
        is_enabled: false,
        name: 'Gemini 3.7 Flash',
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.5-flash',
        is_enabled: true,
        name: 'Gemini 3.5 Flash',
        sort_order: 2,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.1-pro-preview',
        is_enabled: true,
        name: 'Gemini 3.1 Pro (Preview)',
        sort_order: 3,
      },
    ]);
    await expect(
      db.query<{ best_for: string[]; tagline: string }>(
        "SELECT tagline, best_for FROM models WHERE provider_id = 'google' AND id = 'gemini-3.7-flash'"
      )
    ).resolves.toMatchObject({
      rows: [
        {
          best_for: [
            'Code generation',
            'Spatial/multimodal reasoning',
            'Multi-step agentic workflows',
          ],
          tagline: 'Fast multimodal reasoning for complex agentic workflows',
        },
      ],
    });

    await runner.down(migrations, 103);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.5-flash',
        is_enabled: true,
        name: 'Gemini 3.5 Flash',
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.1-pro-preview',
        is_enabled: true,
        name: 'Gemini 3.1 Pro (Preview)',
        sort_order: 2,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'gemini-3.7-flash',
          'google',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations);

    expect((await readRows())[0]).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      id: 'gemini-3.7-flash',
      is_enabled: true,
      name: 'Gemini 3.7 Flash',
      sort_order: 1,
    });

    await runner.down(migrations, 103);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.5-flash',
        is_enabled: true,
        name: 'Gemini 3.5 Flash',
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.1-pro-preview',
        is_enabled: true,
        name: 'Gemini 3.1 Pro (Preview)',
        sort_order: 2,
      },
    ]);
  });
});
