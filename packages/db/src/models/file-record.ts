import type { ResolvedChunkingStrategy } from '@brainstrike/indexing-contract';

export interface FileRecord {
  chunkingStrategy?: ResolvedChunkingStrategy; // Canonical strategy actually used for chunking
  chunksCount?: number; // Number of chunks created for this file
  chunksProcessedAt?: string; // ISO date when file was chunked
  content?: string; // File content (for text files)
  contentHash?: string; // Hash of content for deduplication
  createdAt: string; // ISO date string
  embedding?: number[]; // Vector embedding for semantic search
  embeddingSetId?: string; // Collection this file belongs to (set at import time)
  id: string; // UUID
  name: string;
  path: string;
  processedAt?: string; // ISO date when file was processed/imported
  size: number;
  sourceRootPath?: string; // Canonical root folder path for managed cache entries
  tokenCount?: number; // Number of tokens in content
  updatedAt: string; // ISO date string
}

type NullableFileRecordUpdateFields =
  | 'chunksCount'
  | 'chunksProcessedAt'
  | 'chunkingStrategy'
  | 'content'
  | 'contentHash'
  | 'embedding'
  | 'embeddingSetId'
  | 'processedAt'
  | 'sourceRootPath'
  | 'tokenCount';

export type FileRecordUpdate = Omit<Partial<FileRecord>, NullableFileRecordUpdateFields> & {
  chunksCount?: number | null;
  chunksProcessedAt?: string | null;
  chunkingStrategy?: ResolvedChunkingStrategy | null;
  content?: string | null;
  contentHash?: string | null;
  embedding?: number[] | null;
  embeddingSetId?: string | null;
  processedAt?: string | null;
  sourceRootPath?: string | null;
  tokenCount?: number | null;
};

export interface ManagedCacheEntryMetadata {
  contentHash: string;
  embeddingSetId: string;
  fileRecordId: string;
  // Persisted filesystem stat used by the background-sync stat-cache fast-path:
  // when a discovered file's size AND mtime both match the stored values, the
  // file is treated as unchanged without reading/hashing its content. mtimeMs is
  // null for rows written before the mtime column existed (self-heals on first
  // re-hash). Both optional so callers that don't select them still type-check.
  mtimeMs?: number | null;
  relativePath: string;
  size?: number;
  sourceRootPath: string;
  updatedAt: string;
}

export interface FileImportRequest {
  content: string;
  embeddingSetId?: string; // Collection this file belongs to (set at import time)
  name: string;
  path: string;
  size: number;
  sourceRootPath?: string; // Canonical root folder path for managed cache entries
}

export interface FileImportResult {
  error?: string;
  existed: boolean;
  id: string;
  imported: boolean;
}

export interface ImportProgress {
  completed: number;
  current?: string;
  errors: Array<{ file: string; error: string }>;
  total: number;
}
