import {
  type BrainstrikeDbExecutionClient,
  getMissingBrainstrikeDbExecutionClientCapabilities,
  markTursoCollectionIndexingStatsDirty,
  type ProfileBootstrapReport,
  refreshTursoCollectionIndexingStats,
} from '@brainstrike/db';
import {
  createEmbeddingStatsRefreshControllerWithOperations,
  createTursoEmbeddingWorkerStorage,
  type EmbeddingWorkerQueuePort,
  type EmbeddingWorkerStorage,
} from '@brainstrike/embeddings/worker';

/**
 * Browser Turso embedding worker storage.
 *
 * The browser has NO separate owner process: the DbProvider's WAL
 * single-writer execution client IS the profile owner, so this adapter
 * delegates queue/chunk/stats work to the shared Turso storage directly over
 * that client (same thread, no IPC) — the browser mirror of the desktop
 * adapter, which delegates the same operations to the DB-host owner client
 * over IPC.
 *
 * Ownership discipline: OPFS sync access handles are exclusive, so a second
 * browser context (another tab) cannot open the same store — the vendor
 * worker's `createSyncAccessHandle` throws `NoModificationAllowedError` and
 * that context fails at open. If THIS context loses the store mid-run (store
 * closed during reset/unmount, or the access handle is gone), every storage
 * operation fails closed with an explicit single-writer diagnostic below —
 * never a silent retry, never a PGlite fallback, never split-brain.
 */
export interface CreateTursoBrowserEmbeddingWorkerStorageOptions {
  readonly client: BrainstrikeDbExecutionClient;
  readonly report: ProfileBootstrapReport;
}

/**
 * Signatures that mean this context no longer owns the single-writer store:
 * - vendor closed-connection errors (`The database connection is not open`,
 *   `database must be connected before execution`),
 * - OPFS access-handle exclusivity faults (`NoModificationAllowedError`,
 *   "Access Handle" wording from the OPFS spec).
 */
const OWNERSHIP_LOSS_ERROR_PATTERNS: readonly RegExp[] = [
  /connection is not open/i,
  /database must be connected/i,
  /no ?modification ?allowed/i,
  /access handle/i,
];

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isBrowserTursoOwnershipLossError(error: unknown): boolean {
  const description = describeError(error);
  return OWNERSHIP_LOSS_ERROR_PATTERNS.some((pattern) => pattern.test(description));
}

async function failClosedOnOwnershipLoss<TResult>(
  operation: string,
  work: () => Promise<TResult>
): Promise<TResult> {
  try {
    return await work();
  } catch (error) {
    if (!isBrowserTursoOwnershipLossError(error)) {
      throw error;
    }
    throw new Error(
      `Browser Turso embedding worker storage lost single-writer ownership of the OPFS store during '${operation}'; ` +
        'failing closed (no retry, no PGlite fallback). The provider-owned WAL execution client is the only permitted ' +
        'writer for this profile — a closed store or another context holding the OPFS access handle means this ' +
        `context no longer owns the database. Cause: ${describeError(error)}`,
      { cause: error }
    );
  }
}

function assertBrowserTursoReport(report: ProfileBootstrapReport): void {
  if (!(report.runtime.engine === 'turso' && report.runtime.host === 'browser')) {
    throw new Error(
      'Browser Turso embedding worker storage requires a browser Turso bootstrap runtime ' +
        `(engine 'turso', host 'browser'); received engine '${report.runtime.engine}', host '${report.runtime.host}'.`
    );
  }
  if (!report.ready) {
    throw new Error(
      'Browser Turso embedding worker storage requires a ready bootstrap report; ' +
        `current phase is '${report.phase}'. Failing closed — the embedding queue path has no PGlite fallback.`
    );
  }
}

function assertBrowserTursoExecutionClient(client: BrainstrikeDbExecutionClient): void {
  const missingCapabilities = getMissingBrainstrikeDbExecutionClientCapabilities(client);
  if (missingCapabilities.length > 0) {
    throw new Error(
      'Browser Turso embedding worker storage requires DB execution client capabilities: ' +
        `${missingCapabilities.join(', ')}.`
    );
  }
}

function wrapQueuePortWithOwnershipDiagnostics(
  queue: EmbeddingWorkerQueuePort
): EmbeddingWorkerQueuePort {
  return {
    claimMany: (params) =>
      failClosedOnOwnershipLoss('queue.claimMany', () => queue.claimMany(params)),
    completeBatch: (jobs) =>
      failClosedOnOwnershipLoss('queue.completeBatch', () => queue.completeBatch(jobs)),
    completeEmbeddingChunkBatch: (jobs) =>
      failClosedOnOwnershipLoss('queue.completeEmbeddingChunkBatch', () =>
        queue.completeEmbeddingChunkBatch(jobs)
      ),
    fail: (params) => failClosedOnOwnershipLoss('queue.fail', () => queue.fail(params)),
    failBatch: (params) =>
      failClosedOnOwnershipLoss('queue.failBatch', () => queue.failBatch(params)),
    heartbeatBatch: (jobs, extendMs) =>
      failClosedOnOwnershipLoss('queue.heartbeatBatch', () => queue.heartbeatBatch(jobs, extendMs)),
  };
}

export function createTursoBrowserEmbeddingWorkerStorage(
  options: CreateTursoBrowserEmbeddingWorkerStorageOptions
): EmbeddingWorkerStorage {
  const { client, report } = options;
  assertBrowserTursoReport(report);
  assertBrowserTursoExecutionClient(client);

  const baseStorage = createTursoEmbeddingWorkerStorage(client);

  return {
    assertEmbeddingStorageReady: () =>
      failClosedOnOwnershipLoss('assertEmbeddingStorageReady', () =>
        baseStorage.assertEmbeddingStorageReady()
      ),
    createStatsRefreshController: (controllerOptions) =>
      createEmbeddingStatsRefreshControllerWithOperations(controllerOptions, {
        markDirty: (embeddingSetIds) =>
          failClosedOnOwnershipLoss('stats.markDirty', () =>
            markTursoCollectionIndexingStatsDirty(client, embeddingSetIds)
          ),
        refresh: (embeddingSetIds) =>
          failClosedOnOwnershipLoss('stats.refresh', () =>
            client.transaction((tx) => refreshTursoCollectionIndexingStats(tx, embeddingSetIds))
          ),
      }),
    getModelConfig: (modelId) => baseStorage.getModelConfig(modelId),
    loadChunksByIds: (ids) =>
      failClosedOnOwnershipLoss('loadChunksByIds', () => baseStorage.loadChunksByIds(ids)),
    queue: wrapQueuePortWithOwnershipDiagnostics(baseStorage.queue),
    resolveEmbeddingSetDimension: (embeddingSetId) =>
      failClosedOnOwnershipLoss('resolveEmbeddingSetDimension', () =>
        baseStorage.resolveEmbeddingSetDimension(embeddingSetId)
      ),
  };
}
