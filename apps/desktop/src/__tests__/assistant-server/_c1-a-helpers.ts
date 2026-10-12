/**
 * Live retrieval and grep fixtures for the agent host's search tools.
 *
 * Host threads always read the workspace through Main's native index
 * (`hostIndexSearch` / `desktop-read/grep-index`, served by `nativeGrepIndex`)
 * and a catalog-only retrieval store (`hostRetrievalStore`, served by Main's
 * `pgliteRetrievalStore` catalog reads). These fixtures give a suite exactly
 * those shapes: a native `IndexSearchCapability` answering the way Main's
 * does, and a store restricted to the catalog reads the host can reach.
 */
import { createHash } from 'node:crypto';
import type {
  IndexerGrepRequest,
  IndexerGrepResult,
  IndexerSearchHit,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { vi } from 'vitest';
import { nativeGrepIndex } from '../../agent-host-platform/native-grep-index';
import type { GrepIndexSearch } from '../../assistant-server/grep-search-core';
import type { RetrievalStore } from '../../assistant-server/retrieval-store';

export const nativeProfile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
const profileHash = createHash('sha256')
  .update(
    JSON.stringify([
      nativeProfile.modelId,
      nativeProfile.revision,
      nativeProfile.dtype,
      nativeProfile.dimensions,
      nativeProfile.tokenCap,
    ])
  )
  .digest('hex');
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

/** One indexed grep chunk, in the row shape the grep suites author. */
export interface IndexedGrepRow {
  readonly content: string;
  readonly embedding_set_id?: string;
  readonly path: string;
  readonly root_id?: string;
  readonly start_line: number;
}

interface NativeGrepFixtureOptions {
  readonly authorizedCollectionIds?: readonly string[];
  readonly authorizedRootIds?: readonly string[];
}

/**
 * Main's native grep index (`nativeGrepIndex`) over a fake text-only indexer
 * that answers like the SQLite grep reader: it honours the requested roots,
 * exact file selection and candidate limit, and attributes each hit to a root.
 */
export function nativeGrepFixture(options: NativeGrepFixtureOptions = {}) {
  const authorizedRootIds = options.authorizedRootIds ?? ['root'];
  const authorizedCollectionIds = options.authorizedCollectionIds ?? ['selected'];
  const grep = vi.fn<IndexSearchCapability['grep']>();
  const status = vi.fn<IndexSearchCapability['status']>(async () => ({
    authorizedCollectionIds: [...authorizedCollectionIds],
    authorizedRootIds: [...authorizedRootIds],
    embedding: { indexMode: 'text-only' },
    kind: 'ready',
    rootReadiness: authorizedRootIds.map((rootId) => ({ rootId, scanComplete: true })),
    storeId: nativeStoreId,
  }));
  const answer =
    (rows: readonly IndexedGrepRow[]) =>
    async (request: IndexerGrepRequest): Promise<IndexerGrepResult> => {
      const selected = rows
        .map((row, index) => ({ index, rootId: row.root_id ?? request.rootIds[0] ?? null, row }))
        .filter(
          ({ row, rootId }) =>
            rootId !== null &&
            request.rootIds.includes(rootId) &&
            (request.filePaths === undefined || request.filePaths.includes(row.path))
        );
      const hits = selected.slice(0, request.limit).map(({ index, row, rootId }) => ({
        chunkId: `chunk-${index}`,
        chunkIndex: 0,
        chunkSize: row.content.length,
        chunkType: 'text' as const,
        content: row.content,
        contentHash: 'c'.repeat(64),
        embeddingSetId: row.embedding_set_id ?? authorizedCollectionIds[0] ?? null,
        endLine: row.start_line + row.content.split('\n').length - 1,
        endOffset: row.content.length,
        fileId: `file-${index}`,
        relativePath: row.path,
        rootId,
        score: 1,
        startLine: row.start_line,
        startOffset: 0,
        tokenCount: 1,
      }));
      return {
        candidateCount: hits.length,
        candidatesTruncated: false,
        embedding: { indexMode: 'text-only' },
        hits,
        scanLimited: false,
        storeId: nativeStoreId,
        truncated: selected.length > hits.length,
      };
    };
  const index: GrepIndexSearch = nativeGrepIndex({ grep, status });
  return {
    grep,
    index,
    /** Every later grep answers from these indexed rows. */
    serve: (rows: readonly IndexedGrepRow[]) => {
      grep.mockImplementation(answer(rows));
    },
    /** The next grep answers from these rows (probe sequencing). */
    serveOnce: (rows: readonly IndexedGrepRow[]) => {
      grep.mockImplementationOnce(answer(rows));
    },
    status,
  };
}
