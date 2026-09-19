import {
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileSymbolRepository,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { WorkspaceIndexingPowerSnapshot } from '@brainstrike/indexing-contract/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingPipelineInputs,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/indexing-contract/workspace-indexing-qos';

export function createWorkspaceIndexingRepositories(db: DbHandle): {
  chunkRepository: ElectronFileChunkRepository;
  embeddingSetsRepository: ElectronEmbeddingSetsRepository;
  fileRecordRepository: ElectronFileRecordRepository;
  symbolRepository: FileSymbolRepository;
} {
  if (!db.exec) {
    throw new Error('Background indexing requires database exec support.');
  }
  const repositoryDb = {
    exec: async (sql: string): Promise<void> => {
      await db.exec?.(sql);
    },
    query: db.query,
    ...(db.insertChunksAndEnqueueEmbeddingJobs
      ? {
          insertChunksAndEnqueueEmbeddingJobs: db.insertChunksAndEnqueueEmbeddingJobs.bind(db),
        }
      : {}),
  };
  return {
    chunkRepository: new ElectronFileChunkRepository(repositoryDb),
    embeddingSetsRepository: new ElectronEmbeddingSetsRepository(repositoryDb),
    fileRecordRepository: new ElectronFileRecordRepository(repositoryDb),
    symbolRepository: new FileSymbolRepository(repositoryDb),
  };
}

export function createWorkspaceIndexingQosResolver(args: {
  readBackgroundIndexingPaused: () => boolean;
  readDatabasePressure: (() => Promise<WorkspaceIndexingDatabasePressure>) | null;
  readForegroundQueryActive: () => boolean;
  readPipelineInputs: (() => Promise<WorkspaceIndexingPipelineInputs>) | null;
  readPowerSnapshot: (() => Promise<WorkspaceIndexingPowerSnapshot>) | null;
  readRecentUserInputMs: () => number | null;
  readWindowVisible: () => boolean;
}): (options?: {
  foregroundDbPressureStarvationBypass?: boolean;
}) => Promise<WorkspaceIndexingQosPolicy> {
  const observeTransition = createWorkspaceIndexingQosTransitionLogger('app-shell-sync');
  return async (options) => {
    if (!(args.readDatabasePressure && args.readPipelineInputs)) {
      throw new Error('Workspace Index QoS requires database scheduler snapshots.');
    }
    const powerSnapshot = args.readPowerSnapshot ? await args.readPowerSnapshot() : null;
    const policy = resolveWorkspaceIndexingQosPolicy({
      dbPressure: await args.readDatabasePressure(),
      foregroundDbPressureStarvationBypass: options?.foregroundDbPressureStarvationBypass ?? false,
      foregroundQueryActive: args.readForegroundQueryActive(),
      idleState: powerSnapshot?.idleState ?? 'unknown',
      idleTimeMs: powerSnapshot?.idleTimeMs ?? null,
      manualPaused: args.readBackgroundIndexingPaused(),
      pipeline: await args.readPipelineInputs(),
      powerSource: powerSnapshot?.powerSource ?? 'unknown',
      providerRateLimited: false,
      recentUserInputMs: args.readRecentUserInputMs(),
      thermalState: powerSnapshot?.thermalState ?? 'unknown',
      windowVisible: args.readWindowVisible(),
    });
    observeTransition(policy);
    return policy;
  };
}
