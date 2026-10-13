import { listProviderEmbeddingModels } from '@brainstrike/assistant-contract';
import { decodeCatalogEmbeddingModel } from '@brainstrike/indexing-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const MINILM_ID = 'Xenova/all-MiniLM-L6-v2';

interface CatalogRow {
  readonly capabilities: unknown;
  readonly id: string;
  readonly is_enabled: boolean;
  readonly parameters: unknown;
  readonly provider_id: string;
  readonly sort_order: number;
}

async function readRow(db: PGlite, id: string): Promise<CatalogRow | undefined> {
  const result = await db.query<CatalogRow>(
    'SELECT id, provider_id, capabilities, parameters, is_enabled, sort_order FROM models WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

describe('migration 149: local embedding model facts and the recommended granite (BST-1993)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-migration-149'));
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds the enabled granite row, stating its CLS pooling, pin and per-device dtype', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 149));
    const granite = await readRow(db, GRANITE_ID);
    if (!granite) {
      throw new Error('migration 149 must add the granite row');
    }
    expect(granite).toMatchObject({ is_enabled: true, provider_id: 'local' });
    expect(decodeCatalogEmbeddingModel(granite)).toEqual({
      dimensions: 384,
      execution: { wasm: 'q8', webgpu: 'fp16' },
      id: GRANITE_ID,
      pooling: 'cls',
      prompts: { document: '', query: '' },
      revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8',
    });
    // Listed ahead of every other local embedding model.
    const others = await db.query<{ sort_order: number }>(
      `SELECT sort_order FROM models
       WHERE provider_id = 'local' AND capabilities->>'type' = 'embedding' AND id <> $1`,
      [GRANITE_ID]
    );
    expect(others.rows.every((row) => row.sort_order > granite.sort_order)).toBe(true);
    // Every local embedding row states its card's prompts; none is stated as none.
    const miniLm = await readRow(db, MINILM_ID);
    if (!miniLm) {
      throw new Error('MiniLM must stay in the catalog');
    }
    expect(decodeCatalogEmbeddingModel(miniLm)).toEqual({
      dimensions: 384,
      id: MINILM_ID,
      prompts: { document: '', query: '' },
    });
    const stated = await db.query<{ id: string; prompts: unknown }>(
      `SELECT id, capabilities->'prompts' AS prompts FROM models
       WHERE provider_id = 'local' AND capabilities->>'type' = 'embedding' ORDER BY id`
    );
    const none = { document: '', query: '' };
    const bge = {
      document: '',
      query: 'Represent this sentence for searching relevant passages: ',
    };
    expect(stated.rows).toEqual([
      { id: 'Xenova/all-MiniLM-L6-v2', prompts: none },
      { id: 'Xenova/bge-base-en-v1.5', prompts: bge },
      { id: 'Xenova/bge-large-en-v1.5', prompts: bge },
      { id: 'Xenova/bge-small-en-v1.5', prompts: bge },
      { id: 'Xenova/jina-embeddings-v2-base-en', prompts: none },
      { id: 'jinaai/jina-embeddings-v2-base-code', prompts: none },
      { id: GRANITE_ID, prompts: none },
    ]);

    // Compare the actual current-schema rows, not a second runtime catalog.
    const storedModels = await db.query<CatalogRow>(
      `SELECT id, capabilities, parameters FROM models
       WHERE provider_id = 'local' AND capabilities->>'type' = 'embedding' ORDER BY id`
    );
    const definitions = listProviderEmbeddingModels('local');
    expect(definitions.map(({ id }) => id).sort()).toEqual(storedModels.rows.map(({ id }) => id));
    const catalogProfiles = definitions.map((model) => ({
      dimensions: model.defaultDimension,
      ...(model.execution === undefined ? {} : { execution: model.execution }),
      id: model.id,
      ...(model.pooling === undefined ? {} : { pooling: model.pooling }),
      ...(model.prompts === undefined ? {} : { prompts: model.prompts }),
      ...(model.revision === undefined ? {} : { revision: model.revision }),
    }));
    for (const row of storedModels.rows) {
      expect(catalogProfiles.find(({ id }) => id === row.id)).toEqual(
        decodeCatalogEmbeddingModel(row)
      );
    }

    // Re-applying keeps the user's toggle (database.md rule 3).
    const up = migrations.find(({ version }) => version === 149)?.up;
    if (typeof up !== 'string') {
      throw new Error('migration 149 must be registered with SQL-string up');
    }
    await db.query('UPDATE models SET is_enabled = false WHERE id = $1', [GRANITE_ID]);
    await db.exec(up);
    expect((await readRow(db, GRANITE_ID))?.is_enabled).toBe(false);

    await runner.down(migrations, 148);
    expect(await readRow(db, GRANITE_ID)).toBeUndefined();
    expect((await readRow(db, MINILM_ID))?.capabilities).not.toHaveProperty('prompts');
  });
});
