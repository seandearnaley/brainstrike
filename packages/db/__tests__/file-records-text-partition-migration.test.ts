import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migration146FileRecordsTextPartitionIdentity as migration } from '../src/migrations/146-file-records-text-partition-identity.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

let db: PGlite;
let runner: MigrationRunner;

beforeEach(async () => {
  db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-text-partition-index'));
  runner = new MigrationRunner(db);
});

afterEach(async () => {
  await db.close();
});

async function indexDefinition(): Promise<string | null> {
  const result = await db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_file_records_text_partition_identity'`
  );
  return result.rows[0]?.indexdef ?? null;
}

// BST-1988: the TEXT partition's (root, path) identity, on a fresh database.
it('creates the TEXT partition identity index and drops it on the way down', {
  timeout: 60_000,
}, async () => {
  await runner.initialize();
  await runner.up(migrations);
  expect(await runner.getCurrentVersion()).toBeGreaterThanOrEqual(migration.version);
  expect(await indexDefinition()).toBe(
    'CREATE UNIQUE INDEX idx_file_records_text_partition_identity ON public.file_records USING btree (root_id, path) WHERE ((embedding_set_id IS NULL) AND (root_id IS NOT NULL))'
  );

  await runner.down(migrations, migration.version - 1);
  expect(await indexDefinition()).toBeNull();
});
