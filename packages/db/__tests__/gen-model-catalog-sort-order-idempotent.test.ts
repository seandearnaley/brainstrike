import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planModelCatalogMigration,
  renderUpSql,
} from '../../scripts/gen-model-catalog-migration.mjs';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

function llmModel(id: string) {
  return {
    contextWindow: 400_000,
    id,
    label: id,
    supportsStreaming: true,
    type: 'llm',
    vision: 'supported',
  };
}

async function sortOrders(db: PGlite): Promise<Array<{ id: string; sort_order: number }>> {
  const result = await db.query<{ id: string; sort_order: number }>(
    "SELECT id, sort_order FROM models WHERE provider_id = 'openai' ORDER BY id"
  );
  return result.rows;
}

describe('generated catalog migration sort_order idempotency (BST-1704)', () => {
  let db: PGlite;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-catalog-sort-order');
    db = await wasmLoader.createPGlite(dataDir);
    await db.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        name TEXT NOT NULL,
        capabilities JSONB,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_enabled BOOLEAN NOT NULL DEFAULT FALSE
      );
      INSERT INTO providers (id) VALUES ('openai');
      INSERT INTO models (id, provider_id, name, capabilities, sort_order, is_enabled)
        VALUES ('gpt-seeded', 'openai', 'GPT Seeded',
          '{"type":"llm","streaming":true,"vision":true}', 5, true);
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it('keeps sort_order identical when a generated migration applies twice', {
    timeout: 60_000,
  }, async () => {
    const seed = {
      file: 'packages/db/src/migrations/025-update-provider-models-2026.ts',
      source: `import type { Migration } from './migration-runner';
export const migration025UpdateProviderModels2026: Migration = {
  version: 25,
  ledgerKey: 'custom-025-update-provider-models-2026',
  name: 'update_provider_models_2026',
  up: \`
    INSERT INTO models (id, provider_id, name, capabilities) VALUES
      ('gpt-seeded', 'openai', 'GPT Seeded', '{"type":"llm","streaming":true,"vision":true}');
  \`,
  down: \`\`,
};`,
    };
    const { additions, migration } = planModelCatalogMigration({
      migrationFiles: [seed],
      migrationIndexSource: `// Import all migrations
import { migration025UpdateProviderModels2026 } from './025-update-provider-models-2026.js';

export const migrations: Migration[] = [
  migration025UpdateProviderModels2026,
];

export { MigrationRunner } from './migration-runner.js';`,
      providerCatalog: [
        {
          id: 'openai',
          models: [llmModel('gpt-seeded'), llmModel('gpt-new-a'), llmModel('gpt-new-b')],
        },
      ],
    });
    expect(additions).toHaveLength(2);
    expect(migration).not.toBeNull();

    const up = renderUpSql(additions);

    await db.exec(up);
    const afterFirst = await sortOrders(db);
    expect(afterFirst).toEqual([
      { id: 'gpt-new-a', sort_order: 6 },
      { id: 'gpt-new-b', sort_order: 7 },
      { id: 'gpt-seeded', sort_order: 5 },
    ]);

    await db.exec(up);
    expect(await sortOrders(db)).toEqual(afterFirst);

    const toggle = await db.query<{ is_enabled: boolean }>(
      "SELECT is_enabled FROM models WHERE id = 'gpt-seeded'"
    );
    expect(toggle.rows[0]?.is_enabled).toBe(true);
  });
});
