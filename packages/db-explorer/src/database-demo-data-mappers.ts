import type { FileChunk } from '@brainstrike/db';
import { isResolvedChunkingStrategy } from '@brainstrike/text-splitter';
import type {
  DatabaseCollectionCounts,
  DatabaseFileChunkSummary,
  DatabaseFileRecordSummary,
} from './use-database-demo-data';

export interface FileRecordRow {
  chunkingStrategy: string | null;
  chunksCount: number | null;
  chunksProcessedAt: string | null;
  contentHash: string | null;
  createdAt: string;
  embeddedChunksCount: number | null;
  embeddingSetId: string | null;
  hasEmbedding: boolean;
  id: string;
  name: string;
  path: string;
  processedAt: string | null;
  size: number;
  tokenCount: number | null;
  updatedAt: string;
}

export interface FileChunkRow {
  chunkIndex: number;
  chunkSize: number;
  chunkType: FileChunk['chunkType'];
  contentHash: string;
  createdAt: string;
  embeddingDimensions: number;
  embeddingHash: string | null;
  embeddingSetId: string | null;
  embeddingUpdatedAt: string | null;
  fileRecordId: string;
  hasEmbedding: boolean;
  id: string;
  tokenCount: number;
  updatedAt: string;
}

export interface FileRecordsTotalRow {
  embeddingSetId?: string | null;
  totalRecords: number | null;
}

export interface CollectionCountsRow {
  chunksCount: number | null;
  embeddingsCount: number | null;
  embeddingsetid?: string | null;
  recordsCount: number | null;
}

interface CachedRecordSummary {
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

interface CachedChunkSummary {
  chunkIndex: number;
  chunkSize: number;
  chunkType: FileChunk['chunkType'];
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

export interface CollectionFileDataSnapshot {
  chunks: CachedChunkSummary[];
  collectionCounts: DatabaseCollectionCounts;
  collectionId: string;
  page: number;
  pageSize: number;
  records: CachedRecordSummary[];
  totalRecords: number;
}

export function mapRecordRow(row: FileRecordRow): DatabaseFileRecordSummary {
  const record: DatabaseFileRecordSummary = {
    id: row.id,
    name: row.name,
    path: row.path,
    size: row.size,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasEmbedding: row.hasEmbedding,
  };

  if (row.contentHash) {
    record.contentHash = row.contentHash;
  }
  if (row.tokenCount !== null) {
    record.tokenCount = Number(row.tokenCount);
  }
  if (row.processedAt) {
    record.processedAt = row.processedAt;
  }
  if (row.embeddingSetId) {
    record.embeddingSetId = row.embeddingSetId;
  }
  if (row.chunksProcessedAt) {
    record.chunksProcessedAt = row.chunksProcessedAt;
  }
  if (row.chunksCount !== null) {
    record.chunksCount = Number(row.chunksCount);
  }
  if (row.embeddedChunksCount !== null) {
    record.embeddedChunksCount = Number(row.embeddedChunksCount);
  }
  const resolvedChunkingStrategy = row.chunkingStrategy;
  if (isResolvedChunkingStrategy(resolvedChunkingStrategy)) {
    record.chunkingStrategy = resolvedChunkingStrategy;
  }

  return record;
}

export function mapChunkRow(row: FileChunkRow): DatabaseFileChunkSummary {
  const chunk: DatabaseFileChunkSummary = {
    id: row.id,
    fileRecordId: row.fileRecordId,
    chunkIndex: row.chunkIndex,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount,
    chunkType: row.chunkType,
    chunkSize: row.chunkSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasEmbedding: row.hasEmbedding,
    embeddingDimensions: row.embeddingDimensions,
  };

  if (row.embeddingSetId) {
    chunk.embeddingSetId = row.embeddingSetId;
  }
  if (row.embeddingUpdatedAt) {
    chunk.embeddingUpdatedAt = row.embeddingUpdatedAt;
  }
  if (row.embeddingHash) {
    chunk.embeddingHash = row.embeddingHash;
  }

  return chunk;
}

function toCachedRecordSummary(record: DatabaseFileRecordSummary): CachedRecordSummary {
  const summary: CachedRecordSummary = {
    id: record.id,
    name: record.name,
    path: record.path,
    size: record.size,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tokenCount: record.tokenCount,
    chunksCount: record.chunksCount,
    chunksProcessedAt: record.chunksProcessedAt,
    contentHash: record.contentHash,
    processedAt: record.processedAt,
    hasEmbedding: record.hasEmbedding ?? false,
    chunkingStrategy: record.chunkingStrategy,
    embeddingSetId: record.embeddingSetId,
    embeddedChunksCount: record.embeddedChunksCount,
  };
  return summary;
}

function toCachedChunkSummary(chunk: DatabaseFileChunkSummary): CachedChunkSummary {
  return {
    id: chunk.id,
    fileRecordId: chunk.fileRecordId,
    chunkIndex: chunk.chunkIndex,
    tokenCount: chunk.tokenCount,
    chunkType: chunk.chunkType,
    chunkSize: chunk.chunkSize,
    contentHash: chunk.contentHash,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    hasEmbedding: chunk.hasEmbedding ?? false,
    embeddingDimensions: chunk.embeddingDimensions ?? 0,
    embeddingHash: chunk.embeddingHash,
    embeddingUpdatedAt: chunk.embeddingUpdatedAt,
    embeddingSetId: chunk.embeddingSetId,
  };
}

export function buildRecordPageCacheKey(
  collectionId: string,
  page: number,
  pageSize: number
): string {
  return `${collectionId}::${page}::${pageSize}`;
}

export function buildCollectionFileDataSnapshot(
  collectionId: string,
  page: number,
  pageSize: number,
  totalRecords: number,
  collectionCounts: DatabaseCollectionCounts,
  records: DatabaseFileRecordSummary[],
  chunks: DatabaseFileChunkSummary[]
): CollectionFileDataSnapshot {
  return {
    collectionId,
    page,
    pageSize,
    totalRecords,
    collectionCounts,
    records: records.map(toCachedRecordSummary),
    chunks: chunks.map(toCachedChunkSummary),
  };
}

export function restoreCachedRecord(summary: CachedRecordSummary): DatabaseFileRecordSummary {
  const record: DatabaseFileRecordSummary = {
    id: summary.id,
    name: summary.name,
    path: summary.path,
    size: summary.size,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    hasEmbedding: summary.hasEmbedding,
  };
  if (summary.tokenCount !== undefined) {
    record.tokenCount = summary.tokenCount;
  }
  if (summary.chunksCount !== undefined) {
    record.chunksCount = summary.chunksCount;
  }
  if (summary.embeddedChunksCount !== undefined) {
    record.embeddedChunksCount = summary.embeddedChunksCount;
  }
  if (summary.chunksProcessedAt !== undefined) {
    record.chunksProcessedAt = summary.chunksProcessedAt;
  }
  if (summary.contentHash !== undefined) {
    record.contentHash = summary.contentHash;
  }
  if (summary.processedAt !== undefined) {
    record.processedAt = summary.processedAt;
  }
  if (isResolvedChunkingStrategy(summary.chunkingStrategy)) {
    record.chunkingStrategy = summary.chunkingStrategy;
  }
  if (summary.embeddingSetId !== undefined) {
    record.embeddingSetId = summary.embeddingSetId;
  }
  return record;
}

function restoreCachedChunk(summary: CachedChunkSummary): DatabaseFileChunkSummary {
  const chunk: DatabaseFileChunkSummary = {
    id: summary.id,
    fileRecordId: summary.fileRecordId,
    chunkIndex: summary.chunkIndex,
    contentHash: summary.contentHash,
    tokenCount: summary.tokenCount,
    chunkType: summary.chunkType,
    chunkSize: summary.chunkSize,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    hasEmbedding: summary.hasEmbedding,
    embeddingDimensions: summary.embeddingDimensions,
  };
  if (summary.embeddingSetId !== undefined) {
    chunk.embeddingSetId = summary.embeddingSetId;
  }
  if (summary.embeddingUpdatedAt !== undefined) {
    chunk.embeddingUpdatedAt = summary.embeddingUpdatedAt;
  }
  if (summary.embeddingHash !== undefined) {
    chunk.embeddingHash = summary.embeddingHash;
  }
  return chunk;
}

export function restoreCachedChunkGroups(
  chunks: CachedChunkSummary[]
): Map<string, DatabaseFileChunkSummary[]> {
  const grouped = new Map<string, DatabaseFileChunkSummary[]>();
  for (const summary of chunks) {
    const restored = restoreCachedChunk(summary);
    const existing = grouped.get(restored.fileRecordId);
    if (existing) {
      existing.push(restored);
      continue;
    }
    grouped.set(restored.fileRecordId, [restored]);
  }
  return grouped;
}

export function normalizeCount(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export function rowBelongsToCollection(
  row: { embeddingSetId?: string | null } | null | undefined,
  collectionId: string
): boolean {
  return row?.embeddingSetId === undefined || row.embeddingSetId === collectionId;
}

export function recordsBelongToCollection(
  records: readonly DatabaseFileRecordSummary[],
  collectionId: string
): boolean {
  return records.every(
    (record) => record.embeddingSetId === undefined || record.embeddingSetId === collectionId
  );
}

export function collectionCountsRowBelongsToCollection(
  row: CollectionCountsRow | null | undefined,
  collectionId: string
): boolean {
  return row?.embeddingsetid === collectionId;
}

export function mapCollectionCountsRow(row: CollectionCountsRow): DatabaseCollectionCounts {
  return {
    records: normalizeCount(row.recordsCount),
    chunks: normalizeCount(row.chunksCount),
    embeddings: normalizeCount(row.embeddingsCount),
  };
}

export function cacheTotalRecordsForCollection(args: {
  cache: Map<string, number>;
  collectionId: string;
  rows: readonly FileRecordsTotalRow[];
}): void {
  const totalRow = args.rows[0];
  if (!rowBelongsToCollection(totalRow, args.collectionId)) {
    return;
  }
  args.cache.set(args.collectionId, normalizeCount(totalRow?.totalRecords));
}

export function cacheCollectionCountsForCollection(args: {
  cache: Map<string, DatabaseCollectionCounts>;
  collectionId: string;
  rows: readonly CollectionCountsRow[];
}): void {
  const countsRow = args.rows[0];
  if (!(countsRow && collectionCountsRowBelongsToCollection(countsRow, args.collectionId))) {
    return;
  }
  args.cache.set(args.collectionId, mapCollectionCountsRow(countsRow));
}

export function countLoadedChunkGroups(
  loadedChunksByPage: Map<string, Map<string, DatabaseFileChunkSummary[]>>
): number {
  let total = 0;
  for (const perPage of loadedChunksByPage.values()) {
    total += perPage.size;
  }
  return total;
}

export function countLoadedChunks(
  loadedChunksByPage: Map<string, Map<string, DatabaseFileChunkSummary[]>>
): number {
  let total = 0;
  for (const perPage of loadedChunksByPage.values()) {
    for (const summaries of perPage.values()) {
      total += summaries.length;
    }
  }
  return total;
}

export function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message ?? null;
  }
  if (typeof error === 'string') {
    return error;
  }
  return null;
}

export function isMissingRelation(message: string | null, table: string): boolean {
  if (!message) {
    return false;
  }
  const pattern = new RegExp(`relation .*${table}`, 'i');
  return pattern.test(message);
}
