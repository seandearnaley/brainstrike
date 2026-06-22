import type { EmbeddingSet } from '@brainstrike/db';
import { resolveWorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import { vi } from 'vitest';
import type { WorkspaceCollectionSyncServiceDependencies } from '../workspace-collection-sync-service';

export const ROOT_PATH = '/workspace/root';
export const FILE_PATH = 'src/index.ts';

export const BALANCED_QOS_POLICY = resolveWorkspaceIndexingQosPolicy({
  dbPressure: {
    available: true,
    foregroundPressure: false,
    normalPressure: false,
  },
  foregroundQueryActive: false,
  idleState: 'active',
  idleTimeMs: 0,
  manualPaused: false,
  pipeline: {
    accelerator: { available: false },
    memory: { available: false },
    progress: { available: false },
    queueDepth: {
      activeEmbeddingJobs: 0,
      available: true,
    },
  },
  powerSource: 'ac',
  providerRateLimited: false,
  recentUserInputMs: null,
  thermalState: 'nominal',
  windowVisible: true,
});

export function createCollection(overrides: Partial<EmbeddingSet> = {}): EmbeddingSet {
  return {
    id: overrides.id ?? 'set-1',
    name: overrides.name ?? 'Managed Cache',
    modelId: overrides.modelId ?? 'text-embedding-3-small',
    modelKey: overrides.modelKey ?? 'openai::text-embedding-3-small',
    dimensions: overrides.dimensions ?? 1536,
    distance: overrides.distance ?? 'cosine',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

export function createDeps(
  overrides: Partial<WorkspaceCollectionSyncServiceDependencies> = {}
): WorkspaceCollectionSyncServiceDependencies {
  return {
    applyManagedCacheBatch: vi.fn(async () => undefined),
    chunkRepository: {
      deleteByFileRecordId: vi.fn(async () => undefined),
      getCoverageForSet: vi.fn(async () => ({
        totalChunks: 0,
        chunksWithEmbeddingsForSet: 0,
      })),
      insertMany: vi.fn(async () => []),
      update: vi.fn(async () => null),
    },
    cancelBackfill: vi.fn(async () => undefined),
    db: {
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['db'],
    embeddingSetsRepository: {
      getById: vi.fn(async () => createCollection()),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
    enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
    fileContentProcessor: {
      processFiles: vi.fn(),
    },
    fileRecordRepository: {
      findById: vi.fn(async () => null),
      findByIds: vi.fn(async () => []),
      listManagedCacheEntryMetadata: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
      updateStatMetadata: vi.fn(async () => undefined),
    },
    fileSystemAdapter: {
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    },
    getBackfillsInFlight: vi.fn(async () => []),
    ensureChunkingWorker: vi.fn(async () => ({
      chunkBatch: vi.fn(),
      isReady: () => true,
      transportKind: 'local-worker' as const,
      chunkFile: vi.fn(),
      terminate: vi.fn(),
    })),
    ensureEmbeddingRuntimeStarted: vi.fn(async () => undefined),
    invalidateManagedCacheEntriesByIdentity: vi.fn(async () => ({
      canceledEmbeddingJobCount: 0,
      deletedChunkIds: [],
      deletedFileRecordIds: [],
    })),
    onManagedCollectionMissing: vi.fn(),
    // Non-null by default: managed-cache identity is root_id (source_root_path
    // retired), and an import with a null root_id is skipped. ROOT_PATH doubles
    // as the dbRootId so existing-entry fixtures dedup against the scan.
    resolveDbRootId: vi.fn().mockResolvedValue(ROOT_PATH),
    resolveQosPolicy: vi.fn(async () => BALANCED_QOS_POLICY),
    setImporting: vi.fn(),
    setStatus: vi.fn(),
    subscribeToBackfillProgress: vi.fn(() => () => {}),
    validateHostedProviderAccess: vi.fn(async () => undefined),
    waitForBackgroundPermit: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function createRootHandle(path = ROOT_PATH) {
  return {
    kind: 'directory' as const,
    name: 'workspace',
    path,
    platform: 'electron' as const,
  };
}
