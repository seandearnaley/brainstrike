/**
 * Live retrieval fixtures for the agent host's retrieval tools.
 *
 * Host threads read Main's native index (`hostIndexSearch`) and a catalog-only
 * retrieval store (`hostRetrievalStore`, served by Main's StateStore catalog
 * reads). These fixtures give a suite exactly those shapes: a native
 * `IndexSearchCapability` answering the way Main's does, and a store restricted
 * to the catalog reads the host can reach. Grep reads the disk (ADR 0026), so
 * its suites use real folders instead.
 */
import { embeddingProfileHash } from '@brainstrike/indexer';
import type {
  IndexerSearchHit,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { vi } from 'vitest';
import type { RetrievalStore } from '../../assistant-server/retrieval-store';

export const nativeProfile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
// The indexer's own identity rule, never a copy of its formula.
const profileHash = embeddingProfileHash(nativeProfile);
export const nativeQueryPlan = {
  inferencePlan: {
    device: 'wasm',
    dimensions: nativeProfile.dimensions,
    dtype: nativeProfile.dtype,
    modelId: nativeProfile.modelId,
    revision: nativeProfile.revision,
  },
  modelKey: `local::${nativeProfile.modelId}`,
} as const;
export const nativeEmbedding = {
  indexMode: 'vector-configured',
  profile: nativeProfile,
  profileHash,
} as const;
/** Main's `embedding_sets` row for the saved native collection. */
export const nativeEmbeddingSetRow = {
  dimensions: nativeProfile.dimensions,
  distance: 'cosine',
  modelId: nativeProfile.modelId,
  modelKey: nativeQueryPlan.modelKey,
} as const;
export const nativeHit = {
  chunkId: 'native-chunk',
  chunkIndex: 0,
  chunkSize: 384,
  chunkType: 'text',
  content: 'native marker',
  contentHash: 'c'.repeat(64),
  embeddingSetId: 'selected',
  endLine: 1,
  endOffset: 13,
  fileId: 'file',
  relativePath: null,
  rootId: null,
  score: 0.1,
  sourcePath: null,
  startLine: 1,
  startOffset: 0,
  tokenCount: 3,
} as const;
export const nativeCounts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
const nativeStoreId = 'a'.repeat(64);

/** A ready VECTOR index authorizing the `selected` collection, with mutable status and results. */
export function nativeRetrievalFixture() {
  const initialStatus: IndexerStatus = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: [],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    embedding: nativeEmbedding,
    kind: 'ready',
    queryPlan: nativeQueryPlan,
    rootReadiness: [],
    storeId: nativeStoreId,
  };
  let status: IndexerStatus = initialStatus;
  const result = {
    candidateCount: 1,
    candidatesTruncated: false,
    embedding: nativeEmbedding,
    hits: [nativeHit] as IndexerSearchHit[],
    scanLimited: false,
    storeId: nativeStoreId,
    truncated: false,
  };
  const capability: IndexSearchCapability = {
    coverage: vi.fn(async () => ({
      collections: [{ ...nativeCounts, embeddingSetId: 'selected' }],
      embedding: nativeEmbedding,
      roots: [],
      storeId: result.storeId,
      totals: nativeCounts,
      vectorCoverageComplete: true,
    })),
    coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(async (requests) => {
      const observed = await capability.status();
      if (observed.kind !== 'ready') {
        return { kind: 'blocked', reason: observed.reason };
      }
      return {
        coverage: await Promise.all(requests.map((request) => capability.coverage(request))),
        kind: 'current',
        status: observed,
      };
    }),
    grep: vi.fn(async () => result),
    rebuild: vi.fn(),
    search: vi.fn(async () => result),
    status: vi.fn(async () => status),
  };
  const queryEmbedding = vi.fn(async (_payload: unknown, _options?: { signal?: AbortSignal }) =>
    Array.from({ length: nativeProfile.dimensions }, () => 0.1)
  );
  return {
    capability,
    queryEmbedding,
    result,
    setStatus: (next: IndexerStatus) => {
      status = next;
    },
    status: initialStatus,
  };
}

/** The catalog reads Main serves the agent host (`desktop-read/retrieval/*`); no legacy PG path. */
export function catalogOnly(store: RetrievalStore): RetrievalStore {
  return {
    embeddingSet: store.embeddingSet,
    embeddingSpaces: store.embeddingSpaces,
    fileRecords: store.fileRecords,
  };
}
