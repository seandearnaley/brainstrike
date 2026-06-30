import type { BrainstrikeDbExecutionClient } from '@brainstrike/db';
import {
  createEmbeddingStatsRefreshControllerWithOperations,
  createTursoEmbeddingWorkerStorage,
  type EmbeddingWorkerQueuePort,
  type EmbeddingWorkerStorage,
} from '@brainstrike/embeddings/worker';
import type { DatabaseWorkOptions } from '@brainstrike/types';

type TursoEmbeddingWorkerQueueOperation =
  | 'claimMany'
  | 'completeBatch'
  | 'completeEmbeddingChunkBatch'
  | 'fail'
  | 'failBatch'
  | 'heartbeatBatch';
type TursoEmbeddingWorkerStatsOperation = 'markDirty' | 'refresh';

type QueueBridge = (
  operation: TursoEmbeddingWorkerQueueOperation,
  payload: unknown,
  options?: DatabaseWorkOptions
) => Promise<unknown>;
type StatsBridge = (
  operation: TursoEmbeddingWorkerStatsOperation,
  embeddingSetIds: readonly string[],
  options?: DatabaseWorkOptions
) => Promise<void>;

interface DesktopTursoEmbeddingWorkerBridge {
  readonly queue: QueueBridge;
  readonly stats: StatsBridge;
}

function getDesktopTursoEmbeddingWorkerBridge(): DesktopTursoEmbeddingWorkerBridge {
  const dbBridge = window.electronAPI?.db;
  if (typeof dbBridge?.tursoEmbeddingWorkerQueue !== 'function') {
    throw new Error('Desktop Turso embedding worker queue IPC bridge is unavailable.');
  }
  if (typeof dbBridge.tursoEmbeddingWorkerStats !== 'function') {
    throw new Error('Desktop Turso embedding worker stats IPC bridge is unavailable.');
  }
  return {
    queue: dbBridge.tursoEmbeddingWorkerQueue,
    stats: dbBridge.tursoEmbeddingWorkerStats,
  };
}

function queueWorkOptions(operation: TursoEmbeddingWorkerQueueOperation): DatabaseWorkOptions {
  return {
    label: `turso.embedding-worker.queue.${operation}`,
    priority: 'background',
  };
}

function statsWorkOptions(operation: TursoEmbeddingWorkerStatsOperation): DatabaseWorkOptions {
  return {
    label: `turso.embedding-worker.stats.${operation}`,
    priority: 'background',
  };
}

function createDesktopTursoQueuePort(bridge: QueueBridge): EmbeddingWorkerQueuePort {
  return {
    claimMany: async (params) =>
      (await bridge('claimMany', params, queueWorkOptions('claimMany'))) as ReturnType<
        EmbeddingWorkerQueuePort['claimMany']
      >,
    completeBatch: async (jobs) =>
      (await bridge('completeBatch', [...jobs], queueWorkOptions('completeBatch'))) as ReturnType<
        EmbeddingWorkerQueuePort['completeBatch']
      >,
    completeEmbeddingChunkBatch: async (jobs) =>
      (await bridge(
        'completeEmbeddingChunkBatch',
        [...jobs],
        queueWorkOptions('completeEmbeddingChunkBatch')
      )) as ReturnType<EmbeddingWorkerQueuePort['completeEmbeddingChunkBatch']>,
    fail: async (params) =>
      (await bridge('fail', params, queueWorkOptions('fail'))) as ReturnType<
        EmbeddingWorkerQueuePort['fail']
      >,
    failBatch: async (params) =>
      (await bridge('failBatch', params, queueWorkOptions('failBatch'))) as ReturnType<
        EmbeddingWorkerQueuePort['failBatch']
      >,
    heartbeatBatch: async (jobs, extendMs) =>
      (await bridge(
        'heartbeatBatch',
        { extendMs, jobs: [...jobs] },
        queueWorkOptions('heartbeatBatch')
      )) as ReturnType<EmbeddingWorkerQueuePort['heartbeatBatch']>,
  };
}

export function createDesktopTursoEmbeddingWorkerStorage(
  db: BrainstrikeDbExecutionClient
): EmbeddingWorkerStorage {
  const baseStorage = createTursoEmbeddingWorkerStorage(db);
  const bridge = getDesktopTursoEmbeddingWorkerBridge();
  return {
    ...baseStorage,
    createStatsRefreshController: (options) =>
      createEmbeddingStatsRefreshControllerWithOperations(options, {
        markDirty: async (embeddingSetIds: readonly string[]) =>
          bridge.stats('markDirty', [...embeddingSetIds], statsWorkOptions('markDirty')),
        refresh: async (embeddingSetIds: readonly string[]) =>
          bridge.stats('refresh', [...embeddingSetIds], statsWorkOptions('refresh')),
      }),
    queue: createDesktopTursoQueuePort(bridge.queue),
  };
}
