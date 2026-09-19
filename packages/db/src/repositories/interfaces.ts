import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import type { EmbeddingDistance, EmbeddingSet } from '../models/embedding-set.js';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
  FTSSearchOptions,
  FTSSearchResult,
} from '../models/file-chunk.js';
import type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  ManagedCacheEntryMetadata,
} from '../models/file-record';
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';

/**
 * Common interface for all embedding sets repositories
 */
export interface IEmbeddingSetsRepository {
  delete: (id: string) => Promise<boolean>;
  findAll: () => Promise<EmbeddingSet[]>;
  getById: (id: string) => Promise<EmbeddingSet | null>;
  getByModelKey: (modelKey: string) => Promise<EmbeddingSet[]>;
  getOrCreateSet: (
    modelKey: string,
    modelId: string,
    dimensions: number,
    distance: EmbeddingDistance,
    metadata?: { name?: string; description?: string; tags?: string; category?: string }
  ) => Promise<EmbeddingSet>;
  getOrCreateWorkspaceIndexSet: () => Promise<EmbeddingSet>;
  updateMetadata: (
    id: string,
    metadata: { name?: string; description?: string; tags?: string; category?: string }
  ) => Promise<EmbeddingSet | null>;
}

/**
 * Shared file-chunk repository contract implemented by the direct PGlite,
 * Drizzle, and Electron IPC transports.
 */
export interface IFileChunkRepository {
  clearAll: () => Promise<number>;
  clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  delete: (id: string) => Promise<boolean>;
  deleteByFileRecordId: (fileRecordId: string) => Promise<number>;
  findAll: () => Promise<FileChunk[]>;
  findByFileRecordId: (fileRecordId: string) => Promise<FileChunk[]>;
  findById: (id: string) => Promise<FileChunk | null>;
  findGrepCandidates: (options: GrepCandidateOptions) => Promise<GrepCandidate[]>;
  fullTextSearch: (query: string, options?: FTSSearchOptions) => Promise<FTSSearchResult[]>;
  getCoverageForSet: (embeddingSetId: string) => Promise<{
    chunksWithEmbeddingsForSet: number;
    totalChunks: number;
  }>;
  getStats: () => Promise<{
    averageTokenCount: number;
    chunksWithEmbeddings: number;
    chunkTypeDistribution: Record<string, number>;
    totalChunks: number;
  }>;
  insert: (chunk: FileChunkInsert) => Promise<FileChunk>;
  insertMany: (chunks: FileChunkInsert[]) => Promise<FileChunk[]>;
  insertManyWithTx: (tx: IDatabase, chunks: FileChunkInsert[]) => Promise<FileChunk[]>;
  searchSimilar: (
    queryEmbedding: number[],
    options?: ChunkSearchOptions
  ) => Promise<ChunkSearchResult[]>;
  update: (chunk: FileChunkUpdate) => Promise<FileChunk | null>;
}

/**
 * Common interface for all file record repositories
 */
export interface IFileRecordRepository {
  bulkImport?: (
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ) => Promise<FileImportResult[]>;
  clearAll?: () => Promise<number>;
  count?: () => Promise<number>;
  countWithContent?: () => Promise<number>;
  create: (record: FileRecord) => Promise<void>;
  createWithContent: (record: FileRecord) => Promise<void>;
  delete: (id: string) => Promise<void>;
  findAll: () => Promise<FileRecord[]>;
  findAllWithContent: () => Promise<FileRecord[]>;
  findByContentHash: (contentHash: string) => Promise<FileRecord | null>;
  findById: (id: string) => Promise<FileRecord | null>;
  findByIds: (ids: readonly string[]) => Promise<FileRecord[]>;
  findByManagedCacheIdentity: (
    embeddingSetId: string,
    rootId: string,
    relativePath: string
  ) => Promise<FileRecord | null>;
  listManagedCacheEntries: (embeddingSetId: string) => Promise<FileRecord[]>;
  listManagedCacheEntryMetadata: (embeddingSetId: string) => Promise<ManagedCacheEntryMetadata[]>;
  update: (id: string, updates: FileRecordUpdate) => Promise<void>;
  updateContent: (
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ) => Promise<void>;
  /** Batch-stamp stat metadata (size + floored mtime) without rewriting content. */
  updateStatMetadata: (
    entries: ReadonlyArray<{ fileRecordId: string; mtimeMs: number; size: number }>
  ) => Promise<void>;
}

/**
 * Minimal database query interface that both PGlite and Electron API implement
 * This is a subset of PGlite's full interface to support both implementations
 */
export interface IDatabase {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  transaction?: <T>(fn: (tx: IDatabase) => Promise<T>) => Promise<T>;
}

/**
 * Common interface for view filter presets repositories
 *
 * Uses types from @brainstrike/types for consistency across implementations.
 */
export interface IViewFilterPresetsRepository {
  create: (input: CreateViewFilterPresetInput) => Promise<ViewFilterPreset>;
  delete: (id: string) => Promise<boolean>;
  findAll: () => Promise<ViewFilterPreset[]>;
  getById: (id: string) => Promise<ViewFilterPreset | null>;
  getDefaults: () => Promise<ViewFilterPreset[]>;
  update: (id: string, input: UpdateViewFilterPresetInput) => Promise<ViewFilterPreset | null>;
}
