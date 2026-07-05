import { afterEach, describe, expect, it } from 'vitest';
import {
  createTursoBrowserWasmExecutionClient,
  openTursoBrowserWasmStoreWithBoundedWorkerInitRetry,
  runTursoBrowserWasmBootstrap,
  type TursoBrowserWasmBootstrapDatabase,
  type TursoBrowserWasmExecutionClient,
} from '../src/bootstrap/turso-browser-wasm-bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import { TursoJobQueue } from '../src/queue/turso-job-queue.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import {
  markTursoCollectionIndexingStatsDirty,
  refreshTursoCollectionIndexingStats,
} from '../src/services/turso-collection-indexing-stats.js';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client.js';

/**
 * REAL browser proof for the browser Turso embedding queue path: one
 * embedding job processed end-to-end over the real @tursodatabase/database-wasm
 * store on OPFS — enqueue → lease-token claim → chunk load → complete with a
 * deterministic fake-embedder vector → stats refresh — using the exact
 * db-layer machinery (TursoJobQueue + repositories + shared stats service over
 * the serialized WAL single-writer execution client) that
 * createTursoBrowserEmbeddingWorkerStorage delegates to. The embeddings-package
 * adapter itself cannot be imported here (packages/db must not depend on
 * packages/embeddings), so this lane proves the queue/storage machinery and the
 * adapter's own unit lane proves the delegation.
 */
describe('browser Turso embedding queue (real browser)', () => {
  const openedDbPaths: string[] = [];
  let openDatabase: TursoBrowserWasmBootstrapDatabase | null = null;

  afterEach(async () => {
    if (openDatabase) {
      try {
        await openDatabase.close();
      } catch {
        // Already closed by the test body.
      }
      openDatabase = null;
    }
    for (const dbPath of openedDbPaths.splice(0)) {
      await removeOpfsFileIfPresent(dbPath);
      await removeOpfsFileIfPresent(`${dbPath}-wal`);
      await removeOpfsFileIfPresent(`${dbPath}-shm`);
    }
  });

  it('processes one embedding job end-to-end: enqueue → claim → load chunk → complete → stats refresh', {
    timeout: 120_000,
  }, async () => {
    const dbPath = `brainstrike-browser-embedding-queue-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);

    const { client } = await openReadyBrowserTursoClient(dbPath);

    // Seed a real embedding set + file + chunk through the Turso repositories.
    const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    const fileRecordsRepository = new TursoFileRecordRepository(client);
    const chunkRepository = new TursoFileChunkRepository(client);
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'local::browser-test-model',
      'browser-test-model',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(createRecord());
    await chunkRepository.insert(createChunk({ embeddingSetId: embeddingSet.id }));

    // Enqueue → claim with a lease token (multi-tab hazard keeps the token CAS).
    const queue = new TursoJobQueue(client);
    const enqueued = await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
      queue: 'embeddings',
    });
    const claimed = await queue.claimMany({
      leaseMs: 60_000,
      limit: 1,
      queue: 'embeddings',
      workerId: 'browser-worker-a',
    });
    expect(claimed).toHaveLength(1);
    const claimedJob = claimed[0];
    if (!claimedJob?.lease_token) {
      throw new Error('Expected the claimed browser Turso job to carry a lease token.');
    }
    expect(claimedJob.id).toBe(enqueued.id);
    expect(claimedJob.state).toBe('running');

    // Load the chunk content (the same query shape the worker storage uses).
    const chunkRows = await client.query<{ content: string; id: string }>(
      `SELECT id, content
           FROM file_chunks
          WHERE id IN (?)
          ORDER BY id`,
      ['chunk-1']
    );
    expect(chunkRows.rows).toEqual([{ content: 'const answer = 42;', id: 'chunk-1' }]);

    // Deterministic fake embedder: no model download, fixed vector.
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const completed = await queue.completeEmbeddingChunkBatch([
      {
        chunkId: 'chunk-1',
        embedding: fakeEmbedding,
        embeddingHash: 'browser-embedding-hash-1',
        embeddingSetId: embeddingSet.id,
        id: claimedJob.id,
        leaseToken: claimedJob.lease_token,
      },
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.state).toBe('succeeded');

    await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
      embedding: fakeEmbedding,
      embeddingHash: 'browser-embedding-hash-1',
      embeddingSetId: embeddingSet.id,
    });

    // Stats refresh through the shared Turso stats service (the adapter's
    // createStatsRefreshController operations).
    await markTursoCollectionIndexingStatsDirty(client, [embeddingSet.id]);
    await client.transaction((tx) => refreshTursoCollectionIndexingStats(tx, [embeddingSet.id]));
    const statsRows = await client.query<{
      chunk_count: number | string;
      dirty: number | string;
      embedded_chunk_count: number | string;
      pending_chunk_count: number | string;
    }>(
      `SELECT chunk_count, dirty, embedded_chunk_count, pending_chunk_count
           FROM collection_indexing_stats
          WHERE embedding_set_id = ?`,
      [embeddingSet.id]
    );
    expect(statsRows.rows).toHaveLength(1);
    expect(Number(statsRows.rows[0]?.chunk_count)).toBe(1);
    expect(Number(statsRows.rows[0]?.embedded_chunk_count)).toBe(1);
    expect(Number(statsRows.rows[0]?.pending_chunk_count)).toBe(0);
    expect(Number(statsRows.rows[0]?.dirty)).toBe(0);

    // Single-writer serialization smoke on the REAL engine: overlapping
    // queue and repository transactions must both commit (no interleaved
    // BEGIN on the one WAL connection).
    const [encoreJobs] = await Promise.all([
      queue.enqueueBatch([
        {
          jobType: 'embed_chunk',
          payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
          queue: 'embeddings-encore',
        },
      ]),
      chunkRepository.update({
        id: 'chunk-1',
        updatedAt: '2026-07-05T01:00:00.000Z',
      }),
    ]);
    expect(encoreJobs).toHaveLength(1);
  });

  it('holds an exclusive OPFS access handle while open: a second context cannot take ownership', {
    timeout: 120_000,
  }, async () => {
    const dbPath = `brainstrike-browser-embedding-ownership-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);

    const { database } = await openReadyBrowserTursoClient(dbPath);

    // While the store is open, a second worker context attempting to take
    // the OPFS sync access handle for the same file must fail: this is the
    // exact mechanism that makes a SECOND TAB fail closed at store open
    // (its vendor OPFS worker calls createSyncAccessHandle on the same
    // path), so the single-writer owner can never be silently duplicated.
    const contendedProbe = await probeOpfsSyncAccessHandle(dbPath);
    expect(contendedProbe.ok).toBe(false);
    expect(contendedProbe.errorName).toBe('NoModificationAllowedError');

    // Closing the store releases ownership: the same probe then succeeds.
    await database.close();
    openDatabase = null;
    const releasedProbe = await probeOpfsSyncAccessHandle(dbPath);
    expect(releasedProbe.ok).toBe(true);
  });

  async function openReadyBrowserTursoClient(dbPath: string): Promise<{
    client: TursoBrowserWasmExecutionClient;
    database: TursoBrowserWasmBootstrapDatabase;
  }> {
    const bootstrapResult = await runTursoBrowserWasmBootstrap({ dbPath, profileId: dbPath });
    expect(bootstrapResult.bootstrapReport.ready).toBe(true);

    const { database } = await openTursoBrowserWasmStoreWithBoundedWorkerInitRetry(
      async (path: string) => openTursoBrowserWasmDatabase({ path }),
      dbPath
    );
    openDatabase = database;
    return { client: createTursoBrowserWasmExecutionClient(database), database };
  }
});

interface OpfsProbeResult {
  readonly errorMessage?: string;
  readonly errorName?: string;
  readonly ok: boolean;
}

/**
 * Attempts to take an OPFS sync access handle for `fileName` from a dedicated
 * worker (sync access handles are worker-only). Mirrors what a second tab's
 * vendor OPFS worker does when it opens the same database path.
 */
function probeOpfsSyncAccessHandle(fileName: string): Promise<OpfsProbeResult> {
  const workerSource = `
    self.onmessage = async (event) => {
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(event.data);
        const access = await handle.createSyncAccessHandle();
        access.close();
        self.postMessage({ ok: true });
      } catch (error) {
        self.postMessage({
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : 'UnknownError',
          ok: false,
        });
      }
    };
  `;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  return new Promise<OpfsProbeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('OPFS ownership probe timed out.'));
    }, 30_000);
    worker.onmessage = (event: MessageEvent<OpfsProbeResult>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`OPFS ownership probe worker failed: ${event.message}`));
    };
    worker.postMessage(fileName);
  }).finally(() => {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  });
}

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-07-05T00:50:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-07-05T00:50:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-07-05T00:55:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-07-05T00:55:00.000Z',
    ...overrides,
  };
}

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
