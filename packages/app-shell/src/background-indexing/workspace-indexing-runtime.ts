import {
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileSymbolRepository,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { WorkspaceIndexingPowerSnapshot } from '@brainstrike/indexing-contract/workspace-indexing-power-snapshot';
import {
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
    query: db.query.bind(db),
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
  observeTransition: (policy: WorkspaceIndexingQosPolicy) => void;
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
  return async (options) => {
    if (!(args.readDatabasePressure && args.readPipelineInputs)) {
      throw new Error('Workspace Index QoS requires database scheduler snapshots.');
    }
    const powerSnapshot = args.readPowerSnapshot ? await args.readPowerSnapshot() : null;
    const policy = resolveWorkspaceIndexingQosPolicy({
      dbPressure: await args.readDatabasePressure(),
      foregroundDbPressureStarvationBypass: options?.foregroundDbPressureStarvationBypass ?? false,
      // This is the coarse app-shell signal. The hidden renderer host's
      // ForegroundEmbeddingGate remains the embedding-scoped GPU coordinator.
      foregroundQueryActive: args.readForegroundQueryActive(),
      idleState: powerSnapshot?.idleState ?? 'unknown',
      idleTimeMs: powerSnapshot?.idleTimeMs ?? null,
      manualPaused: args.readBackgroundIndexingPaused(),
      pipeline: await args.readPipelineInputs(),
      powerSource: powerSnapshot?.powerSource ?? 'unknown',
      // TODO(workspace-index-qos): wire hosted provider rate-limit telemetry.
      providerRateLimited: false,
      recentUserInputMs: args.readRecentUserInputMs(),
      thermalState: powerSnapshot?.thermalState ?? 'unknown',
      windowVisible: args.readWindowVisible(),
    });
    args.observeTransition(policy);
    return policy;
  };
}
