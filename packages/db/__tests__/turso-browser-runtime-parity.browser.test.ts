import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTursoBrowserWasmExecutionClient,
  openTursoBrowserWasmStoreWithBoundedWorkerInitRetry,
  runTursoBrowserWasmBootstrap,
  type TursoBrowserWasmBootstrapDatabase,
  type TursoBrowserWasmExecutionClient,
} from '../src/bootstrap/turso-browser-wasm-bootstrap.js';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client.js';
import {
  resetTursoParityTables,
  runCollectionStatsRefreshContract,
  runEffectiveMembershipContract,
  runEmbeddingSetsCrudAndStatsSeedContract,
  runFileChunkPersistenceContract,
  runFileRecordPersistenceContract,
  runGrepCandidatesContract,
  runJobQueueLifecycleContract,
  runManagedCacheApplyContract,
  runManagedCacheIdentityContract,
  runQuickOpenNameGramContract,
  runTokenCacheContract,
  runVectorSearchContract,
  runViewFilterPresetsContract,
} from './helpers/turso-runtime-parity-contracts.js';

/**
 * Browser lane of the Turso runtime parity contract (A6 browser-cutover gate).
 *
 * Runs the IDENTICAL shared contract bodies as the node lane
 * (turso-runtime-parity.test.ts) against the REAL
 * @tursodatabase/database-wasm store on OPFS through the WAL single-writer
 * FIFO-serialized execution client — the exact client the browser runtime
 * hands to repositories. Row-level results, effective membership semantics,
 * lease-token queue lifecycle, stats refresh values, and gram/vector search
 * results must match the native runtime exactly; only the concurrency model,
 * journal mode, and timings may differ (documented runtime tolerances in the
 * shared helper).
 *
 * Budget: ONE OPFS store is opened for the whole suite (worker + OPFS startup
 * dominates wall time) and tables are reset between contracts; fixtures are
 * intentionally tiny — this is a contract proof, not a load test.
 */
describe('browser Turso runtime parity contracts (real browser WASM over OPFS)', () => {
  const dbPath = `brainstrike-browser-runtime-parity-${crypto.randomUUID()}.db`;
  let client: TursoBrowserWasmExecutionClient;
  let database: TursoBrowserWasmBootstrapDatabase | null = null;

  beforeAll(async () => {
    const bootstrapResult = await runTursoBrowserWasmBootstrap({ dbPath, profileId: dbPath });
    expect(bootstrapResult.bootstrapReport.ready).toBe(true);

    const opened = await openTursoBrowserWasmStoreWithBoundedWorkerInitRetry(
      async (path: string) => openTursoBrowserWasmDatabase({ path }),
      dbPath
    );
    database = opened.database;
    client = createTursoBrowserWasmExecutionClient(opened.database);
  }, 120_000);

  afterAll(async () => {
    if (database) {
      try {
        await database.close();
      } catch {
        // Already closed.
      }
      database = null;
    }
    for (const fileName of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      await removeOpfsFileIfPresent(fileName);
    }
  });

  beforeEach(async () => {
    await resetTursoParityTables(client);
  });

  it('embedding sets: CRUD + seeded indexing stats', async () => {
    await runEmbeddingSetsCrudAndStatsSeedContract(client);
  });

  it('file records: persistence, validation, bulk import dedupe', async () => {
    await runFileRecordPersistenceContract(client);
  });

  it('file records: managed-cache identity + stat metadata', async () => {
    await runManagedCacheIdentityContract(client);
  });

  it('file chunks: non-search persistence + embedding update validation', async () => {
    await runFileChunkPersistenceContract(client);
  });

  it('file chunks: effective embedding-set membership (explicit wins, NULL inherits)', async () => {
    await runEffectiveMembershipContract(client);
  });

  it('quick-open: name-gram lookup stays consistent across writes', async () => {
    await runQuickOpenNameGramContract(client);
  });

  it('grep: gram-indexed candidate selection with filters and escapes', async () => {
    await runGrepCandidatesContract(client);
  });

  it('vector: vector32 searchSimilar with set/root/path filters and inheritance', async () => {
    await runVectorSearchContract(client);
  });

  it('view filter presets: seeded defaults + CRUD + protected deletes', async () => {
    await runViewFilterPresetsContract(client);
  });

  it('file token cache: upserts, batch lookups, folder-scoped deletes', async () => {
    await runTokenCacheContract(client);
  });

  it('job queue: enqueue → claim/lease → heartbeat → fail/retry → complete → counts', async () => {
    await runJobQueueLifecycleContract(client);
  });

  it('managed cache: import/replace/invalidate through the batch apply path', async () => {
    await runManagedCacheApplyContract(client);
  });

  it('collection stats: dirty marking + refresh with inherited ownership', async () => {
    await runCollectionStatsRefreshContract(client);
  });
});

async function removeOpfsFileIfPresent(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return;
    }
    throw error;
  }
}
