import { projectModelCatalog } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

test('canonical desktop catalog preserves every current fresh web catalog row and embedding profile', {
  timeout: 60_000,
}, async () => {
  const db = await wasmLoader.createPGlite(createPGliteTestDataDir('desktop-catalog-parity'));
  try {
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    const providers = (
      await db.query<{ id: string }>(
        `SELECT id,name,icon,is_enabled AS "isEnabled",sort_order AS "sortOrder" FROM providers ORDER BY id`
      )
    ).rows;
    const models = (
      await db.query<{ id: string }>(
        `SELECT id,provider_id AS "providerId",name,tagline,description,best_for AS "bestFor",capabilities,parameters,icon,is_enabled AS "isEnabled",sort_order AS "sortOrder" FROM models ORDER BY id`
      )
    ).rows;
    const actual = projectModelCatalog({ models: [], providers: [] });
    expect([...actual.providers].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      providers.sort((a, b) => a.id.localeCompare(b.id))
    );
    expect([...actual.models].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      models.sort((a, b) => a.id.localeCompare(b.id))
    );
  } finally {
    await db.close();
  }
});
