export type FileChunk = {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileChunkInsert = {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileChunkUpdate = {
  id: string;
  content?: string;
  contentHash?: string;
  tokenCount?: number;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize?: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  updatedAt: string;
};

export type ChunkSearchResult = {
  chunk: FileChunk;
  similarity: number;
  rank: number;
};

export type ChunkSearchOptions = {
  limit?: number;
  threshold?: number;
  fileRecordId?: string;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  embeddingSetId?: string;
  /** Optional allowlist of file paths to scope results (relative to project root). */
  filePaths?: readonly string[];
  /** Optional snapshot id referencing a persisted selection allowlist. */
  selectionSnapshotId?: string;
};
