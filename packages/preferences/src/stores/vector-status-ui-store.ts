import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

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
  chunksCount: number | undefined;
  createdAt: string;
  embeddingSetId: string | undefined;
  id: string;
  name: string;
  path: string;
  size: number;
  tokenCount: number | undefined;
  updatedAt: string;
}

/**
 * Minimal file chunk for caching - excludes large fields like content/embedding
 */
export interface CachedFileChunk {
  chunkIndex: number;
  chunkType: 'text' | 'sentence' | 'recursive' | 'code';
  embeddingSetId: string | undefined;
  fileRecordId: string;
  id: string;
  tokenCount: number;
}

/**
 * Per-collection cache entry
 */
interface CollectionDataCache {
  chunks: CachedFileChunk[];
  collectionId: string;
  records: CachedFileRecord[];
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

interface VectorStatusUIData {
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
  setActiveEmbeddingSetId: (id: string | null) => void;
  setCachedCollections: (collections: CachedCollection[]) => void;
  setCachedFileData: (data: CollectionDataCache | null) => void;
  /** BST-359: Write durable queue stats from the single tracker poller. */
  setDurableQueueStats: (stats: QueueStatsSnapshot | null) => void;
  setIsEmbeddingQueueActive: (active: boolean) => void;
  setIsImporting: (importing: boolean) => void;
  setIsJobQueueActive: (active: boolean) => void;
  setSchemaVerified: (verified: boolean) => void;
}

export type VectorStatusUIStore = VectorStatusUIData & VectorStatusUIActions;

const STORE_NAME = 'vector-status-ui.v1' as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

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
      isImporting: false,
      isEmbeddingActive: false,
      isEmbeddingQueueActive: false,
      isJobQueueActive: false,
      durableQueueStats: null,
      cachedCollections: [],
      cachedFileData: null,
      schemaVerified: false,
      setActiveEmbeddingSetId: (id) => set({ activeEmbeddingSetId: id }),
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
