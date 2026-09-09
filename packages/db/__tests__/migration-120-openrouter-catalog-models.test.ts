import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 120: 2026-09 OpenRouter open-weight catalog refresh', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-migration-120');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds the 2026-09 OpenRouter open-weight routes disabled, appended, with authored copy', {
    timeout: 60_000,
  }, async () => {
    // BST-1696 / BST-1041. `tagline` and `best_for` are hand-authored in
    // migration 120 — the generator leaves them NULL and
    // `model-catalog-migration-contract.mjs` never reads those columns, so a
    // typo in that copy fails HERE or nowhere. The sort_order assertion is
    // relative, not absolute, because the migration appends with a live
    // `MAX(sort_order)` subquery: pinning literals would break the moment
    // another OpenRouter migration lands ahead of this one.
    const newIds = [
      'tencent/hy4-preview',
      'z-ai/glm-5.3-flash',
      'tencent/hy3',
      'xiaomi/mimo-v2.5',
      'upstage/solar-pro4',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v4-flash-0731',
    ];
    const idList = newIds.map((id) => `'${id}'`).join(', ');

    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 119));

    const before = await db.query<{ max_sort_order: number | null }>(
      "SELECT MAX(sort_order) AS max_sort_order FROM models WHERE provider_id = 'openrouter'"
    );
    const maxBefore = before.rows[0]?.max_sort_order ?? 0;

    await runner.up(migrations);

    const rows = await db.query<{
      best_for: readonly string[] | null;
      capabilities: { streaming?: boolean; type?: string; vision?: boolean };
      id: string;
      is_enabled: boolean;
      name: string;
      provider_id: string;
      sort_order: number;
      tagline: string | null;
    }>(`
      SELECT id, provider_id, name, tagline, best_for, capabilities, is_enabled, sort_order
      FROM models
      WHERE id IN (${idList})
      ORDER BY sort_order
    `);

    expect(rows.rows).toEqual([
      {
        best_for: ['Coding agents', 'Tool use', 'Productivity tasks'],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'tencent/hy4-preview',
        is_enabled: false,
        name: 'Hy4 Preview (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 1,
        tagline: 'Mixture-of-experts preview for coding agents and tool use',
      },
      {
        best_for: ['Coding', 'Long-horizon agents', 'Long context'],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'z-ai/glm-5.3-flash',
        is_enabled: false,
        name: 'GLM 5.3 Flash (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 2,
        tagline: 'Native multimodal model for efficient coding and long-horizon agents',
      },
      {
        best_for: ['Reasoning', 'Agentic workflows', 'Production use'],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'tencent/hy3',
        is_enabled: false,
        name: 'Hy3 (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 3,
        tagline: 'Mixture-of-experts model for reasoning and agentic workflows',
      },
      {
        best_for: ['Agentic tasks', 'Image understanding', 'Video understanding'],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'xiaomi/mimo-v2.5',
        is_enabled: false,
        name: 'MiMo-V2.5 (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 4,
        tagline: 'Omnimodal model with image and video understanding',
      },
      {
        best_for: ['Long-horizon tasks', 'Agentic workflows', 'Office productivity'],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'upstage/solar-pro4',
        is_enabled: false,
        name: 'Solar Pro 4 (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 5,
        tagline: 'Cost-efficient long-context model for document-intensive work',
      },
      {
        best_for: [],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'deepseek/deepseek-v4-pro-0813',
        is_enabled: false,
        name: 'DeepSeek V4 Pro 0813 (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 6,
        tagline: 'GA release snapshot of DeepSeek V4 Pro',
      },
      {
        best_for: ['Coding', 'Reasoning', 'Agent workflows'],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'deepseek/deepseek-v4-flash-0731',
        is_enabled: false,
        name: 'DeepSeek V4 Flash 0731 (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 7,
        tagline: 'Sparse mixture-of-experts revision for coding, reasoning and agents',
      },
    ]);

    // Re-applying the SAME up SQL over a row the user has since enabled and a
    // stale name must refresh the catalog columns and LEAVE THE TOGGLE ALONE
    // (database.md rule 3: never `is_enabled = EXCLUDED.is_enabled`). Setting
    // the toggle on some OTHER row would not exercise this migration's
    // ON CONFLICT branch at all — the conflict target has to be one of the
    // seven ids the INSERT actually names.
    const up = migrations.find(({ version }) => version === 120)?.up;
    if (typeof up !== 'string') {
      throw new Error('migration 120 must be registered with SQL-string up');
    }
    await db.query(
      "UPDATE models SET is_enabled = true, name = 'stale name' WHERE id = 'tencent/hy3'"
    );
    await db.exec(up);
    const reapplied = await db.query<{ is_enabled: boolean; name: string }>(
      "SELECT is_enabled, name FROM models WHERE id = 'tencent/hy3'"
    );
    expect(reapplied.rows[0]).toEqual({ is_enabled: true, name: 'Hy3 (OpenRouter)' });

    await runner.down(migrations, 119);
    const afterRollback = await db.query<{ id: string }>(
      `SELECT id FROM models WHERE id IN (${idList})`
    );
    expect(afterRollback.rows).toEqual([]);
  });
});
