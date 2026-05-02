import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

/**
 * Sort comparator for collections: descending by createdAt, then id.
 * Accepts any object with `createdAt` and `id` string fields.
 */
export function compareCollectionsDesc(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
): number {
  if (right.createdAt > left.createdAt) {
    return 1;
  }
  if (right.createdAt < left.createdAt) {
    return -1;
  }
  if (right.id > left.id) {
    return 1;
  }
  if (right.id < left.id) {
    return -1;
  }
  return 0;
}

/**
 * Cached collection data - persists across component unmounts during imports
 */
export interface CachedCollection {
  category: string | null;
  chunkCount: number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  embeddingCount: number;
  fileCount: number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  tags: string | null;
}

/**
 * Minimal file record for caching - excludes large fields like content/embedding
 */
export interface CachedFileRecord {
  chunkingStrategy: string | undefined;
  chunksCount: number | undefined;
  chunksProcessedAt: string | undefined;
  contentHash: string | undefined;
  createdAt: string;
  embeddedChunksCount: number | undefined;
  embeddingSetId: string | undefined;
  hasEmbedding: boolean;
  id: string;
  name: string;
  path: string;
  processedAt: string | undefined;
  size: number;
  tokenCount: number | undefined;
  updatedAt: string;
}

/**
 * Minimal file chunk for caching - excludes large fields like content/embedding
 */
export interface CachedFileChunk {
  chunkIndex: number;
  chunkSize: number;
  chunkType: 'text' | 'sentence' | 'recursive' | 'code';
  contentHash: string;
  createdAt: string;
  embeddingDimensions: number;
  embeddingHash: string | undefined;
  embeddingSetId: string | undefined;
  embeddingUpdatedAt: string | undefined;
  fileRecordId: string;
  hasEmbedding: boolean;
  id: string;
  tokenCount: number;
  updatedAt: string;
}

/**
 * Per-collection cache entry
 */
interface CollectionDataCache {
  chunks: CachedFileChunk[];
  collectionCounts: {
    chunks: number;
    embeddings: number;
    records: number;
  };
  collectionId: string;
  page: number;
  pageSize: number;
  records: CachedFileRecord[];
  totalRecords: number;
}

/**
 * Snapshot of durable queue stats from the database.
 * BST-359: Shared across tracker, HUD, and diagnostics to avoid duplicate polling.
 */
export interface QueueStatsSnapshot {
  failed: number;
  nextRunnableAt: string | null;
  queued: number;
  running: number;
  succeeded: number;
}

export interface BackfillProgressSnapshot {
  done: number;
  total: number;
}

export interface ActiveBackfillState {
  embeddingSetId: string;
  progress: BackfillProgressSnapshot | null;
  requestId: string;
}

interface VectorStatusUIData {
  /** Active backfill state shared across tab switches and remounts. */
  activeBackfill: ActiveBackfillState | null;
  activeEmbeddingSetId: string | null;
  /** Cached collections data - persists across component unmounts during bulk operations */
  cachedCollections: CachedCollection[];
  /** Cached file data for active collection - persists across component unmounts */
  cachedFileData: CollectionDataCache | null;
  /** BST-359: Durable queue stats polled by EmbeddingJobQueueTracker, consumed by HUD and diagnostics. */
  durableQueueStats: QueueStatsSnapshot | null;
  /** When true, embeddings are actively being generated (from any source). */
  isEmbeddingActive: boolean;
  /** When true, the local embedding queue adapter is processing tasks. */
  isEmbeddingQueueActive: boolean;
  /** When true, live queries should be paused to avoid performance degradation during bulk operations */
  isImporting: boolean;
  /** When true, the job_queue has embedding work pending (queued/running). */
  isJobQueueActive: boolean;
  /** Whether database schema has been verified - persists across component unmounts */
  schemaVerified: boolean;
}

interface VectorStatusUIActions {
  /**
   * Remove a collection from the cache by ID.
   * Uses functional state update to avoid stale closure bugs in async handlers.
   */
  removeCachedCollection: (collectionId: string) => void;
  setActiveBackfill: (backfill: ActiveBackfillState | null) => void;
  setActiveEmbeddingSetId: (id: string | null) => void;
  setCachedCollections: (collections: CachedCollection[]) => void;
  setCachedFileData: (data: CollectionDataCache | null) => void;
  /** BST-359: Write durable queue stats from the single tracker poller. */
  setDurableQueueStats: (stats: QueueStatsSnapshot | null) => void;
  setIsEmbeddingQueueActive: (active: boolean) => void;
  setIsImporting: (importing: boolean) => void;
  setIsJobQueueActive: (active: boolean) => void;
  setSchemaVerified: (verified: boolean) => void;
  upsertCachedCollection: (collection: CachedCollection) => void;
}

export type VectorStatusUIStore = VectorStatusUIData & VectorStatusUIActions;

const STORE_NAME = 'vector-status-ui.v1' as const;

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function getElectronStorageBridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const bridge = (
    window as Window & {
      electronAPI?: {
        storage?: ElectronStorageBridge;
      };
    }
  ).electronAPI?.storage;

  if (!bridge) {
    return null;
  }

  return bridge;
}

function readLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return;
  }
}

function removeStoredValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Best effort: blocked storage should not make cleanup flows fail.
  }
}

function createVectorStatusBrowserStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const raw = readLocalStorage()?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        removeStoredValue(readLocalStorage(), key);
        memory.delete(key);
        return null;
      }
    },
    setItem: (key, value) => {
      const storage = readLocalStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall through to in-memory storage for quota/private-mode failures.
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      removeStoredValue(readLocalStorage(), key);
      memory.delete(key);
    },
  };
}

/**
 * Keep this browser fallback local instead of importing the shared helper.
 * In the production bundle, Zustand eagerly initializes storage during module
 * evaluation; importing the shared helper here can reintroduce the preference
 * chunk cycle that made storage unavailable on web boot.
 */
function createVectorStatusUIStorage(): StateStorage {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
      removeItem: (key: string) => electronStorage.removeItem(key),
    };
  }

  return createVectorStatusBrowserStorage();
}

const storage = createJSONStorage(() => createVectorStatusUIStorage());

function areQueueStatsSnapshotsEqual(
  left: QueueStatsSnapshot | null,
  right: QueueStatsSnapshot | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  return (
    left.failed === right.failed &&
    left.queued === right.queued &&
    left.running === right.running &&
    left.succeeded === right.succeeded &&
    left.nextRunnableAt === right.nextRunnableAt
  );
}

export const useVectorStatusUIStore = create<VectorStatusUIStore>()(
  persist(
    (set) => ({
      activeEmbeddingSetId: null,
      activeBackfill: null,
      isImporting: false,
      isEmbeddingActive: false,
      isEmbeddingQueueActive: false,
      isJobQueueActive: false,
      durableQueueStats: null,
      cachedCollections: [],
      cachedFileData: null,
      schemaVerified: false,
      setActiveEmbeddingSetId: (id) => set({ activeEmbeddingSetId: id }),
      setActiveBackfill: (backfill) => set({ activeBackfill: backfill }),
      setIsImporting: (importing) => set({ isImporting: importing }),
      setDurableQueueStats: (stats) =>
        set((state) =>
          areQueueStatsSnapshotsEqual(state.durableQueueStats, stats)
            ? state
            : { durableQueueStats: stats }
        ),
      setIsEmbeddingQueueActive: (active) =>
        set((state) => ({
          isEmbeddingQueueActive: active,
          isEmbeddingActive: active || state.isJobQueueActive,
        })),
      setIsJobQueueActive: (active) =>
        set((state) => ({
          isJobQueueActive: active,
          isEmbeddingActive: state.isEmbeddingQueueActive || active,
        })),
      setCachedCollections: (collections) => set({ cachedCollections: collections }),
      removeCachedCollection: (collectionId) =>
        set((state) => ({
          cachedCollections: state.cachedCollections.filter((c) => c.id !== collectionId),
        })),
      upsertCachedCollection: (collection) =>
        set((state) => {
          const next = state.cachedCollections.filter(
            (candidate) => candidate.id !== collection.id
          );
          next.unshift(collection);
          next.sort(compareCollectionsDesc);
          return { cachedCollections: next };
        }),
      setCachedFileData: (data) => set({ cachedFileData: data }),
      setSchemaVerified: (verified) => set({ schemaVerified: verified }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      // Only persist activeEmbeddingSetId - import/embedding flags and cached data are transient
      partialize: (s) => ({ activeEmbeddingSetId: s.activeEmbeddingSetId }),
    }
  )
);

export const vectorStatusUISelectors = {
  activeSet: (s: VectorStatusUIStore) => s.activeEmbeddingSetId,
  activeBackfill: (s: VectorStatusUIStore) => s.activeBackfill,
  isImporting: (s: VectorStatusUIStore) => s.isImporting,
  isEmbeddingActive: (s: VectorStatusUIStore) => s.isEmbeddingActive,
  isEmbeddingQueueActive: (s: VectorStatusUIStore) => s.isEmbeddingQueueActive,
  isJobQueueActive: (s: VectorStatusUIStore) => s.isJobQueueActive,
  durableQueueStats: (s: VectorStatusUIStore) => s.durableQueueStats,
  cachedCollections: (s: VectorStatusUIStore) => s.cachedCollections,
  cachedFileData: (s: VectorStatusUIStore) => s.cachedFileData,
  schemaVerified: (s: VectorStatusUIStore) => s.schemaVerified,
};

export function __resetVectorStatusUIStoreForTests() {
  try {
    const persistApi = (
      useVectorStatusUIStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useVectorStatusUIStore.setState({
    activeEmbeddingSetId: null,
    activeBackfill: null,
    isImporting: false,
    isEmbeddingActive: false,
    isEmbeddingQueueActive: false,
    isJobQueueActive: false,
    durableQueueStats: null,
    cachedCollections: [],
    cachedFileData: null,
    schemaVerified: false,
  });
}
