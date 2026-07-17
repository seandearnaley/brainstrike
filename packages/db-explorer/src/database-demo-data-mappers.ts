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
    createdAt: row.createdAt,
    hasEmbedding: row.hasEmbedding,
    id: row.id,
    name: row.name,
    path: row.path,
    size: row.size,
    updatedAt: row.updatedAt,
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
    chunkIndex: row.chunkIndex,
    chunkSize: row.chunkSize,
    chunkType: row.chunkType,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    embeddingDimensions: row.embeddingDimensions,
    fileRecordId: row.fileRecordId,
    hasEmbedding: row.hasEmbedding,
    id: row.id,
    tokenCount: row.tokenCount,
    updatedAt: row.updatedAt,
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
    chunkingStrategy: record.chunkingStrategy,
    chunksCount: record.chunksCount,
    chunksProcessedAt: record.chunksProcessedAt,
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    embeddedChunksCount: record.embeddedChunksCount,
    embeddingSetId: record.embeddingSetId,
    hasEmbedding: record.hasEmbedding ?? false,
    id: record.id,
    name: record.name,
    path: record.path,
    processedAt: record.processedAt,
    size: record.size,
    tokenCount: record.tokenCount,
    updatedAt: record.updatedAt,
  };
  return summary;
}

function toCachedChunkSummary(chunk: DatabaseFileChunkSummary): CachedChunkSummary {
  return {
    chunkIndex: chunk.chunkIndex,
    chunkSize: chunk.chunkSize,
    chunkType: chunk.chunkType,
    contentHash: chunk.contentHash,
    createdAt: chunk.createdAt,
    embeddingDimensions: chunk.embeddingDimensions ?? 0,
    embeddingHash: chunk.embeddingHash,
    embeddingSetId: chunk.embeddingSetId,
    embeddingUpdatedAt: chunk.embeddingUpdatedAt,
    fileRecordId: chunk.fileRecordId,
    hasEmbedding: chunk.hasEmbedding ?? false,
    id: chunk.id,
    tokenCount: chunk.tokenCount,
    updatedAt: chunk.updatedAt,
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
    chunks: chunks.map(toCachedChunkSummary),
    collectionCounts,
    collectionId,
    page,
    pageSize,
    records: records.map(toCachedRecordSummary),
    totalRecords,
  };
}

export function restoreCachedRecord(summary: CachedRecordSummary): DatabaseFileRecordSummary {
  const record: DatabaseFileRecordSummary = {
    createdAt: summary.createdAt,
    hasEmbedding: summary.hasEmbedding,
    id: summary.id,
    name: summary.name,
    path: summary.path,
    size: summary.size,
    updatedAt: summary.updatedAt,
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
    chunkIndex: summary.chunkIndex,
    chunkSize: summary.chunkSize,
    chunkType: summary.chunkType,
    contentHash: summary.contentHash,
    createdAt: summary.createdAt,
    embeddingDimensions: summary.embeddingDimensions,
    fileRecordId: summary.fileRecordId,
    hasEmbedding: summary.hasEmbedding,
    id: summary.id,
    tokenCount: summary.tokenCount,
    updatedAt: summary.updatedAt,
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
    chunks: normalizeCount(row.chunksCount),
    embeddings: normalizeCount(row.embeddingsCount),
    records: normalizeCount(row.recordsCount),
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
