import type { DbHandle, FileChunk, FileRecord, IFileRecordRepository } from '@brainstrike/db';
import {
  type CollectionCountsRow,
  cacheCollectionCountsForCollection,
  cacheTotalRecordsForCollection,
  type FileChunkRow,
  type FileRecordRow,
  type FileRecordsTotalRow,
  mapChunkRow,
  mapRecordRow,
} from './database-demo-data-mappers';

const EXPORT_LOAD_BATCH_SIZE = 50;

interface DatabaseQuerySurface {
  query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
}

export interface DatabaseDemoChunkRepository {
  readonly countEmbeddedByFileRecordIds?: (
    fileRecordIds: readonly string[],
    embeddingSetId: string
  ) => Promise<Map<string, number>>;
  readonly findByFileRecordId?: (fileRecordId: string) => Promise<FileChunk[]>;
  readonly findById?: (chunkId: string) => Promise<FileChunk | null>;
  readonly getCoverageForSet?: (embeddingSetId: string) => Promise<{
    chunksWithEmbeddingsForSet: number;
    totalChunks: number;
  }>;
}

export interface DatabaseDemoRecordRepository extends IFileRecordRepository {
  readonly countByEmbeddingSet?: (embeddingSetId: string) => Promise<number>;
  readonly listByEmbeddingSet?: (embeddingSetId: string) => Promise<FileRecord[]>;
  readonly listByEmbeddingSetPage?: (
    embeddingSetId: string,
    options: { limit: number; offset: number }
  ) => Promise<FileRecord[]>;
}

export interface DatabaseFileRecordSummary {
  chunkingStrategy?: FileRecord['chunkingStrategy'];
  chunksCount?: number;
  chunksProcessedAt?: string;
  contentHash?: string;
  createdAt: string;
  embeddedChunksCount?: number;
  embeddingSetId?: string;
  hasEmbedding?: boolean;
  id: string;
  name: string;
  path: string;
  processedAt?: string;
  size: number;
  tokenCount?: number;
  updatedAt: string;
}

export interface DatabaseFileChunkSummary {
  chunkIndex: number;
  chunkSize: number;
  chunkType: FileChunk['chunkType'];
  contentHash: string;
  createdAt: string;
  embeddingDimensions?: number;
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  fileRecordId: string;
  hasEmbedding?: boolean;
  id: string;
  tokenCount: number;
  updatedAt: string;
}

export interface DatabaseCollectionCounts {
  chunks: number;
  embeddings: number;
  records: number;
}

export type DatabaseCollectionCountsStatus = 'pending' | 'ready';

export interface SnapshotCacheState {
  cachedCollectionCounts: Map<string, DatabaseCollectionCounts>;
  cachedRecords: Map<string, DatabaseFileRecordSummary[]>;
  cachedRecordTotals: Map<string, number>;
  loadedRecordPages: Set<string>;
}

export interface SnapshotLoadOptions {
  includeCollectionCounts: boolean;
  includeRecords: boolean;
  includeTotalRecords: boolean;
}

export interface PGliteCollectionSnapshotQueries {
  collectionCounts: string;
  fileRecordsPage: string;
  fileRecordsTotal: string;
}

function getQuerySurface(database: DbHandle | null | undefined): DatabaseQuerySurface | null {
  return typeof (database as { query?: unknown })?.query === 'function'
    ? (database as DatabaseQuerySurface)
    : null;
}

function formatDatabaseRuntimeLabel(databaseRuntimeEngine: string | null): string {
  if (databaseRuntimeEngine === 'turso') {
    return 'Turso';
  }
  return 'current';
}

export function resolveCollectionBrowserUnavailableReason({
  activeCollectionId,
  databaseRuntimeEngine,
  supportsCollectionSnapshots,
}: {
  activeCollectionId: string | null;
  databaseRuntimeEngine: string | null;
  supportsCollectionSnapshots: boolean;
}): string | undefined {
  if (!(activeCollectionId && !supportsCollectionSnapshots)) {
    return;
  }
  return `Collection file browsing requires collection snapshot support for the ${formatDatabaseRuntimeLabel(
    databaseRuntimeEngine
  )} database runtime.`;
}

export function resolveCachedCollectionCountsStatus(
  activeCollectionId: string | null,
  cachedCollectionCounts: Map<string, DatabaseCollectionCounts>
): DatabaseCollectionCountsStatus {
  return activeCollectionId && cachedCollectionCounts.has(activeCollectionId) ? 'ready' : 'pending';
}

export async function mapInBatches<T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
  batchSize = EXPORT_LOAD_BATCH_SIZE
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...batchResults);
  }
  return results;
}

export function hasRepositorySnapshotSupport(
  repository: IFileRecordRepository | null,
  chunkRepository: DatabaseDemoChunkRepository | null | undefined
): repository is DatabaseDemoRecordRepository {
  return Boolean(
    repository &&
      typeof (repository as DatabaseDemoRecordRepository).countByEmbeddingSet === 'function' &&
      typeof (repository as DatabaseDemoRecordRepository).listByEmbeddingSet === 'function' &&
      typeof (repository as DatabaseDemoRecordRepository).listByEmbeddingSetPage === 'function' &&
      chunkRepository &&
      typeof chunkRepository.countEmbeddedByFileRecordIds === 'function' &&
      typeof chunkRepository.findByFileRecordId === 'function' &&
      typeof chunkRepository.getCoverageForSet === 'function'
  );
}

function fileRecordToSummary(
  record: FileRecord,
  embeddedChunksCount = 0
): DatabaseFileRecordSummary {
  return {
    ...(record.chunkingStrategy !== undefined && { chunkingStrategy: record.chunkingStrategy }),
    ...(record.chunksCount !== undefined && { chunksCount: record.chunksCount }),
    ...(record.chunksProcessedAt !== undefined && { chunksProcessedAt: record.chunksProcessedAt }),
    ...(record.contentHash !== undefined && { contentHash: record.contentHash }),
    createdAt: record.createdAt,
    embeddedChunksCount,
    ...(record.embeddingSetId !== undefined && { embeddingSetId: record.embeddingSetId }),
    hasEmbedding: embeddedChunksCount > 0,
    id: record.id,
    name: record.name,
    path: record.path,
    ...(record.processedAt !== undefined && { processedAt: record.processedAt }),
    size: record.size,
    ...(record.tokenCount !== undefined && { tokenCount: record.tokenCount }),
    updatedAt: record.updatedAt,
  };
}

function fileChunkToSummary(chunk: FileChunk): DatabaseFileChunkSummary {
  const embeddingDimensions = chunk.embeddingDimensions ?? chunk.embedding?.length;
  return {
    chunkIndex: chunk.chunkIndex,
    chunkSize: chunk.chunkSize,
    chunkType: chunk.chunkType,
    contentHash: chunk.contentHash,
    createdAt: chunk.createdAt,
    ...(embeddingDimensions !== undefined && { embeddingDimensions }),
    ...(chunk.embeddingHash !== undefined && { embeddingHash: chunk.embeddingHash }),
    ...(chunk.embeddingSetId !== undefined && { embeddingSetId: chunk.embeddingSetId }),
    ...(chunk.embeddingUpdatedAt !== undefined && { embeddingUpdatedAt: chunk.embeddingUpdatedAt }),
    fileRecordId: chunk.fileRecordId,
    hasEmbedding: Boolean(chunk.embedding || embeddingDimensions || chunk.embeddingHash),
    id: chunk.id,
    tokenCount: chunk.tokenCount,
    updatedAt: chunk.updatedAt,
  };
}

export async function loadPGliteChunkSummaries({
  database,
  fileRecordId,
  query,
}: {
  database: DbHandle | null | undefined;
  fileRecordId: string;
  query: string;
}): Promise<DatabaseFileChunkSummary[]> {
  const queryDatabase = getQuerySurface(database);
  if (!queryDatabase) {
    throw new Error('Chunk summary requests require database query support.');
  }
  const result = await queryDatabase.query<FileChunkRow>(query, [fileRecordId]);
  return result.rows.map(mapChunkRow);
}

export async function loadRepositoryChunkSummaries(
  chunkRepository: DatabaseDemoChunkRepository | null | undefined,
  fileRecordId: string
): Promise<DatabaseFileChunkSummary[]> {
  if (!chunkRepository || typeof chunkRepository.findByFileRecordId !== 'function') {
    throw new Error('Chunk summary repository does not support findByFileRecordId.');
  }
  const chunks = await chunkRepository.findByFileRecordId(fileRecordId);
  return chunks.map(fileChunkToSummary);
}

export async function loadPGliteExportRecords({
  activeCollectionId,
  database,
  query,
  repository,
}: {
  activeCollectionId: string;
  database: DbHandle | null | undefined;
  query: string;
  repository: IFileRecordRepository;
}): Promise<FileRecord[]> {
  const queryDatabase = getQuerySurface(database);
  if (!queryDatabase) {
    throw new Error('Collection export requires database query support.');
  }
  const recordIdsResult = await queryDatabase.query<{ id: string }>(query, [activeCollectionId]);
  const recordIds = recordIdsResult.rows.map((record) => record.id);
  return mapInBatches(recordIds, async (recordId) => {
    const record = await repository.findById(recordId);
    if (!record) {
      throw new Error(`Missing file record during export: ${recordId}`);
    }
    return record;
  });
}

export async function cachePGliteCollectionSnapshot({
  activeCollectionId,
  cache,
  database,
  normalizedRecordPageSize,
  options,
  queries,
  recordOffset,
  recordPageCacheKey,
  recordQueryParams,
}: {
  activeCollectionId: string;
  cache: SnapshotCacheState;
  database: DbHandle;
  normalizedRecordPageSize: number;
  options: SnapshotLoadOptions;
  queries: PGliteCollectionSnapshotQueries;
  recordOffset: number;
  recordPageCacheKey: string;
  recordQueryParams: readonly [string, number, number, string] | undefined;
}): Promise<boolean> {
  const queryDatabase = getQuerySurface(database);
  if (!queryDatabase) {
    return false;
  }
  const recordParams = recordQueryParams ?? [
    activeCollectionId,
    normalizedRecordPageSize,
    recordOffset,
    activeCollectionId,
  ];
  const recordsResult = await (options.includeRecords
    ? queryDatabase.query<FileRecordRow>(queries.fileRecordsPage, recordParams)
    : Promise.resolve(null));
  const totalRecordsResult = await (options.includeTotalRecords
    ? queryDatabase.query<FileRecordsTotalRow>(queries.fileRecordsTotal, [activeCollectionId])
    : Promise.resolve(null));
  const collectionCountsResult = await (options.includeCollectionCounts
    ? queryDatabase.query<CollectionCountsRow>(queries.collectionCounts, [activeCollectionId])
    : Promise.resolve(null));

  if (recordsResult) {
    cache.cachedRecords.set(recordPageCacheKey, recordsResult.rows.map(mapRecordRow));
    cache.loadedRecordPages.add(recordPageCacheKey);
  }
  if (totalRecordsResult) {
    cacheTotalRecordsForCollection({
      cache: cache.cachedRecordTotals,
      collectionId: activeCollectionId,
      rows: totalRecordsResult.rows,
    });
  }
  if (collectionCountsResult) {
    cacheCollectionCountsForCollection({
      cache: cache.cachedCollectionCounts,
      collectionId: activeCollectionId,
      rows: collectionCountsResult.rows,
    });
  }
  return true;
}

export async function cacheRepositoryCollectionSnapshot({
  activeCollectionId,
  cache,
  chunkRepository,
  normalizedRecordPageSize,
  options,
  recordOffset,
  recordPageCacheKey,
  repository,
}: {
  activeCollectionId: string;
  cache: SnapshotCacheState;
  chunkRepository: Required<
    Pick<
      DatabaseDemoChunkRepository,
      'countEmbeddedByFileRecordIds' | 'findByFileRecordId' | 'getCoverageForSet'
    >
  >;
  normalizedRecordPageSize: number;
  options: SnapshotLoadOptions;
  recordOffset: number;
  recordPageCacheKey: string;
  repository: Required<
    Pick<
      DatabaseDemoRecordRepository,
      'countByEmbeddingSet' | 'listByEmbeddingSet' | 'listByEmbeddingSetPage'
    >
  >;
}): Promise<void> {
  if (options.includeRecords) {
    const pageRecords = await repository.listByEmbeddingSetPage(activeCollectionId, {
      limit: normalizedRecordPageSize,
      offset: recordOffset,
    });
    const embeddedCountByFileRecordId = await chunkRepository.countEmbeddedByFileRecordIds(
      pageRecords.map((record) => record.id),
      activeCollectionId
    );
    cache.cachedRecords.set(
      recordPageCacheKey,
      pageRecords.map((record) =>
        fileRecordToSummary(record, embeddedCountByFileRecordId.get(record.id) ?? 0)
      )
    );
    cache.loadedRecordPages.add(recordPageCacheKey);
  }
  if (options.includeTotalRecords) {
    cache.cachedRecordTotals.set(
      activeCollectionId,
      await repository.countByEmbeddingSet(activeCollectionId)
    );
  }
  if (options.includeCollectionCounts) {
    const coverage = await chunkRepository.getCoverageForSet(activeCollectionId);
    cache.cachedCollectionCounts.set(activeCollectionId, {
      chunks: coverage.totalChunks,
      embeddings: coverage.chunksWithEmbeddingsForSet,
      records:
        cache.cachedRecordTotals.get(activeCollectionId) ??
        (await repository.countByEmbeddingSet(activeCollectionId)),
    });
  }
}
